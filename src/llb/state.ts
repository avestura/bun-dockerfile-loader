import { Cap } from "./caps.ts";
import {
  EMPTY_INPUT,
  ROOT_MOUNT,
  SKIP_OUTPUT,
  type CacheSharingOpt,
  type ChownOpt,
  type Definition,
  type FileAction,
  type Input,
  type Meta,
  type Mount,
  type MountType,
  type NetMode,
  type Op,
  type OpMetadata,
  type Platform,
  type SecurityMode,
  type SourceOp,
  CacheSharingOpt as Sharing,
  MountType as MT,
  marshalOp,
} from "./ops.ts";
import { digestOf } from "./digest.ts";

/**
 * A graph builder mirroring `github.com/moby/buildkit/client/llb`.
 *
 * States are immutable: every `with*` returns a new State that shares the same
 * output vertex, which is what lets `ENV`/`WORKDIR` accumulate without
 * producing a build step of their own.
 */

export interface Output {
  vertex: Vertex;
  index: number;
}

export class Vertex {
  constructor(
    readonly inputs: Output[],
    readonly makeOp: (inputs: Input[]) => Op,
    readonly metadata: OpMetadata = {},
  ) {}
}

export const DEFAULT_PLATFORM: Platform = { Architecture: "amd64", OS: "linux" };

export interface StateMeta {
  args: string[];
  env: string[];
  cwd: string;
  user: string;
  hostname: string;
  cgroupParent: string;
  platform: Platform;
  network: NetMode;
  security: SecurityMode;
  extraHosts: { Host: string; IP: string }[];
  validExitCodes?: number[];
}

const EMPTY_META: StateMeta = {
  args: [],
  env: [],
  cwd: "/",
  user: "",
  hostname: "",
  cgroupParent: "",
  platform: DEFAULT_PLATFORM,
  network: 0,
  security: 0,
  extraHosts: [],
};

export class State {
  constructor(
    readonly output: Output | null,
    readonly meta: StateMeta = EMPTY_META,
  ) {}

  /** The empty filesystem. */
  static scratch(): State {
    return new State(null);
  }

  private withMeta(patch: Partial<StateMeta>): State {
    return new State(this.output, { ...this.meta, ...patch });
  }

  dir(cwd: string): State {
    return this.withMeta({ cwd });
  }

  user(user: string): State {
    return this.withMeta({ user });
  }

  hostname(hostname: string): State {
    return this.withMeta({ hostname });
  }

  platform(platform: Platform): State {
    return this.withMeta({ platform });
  }

  network(network: NetMode): State {
    return this.withMeta({ network });
  }

  security(security: SecurityMode): State {
    return this.withMeta({ security });
  }

  /** Replaces the whole environment, in `KEY=VALUE` order. */
  withEnv(env: string[]): State {
    return this.withMeta({ env });
  }

  addEnv(key: string, value: string): State {
    const env = this.meta.env.filter((e) => envKey(e) !== key);
    env.push(key + "=" + value);
    return this.withMeta({ env });
  }

  getEnv(key: string): string | undefined {
    for (let i = this.meta.env.length - 1; i >= 0; i--) {
      const e = this.meta.env[i]!;
      if (envKey(e) === key) return e.slice(key.length + 1);
    }
    return undefined;
  }

  /** Attaches a new vertex's output while keeping this state's metadata. */
  withOutput(output: Output | null): State {
    return new State(output, this.meta);
  }

  marshal(opts: MarshalOptions = {}): MarshaledDefinition {
    return marshalState(this, opts);
  }
}

function envKey(entry: string): string {
  const i = entry.indexOf("=");
  return i < 0 ? entry : entry.slice(0, i);
}

// --- Sources ----------------------------------------------------------------

/**
 * Only image sources carry a platform; BuildKit strips `Op.platform` for every
 * other source kind (`platformSpecificSource` in client/llb/source.go).
 */
function platformSpecificSource(id: string): boolean {
  return id.startsWith("docker-image://") || id.startsWith("oci-layout://");
}

function sourceState(
  source: SourceOp,
  caps: string[],
  meta: Partial<StateMeta>,
  metadata: OpMetadata = {},
): State {
  const base: StateMeta = { ...EMPTY_META, ...meta };
  const platform = platformSpecificSource(source.identifier) ? base.platform : undefined;
  const vertex = new Vertex([], () => ({ inputs: [], source, platform, constraints: {} }), {
    ...metadata,
    caps: { ...capsOf(caps), ...(metadata.caps ?? {}) },
  });
  return new State({ vertex, index: 0 }, base);
}

function capsOf(ids: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = true;
  return out;
}

export interface ImageOptions {
  platform?: Platform;
  /** `default`, `pull` or `local`. */
  resolveMode?: "default" | "pull" | "local";
  layerLimit?: number;
  /** Env/cwd/user carried over from the resolved image config. */
  meta?: Partial<StateMeta>;
  metadata?: OpMetadata;
}

/** `docker-image://` source. `ref` should already be canonical. */
export function image(ref: string, opts: ImageOptions = {}): State {
  const attrs: Record<string, string> = {};
  const caps: string[] = [Cap.SourceImage];
  // `default` is the zero value in Go and emits no attribute at all; only the
  // security-enforced `pull` mode requires the capability.
  if (opts.resolveMode && opts.resolveMode !== "default") {
    attrs["image.resolvemode"] = opts.resolveMode;
    if (opts.resolveMode === "pull") caps.push(Cap.SourceImageResolveMode);
  }
  if (opts.layerLimit !== undefined) {
    attrs["image.layerlimit"] = String(opts.layerLimit);
    caps.push(Cap.SourceImageLayerLimit);
  }
  return sourceState(
    { identifier: "docker-image://" + ref, attrs },
    caps,
    { ...opts.meta, platform: opts.platform ?? opts.meta?.platform ?? DEFAULT_PLATFORM },
    opts.metadata,
  );
}

export interface LocalOptions {
  sessionID?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  followPaths?: string[];
  sharedKeyHint?: string;
  differ?: "none" | "metadata";
  uniqueID?: string;
  metadata?: OpMetadata;
}

/** `local://` source: a directory streamed from the build client. */
export function local(name: string, opts: LocalOptions = {}): State {
  const attrs: Record<string, string> = {};
  const caps: string[] = [Cap.SourceLocal];
  if (opts.sessionID) {
    attrs["local.session"] = opts.sessionID;
    caps.push(Cap.SourceLocalSessionID);
  }
  if (opts.uniqueID) {
    attrs["local.unique"] = opts.uniqueID;
    caps.push(Cap.SourceLocalUnique);
  }
  if (opts.includePatterns?.length) {
    attrs["local.includepattern"] = JSON.stringify(opts.includePatterns);
    caps.push(Cap.SourceLocalIncludePatterns);
  }
  if (opts.excludePatterns?.length) {
    attrs["local.excludepatterns"] = JSON.stringify(opts.excludePatterns);
    caps.push(Cap.SourceLocalExcludePatterns);
  }
  if (opts.followPaths?.length) {
    attrs["local.followpaths"] = JSON.stringify(opts.followPaths);
    caps.push(Cap.SourceLocalFollowPaths);
  }
  if (opts.sharedKeyHint) {
    attrs["local.sharedkeyhint"] = opts.sharedKeyHint;
    caps.push(Cap.SourceLocalSharedKeyHint);
  }
  if (opts.differ) {
    attrs["local.differ"] = opts.differ;
    caps.push(Cap.SourceLocalDiffer);
  }
  return sourceState({ identifier: "local://" + name, attrs }, caps, {}, opts.metadata);
}

export interface GitOptions {
  keepGitDir?: boolean;
  fullURL?: string;
  metadata?: OpMetadata;
}

export function git(remote: string, ref: string, opts: GitOptions = {}): State {
  const attrs: Record<string, string> = {};
  const caps: string[] = [Cap.SourceGit];
  if (opts.keepGitDir) {
    attrs["git.keepgitdir"] = "true";
    caps.push(Cap.SourceGitKeepDir);
  }
  if (opts.fullURL) {
    attrs["git.fullurl"] = opts.fullURL;
    caps.push(Cap.SourceGitFullURL);
  }
  const id = "git://" + remote + (ref ? "#" + ref : "");
  return sourceState({ identifier: id, attrs }, caps, {}, opts.metadata);
}

export interface HTTPOptions {
  filename?: string;
  checksum?: string;
  perm?: number;
  uid?: number;
  gid?: number;
  metadata?: OpMetadata;
}

export function http(url: string, opts: HTTPOptions = {}): State {
  const attrs: Record<string, string> = {};
  const caps: string[] = [Cap.SourceHTTP];
  if (opts.checksum) {
    attrs["http.checksum"] = opts.checksum;
    caps.push(Cap.SourceHTTPChecksum);
  }
  if (opts.filename) attrs["http.filename"] = opts.filename;
  if (opts.perm !== undefined) {
    attrs["http.perm"] = "0" + opts.perm.toString(8);
    caps.push(Cap.SourceHTTPPerm);
  }
  if (opts.uid !== undefined) {
    attrs["http.uid"] = String(opts.uid);
    caps.push(Cap.SourceHTTPUIDGID);
  }
  if (opts.gid !== undefined) attrs["http.gid"] = String(opts.gid);
  return sourceState({ identifier: url, attrs }, caps, {}, opts.metadata);
}

// --- Exec -------------------------------------------------------------------

export interface RunMount {
  target: string;
  /** Omitted for a tmpfs or cache mount with no backing state. */
  source?: State;
  selector?: string;
  readonly?: boolean;
  /** Suppresses this mount's output even when it is writable. */
  noOutput?: boolean;
  cacheID?: string;
  cacheSharing?: CacheSharingOpt;
  tmpfs?: boolean;
  tmpfsSize?: number;
  secret?: { id: string; uid?: number; gid?: number; mode?: number; optional?: boolean };
  ssh?: { id: string; uid?: number; gid?: number; mode?: number; optional?: boolean };
}

export interface RunOptions {
  args: string[];
  mounts?: RunMount[];
  secretEnv?: { id: string; name: string; optional?: boolean }[];
  network?: NetMode;
  security?: SecurityMode;
  /** Custom progress description, shown by buildctl as the step name. */
  description?: Record<string, string>;
  ignoreCache?: boolean;
  /**
   * When true, the daemon injects the default PATH itself
   * (`exec.meta.setsdefaultpath`); otherwise a PATH is baked into the env.
   */
  daemonSetsDefaultPath?: boolean;
}

export interface ExecResult {
  /** The root filesystem after the command ran. */
  root: State;
  /** Output states for each writable mount, keyed by target. */
  mounts: Map<string, State>;
}

export const DEFAULT_PATH_ENV =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Builds an `ExecOp` on top of `base`, returning the resulting states. */
export function run(base: State, opts: RunOptions): ExecResult {
  const caps: string[] = [Cap.ExecMetaBase];
  const all = opts.mounts ?? [];
  // Secrets and SSH sockets live in separate lists in BuildKit and are appended
  // after the sorted filesystem mounts, so they must not take part in the sort.
  const secretMounts = all.filter((m) => m.secret);
  const sshMounts = all.filter((m) => m.ssh);
  const rootMount: RunMount = { target: ROOT_MOUNT, source: base };
  const mounts = [rootMount, ...all.filter((m) => !m.secret && !m.ssh)].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // An unnamed SSH socket gets BuildKit's positional default target.
  const sshTargets = sshMounts.map((m, i) => m.target || "/run/buildkit/ssh_agent." + i);

  let env = base.meta.env;
  if (sshMounts.length > 0 && !env.some((e) => envKey(e) === "SSH_AUTH_SOCK")) {
    env = [...env, "SSH_AUTH_SOCK=" + sshTargets[0]];
  }
  if (opts.daemonSetsDefaultPath === false && base.meta.platform.OS !== "windows") {
    if (!env.some((e) => envKey(e) === "PATH")) env = [...env, "PATH=" + DEFAULT_PATH_ENV];
  } else if (opts.daemonSetsDefaultPath !== false) {
    caps.push(Cap.ExecMetaSetsDefaultPath);
  }

  const network = opts.network ?? base.meta.network;
  const security = opts.security ?? base.meta.security;
  if (network !== 0) caps.push(Cap.ExecMetaNetwork);
  if (security !== 0) caps.push(Cap.ExecMetaSecurity);

  const meta: Meta = {
    args: opts.args,
    env,
    cwd: base.meta.cwd,
    user: base.meta.user,
    hostname: base.meta.hostname,
    cgroupParent: base.meta.cgroupParent,
    removeMountStubsRecursive: true,
    validExitCodes: base.meta.validExitCodes,
    extraHosts: base.meta.extraHosts.length ? base.meta.extraHosts : undefined,
  };

  // Inputs are deduplicated by (vertex, index) exactly as BuildKit does.
  const inputs: Output[] = [];
  const inputIndexOf = (out: Output): number => {
    const found = inputs.findIndex((i) => i.vertex === out.vertex && i.index === out.index);
    if (found >= 0) return found;
    inputs.push(out);
    return inputs.length - 1;
  };

  const pbMounts: Mount[] = [];
  const outputTargets: string[] = [];
  let outIndex = 0;

  for (const m of mounts) {
    let inputIndex = EMPTY_INPUT;
    if (m.source && m.source.output) {
      if (m.tmpfs) throw new Error("tmpfs mounts must use scratch");
      inputIndex = inputIndexOf(m.source.output);
    }

    let outputIndex = SKIP_OUTPUT;
    if (!m.noOutput && !m.readonly && !m.cacheID && !m.tmpfs) {
      outputIndex = outIndex++;
      outputTargets.push(m.target);
    }

    const pm: Mount = {
      input: inputIndex,
      dest: m.target,
      readonly: m.readonly ?? false,
      output: outputIndex,
      selector: m.selector ?? "",
      mountType: MT.BIND,
    };
    if (m.selector) caps.push(Cap.ExecMountSelector);
    if (m.cacheID) {
      pm.mountType = MT.CACHE;
      pm.cacheOpt = { ID: m.cacheID, sharing: m.cacheSharing ?? Sharing.SHARED };
      caps.push(Cap.ExecMountCache, Cap.ExecMountCacheSharing);
    } else if (m.tmpfs) {
      pm.mountType = MT.TMPFS;
      pm.TmpfsOpt = { size: m.tmpfsSize ?? 0 };
      caps.push(Cap.ExecMountTmpfs);
      if (m.tmpfsSize) caps.push(Cap.ExecMountTmpfsSize);
    } else if (m.source) {
      caps.push(Cap.ExecMountBind);
    }
    pbMounts.push(pm);
  }

  // Secret and SSH mounts carry no output index at all, not even SkipOutput.
  for (const m of secretMounts) {
    caps.push(Cap.ExecMountSecret);
    pbMounts.push({
      input: EMPTY_INPUT,
      dest: m.target,
      output: 0,
      mountType: MT.SECRET,
      secretOpt: {
        ID: m.secret!.id,
        uid: m.secret!.uid ?? 0,
        gid: m.secret!.gid ?? 0,
        mode: m.secret!.mode ?? 0o400,
        optional: m.secret!.optional ?? false,
      },
    });
  }
  sshMounts.forEach((m, i) => {
    caps.push(Cap.ExecMountSSH);
    pbMounts.push({
      input: EMPTY_INPUT,
      dest: sshTargets[i]!,
      output: 0,
      mountType: MT.SSH,
      SSHOpt: {
        ID: m.ssh!.id,
        uid: m.ssh!.uid ?? 0,
        gid: m.ssh!.gid ?? 0,
        mode: m.ssh!.mode ?? 0o600,
        optional: m.ssh!.optional ?? false,
      },
    });
  });

  if (opts.secretEnv?.length) caps.push(Cap.ExecMountSecret, Cap.ExecSecretEnv);

  const metadata: OpMetadata = { caps: capsOf(caps) };
  if (opts.description) metadata.description = opts.description;
  if (opts.ignoreCache) metadata.ignore_cache = true;

  const platform = base.meta.platform;
  const vertex = new Vertex(
    inputs,
    (resolved) => ({
      inputs: resolved,
      exec: {
        meta,
        mounts: pbMounts,
        network,
        security,
        secretenv: opts.secretEnv?.map((s) => ({ ID: s.id, name: s.name, optional: s.optional })),
      },
      platform,
      constraints: {},
    }),
    metadata,
  );

  const outputs = new Map<string, State>();
  outputTargets.forEach((target, i) => {
    outputs.set(target, base.withOutput({ vertex, index: i }));
  });

  const rootIdx = outputTargets.indexOf(ROOT_MOUNT);
  const root = rootIdx >= 0 ? base.withOutput({ vertex, index: rootIdx }) : base;
  return { root, mounts: outputs };
}

// --- File operations --------------------------------------------------------

export type FileActionSpec =
  | {
      kind: "copy";
      /** Filesystem the files are read from. */
      from: State;
      src: string;
      dest: string;
      owner?: ChownOpt;
      mode?: number;
      modeStr?: string;
      followSymlink?: boolean;
      dirCopyContents?: boolean;
      attemptUnpack?: boolean;
      createDestPath?: boolean;
      allowWildcard?: boolean;
      allowEmptyWildcard?: boolean;
      includePatterns?: string[];
      excludePatterns?: string[];
      timestamp?: number;
    }
  | { kind: "mkdir"; path: string; mode: number; makeParents?: boolean; owner?: ChownOpt; timestamp?: number }
  | { kind: "mkfile"; path: string; mode: number; data: Uint8Array; owner?: ChownOpt; timestamp?: number }
  | { kind: "rm"; path: string; allowNotFound?: boolean; allowWildcard?: boolean }
  | { kind: "symlink"; oldpath: string; newpath: string; owner?: ChownOpt; timestamp?: number };

export interface FileOptions {
  description?: Record<string, string>;
  ignoreCache?: boolean;
}

/**
 * Chains file actions on top of `base`.
 *
 * Each action's `input` is the previous action's result, encoded the way
 * BuildKit does it: indices below `inputs.length` reference real inputs, and
 * indices at or above it reference earlier actions in the same FileOp.
 */
/** `path.Clean`, kept here so FileOp paths match Go's `path` package exactly. */
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

/** `normalizePath` from client/llb/fileop.go. */
function normalizePath(parent: string, p: string, keepSlash: boolean): string {
  const orig = p;
  let out = cleanPath(p);
  if (!out.startsWith("/")) out = cleanPath("/" + parent + "/" + out);
  if (keepSlash) {
    if (orig.endsWith("/") && !out.endsWith("/")) out += "/";
    else if (orig.endsWith("/.")) {
      if (out !== "/") out += "/";
      out += ".";
    }
  }
  return out;
}

/** `fileActionCopy.sourcePath`: relative sources resolve against the source state. */
function copySourcePath(src: string, sourceDir: string): string {
  const p = cleanPath(src);
  if (p.startsWith("/")) return p;
  return cleanPath("/" + (sourceDir || "/") + "/" + p);
}

export function file(base: State, actions: FileActionSpec[], opts: FileOptions = {}): State {
  if (actions.length === 0) return base;
  // Every action in a chain resolves relative paths against the state the
  // FileOp is bound to, not against the previous action's result.
  const parent = base.meta.cwd;

  const caps: string[] = [Cap.FileBase];
  const inputs: Output[] = [];
  const inputIndexOf = (out: Output): number => {
    const found = inputs.findIndex((i) => i.vertex === out.vertex && i.index === out.index);
    if (found >= 0) return found;
    inputs.push(out);
    return inputs.length - 1;
  };

  const baseIndex = base.output ? inputIndexOf(base.output) : EMPTY_INPUT;

  // Placeholders resolved once every input is known.
  const pending: {
    input: number | { relative: number };
    secondaryInput: number | { relative: number };
    make: () => FileAction["copy" | "mkdir" | "mkfile" | "rm" | "symlink"];
    key: "copy" | "mkdir" | "mkfile" | "rm" | "symlink";
  }[] = [];

  actions.forEach((action, i) => {
    const input: number | { relative: number } = i === 0 ? baseIndex : { relative: i - 1 };
    let secondaryInput: number | { relative: number } = EMPTY_INPUT;

    switch (action.kind) {
      case "copy": {
        secondaryInput = action.from.output ? inputIndexOf(action.from.output) : EMPTY_INPUT;
        if (action.includePatterns?.length || action.excludePatterns?.length) {
          caps.push(Cap.FileCopyIncludeExcludePatterns);
        }
        if (action.modeStr) caps.push(Cap.FileCopyModeStringFormat);
        pending.push({
          input,
          secondaryInput,
          key: "copy",
          make: () => ({
            src: copySourcePath(action.src, action.from.meta.cwd),
            dest: normalizePath(parent, action.dest, true),
            owner: action.owner,
            mode: action.modeStr ? 0 : (action.mode ?? -1),
            modeStr: action.modeStr,
            followSymlink: action.followSymlink,
            dirCopyContents: action.dirCopyContents,
            attemptUnpackDockerCompatibility: action.attemptUnpack,
            createDestPath: action.createDestPath,
            allowWildcard: action.allowWildcard,
            allowEmptyWildcard: action.allowEmptyWildcard,
            include_patterns: action.includePatterns,
            exclude_patterns: action.excludePatterns,
            timestamp: action.timestamp ?? -1,
          }),
        });
        break;
      }
      case "mkdir":
        pending.push({
          input,
          secondaryInput,
          key: "mkdir",
          make: () => ({
            path: normalizePath(parent, action.path, false),
            mode: action.mode & 0o777,
            makeParents: action.makeParents,
            owner: action.owner,
            timestamp: action.timestamp ?? -1,
          }),
        });
        break;
      case "mkfile":
        pending.push({
          input,
          secondaryInput,
          key: "mkfile",
          make: () => ({
            path: normalizePath(parent, action.path, false),
            mode: action.mode & 0o777,
            data: action.data,
            owner: action.owner,
            timestamp: action.timestamp ?? -1,
          }),
        });
        break;
      case "rm":
        if (action.allowWildcard) caps.push(Cap.FileRmWildcard);
        pending.push({
          input,
          secondaryInput,
          key: "rm",
          make: () => ({
            path: normalizePath(parent, action.path, false),
            allowNotFound: action.allowNotFound,
            allowWildcard: action.allowWildcard,
          }),
        });
        break;
      case "symlink":
        caps.push(Cap.FileSymlinkCreate);
        pending.push({
          input,
          secondaryInput,
          key: "symlink",
          make: () => ({
            oldpath: action.oldpath,
            newpath: normalizePath(parent, action.newpath, true),
            owner: action.owner,
            timestamp: action.timestamp ?? -1,
          }),
        });
        break;
    }
  });

  const metadata: OpMetadata = { caps: capsOf(caps) };
  if (opts.description) metadata.description = opts.description;
  if (opts.ignoreCache) metadata.ignore_cache = true;

  const vertex = new Vertex(
    inputs,
    (resolved) => {
      const n = resolved.length;
      const resolveIdx = (v: number | { relative: number }) =>
        typeof v === "number" ? v : n + v.relative;
      const fileActions: FileAction[] = pending.map((p, i) => ({
        input: resolveIdx(p.input),
        secondaryInput: resolveIdx(p.secondaryInput),
        output: i + 1 === pending.length ? 0 : SKIP_OUTPUT,
        [p.key]: p.make(),
      }));
      // FileOp is deliberately not platform-specific.
      return { inputs: resolved, file: { actions: fileActions }, constraints: {} };
    },
    metadata,
  );

  return base.withOutput({ vertex, index: 0 });
}

/** MergeOp: unions several filesystems. */
export function merge(states: State[], opts: FileOptions = {}): State {
  const withOutput = states.filter((s) => s.output);
  if (withOutput.length === 0) return State.scratch();
  if (withOutput.length === 1) return withOutput[0]!;
  const inputs = withOutput.map((s) => s.output!);
  const metadata: OpMetadata = { caps: capsOf([Cap.MergeOp]) };
  if (opts.description) metadata.description = opts.description;
  const vertex = new Vertex(
    inputs,
    (resolved) => ({
      inputs: resolved,
      merge: { inputs: resolved.map((_, i) => ({ input: i })) },
      // MergeOp, like FileOp, is not platform specific.
      constraints: {},
    }),
    metadata,
  );
  return withOutput[withOutput.length - 1]!.withOutput({ vertex, index: 0 });
}

/** DiffOp: the changes `upper` makes relative to `lower`. */
export function diff(lower: State, upper: State, opts: FileOptions = {}): State {
  if (!upper.output) return State.scratch();
  if (!lower.output) return upper;
  const inputs = [lower.output, upper.output];
  const metadata: OpMetadata = { caps: capsOf([Cap.DiffOp]) };
  if (opts.description) metadata.description = opts.description;
  const vertex = new Vertex(
    inputs,
    (resolved) => ({
      inputs: resolved,
      diff: { lower: { input: 0 }, upper: { input: 1 } },
      // DiffOp, like FileOp, is not platform specific.
      constraints: {},
    }),
    metadata,
  );
  return upper.withOutput({ vertex, index: 0 });
}

// --- Marshaling -------------------------------------------------------------

export interface MarshalOptions {
  /** Attached to `Definition.Source` for `--print` style source maps. */
  source?: Definition["Source"];
}

/** One vertex of a marshaled definition, retained so it can be dumped as JSON. */
export interface LLBOp {
  digest: string;
  op: Op;
  metadata?: OpMetadata;
}

export interface MarshaledDefinition extends Definition {
  /** Decoded vertices in `def` order, for `dumpLLB`. */
  ops: LLBOp[];
}

/**
 * Walks the graph depth-first, inputs before dependents, exactly as
 * `client/llb.marshal` does, then appends the synthetic terminal Op that names
 * the result.
 */
export function marshalState(state: State, opts: MarshalOptions = {}): MarshaledDefinition {
  const def: Uint8Array[] = [];
  const metadata: Record<string, OpMetadata> = {};
  const ops: LLBOp[] = [];

  if (!state.output) return { def, metadata, Source: opts.source, ops };

  const visited = new Map<Vertex, string>();
  const emitted = new Set<string>();

  const visit = (vertex: Vertex): string => {
    const cached = visited.get(vertex);
    if (cached) return cached;

    const inputs: Input[] = vertex.inputs.map((out) => ({
      digest: visit(out.vertex),
      index: out.index,
    }));

    const op = vertex.makeOp(inputs);
    const bytes = marshalOp(op);
    const dgst = digestOf(bytes);
    visited.set(vertex, dgst);

    if (hasMetadata(vertex.metadata)) {
      metadata[dgst] = mergeMetadata(metadata[dgst], vertex.metadata);
    }
    if (!emitted.has(dgst)) {
      def.push(bytes);
      ops.push({ digest: dgst, op });
      emitted.add(dgst);
    }
    return dgst;
  };

  const head = visit(state.output.vertex);

  const terminalOp: Op = { inputs: [{ digest: head, index: state.output.index }] };
  const terminal = marshalOp(terminalOp);
  def.push(terminal);
  const terminalDigest = digestOf(terminal);
  ops.push({ digest: terminalDigest, op: terminalOp });

  const caps: Record<string, boolean> = { [Cap.Constraints]: true, [Cap.Platform]: true };
  for (const m of Object.values(metadata)) {
    if (m.ignore_cache) caps[Cap.MetaIgnoreCache] = true;
    if (m.description) caps[Cap.MetaDescription] = true;
    if (m.export_cache) caps[Cap.MetaExportCache] = true;
  }
  metadata[terminalDigest] = mergeMetadata(metadata[terminalDigest], { caps });

  for (const entry of ops) entry.metadata = metadata[entry.digest];
  return { def, metadata, Source: opts.source, ops };
}

function hasMetadata(m: OpMetadata): boolean {
  return (
    m.ignore_cache === true ||
    m.description !== undefined ||
    m.export_cache !== undefined ||
    (m.caps !== undefined && Object.keys(m.caps).length > 0) ||
    m.progress_group !== undefined ||
    m.linux_resources !== undefined
  );
}

function mergeMetadata(base: OpMetadata | undefined, next: OpMetadata): OpMetadata {
  const out: OpMetadata = { ...base };
  if (next.ignore_cache) out.ignore_cache = true;
  if (next.description) out.description = { ...out.description, ...next.description };
  if (next.export_cache) out.export_cache = next.export_cache;
  if (next.caps) out.caps = { ...out.caps, ...next.caps };
  if (next.progress_group) out.progress_group = next.progress_group;
  if (next.linux_resources) out.linux_resources = next.linux_resources;
  return out;
}

export { digestOf };
