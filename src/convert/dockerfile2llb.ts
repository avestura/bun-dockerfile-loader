import type {
  AddInstruction,
  CopyInstruction,
  Instruction,
  MountFlag,
  RunInstruction,
} from "../parser/ast.ts";
import { Dockerfile, type Stage } from "../edit/document.ts";
import { formatInstruction } from "../edit/printer.ts";
import { ShellLex, envsFromSlice, type EnvGetter } from "../parser/shell.ts";
import { Cap } from "../llb/caps.ts";
import {
  CacheSharingOpt,
  NetMode,
  SecurityMode,
  type OpMetadata,
  type Platform,
} from "../llb/ops.ts";
import {
  file,
  image as imageSource,
  http as httpSource,
  git as gitSource,
  merge,
  run as runExec,
  State,
  Vertex,
  marshalState,
  type FileActionSpec,
  type MarshaledDefinition,
  type RunMount,
} from "../llb/state.ts";
import {
  addEnv,
  commitToHistory,
  cloneImage,
  defaultPathEnv,
  emptyImage,
  parseKeyValue,
  withShell,
  type Image,
} from "./image.ts";
import {
  defaultArgs,
  formatPlatform,
  formatPlatformAll,
  normalizePlatform,
  parsePlatform,
  platformsEqual,
  PROXY_ARGS,
} from "./platform.ts";
import { normalizeReference } from "./reference.ts";
import { nullResolver, type MetaResolver } from "./resolver.ts";

/**
 * Compiles a Dockerfile to BuildKit LLB.
 *
 * This is a port of `frontend/dockerfile/dockerfile2llb`: it produces both the
 * LLB graph and the OCI image config, because the config carries everything LLB
 * cannot express (ENV, CMD, ENTRYPOINT, LABEL, USER, EXPOSE, ...).
 */

export const SCRATCH = "scratch";
const DEFAULT_CONTEXT_NAME = "context";

/** Build args that configure BuildKit itself and never enter the shell env. */
const NON_ENV_ARGS = new Set(["BUILDKIT_SBOM_SCAN_CONTEXT", "BUILDKIT_SBOM_SCAN_STAGE"]);

export interface ConvertOptions {
  /** Stage to build; defaults to the last one. */
  target?: string;
  buildArgs?: Record<string, string>;
  /** Labels merged into the final image config. */
  labels?: Record<string, string>;
  targetPlatform?: Platform;
  buildPlatform?: Platform;
  /** Prefixes progress names with the platform, as multi-platform builds do. */
  multiPlatform?: boolean;
  /** Resolves `FROM` references; defaults to {@link nullResolver}. */
  metaResolver?: MetaResolver;
  imageResolveMode?: "default" | "pull" | "local";
  /** Local context name; `context` unless a named context is used. */
  contextName?: string;
  /** Session ID stamped onto `local://` sources. */
  sessionID?: string;
  /**
   * Value for the context's `local.unique` attribute, used when no session ID
   * is given. BuildKit generates a fresh random ID per marshal, which makes the
   * definition differ between runs; pin this for reproducible output.
   */
  localUniqueID?: string;
  /** Overrides the build context state entirely. */
  buildContext?: State;
  cacheIDNamespace?: string;
  extraHosts?: { Host: string; IP: string }[];
  hostname?: string;
  shmSize?: number;
  networkMode?: NetMode;
  /** `true` for every stage, or a list of stage names (`--no-cache-filter`). */
  ignoreCache?: boolean | string[];
  /** SOURCE_DATE_EPOCH equivalent; stamps history and file timestamps. */
  epoch?: Date;
  /** Name used in progress output and source maps. */
  filename?: string;
  /**
   * Daemon capabilities. Defaults assume a current BuildKit: the daemon injects
   * the default PATH itself and MergeOp is available for `COPY --link`.
   */
  caps?: {
    execMetaSetsDefaultPath?: boolean;
    mergeOp?: boolean;
    bindReadWriteNoOutput?: boolean;
  };
}

export interface StageResult {
  name: string;
  index: number;
  baseName: string;
  platform: Platform;
  state: State;
  image: Image;
}

export interface ConvertResult {
  /** LLB state of the target stage. */
  state: State;
  /** OCI image config for the target stage. */
  image: Image;
  /** Marshaled definition, ready for `buildctl build`. */
  definition: MarshaledDefinition;
  target: string;
  stages: StageResult[];
  /** Build args that were actually referenced. */
  usedBuildArgs: string[];
  /** Context paths the build reads, as `local.followpaths` would list them. */
  contextPaths: string[];
  warnings: string[];
}

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : message + " (line " + line + ")");
    this.name = "ConvertError";
  }
}

interface DispatchState {
  index: number;
  stageName: string;
  /** Name as written in FROM, after variable expansion. */
  baseName: string;
  sourceCode: string;
  stage: Stage | null;
  state: State;
  image: Image;
  baseImage?: Image;
  platform: Platform;
  /** Explicit `--platform=` on the FROM line. */
  explicitPlatform: boolean;
  base: DispatchState | null;
  deps: Set<DispatchState>;
  buildArgs: { key: string; value?: string }[];
  ctxPaths: Set<string>;
  paths: Set<string>;
  cmdIndex: number;
  cmdTotal: number;
  cmdIsOnBuild: boolean;
  dispatched: boolean;
  resolved: boolean;
  unregistered: boolean;
  ignoreCache: boolean;
  workdirSet: boolean;
  line: number;
}

export async function dockerfileToLLB(
  input: Dockerfile | string,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const doc = typeof input === "string" ? Dockerfile.parse(input, { filename: opts.filename }) : input;
  const warnings: string[] = doc.warnings.map((w) => w.message + " (line " + w.line + ")");

  const targetPlatform = normalizePlatform(opts.targetPlatform ?? { OS: "linux", Architecture: "amd64" });
  const buildPlatform = normalizePlatform(opts.buildPlatform ?? targetPlatform);
  const implicitTarget = opts.targetPlatform === undefined;
  const caps = {
    execMetaSetsDefaultPath: opts.caps?.execMetaSetsDefaultPath ?? true,
    mergeOp: opts.caps?.mergeOp ?? true,
    bindReadWriteNoOutput: opts.caps?.bindReadWriteNoOutput ?? true,
  };
  const resolver = opts.metaResolver ?? nullResolver();
  const shlex = new ShellLex(doc.escapeChar);
  const buildArgValues = { ...opts.buildArgs };

  const docStages = doc.stages;
  if (docStages.length === 0) throw new ConvertError("dockerfile contains no stages to build");

  const targetName = opts.target ?? docStages[docStages.length - 1]!.name ?? "";

  // --- Global (pre-FROM) ARGs ----------------------------------------------
  let globalArgs = defaultArgs(buildPlatform, targetPlatform, targetName, buildArgValues);
  const usedArgs = new Set<string>();
  const allArgKeys = new Set<string>();

  for (const inst of doc.globalArgs) {
    if (inst.type !== "Arg") continue;
    for (const a of inst.args) {
      allArgKeys.add(a.key);
      if (a.key in buildArgValues) {
        globalArgs[a.key] = buildArgValues[a.key]!;
      } else if (a.value !== undefined) {
        const r = shlex.processWord(a.value, envsFromMapOrdered(globalArgs));
        for (const m of r.matched) usedArgs.add(m);
        globalArgs[a.key] = r.result;
      }
    }
  }

  // --- Build a dispatch state per stage ------------------------------------
  const states: DispatchState[] = [];
  const byName = new Map<string, DispatchState>();

  const registerState = (ds: DispatchState) => {
    states.push(ds);
    if (ds.stageName) byName.set(ds.stageName.toLowerCase(), ds);
  };

  docStages.forEach((stage, i) => {
    const nameMatch = shlex.processWord(stage.baseImage, envsFromMapOrdered(globalArgs));
    for (const m of nameMatch.matched) usedArgs.add(m);
    if (nameMatch.result === "") {
      throw new ConvertError("base name (" + stage.baseImage + ") should not be blank", stage.from.loc.startLine);
    }

    let platform = targetPlatform;
    let explicitPlatform = false;
    if (stage.platform) {
      const platMatch = shlex.processWord(stage.platform, envsFromMapOrdered(globalArgs));
      for (const m of platMatch.matched) usedArgs.add(m);
      if (platMatch.result === "") {
        throw new ConvertError("empty platform value from expression " + stage.platform, stage.from.loc.startLine);
      }
      platform = normalizePlatform(parsePlatform(platMatch.result));
      explicitPlatform = true;
    }

    const ds: DispatchState = {
      index: i,
      stageName: stage.name ?? "stage-" + i,
      baseName: nameMatch.result,
      sourceCode: formatInstruction(stage.from),
      stage,
      state: State.scratch(),
      image: emptyImage(platform),
      platform,
      explicitPlatform,
      base: null,
      deps: new Set(),
      buildArgs: [],
      ctxPaths: new Set(),
      paths: new Set(),
      cmdIndex: 0,
      cmdTotal: 0,
      cmdIsOnBuild: false,
      dispatched: false,
      resolved: false,
      unregistered: false,
      ignoreCache:
        opts.ignoreCache === true ||
        (Array.isArray(opts.ignoreCache) && opts.ignoreCache.includes(stage.name ?? "")),
      workdirSet: false,
      line: stage.from.loc.startLine,
    };
    registerState(ds);
  });

  // --- Build context --------------------------------------------------------
  const contextName = opts.contextName ?? DEFAULT_CONTEXT_NAME;
  const contextAttrs: Record<string, string> = {};
  if (opts.sessionID) contextAttrs["local.session"] = opts.sessionID;
  else contextAttrs["local.unique"] = opts.localUniqueID ?? newIdentity();
  contextAttrs["local.sharedkeyhint"] = contextName;

  const contextCaps: Record<string, boolean> = {
    [Cap.SourceLocal]: true,
    [Cap.SourceLocalSharedKeyHint]: true,
  };
  if (opts.sessionID) contextCaps[Cap.SourceLocalSessionID] = true;
  else contextCaps[Cap.SourceLocalUnique] = true;

  // `followpaths` is only known once every stage has been dispatched, and the
  // vertex is not marshaled until then, so the attrs map can be filled in later.
  const contextVertex = new Vertex(
    [],
    () => ({
      inputs: [],
      source: { identifier: "local://" + contextName, attrs: contextAttrs },
      constraints: {},
    }),
    {
      caps: contextCaps,
      description: { "llb.customname": "[internal] load build context" },
    },
  );
  const buildContext = opts.buildContext ?? new State({ vertex: contextVertex, index: 0 });

  // --- Dependency graph -----------------------------------------------------
  /**
   * Sources are resolved up front, exactly like BuildKit's `toCommand` +
   * `detectRunMount`: every `--from` and every RUN mount gets a dispatch state
   * before any stage is dispatched, so a mount can reference `scratch` or an
   * image that is not a stage.
   */
  const instructionSources = new Map<Instruction, DispatchState[]>();

  const lookupOrCreate = (ref: string): DispatchState => {
    const hit = byName.get(ref.toLowerCase());
    if (hit) return hit;
    // A numeric `--from` selects a stage by position.
    if (/^\d+$/.test(ref)) {
      const byIndex = states.filter((s) => s.stage)[Number(ref)];
      if (byIndex) return byIndex;
      throw new ConvertError("invalid stage index " + ref);
    }
    // Anything else is an external image reference.
    const ds: DispatchState = {
      index: states.length,
      stageName: "",
      baseName: ref,
      sourceCode: "FROM " + ref,
      stage: null,
      state: State.scratch(),
      image: emptyImage(targetPlatform),
      platform: targetPlatform,
      explicitPlatform: false,
      base: null,
      deps: new Set(),
      buildArgs: [],
      ctxPaths: new Set(),
      paths: new Set(),
      cmdIndex: 0,
      cmdTotal: 0,
      cmdIsOnBuild: false,
      dispatched: false,
      resolved: false,
      unregistered: true,
      ignoreCache: false,
      workdirSet: false,
      line: 0,
    };
    registerState(ds);
    return ds;
  };

  for (const ds of states) {
    if (!ds.stage) continue;
    const baseRef = byName.get(ds.baseName.toLowerCase());
    if (baseRef && baseRef !== ds) {
      ds.base = baseRef;
      ds.deps.add(baseRef);
    }
    for (const inst of ds.stage.instructions) {
      const sources: DispatchState[] = [];
      if (inst.type === "Copy" && inst.from) sources.push(lookupOrCreate(inst.from));
      if (inst.type === "Run") {
        // One source per mount, positionally, with an empty `from` meaning
        // scratch — the same placeholder BuildKit uses.
        for (const m of inst.mounts) sources.push(lookupOrCreate(m.from || SCRATCH));
      }
      instructionSources.set(inst, sources);
      for (const src of sources) if (src !== ds) ds.deps.add(src);
    }
  }

  validateNoCircularDependency(states);

  // A build with a single stage prints no stage name in its progress output.
  if (states.length === 1) states[0]!.stageName = "";

  // --- Target and reachability ---------------------------------------------
  const target =
    opts.target === undefined
      ? states.filter((s) => s.stage).at(-1)!
      : byName.get(opts.target.toLowerCase());
  if (!target) {
    throw new ConvertError(
      "target stage \"" + opts.target + "\" could not be found; available: " +
        [...byName.keys()].join(", "),
    );
  }

  const reachable = new Set<DispatchState>();
  const walk = (ds: DispatchState) => {
    if (reachable.has(ds)) return;
    reachable.add(ds);
    for (const dep of ds.deps) walk(dep);
  };
  walk(target);

  // --- Resolve base images --------------------------------------------------
  for (const ds of states) {
    if (!reachable.has(ds)) continue;
    if (ds.base) continue;
    await resolveBase(ds);
  }

  async function resolveBase(ds: DispatchState): Promise<void> {
    if (ds.resolved) return;
    ds.resolved = true;

    if (ds.baseName === SCRATCH) {
      ds.state = State.scratch();
      ds.image = emptyImage(ds.platform);
      ds.cmdTotal = countCommands(ds);
      if (ds.unregistered) ds.dispatched = true;
      return;
    }

    let platform = ds.platform;
    const resolved = await resolver.resolve(ds.baseName, {
      platform,
      resolveMode: opts.imageResolveMode ?? "default",
    });
    const img = cloneImage(resolved.config);
    ds.baseImage = cloneImage(resolved.config);
    delete img.created;

    // Without an explicit --platform, a base image built for another platform
    // is honoured when the target platform was itself implicit.
    if (!ds.explicitPlatform && implicitTarget && img.os && img.architecture) {
      const detected = normalizePlatform({
        OS: img.os,
        Architecture: img.architecture,
        Variant: img.variant,
      });
      if (!platformsEqual(detected, platform) && detected.OS === platform.OS) {
        platform = detected;
      }
    }

    // An image with no layers behaves as scratch, but only when the resolver
    // actually knows the layer list.
    const hasLayers =
      resolved.hasLayers ??
      ((img.rootfs?.diff_ids?.length ?? 0) > 0 || (img.history?.some((h) => !h.empty_layer) ?? false));

    ds.image = img;
    ds.platform = platform;
    ds.cmdTotal = countCommands(ds);

    if (!hasLayers) {
      ds.state = State.scratch();
    } else {
      ds.state = imageSource(resolved.ref, {
        platform,
        resolveMode: opts.imageResolveMode,
        metadata: {
          description: {
            "com.docker.dockerfile.v1.command": ds.sourceCode,
            "llb.customname": prefixCommand(ds, "FROM " + resolved.ref, platform),
          },
        },
      });
    }
    if (ds.unregistered) ds.dispatched = true;
  }

  function countCommands(ds: DispatchState): number {
    let total = ds.baseName !== SCRATCH && ds.base === null ? 1 : 0;
    for (const inst of ds.stage?.instructions ?? []) {
      if (inst.type === "Run" || inst.type === "Copy" || inst.type === "Add" || inst.type === "Workdir") {
        total++;
      }
    }
    return total;
  }

  function prefixCommand(ds: DispatchState, str: string, platform: Platform): string {
    if (ds.cmdTotal === 0) return str;
    let out = "[";
    if (opts.multiPlatform) out += formatPlatformAll(platform) + " ";
    if (ds.stageName) out += ds.stageName + " ";
    ds.cmdIndex++;
    const width = String(ds.cmdTotal).length;
    out += String(ds.cmdIndex).padStart(width, " ") + "/" + ds.cmdTotal + "] ";
    if (ds.cmdIsOnBuild) out += "ONBUILD ";
    return out + str;
  }

  // --- Dispatch -------------------------------------------------------------
  const proxyEnv = proxyEnvFrom(buildArgValues);
  const allContextPaths = new Set<string>();
  /** Stages whose Dockerfile sets a CMD, which changes ENTRYPOINT's behaviour. */
  const cmdSet = new Set<DispatchState>();

  for (const ds of states) {
    if (!reachable.has(ds) || ds.dispatched) continue;
    if (!ds.stage) continue;

    initFromBase(ds);
    ds.dispatched = true;

    // PATH is always present, except on Windows where the OS supplies it.
    if (ds.platform.OS !== "windows" && !(ds.image.config.Env ?? []).some((e) => e.startsWith("PATH="))) {
      ds.image.config.Env = [...(ds.image.config.Env ?? []), "PATH=" + defaultPathEnv(ds.platform.OS)];
    }
    for (const entry of ds.image.config.Env ?? []) {
      const [k, v] = parseKeyValue(entry);
      ds.state = ds.state.addEnv(k, v);
    }
    if (opts.hostname) ds.state = ds.state.hostname(opts.hostname);
    if (ds.image.config.WorkingDir) {
      dispatchWorkdir(ds, ds.image.config.WorkingDir, false);
    }
    if (ds.image.config.User) {
      ds.state = ds.state.user(ds.image.config.User);
    }
    if (opts.networkMode !== undefined) ds.state = ds.state.network(opts.networkMode);

    for (const inst of ds.stage.instructions) {
      dispatchInstruction(ds, inst);
    }
    for (const p of ds.ctxPaths) allContextPaths.add(p);
  }

  function initFromBase(ds: DispatchState) {
    if (!ds.base) return;
    ds.state = ds.base.state;
    ds.platform = ds.base.platform;
    ds.image = cloneImage(ds.base.image);
    // ONBUILD triggers are not inherited from a parent stage.
    delete ds.image.config.OnBuild;
    ds.baseImage = ds.base.baseImage ? cloneImage(ds.base.baseImage) : undefined;
    ds.paths = ds.base.paths;
    ds.workdirSet = ds.base.workdirSet;
    ds.buildArgs = [...ds.base.buildArgs, ...ds.buildArgs];
    ds.cmdTotal = countCommands(ds);
  }

  function stateEnv(ds: DispatchState): EnvGetter {
    return envsFromSlice(ds.state.meta.env, ds.platform.OS === "windows");
  }

  /** `SupportsSingleWordExpansion`: expands the fields BuildKit expands. */
  function expand(ds: DispatchState, word: string): string {
    return shlex.processWord(word, stateEnv(ds)).result;
  }

  /**
   * Builds an op's `OpMetadata.description`.
   *
   * Only RUN and image sources record the originating Dockerfile line
   * (`dfCmd`); FileOps from COPY/ADD/WORKDIR carry just the progress name.
   */
  function descriptionFor(
    ds: DispatchState,
    inst: Instruction,
    opt: { name?: string; withCommand?: boolean } = {},
  ): OpMetadata {
    const source = inst.code || formatInstruction(inst);
    const lex = new ShellLex(doc.escapeChar, { rawQuotes: true, skipUnsetEnv: true });
    let display: string;
    try {
      display = lex.processWord(opt.name ?? source, stateEnv(ds)).result;
    } catch {
      display = opt.name ?? source;
    }
    const description: Record<string, string> = {};
    if (opt.withCommand) description["com.docker.dockerfile.v1.command"] = source;
    description["llb.customname"] = prefixCommand(ds, uppercaseCmd(display), ds.platform);
    const metadata: OpMetadata = { description };
    if (ds.ignoreCache) metadata.ignore_cache = true;
    return metadata;
  }

  function dispatchInstruction(ds: DispatchState, inst: Instruction): void {
    switch (inst.type) {
      case "Env": {
        const parts: string[] = [];
        for (const pair of inst.pairs) {
          const value = expand(ds, pair.value);
          ds.state = ds.state.addEnv(pair.key, value);
          ds.image.config.Env = addEnv(ds.image.config.Env ?? [], pair.key, value, ds.platform.OS === "windows");
          parts.push(pair.key + "=" + value);
        }
        commitToHistory(ds.image, "ENV " + parts.join(" "), false, false, opts.epoch);
        return;
      }

      case "Arg": {
        const parts: string[] = [];
        for (const a of inst.args) {
          allArgKeys.add(a.key);
          usedArgs.add(a.key);
          let value: string | undefined;
          if (a.key in buildArgValues) value = buildArgValues[a.key];
          else if (a.value !== undefined) value = expand(ds, a.value);
          else if (a.key in globalArgs) value = globalArgs[a.key];

          if (value !== undefined && !NON_ENV_ARGS.has(a.key)) {
            ds.state = ds.state.addEnv(a.key, value);
          }
          ds.buildArgs.push({ key: a.key, value });
          parts.push(value === undefined ? a.key : a.key + "=" + value);
        }
        commitToHistory(ds.image, "ARG " + parts.join(" "), false, false, opts.epoch);
        return;
      }

      case "Workdir":
        dispatchWorkdir(ds, expand(ds, inst.path), true, inst);
        return;

      case "Run":
        dispatchRun(ds, inst);
        return;

      case "Copy":
      case "Add":
        dispatchCopy(ds, inst);
        return;

      case "User": {
        const user = expand(ds, inst.user);
        ds.state = ds.state.user(user);
        ds.image.config.User = user;
        commitToHistory(ds.image, "USER " + user, false, false, opts.epoch);
        return;
      }

      case "Label": {
        ds.image.config.Labels ??= {};
        const parts: string[] = [];
        for (const pair of inst.pairs) {
          const value = expand(ds, pair.value);
          ds.image.config.Labels[expand(ds, pair.key)] = value;
          parts.push(pair.key + "=" + value);
        }
        commitToHistory(ds.image, "LABEL " + parts.join(" "), false, false, opts.epoch);
        return;
      }

      case "Expose": {
        ds.image.config.ExposedPorts ??= {};
        const ports: string[] = [];
        for (const raw of inst.ports) {
          const port = normalizePort(expand(ds, raw));
          ds.image.config.ExposedPorts[port] = {};
          ports.push(port);
        }
        commitToHistory(ds.image, "EXPOSE " + JSON.stringify(ports), false, false, opts.epoch);
        return;
      }

      case "Volume": {
        ds.image.config.Volumes ??= {};
        for (const v of inst.volumes) {
          const volume = expand(ds, v);
          if (volume === "") throw new ConvertError("VOLUME specified can not be an empty string", inst.loc.startLine);
          ds.image.config.Volumes[volume] = {};
        }
        commitToHistory(ds.image, "VOLUME " + JSON.stringify(inst.volumes), false, false, opts.epoch);
        return;
      }

      case "Cmd": {
        const args = inst.command.kind === "shell" ? withShell(ds.image, inst.command.args) : inst.command.args;
        cmdSet.add(ds);
        ds.image.config.Cmd = args;
        ds.image.config.ArgsEscaped = true;
        commitToHistory(ds.image, "CMD " + JSON.stringify(args), false, false, opts.epoch);
        return;
      }

      case "Entrypoint": {
        const args = inst.command.kind === "shell" ? withShell(ds.image, inst.command.args) : inst.command.args;
        ds.image.config.Entrypoint = args;
        // An ENTRYPOINT discards a CMD inherited from the base image, unless
        // this Dockerfile set one itself.
        if (!cmdSet.has(ds)) delete ds.image.config.Cmd;
        commitToHistory(ds.image, "ENTRYPOINT " + JSON.stringify(args), false, false, opts.epoch);
        return;
      }

      case "Healthcheck": {
        ds.image.config.Healthcheck = inst.none
          ? { Test: ["NONE"] }
          : {
              Test: inst.test,
              Interval: durationToNanos(inst.interval),
              Timeout: durationToNanos(inst.timeout),
              StartPeriod: durationToNanos(inst.startPeriod),
              StartInterval: durationToNanos(inst.startInterval),
              Retries: inst.retries,
            };
        commitToHistory(ds.image, "HEALTHCHECK " + JSON.stringify(ds.image.config.Healthcheck), false, false, opts.epoch);
        return;
      }

      case "StopSignal":
        ds.image.config.StopSignal = expand(ds, inst.signal);
        commitToHistory(ds.image, "STOPSIGNAL " + ds.image.config.StopSignal, false, false, opts.epoch);
        return;

      case "Shell":
        ds.image.config.Shell = inst.shell;
        commitToHistory(ds.image, "SHELL " + JSON.stringify(inst.shell), false, false, opts.epoch);
        return;

      case "Maintainer":
        ds.image.author = inst.maintainer;
        commitToHistory(ds.image, "MAINTAINER " + inst.maintainer, false, false, opts.epoch);
        return;

      case "Onbuild":
        ds.image.config.OnBuild = [...(ds.image.config.OnBuild ?? []), inst.body];
        return;

      case "From":
      case "Unknown":
        return;
    }
  }

  function dispatchWorkdir(ds: DispatchState, path: string, commit: boolean, inst?: Instruction) {
    const wd = normalizeWorkdir(ds.image.config.WorkingDir ?? "", path, ds.platform.OS);
    ds.image.config.WorkingDir = wd;
    ds.state = ds.state.dir(wd);
    if (!commit) return;
    ds.workdirSet = true;

    let withLayer = false;
    if (wd !== "/") {
      const owner = ds.image.config.User ? chownFromUser(ds.image.config.User) : undefined;
      ds.state = file(
        ds.state,
        [
          {
            kind: "mkdir",
            path: wd,
            mode: 0o755,
            makeParents: true,
            owner,
            timestamp: opts.epoch ? Math.floor(opts.epoch.getTime() / 1000) * 1e9 : undefined,
          },
        ],
        inst ? { description: descriptionFor(ds, inst).description, ignoreCache: ds.ignoreCache } : {},
      );
      withLayer = true;
    }
    commitToHistory(ds.image, "WORKDIR " + wd, withLayer, false, opts.epoch);
  }

  function dispatchRun(ds: DispatchState, inst: RunInstruction) {
    ds.paths.add("/");
    let args = inst.command.args;
    let prependShell = inst.command.kind === "shell";
    const extraMounts: RunMount[] = [];
    let customName = inst.code || formatInstruction(inst);

    if (inst.heredocs.length > 0) {
      const first = inst.heredocs[0]!;
      const onlyHeredoc = inst.heredocs.length === 1 && isBareHeredoc(inst.command.args[0] ?? "", first);
      if (onlyHeredoc) {
        const data = first.chomp ? chompHeredoc(first.content) : first.content;
        if (ds.platform.OS !== "windows" && data.startsWith("#!")) {
          // A heredoc with a shebang becomes a file that is executed directly.
          const script = file(State.scratch().dir("/"), [
            { kind: "mkfile", path: first.delimiter, mode: 0o755, data: new TextEncoder().encode(data) },
          ], { description: { "llb.customname": "[internal] preparing inline document" } });
          extraMounts.push({
            target: "/dev/pipes/",
            source: script,
            selector: "/",
            readonly: true,
          });
          args = ["/dev/pipes/" + first.delimiter];
          prependShell = false;
        } else {
          args = [data];
        }
        customName += " (" + summarizeHeredoc(first.content) + ")";
      } else {
        // Multiple or mixed heredocs are reconstituted and handed to the shell.
        let body = inst.command.args[0] ?? "";
        for (const h of inst.heredocs) body += "\n" + h.content + h.delimiter;
        args = [body];
      }
    }

    if (prependShell) args = withShell(ds.image, args);

    const mounts: RunMount[] = [...extraMounts];
    const sources = instructionSources.get(inst) ?? [];
    inst.mounts.forEach((m, i) => {
      const built = buildRunMount(ds, m, inst, sources[i]);
      if (built) mounts.push(built);
    });

    const metadata = descriptionFor(ds, inst, { name: customName, withCommand: true });
    const result = runExec(ds.state, {
      args,
      mounts,
      network: networkFor(inst.network),
      security: inst.security === "insecure" ? SecurityMode.INSECURE : undefined,
      description: metadata.description,
      ignoreCache: ds.ignoreCache,
      daemonSetsDefaultPath: caps.execMetaSetsDefaultPath,
    });
    ds.state = result.root;
    commitToHistory(ds.image, "RUN " + runCommandString(args, ds.buildArgs, stateEnv(ds)), true, true, opts.epoch);
    void proxyEnv;
  }

  /**
   * Builds one `RUN --mount`.
   *
   * The control flow mirrors `dispatchRunMounts`: secret and SSH mounts return
   * early and never touch the context paths, while every other kind — tmpfs
   * included, with its empty source collapsing to "/" — records one. That "/"
   * is what suppresses `local.followpaths` for the whole build.
   */
  function buildRunMount(
    ds: DispatchState,
    m: MountFlag,
    inst: RunInstruction,
    sourceState: DispatchState | undefined,
  ): RunMount | null {
    const rawTarget = expand(ds, m.target ?? "");

    if (m.type === "secret") {
      const id = m.id ?? m.source ?? (rawTarget ? basename(rawTarget) : "");
      if (!id) throw new ConvertError("one of source, target required for secret mount", inst.loc.startLine);
      return {
        target: rawTarget || "/run/secrets/" + basename(id),
        secret: {
          id,
          uid: m.uid,
          gid: m.gid,
          mode: m.mode ?? 0o400,
          optional: m.required !== true,
        },
      };
    }
    if (m.type === "ssh") {
      if (m.source) throw new ConvertError("ssh does not support source", inst.loc.startLine);
      // BuildKit passes the raw id through; the "default" fallback it computes
      // is only used for the build outline, not for the mount itself.
      return {
        target: rawTarget,
        ssh: { id: m.id ?? "", uid: m.uid, gid: m.gid, mode: m.mode ?? 0o600, optional: m.required !== true },
      };
    }

    // A cache mount with no explicit source reads from scratch, not the context.
    const from = m.from ?? (m.type === "cache" ? SCRATCH : "");
    let source: State;
    if (from) {
      if (!sourceState) throw new ConvertError('unknown mount source "' + from + '"', inst.loc.startLine);
      if (!sourceState.dispatched) {
        throw new ConvertError(
          'cannot mount from stage "' + from + '" to "' + rawTarget + '", stage needs to be defined before current command',
          inst.loc.startLine,
        );
      }
      source = sourceState.state;
    } else {
      source = buildContext;
    }

    const mount: RunMount = { target: "", source };
    if (m.type === "tmpfs") {
      mount.source = undefined;
      mount.tmpfs = true;
      mount.tmpfsSize = m.size;
    }
    if (m.readonly) mount.readonly = true;
    else if (m.type === "bind" && caps.bindReadWriteNoOutput) mount.noOutput = true;

    if (m.type === "cache") {
      const cacheID = m.id ?? cleanPath(rawTarget);
      mount.cacheID = (opts.cacheIDNamespace ?? "") + "/" + cacheID;
      mount.cacheSharing =
        m.sharing === "private"
          ? CacheSharingOpt.PRIVATE
          : m.sharing === "locked"
            ? CacheSharingOpt.LOCKED
            : CacheSharingOpt.SHARED;
    }

    const target = absoluteTarget(ds, rawTarget);
    if (target === "/") throw new ConvertError('invalid mount target "/"', inst.loc.startLine);
    mount.target = target;

    const sub = joinPath("/", m.source ?? "");
    if (sub !== "/") mount.selector = sub;
    else if (m.uid !== undefined || m.gid !== undefined || m.mode !== undefined) {
      // Permissions on a cache directory are applied by creating it first.
      mount.source = file(
        mount.source ?? State.scratch(),
        [{ kind: "mkdir", path: "/cache", mode: m.mode ?? 0o755, owner: { user: { byID: m.uid ?? 0 }, group: { byID: m.gid ?? 0 } } }],
        { description: { "llb.customname": "[internal] setting cache mount permissions" } },
      );
      mount.selector = "/cache";
    }

    // A mount that reads the context contributes a followpath; one that reads
    // another stage records the path against that stage instead.
    if (!m.from) ds.ctxPaths.add(joinPath("/", m.source ?? ""));
    else sourceState?.paths.add(joinPath("/", m.source ?? ""));
    return mount;
  }

  function dispatchCopy(ds: DispatchState, inst: CopyInstruction | AddInstruction) {
    const isAdd = inst.type === "Add";
    const dest = pathRelativeToWorkingDir(ds, expand(ds, inst.dest));
    const chown = inst.chown ? expand(ds, inst.chown) : undefined;
    const chmod = inst.chmod ? expand(ds, inst.chmod) : undefined;
    const owner = chown ? chownFromUser(chown) : undefined;
    const excludes = inst.excludes.map((e) => expand(ds, e));

    let mode: number | undefined;
    let modeStr: string | undefined;
    if (chmod) {
      if (/^[0-7]{1,4}$/.test(chmod)) {
        const parsed = parseInt(chmod, 8);
        if (parsed > 0o7777) {
          throw new ConvertError("invalid chmod parameter: '" + chmod + "'", inst.loc.startLine);
        }
        mode = parsed;
      } else {
        modeStr = chmod;
      }
    }

    // `COPY --from=<stage>` reads from that stage; otherwise from the context.
    let source = buildContext;
    const copyFrom = instructionSources.get(inst)?.[0];
    if (inst.type === "Copy" && inst.from) {
      const src = copyFrom;
      if (!src || !src.dispatched) {
        throw new ConvertError(
          'cannot copy from stage "' + inst.from + '", it needs to be defined before current stage "' + ds.stageName + '"',
          inst.loc.startLine,
        );
      }
      source = src.state;
    }

    // ADD unpacks local archives by default; --unpack overrides either way.
    const unpackLocal = inst.type === "Add" ? (inst.unpack ?? true) : false;

    const actions: FileActionSpec[] = [];
    const commit: string[] = [isAdd ? "ADD" : "COPY"];
    if (inst.parents) commit.push("--parents");
    if (chown) commit.push("--chown=" + chown);
    if (chmod) commit.push("--chmod=" + chmod);

    for (const rawSrc of inst.sources) {
      const src = expand(ds, rawSrc);
      commit.push(src);

      if (isAdd && /^https?:\/\//.test(src)) {
        const filename = urlFilename(src);
        const remote = httpSource(src, {
          filename,
          checksum: inst.type === "Add" ? inst.checksum : undefined,
          metadata: {
            description: {
              "com.docker.dockerfile.v1.command": inst.code || formatInstruction(inst),
              "llb.customname": prefixCommand(ds, uppercaseCmd(inst.code || formatInstruction(inst)), ds.platform),
            },
          },
        });
        actions.push({
          kind: "copy",
          from: remote,
          src: filename,
          dest,
          owner,
          mode,
          modeStr,
          createDestPath: true,
          attemptUnpack: inst.type === "Add" ? (inst.unpack ?? false) : false,
          excludePatterns: excludes.length ? excludes : undefined,
          timestamp: epochNanos(),
        });
        continue;
      }

      if (isAdd && isGitRef(src)) {
        const { remote, ref, subdir } = parseGitRef(src);
        const st = gitSource(remote, ref, {
          keepGitDir: inst.type === "Add" ? inst.keepGitDir : undefined,
          metadata: {
            description: {
              "llb.customname": prefixCommand(ds, uppercaseCmd(inst.code || formatInstruction(inst)), ds.platform),
            },
          },
        });
        actions.push({
          kind: "copy",
          from: st,
          src: subdir || "/",
          dest,
          owner,
          mode,
          modeStr,
          createDestPath: true,
          excludePatterns: excludes.length ? excludes : undefined,
          timestamp: epochNanos(),
        });
        continue;
      }

      const normalized = normalizePathAbs(src);
      let includePatterns: string[] | undefined;
      if (inst.parents) {
        const [parent, pattern] = splitParentsPivot(src);
        includePatterns = [pattern.replace(/^\//, "")];
        actions.push({
          kind: "copy",
          from: source,
          src: normalizePathAbs(parent),
          dest,
          owner,
          mode,
          modeStr,
          followSymlink: true,
          dirCopyContents: true,
          createDestPath: true,
          allowWildcard: true,
          allowEmptyWildcard: true,
          attemptUnpack: unpackLocal,
          includePatterns,
          excludePatterns: excludes.length ? excludes : undefined,
          timestamp: epochNanos(),
        });
      } else {
        actions.push({
          kind: "copy",
          from: source,
          src: normalized,
          dest,
          owner,
          mode,
          modeStr,
          followSymlink: true,
          dirCopyContents: true,
          createDestPath: true,
          allowWildcard: true,
          allowEmptyWildcard: true,
          attemptUnpack: unpackLocal,
          excludePatterns: excludes.length ? excludes : undefined,
          timestamp: epochNanos(),
        });
      }

      if (inst.type === "Copy" && !inst.from) ds.ctxPaths.add(joinPath("/", src));
      else if (isAdd) ds.ctxPaths.add(joinPath("/", src));
      else if (inst.type === "Copy" && inst.from) copyFrom?.paths.add(joinPath("/", src));
    }

    // Heredoc sources become an inline document copied into place.
    for (const hd of inst.heredocs) {
      commit.push("<<" + hd.delimiter);
      const content = hd.chomp ? chompHeredoc(hd.content) : hd.content;
      const inline = file(State.scratch(), [
        { kind: "mkfile", path: hd.delimiter, mode: 0o644, data: new TextEncoder().encode(content) },
      ], { description: { "llb.customname": "[internal] preparing inline document" } });
      actions.push({
        kind: "copy",
        from: inline,
        src: hd.delimiter,
        dest,
        owner,
        mode,
        modeStr,
        createDestPath: true,
        timestamp: epochNanos(),
      });
    }

    commit.push(inst.dest);
    if (actions.length === 0) return;

    const metadata = descriptionFor(ds, inst);
    // `COPY --link` builds the layer against scratch and merges it in, so the
    // result does not depend on the state of the destination filesystem.
    if (caps.mergeOp && inst.link && !chmod) {
      const progressID = "pg-" + ds.stageName + "-" + ds.cmdIndex;
      const copied = file(State.scratch(), actions, {
        description: metadata.description,
        ignoreCache: ds.ignoreCache,
      });
      // BuildKit rewinds the command counter so the copy and the merge share
      // one index, and prefixes the merge's name with LINK inside the bracket.
      ds.cmdIndex -= 1;
      ds.state = merge([ds.state, copied], {
        description: {
          "llb.customname": prefixCommand(ds, "LINK " + uppercaseCmd(inst.code || formatInstruction(inst)), ds.platform),
        },
      });
      void progressID;
    } else {
      ds.state = file(ds.state, actions, {
        description: metadata.description,
        ignoreCache: ds.ignoreCache,
      });
    }
    commitToHistory(ds.image, commit.join(" "), true, true, opts.epoch);
  }

  function epochNanos(): number | undefined {
    return opts.epoch ? Math.floor(opts.epoch.getTime() / 1000) * 1e9 : undefined;
  }

  function pathRelativeToWorkingDir(ds: DispatchState, p: string): string {
    const dir = ds.state.meta.cwd || "/";
    if (p.startsWith("/")) return normalizePathKeepSlash("/", p);
    if (p === "." || p === "") p = "./";
    return normalizePathKeepSlash(dir, p);
  }

  function absoluteTarget(ds: DispatchState, target: string): string {
    if (target === "") return "";
    if (target.startsWith("/")) return cleanPath(target);
    return joinPath("/", ds.state.meta.cwd || "/", target);
  }

  // --- Finalize -------------------------------------------------------------
  const followPaths = normalizeContextPaths(allContextPaths);
  if (followPaths) contextAttrs["local.followpaths"] = JSON.stringify(followPaths);
  if (followPaths) contextCaps[Cap.SourceLocalFollowPaths] = true;

  const finalImage = target.image;
  if (opts.labels && Object.keys(opts.labels).length > 0) {
    finalImage.config.Labels = { ...finalImage.config.Labels, ...opts.labels };
  }
  if (!implicitTarget) {
    finalImage.os = targetPlatform.OS;
    finalImage.architecture = targetPlatform.Architecture;
    if (targetPlatform.Variant) finalImage.variant = targetPlatform.Variant;
    if (targetPlatform.OSVersion) finalImage["os.version"] = targetPlatform.OSVersion;
  }

  const definition = marshalState(target.state);

  return {
    state: target.state,
    image: finalImage,
    definition,
    target: target.stageName,
    stages: states
      .filter((s) => s.stage)
      .map((s) => ({
        name: s.stageName,
        index: s.index,
        baseName: s.baseName,
        platform: s.platform,
        state: s.state,
        image: s.image,
      })),
    usedBuildArgs: [...usedArgs].filter((a) => allArgKeys.has(a) || a in globalArgs).sort(),
    contextPaths: followPaths ?? [],
    warnings,
  };
}

// --- Helpers ----------------------------------------------------------------

/** Rejects `FROM`/`COPY --from` cycles before anything is dispatched. */
function validateNoCircularDependency(states: DispatchState[]): void {
  const visited = new Set<DispatchState>();
  const stack = new Set<DispatchState>();

  const visit = (ds: DispatchState, path: DispatchState[]) => {
    if (stack.has(ds)) {
      const names = [...path, ds].map((s) => s.stageName || s.baseName);
      throw new ConvertError("circular dependency detected on stage: " + names.join(" -> "));
    }
    if (visited.has(ds)) return;
    visited.add(ds);
    stack.add(ds);
    for (const dep of ds.deps) visit(dep, [...path, ds]);
    stack.delete(ds);
  };

  for (const ds of states) visit(ds, []);
}

/** `identity.NewID()`: 25 base-36 characters from 128 random bits. */
function newIdentity(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(25, "0").slice(-25);
}

function envsFromMapOrdered(vars: Record<string, string>): EnvGetter {
  return {
    get: (name) => vars[name],
    keys: () => Object.keys(vars),
  };
}

function uppercaseCmd(str: string): string {
  const i = str.indexOf(" ");
  return i < 0 ? str.toUpperCase() : str.slice(0, i).toUpperCase() + str.slice(i);
}

function networkFor(network: RunInstruction["network"]): NetMode | undefined {
  if (network === "none") return NetMode.NONE;
  if (network === "host") return NetMode.HOST;
  return undefined;
}

/** `|N ARG=v ...` prefix Docker records in image history for RUN steps. */
function runCommandString(
  args: string[],
  buildArgs: { key: string; value?: string }[],
  env: EnvGetter,
): string {
  const entries: string[] = [];
  const index = new Map<string, number>();
  for (const arg of buildArgs) {
    const v = env.get(arg.key) ?? arg.value ?? "";
    const entry = arg.key + "=" + v;
    const at = index.get(arg.key);
    if (at !== undefined) entries[at] = entry;
    else {
      index.set(arg.key, entries.length);
      entries.push(entry);
    }
  }
  const prefix = entries.length > 0 ? ["|" + entries.length, ...entries] : [];
  return [...prefix, ...args].join(" ");
}

function proxyEnvFrom(buildArgs: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  let any = false;
  for (const key of PROXY_ARGS) {
    const v = buildArgs[key];
    if (v !== undefined) {
      out[key.toLowerCase()] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function chownFromUser(user: string): { user?: { byName?: { name: string; input: number }; byID?: number }; group?: { byName?: { name: string; input: number }; byID?: number } } {
  const [u, g] = user.split(":");
  const parse = (v: string | undefined) => {
    if (v === undefined || v === "") return undefined;
    return /^\d+$/.test(v) ? { byID: Number(v) } : { byName: { name: v, input: 0 } };
  };
  // A group is only set when the value actually contains a `:`, matching
  // llb.WithUser; defaulting it would change the FileOp digest.
  const owner = parse(u);
  const group = parse(g);
  return group ? { user: owner, group } : { user: owner };
}

function durationToNanos(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2] ?? "s") {
    case "ns": return n;
    case "us": return n * 1e3;
    case "ms": return n * 1e6;
    case "s": return n * 1e9;
    case "m": return n * 60 * 1e9;
    case "h": return n * 3600 * 1e9;
    default: return n * 1e9;
  }
}

function normalizePort(port: string): string {
  return port.includes("/") ? port : port + "/tcp";
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function cleanPath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (abs) return "/" + joined;
  return joined === "" ? "." : joined;
}

function joinPath(...parts: string[]): string {
  return cleanPath(parts.filter((p) => p !== "").join("/"));
}

function normalizePathAbs(p: string): string {
  const cleaned = cleanPath(p);
  return cleaned.startsWith("/") ? cleaned : "/" + (cleaned === "." ? "" : cleaned);
}

/** `normalizePath(parent, p, keepSlash=true)` from client/llb/fileop.go. */
function normalizePathKeepSlash(parent: string, p: string): string {
  const orig = p;
  let out = cleanPath(p);
  if (!out.startsWith("/")) out = joinPath("/", parent, out);
  if (orig.endsWith("/") && !out.endsWith("/")) out += "/";
  else if (orig.endsWith("/.")) {
    if (out !== "/") out += "/";
    out += ".";
  }
  return out;
}

function normalizeWorkdir(current: string, p: string, os: string): string {
  if (p === "") return current === "" ? "/" : current;
  if (os === "windows") p = p.replace(/\\/g, "/");
  if (p.startsWith("/")) return cleanPath(p);
  return joinPath("/", current || "/", p);
}

function normalizeContextPaths(paths: Set<string>): string[] | null {
  if (paths.size === 0) return null;
  const out: string[] = [];
  for (const p of paths) {
    if (p === "/") return null;
    out.push(joinPath(".", p));
  }
  out.sort();
  return out;
}

function urlFilename(url: string): string {
  try {
    const base = basename(new URL(url).pathname);
    return base === "" || base === "." || base === "/" ? "__unnamed__" : base;
  } catch {
    return "__unnamed__";
  }
}

function isGitRef(src: string): boolean {
  return (
    /^git@/.test(src) ||
    /^(git|ssh):\/\//.test(src) ||
    (/^https?:\/\//.test(src) && /\.git(#.*)?$/.test(src))
  );
}

function parseGitRef(src: string): { remote: string; ref: string; subdir: string } {
  const hash = src.indexOf("#");
  const remote = hash < 0 ? src : src.slice(0, hash);
  const rest = hash < 0 ? "" : src.slice(hash + 1);
  const [ref = "", subdir = ""] = rest.split(":");
  return { remote, ref, subdir };
}

/** `COPY --parents src/./rest` pivots the preserved prefix at `/./`. */
function splitParentsPivot(src: string): [string, string] {
  const i = src.indexOf("/./");
  if (i < 0) return ["/", src];
  return [src.slice(0, i), src.slice(i + 2)];
}

function chompHeredoc(content: string): string {
  return content
    .split("\n")
    .map((l) => l.replace(/^\t+/, ""))
    .join("\n");
}

/** First line of a heredoc, with an ellipsis when more lines follow. */
function summarizeHeredoc(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").trim().split("\n");
  return lines.length > 1 ? lines[0] + "..." : (lines[0] ?? "");
}

/** True when the RUN body is nothing but the heredoc opener. */
function isBareHeredoc(cmdline: string, heredoc: { name: string }): boolean {
  return cmdline.trim() === heredoc.name.trim();
}
