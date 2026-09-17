import type {
  AddInstruction,
  ArgInstruction,
  CmdInstruction,
  CommentNode,
  CopyInstruction,
  EmptyNode,
  EntrypointInstruction,
  EnvInstruction,
  ExposeInstruction,
  FromInstruction,
  HealthcheckInstruction,
  Heredoc,
  LabelInstruction,
  MountFlag,
  RunInstruction,
  ShellInstruction,
  ShellOrExec,
  StopSignalInstruction,
  UserInstruction,
  VolumeInstruction,
  WorkdirInstruction,
} from "../parser/ast.ts";

/**
 * Constructors for synthetic AST nodes.
 *
 * Synthetic nodes carry `raw: ""` and `loc: {0,0}`, which is how the printer
 * knows to render them from their fields rather than echo source text.
 */

const NEW = { loc: { startLine: 0, endLine: 0 }, raw: "", code: "", flags: [] as never[] };

function cmdOf(command: string | string[]): ShellOrExec {
  return Array.isArray(command) ? { kind: "exec", args: command } : { kind: "shell", args: [command] };
}

export function from(image: string, opts: { as?: string; platform?: string } = {}): FromInstruction {
  return { ...NEW, flags: [], type: "From", keyword: "FROM", image, stageName: opts.as, platform: opts.platform };
}

export function run(
  command: string | string[],
  opts: {
    mounts?: MountFlag[];
    network?: RunInstruction["network"];
    security?: RunInstruction["security"];
    heredocs?: Heredoc[];
  } = {},
): RunInstruction {
  return {
    ...NEW,
    flags: [],
    type: "Run",
    keyword: "RUN",
    command: cmdOf(command),
    mounts: opts.mounts ?? [],
    network: opts.network,
    security: opts.security,
    heredocs: opts.heredocs ?? [],
  };
}

export function cmd(command: string | string[]): CmdInstruction {
  return { ...NEW, flags: [], type: "Cmd", keyword: "CMD", command: cmdOf(command) };
}

export function entrypoint(command: string | string[]): EntrypointInstruction {
  return { ...NEW, flags: [], type: "Entrypoint", keyword: "ENTRYPOINT", command: cmdOf(command) };
}

export function env(pairs: Record<string, string>): EnvInstruction {
  return {
    ...NEW,
    flags: [],
    type: "Env",
    keyword: "ENV",
    pairs: Object.entries(pairs).map(([key, value]) => ({ key, value })),
  };
}

export function label(pairs: Record<string, string>): LabelInstruction {
  return {
    ...NEW,
    flags: [],
    type: "Label",
    keyword: "LABEL",
    pairs: Object.entries(pairs).map(([key, value]) => ({ key, value })),
  };
}

export function arg(key: string, value?: string): ArgInstruction {
  return { ...NEW, flags: [], type: "Arg", keyword: "ARG", args: [{ key, value }] };
}

export function copy(
  sources: string[],
  dest: string,
  opts: {
    from?: string;
    chown?: string;
    chmod?: string;
    link?: boolean;
    parents?: boolean;
    excludes?: string[];
    heredocs?: Heredoc[];
  } = {},
): CopyInstruction {
  return {
    ...NEW,
    flags: [],
    type: "Copy",
    keyword: "COPY",
    sources,
    dest,
    from: opts.from,
    chown: opts.chown,
    chmod: opts.chmod,
    link: opts.link,
    parents: opts.parents,
    excludes: opts.excludes ?? [],
    heredocs: opts.heredocs ?? [],
  };
}

export function add(
  sources: string[],
  dest: string,
  opts: {
    chown?: string;
    chmod?: string;
    link?: boolean;
    parents?: boolean;
    checksum?: string;
    keepGitDir?: boolean;
    unpack?: boolean;
    excludes?: string[];
    heredocs?: Heredoc[];
  } = {},
): AddInstruction {
  return {
    ...NEW,
    flags: [],
    type: "Add",
    keyword: "ADD",
    sources,
    dest,
    chown: opts.chown,
    chmod: opts.chmod,
    link: opts.link,
    parents: opts.parents,
    checksum: opts.checksum,
    keepGitDir: opts.keepGitDir,
    unpack: opts.unpack,
    excludes: opts.excludes ?? [],
    heredocs: opts.heredocs ?? [],
  };
}

export function workdir(path: string): WorkdirInstruction {
  return { ...NEW, flags: [], type: "Workdir", keyword: "WORKDIR", path };
}

export function user(name: string): UserInstruction {
  return { ...NEW, flags: [], type: "User", keyword: "USER", user: name };
}

export function expose(...ports: string[]): ExposeInstruction {
  return { ...NEW, flags: [], type: "Expose", keyword: "EXPOSE", ports };
}

export function volume(...volumes: string[]): VolumeInstruction {
  return { ...NEW, flags: [], type: "Volume", keyword: "VOLUME", volumes };
}

export function stopSignal(signal: string): StopSignalInstruction {
  return { ...NEW, flags: [], type: "StopSignal", keyword: "STOPSIGNAL", signal };
}

export function shell(...argv: string[]): ShellInstruction {
  return { ...NEW, flags: [], type: "Shell", keyword: "SHELL", shell: argv };
}

export function healthcheck(
  opts:
    | { none: true }
    | {
        none?: false;
        test: string[];
        interval?: string;
        timeout?: string;
        startPeriod?: string;
        startInterval?: string;
        retries?: number;
      },
): HealthcheckInstruction {
  if (opts.none) return { ...NEW, flags: [], type: "Healthcheck", keyword: "HEALTHCHECK", none: true };
  return { ...NEW, flags: [], type: "Healthcheck", keyword: "HEALTHCHECK", none: false, ...opts };
}

export function comment(text: string): CommentNode {
  return { type: "Comment", loc: { startLine: 0, endLine: 0 }, text, raw: "" };
}

export function blank(): EmptyNode {
  return { type: "Empty", loc: { startLine: 0, endLine: 0 }, raw: "" };
}

/** Builds a `--mount=` flag value and its parsed form together. */
export function mount(spec: Omit<MountFlag, "raw">): MountFlag {
  const parts: string[] = ["type=" + spec.type];
  if (spec.target) parts.push("target=" + spec.target);
  if (spec.source) parts.push("source=" + spec.source);
  if (spec.from) parts.push("from=" + spec.from);
  if (spec.id) parts.push("id=" + spec.id);
  if (spec.sharing) parts.push("sharing=" + spec.sharing);
  if (spec.readonly !== undefined) parts.push("readonly=" + String(spec.readonly));
  if (spec.mode !== undefined) parts.push("mode=0" + spec.mode.toString(8));
  if (spec.uid !== undefined) parts.push("uid=" + spec.uid);
  if (spec.gid !== undefined) parts.push("gid=" + spec.gid);
  if (spec.required !== undefined) parts.push("required=" + String(spec.required));
  if (spec.size !== undefined) parts.push("size=" + spec.size);
  if (spec.env) parts.push("env=" + spec.env);
  return { ...spec, raw: parts.join(",") };
}

/** Builds a heredoc body for `RUN <<EOF` / `COPY <<EOF target`. */
export function heredoc(
  delimiter: string,
  content: string,
  opts: { chomp?: boolean; expand?: boolean } = {},
): Heredoc {
  const expand = opts.expand ?? true;
  const chomp = opts.chomp ?? false;
  const name = "<<" + (chomp ? "-" : "") + (expand ? delimiter : "'" + delimiter + "'");
  return { name, delimiter, chomp, expand, content: content.endsWith("\n") ? content : content + "\n" };
}
