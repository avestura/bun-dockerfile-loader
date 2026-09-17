/**
 * Typed AST for Dockerfiles.
 *
 * The shape mirrors moby/buildkit's `frontend/dockerfile/instructions` commands,
 * but keeps enough raw text (`raw`, `Loc`) that a document can be re-printed
 * byte-for-byte when it has not been edited.
 */

/** 1-based inclusive line range, matching BuildKit's `parser.Node` line numbers. */
export interface Loc {
  startLine: number;
  endLine: number;
}

/** A `--flag` / `--flag=value` token attached to an instruction. */
export interface Flag {
  name: string;
  /** `undefined` for a boolean flag such as `--link`. */
  value?: string;
  raw: string;
}

/** A heredoc body attached to a RUN/COPY/ADD instruction. */
export interface Heredoc {
  /** The full `<<-'EOF'` token as written. */
  name: string;
  /** Delimiter word with quotes stripped. */
  delimiter: string;
  /** `<<-` strips leading tabs from the body and the closing delimiter. */
  chomp: boolean;
  /** Quoted delimiters (`<<'EOF'`) disable variable expansion in the body. */
  expand: boolean;
  content: string;
}

/** A single word of an instruction's arguments, with quoting preserved. */
export interface Word {
  /** Value with outer quoting removed but escapes intact. */
  value: string;
  /** Exactly as written in the source. */
  raw: string;
}

export type ShellOrExec =
  | { kind: "exec"; args: string[] }
  | { kind: "shell"; args: string[] };

export interface BaseInstruction {
  loc: Loc;
  /** Keyword exactly as written, e.g. `from`, `FROM`, `From`. */
  keyword: string;
  flags: Flag[];
  /** Verbatim source text of the whole instruction, continuations included. */
  raw: string;
  /**
   * The logical line with continuations joined and interior comments removed,
   * trimmed. This is BuildKit's `node.Original`, which it uses verbatim for
   * progress names, so re-rendering here would change the displayed command.
   */
  code: string;
  /** Set when the instruction was wrapped in `ONBUILD`. */
  onbuild?: boolean;
}

export interface CommentNode {
  type: "Comment";
  loc: Loc;
  text: string;
  raw: string;
}

export interface EmptyNode {
  type: "Empty";
  loc: Loc;
  raw: string;
}

export interface FromInstruction extends BaseInstruction {
  type: "From";
  image: string;
  stageName?: string;
  platform?: string;
}

export interface RunInstruction extends BaseInstruction {
  type: "Run";
  command: ShellOrExec;
  mounts: MountFlag[];
  network?: "default" | "none" | "host";
  security?: "sandbox" | "insecure";
  heredocs: Heredoc[];
}

export interface MountFlag {
  type: "bind" | "cache" | "tmpfs" | "secret" | "ssh";
  target?: string;
  source?: string;
  from?: string;
  readonly?: boolean;
  sharing?: "shared" | "private" | "locked";
  id?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  required?: boolean;
  size?: number;
  env?: string;
  raw: string;
}

export interface CmdInstruction extends BaseInstruction {
  type: "Cmd";
  command: ShellOrExec;
}

export interface EntrypointInstruction extends BaseInstruction {
  type: "Entrypoint";
  command: ShellOrExec;
}

export interface KeyValuePair {
  key: string;
  value: string;
  /** True when the value was written without quotes and may need expansion. */
  noDelim?: boolean;
}

export interface EnvInstruction extends BaseInstruction {
  type: "Env";
  pairs: KeyValuePair[];
}

export interface LabelInstruction extends BaseInstruction {
  type: "Label";
  pairs: KeyValuePair[];
}

export interface ArgInstruction extends BaseInstruction {
  type: "Arg";
  args: { key: string; value?: string }[];
}

export interface CopyInstruction extends BaseInstruction {
  type: "Copy";
  sources: string[];
  dest: string;
  from?: string;
  chown?: string;
  chmod?: string;
  link?: boolean;
  parents?: boolean;
  excludes: string[];
  heredocs: Heredoc[];
}

export interface AddInstruction extends BaseInstruction {
  type: "Add";
  sources: string[];
  dest: string;
  chown?: string;
  chmod?: string;
  link?: boolean;
  parents?: boolean;
  checksum?: string;
  keepGitDir?: boolean;
  unpack?: boolean;
  excludes: string[];
  heredocs: Heredoc[];
}

export interface WorkdirInstruction extends BaseInstruction {
  type: "Workdir";
  path: string;
}

export interface UserInstruction extends BaseInstruction {
  type: "User";
  user: string;
}

export interface ExposeInstruction extends BaseInstruction {
  type: "Expose";
  ports: string[];
}

export interface VolumeInstruction extends BaseInstruction {
  type: "Volume";
  volumes: string[];
}

export interface StopSignalInstruction extends BaseInstruction {
  type: "StopSignal";
  signal: string;
}

export interface ShellInstruction extends BaseInstruction {
  type: "Shell";
  shell: string[];
}

export interface MaintainerInstruction extends BaseInstruction {
  type: "Maintainer";
  maintainer: string;
}

export interface HealthcheckInstruction extends BaseInstruction {
  type: "Healthcheck";
  /** `NONE` disables an inherited healthcheck. */
  none: boolean;
  test?: string[];
  interval?: string;
  timeout?: string;
  startPeriod?: string;
  startInterval?: string;
  retries?: number;
}

export interface OnbuildInstruction extends BaseInstruction {
  type: "Onbuild";
  /** The wrapped instruction; `null` when it failed to parse. */
  instruction: Instruction | null;
  /** Source text of the wrapped instruction. */
  body: string;
}

/** An instruction BuildKit does not know; retained so round-tripping is lossless. */
export interface UnknownInstruction extends BaseInstruction {
  type: "Unknown";
  args: string;
}

export type Instruction =
  | FromInstruction
  | RunInstruction
  | CmdInstruction
  | EntrypointInstruction
  | EnvInstruction
  | LabelInstruction
  | ArgInstruction
  | CopyInstruction
  | AddInstruction
  | WorkdirInstruction
  | UserInstruction
  | ExposeInstruction
  | VolumeInstruction
  | StopSignalInstruction
  | ShellInstruction
  | MaintainerInstruction
  | HealthcheckInstruction
  | OnbuildInstruction
  | UnknownInstruction;

export type Node = Instruction | CommentNode | EmptyNode;

/** Parser directives (`# syntax=`, `# escape=`, `# check=`) found in the header. */
export interface Directives {
  syntax?: string;
  escape?: string;
  check?: string;
  /** Raw directive lines, in order, so the header can be re-printed. */
  raw: { key: string; value: string; line: number }[];
}

export interface DockerfileAST {
  directives: Directives;
  nodes: Node[];
  /** The escape character in force, `\` unless `# escape=` said otherwise. */
  escapeChar: string;
}

export function isInstruction(node: Node): node is Instruction {
  return node.type !== "Comment" && node.type !== "Empty";
}
