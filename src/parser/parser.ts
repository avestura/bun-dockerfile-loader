import type {
  AddInstruction,
  ArgInstruction,
  CmdInstruction,
  CopyInstruction,
  DockerfileAST,
  EntrypointInstruction,
  EnvInstruction,
  Flag,
  FromInstruction,
  Heredoc,
  HealthcheckInstruction,
  Instruction,
  KeyValuePair,
  LabelInstruction,
  Loc,
  MaintainerInstruction,
  MountFlag,
  Node,
  OnbuildInstruction,
  RunInstruction,
  ShellInstruction,
  ShellOrExec,
  StopSignalInstruction,
  UnknownInstruction,
  UserInstruction,
  VolumeInstruction,
  WorkdirInstruction,
  ExposeInstruction,
} from "./ast.ts";
import { lex, splitWords, type LexedHeredoc, type LexWarning } from "./lexer.ts";

export class DockerfileParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message + " (line " + line + ")");
    this.name = "DockerfileParseError";
  }
}

export interface ParseResult {
  ast: DockerfileAST;
  warnings: LexWarning[];
}

const KNOWN_COMMANDS = new Set([
  "add",
  "arg",
  "cmd",
  "copy",
  "entrypoint",
  "env",
  "expose",
  "from",
  "healthcheck",
  "label",
  "maintainer",
  "onbuild",
  "run",
  "shell",
  "stopsignal",
  "user",
  "volume",
  "workdir",
]);

/** Splits `KEYWORD --flag=v rest...` into its three parts, honouring quotes. */
function splitCommand(
  line: string,
  escapeChar: string,
): { keyword: string; flags: Flag[]; rest: string } {
  const m = /^(\S+)(\s+([\s\S]*))?$/.exec(line);
  if (!m) return { keyword: line, flags: [], rest: "" };
  const keyword = m[1]!;
  let rest = (m[3] ?? "").trimStart();
  const flags: Flag[] = [];

  for (;;) {
    if (!rest.startsWith("--")) break;
    const word = readWord(rest, escapeChar);
    if (word === null) break;
    const raw = rest.slice(0, word.end);
    if (raw === "--") {
      rest = rest.slice(word.end).trimStart();
      break;
    }
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    flags.push(
      eq < 0
        ? { name: body, raw }
        : { name: body.slice(0, eq), value: stripQuotes(body.slice(eq + 1)), raw },
    );
    rest = rest.slice(word.end).trimStart();
  }
  return { keyword, flags, rest: rest.trim() };
}

/** Finds the end offset of the first whitespace-delimited word, quotes aware. */
function readWord(s: string, escapeChar: string): { end: number } | null {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === escapeChar && i + 1 < s.length) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") return { end: i };
  }
  return { end: s.length };
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const f = s[0];
    if ((f === '"' || f === "'") && s.endsWith(f)) return s.slice(1, -1);
  }
  return s;
}

/** `parseMaybeJSON`: a bracketed JSON string array, else the raw remainder. */
function parseMaybeJSON(rest: string): ShellOrExec {
  const json = tryJSONArray(rest);
  if (json) return { kind: "exec", args: json };
  return { kind: "shell", args: [rest] };
}

/** `parseMaybeJSONToList`: a JSON string array, else a whitespace split. */
function parseMaybeJSONToList(rest: string): string[] {
  const json = tryJSONArray(rest);
  if (json) return json;
  return rest.split(/\s+/).filter((s) => s.length > 0);
}

function tryJSONArray(rest: string): string[] | null {
  const trimmed = rest.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v) => typeof v === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/** `parseEnv`/`parseLabel`: `k=v k2=v2`, or the legacy `k v...` single pair. */
function parseKeyValues(rest: string, escapeChar: string, line: number, what: string): KeyValuePair[] {
  const words = splitWords(rest, escapeChar);
  if (words.length === 0) throw new DockerfileParseError(what + " requires at least one argument", line);

  // Legacy form: no `=` in the first token means "key rest-of-line".
  if (!words[0]!.includes("=")) {
    const key = words[0]!;
    if (words.length < 2) {
      throw new DockerfileParseError(what + " must have two arguments in the legacy form", line);
    }
    const idx = rest.indexOf(words[0]!) + words[0]!.length;
    return [{ key: stripQuotes(key), value: rest.slice(idx).trim(), noDelim: true }];
  }

  const pairs: KeyValuePair[] = [];
  for (const word of words) {
    const eq = word.indexOf("=");
    if (eq < 0) throw new DockerfileParseError("syntax error in " + what + ": " + word, line);
    pairs.push({ key: stripQuotes(word.slice(0, eq)), value: stripQuotes(word.slice(eq + 1)) });
  }
  return pairs;
}

function toHeredocs(lexed: LexedHeredoc[]): Heredoc[] {
  return lexed.map((h) => ({ ...h }));
}

function flagValue(flags: Flag[], name: string): string | undefined {
  for (let i = flags.length - 1; i >= 0; i--) {
    if (flags[i]!.name === name) return flags[i]!.value;
  }
  return undefined;
}

function flagPresent(flags: Flag[], name: string): boolean {
  return flags.some((f) => f.name === name);
}

/** Boolean flags accept `--link` and `--link=true|false`. */
function flagBool(flags: Flag[], name: string): boolean | undefined {
  const f = flags.findLast((x) => x.name === name);
  if (!f) return undefined;
  if (f.value === undefined || f.value === "") return true;
  return f.value.toLowerCase() === "true" || f.value === "1";
}

function parseMount(raw: string, line: number): MountFlag {
  const mount: MountFlag = { type: "bind", raw };
  const fields = splitCSVFields(raw);
  for (const field of fields) {
    const eq = field.indexOf("=");
    const key = (eq < 0 ? field : field.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? undefined : stripQuotes(field.slice(eq + 1));
    switch (key) {
      case "type": {
        const t = (value ?? "").toLowerCase();
        if (t !== "bind" && t !== "cache" && t !== "tmpfs" && t !== "secret" && t !== "ssh") {
          throw new DockerfileParseError("unsupported mount type: " + t, line);
        }
        mount.type = t;
        break;
      }
      case "target":
      case "dst":
      case "destination":
        mount.target = value;
        break;
      case "source":
      case "src":
        mount.source = value;
        break;
      case "from":
        mount.from = value;
        break;
      case "readonly":
      case "ro":
        mount.readonly = value === undefined ? true : value === "true";
        break;
      case "readwrite":
      case "rw":
        mount.readonly = value === undefined ? false : value !== "true";
        break;
      case "sharing": {
        const s = (value ?? "").toLowerCase();
        if (s !== "shared" && s !== "private" && s !== "locked") {
          throw new DockerfileParseError("unsupported cache sharing mode: " + s, line);
        }
        mount.sharing = s;
        break;
      }
      case "id":
        mount.id = value;
        break;
      case "mode":
        mount.mode = parseInt(value ?? "0", 8);
        break;
      case "uid":
        mount.uid = Number(value);
        break;
      case "gid":
        mount.gid = Number(value);
        break;
      case "required":
        mount.required = value === undefined ? true : value === "true";
        break;
      case "size":
        mount.size = parseSize(value ?? "0");
        break;
      case "env":
        mount.env = value;
        break;
      default:
        throw new DockerfileParseError("unexpected key '" + key + "' in mount flag", line);
    }
  }
  return mount;
}

function parseSize(v: string): number {
  const m = /^(\d+)\s*([kKmMgG]?)[bB]?$/.exec(v.trim());
  if (!m) return Number(v) || 0;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "k":
      return n * 1024;
    case "m":
      return n * 1024 * 1024;
    case "g":
      return n * 1024 * 1024 * 1024;
    default:
      return n;
  }
}

/** Splits `a=1,b=2` while leaving commas inside quotes alone. */
function splitCSVFields(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function parseInstruction(
  keyword: string,
  flags: Flag[],
  rest: string,
  loc: Loc,
  raw: string,
  code: string,
  heredocs: LexedHeredoc[],
  escapeChar: string,
): Instruction {
  const base = { loc, keyword, flags, raw, code };
  const cmd = keyword.toLowerCase();
  const line = loc.startLine;

  switch (cmd) {
    case "from": {
      const words = rest.split(/\s+/).filter(Boolean);
      if (words.length === 0) throw new DockerfileParseError("FROM requires an image argument", line);
      const inst: FromInstruction = {
        ...base,
        type: "From",
        image: words[0]!,
        platform: flagValue(flags, "platform"),
      };
      if (words.length >= 3 && words[1]!.toLowerCase() === "as") {
        inst.stageName = words[2]!;
      } else if (words.length !== 1) {
        throw new DockerfileParseError("FROM requires either one or three arguments", line);
      }
      return inst;
    }

    case "run": {
      const mounts = flags.filter((f) => f.name === "mount").map((f) => parseMount(f.value ?? "", line));
      const network = flagValue(flags, "network") as RunInstruction["network"] | undefined;
      const security = flagValue(flags, "security") as RunInstruction["security"] | undefined;
      const inst: RunInstruction = {
        ...base,
        type: "Run",
        command: parseMaybeJSON(rest),
        mounts,
        heredocs: toHeredocs(heredocs),
      };
      if (network) inst.network = network;
      if (security) inst.security = security;
      return inst;
    }

    case "cmd":
      return { ...base, type: "Cmd", command: parseMaybeJSON(rest) } satisfies CmdInstruction;

    case "entrypoint":
      return { ...base, type: "Entrypoint", command: parseMaybeJSON(rest) } satisfies EntrypointInstruction;

    case "env":
      return { ...base, type: "Env", pairs: parseKeyValues(rest, escapeChar, line, "ENV") } satisfies EnvInstruction;

    case "label":
      return { ...base, type: "Label", pairs: parseKeyValues(rest, escapeChar, line, "LABEL") } satisfies LabelInstruction;

    case "arg": {
      const words = splitWords(rest, escapeChar);
      if (words.length === 0) throw new DockerfileParseError("ARG requires at least one argument", line);
      const args = words.map((w) => {
        const eq = w.indexOf("=");
        return eq < 0
          ? { key: stripQuotes(w) }
          : { key: stripQuotes(w.slice(0, eq)), value: stripQuotes(w.slice(eq + 1)) };
      });
      return { ...base, type: "Arg", args } satisfies ArgInstruction;
    }

    case "copy":
    case "add": {
      const parts = parseMaybeJSONToList(rest);
      const hd = toHeredocs(heredocs);
      if (parts.length < 2 && hd.length === 0) {
        throw new DockerfileParseError(keyword.toUpperCase() + " requires at least two arguments", line);
      }
      const dest = parts[parts.length - 1] ?? "";
      // Heredoc openers are inline documents, not source paths, so they are
      // carried in `heredocs` instead of `sources`.
      const openers = new Set(hd.map((h) => h.name));
      const sources = parts.slice(0, -1).filter((p) => !openers.has(p));
      const excludes = flags.filter((f) => f.name === "exclude").map((f) => f.value ?? "");
      const common = {
        sources,
        dest,
        excludes,
        heredocs: hd,
        chown: flagValue(flags, "chown"),
        chmod: flagValue(flags, "chmod"),
        link: flagBool(flags, "link"),
        parents: flagBool(flags, "parents"),
      };
      if (cmd === "copy") {
        return { ...base, type: "Copy", ...common, from: flagValue(flags, "from") } satisfies CopyInstruction;
      }
      return {
        ...base,
        type: "Add",
        ...common,
        checksum: flagValue(flags, "checksum"),
        keepGitDir: flagBool(flags, "keep-git-dir"),
        unpack: flagBool(flags, "unpack"),
      } satisfies AddInstruction;
    }

    case "workdir":
      return { ...base, type: "Workdir", path: rest } satisfies WorkdirInstruction;

    case "user":
      return { ...base, type: "User", user: rest } satisfies UserInstruction;

    case "stopsignal":
      return { ...base, type: "StopSignal", signal: rest } satisfies StopSignalInstruction;

    case "maintainer":
      return { ...base, type: "Maintainer", maintainer: rest } satisfies MaintainerInstruction;

    case "expose":
      return {
        ...base,
        type: "Expose",
        ports: rest.split(/\s+/).filter(Boolean),
      } satisfies ExposeInstruction;

    case "volume":
      return { ...base, type: "Volume", volumes: parseMaybeJSONToList(rest) } satisfies VolumeInstruction;

    case "shell": {
      const json = tryJSONArray(rest);
      if (!json) throw new DockerfileParseError("SHELL requires the JSON array form", line);
      return { ...base, type: "Shell", shell: json } satisfies ShellInstruction;
    }

    case "healthcheck": {
      const words = rest.split(/\s+/).filter(Boolean);
      const first = (words[0] ?? "").toUpperCase();
      if (first === "NONE") {
        return { ...base, type: "Healthcheck", none: true } satisfies HealthcheckInstruction;
      }
      if (first !== "CMD") {
        throw new DockerfileParseError("HEALTHCHECK expects NONE or CMD, got " + (words[0] ?? ""), line);
      }
      const body = rest.slice(rest.toUpperCase().indexOf("CMD") + 3).trim();
      const command = parseMaybeJSON(body);
      const retriesRaw = flagValue(flags, "retries");
      return {
        ...base,
        type: "Healthcheck",
        none: false,
        test: [command.kind === "exec" ? "CMD" : "CMD-SHELL", ...command.args],
        interval: flagValue(flags, "interval"),
        timeout: flagValue(flags, "timeout"),
        startPeriod: flagValue(flags, "start-period"),
        startInterval: flagValue(flags, "start-interval"),
        retries: retriesRaw === undefined ? undefined : Number(retriesRaw),
      } satisfies HealthcheckInstruction;
    }

    case "onbuild": {
      if (rest.trim() === "") throw new DockerfileParseError("ONBUILD requires at least one argument", line);
      const sub = splitCommand(rest, escapeChar);
      const subCmd = sub.keyword.toLowerCase();
      if (subCmd === "onbuild") throw new DockerfileParseError("ONBUILD isn't allowed to be used with ONBUILD", line);
      if (subCmd === "from" || subCmd === "maintainer") {
        throw new DockerfileParseError("ONBUILD isn't allowed to be used with " + sub.keyword.toUpperCase(), line);
      }
      let inner: Instruction | null = null;
      try {
        inner = parseInstruction(sub.keyword, sub.flags, sub.rest, loc, rest, rest, heredocs, escapeChar);
        inner.onbuild = true;
      } catch {
        inner = null;
      }
      return { ...base, type: "Onbuild", instruction: inner, body: rest } satisfies OnbuildInstruction;
    }

    default:
      return { ...base, type: "Unknown", args: rest } satisfies UnknownInstruction;
  }
}

export function parse(source: string): ParseResult {
  const lexed = lex(source);
  const nodes: Node[] = [];
  const warnings = [...lexed.warnings];

  for (const n of lexed.nodes) {
    if (n.kind === "comment") {
      nodes.push({ type: "Comment", loc: { startLine: n.startLine, endLine: n.endLine }, text: n.text, raw: n.raw });
      continue;
    }
    if (n.kind === "empty") {
      nodes.push({ type: "Empty", loc: { startLine: n.startLine, endLine: n.endLine }, raw: n.raw });
      continue;
    }
    const { keyword, flags, rest } = splitCommand(n.text, lexed.escapeChar);
    if (!KNOWN_COMMANDS.has(keyword.toLowerCase())) {
      warnings.push({ message: "unknown instruction: " + keyword.toUpperCase(), line: n.startLine });
    }
    nodes.push(
      parseInstruction(
        keyword,
        flags,
        rest,
        { startLine: n.startLine, endLine: n.endLine },
        n.raw,
        n.text.trim(),
        n.heredocs,
        lexed.escapeChar,
      ),
    );
  }

  return {
    ast: { directives: lexed.directives, nodes, escapeChar: lexed.escapeChar },
    warnings,
  };
}

export { lex };
export type { LexWarning };
