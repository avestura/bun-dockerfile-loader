import type { DockerfileAST, Flag, Heredoc, Instruction, Node, ShellOrExec } from "../parser/ast.ts";

export interface PrintOptions {
  eol?: "\n" | "\r\n";
  /** Force every keyword to upper case instead of keeping its source casing. */
  uppercaseKeywords?: boolean;
  /** Emit a trailing newline. */
  trailingNewline?: boolean;
}

function kw(inst: Instruction, opts: PrintOptions): string {
  return opts.uppercaseKeywords ? inst.keyword.toUpperCase() : inst.keyword;
}

function renderFlags(flags: Flag[]): string {
  if (flags.length === 0) return "";
  return (
    " " +
    flags
      .map((f) => (f.value === undefined ? "--" + f.name : "--" + f.name + "=" + quoteIfNeeded(f.value)))
      .join(" ")
  );
}

function quoteIfNeeded(v: string): string {
  return /[\s]/.test(v) && !/^".*"$/.test(v) ? JSON.stringify(v) : v;
}

function renderCommand(c: ShellOrExec): string {
  return c.kind === "exec" ? JSON.stringify(c.args) : (c.args[0] ?? "");
}

function renderHeredocs(heredocs: Heredoc[], eol: string): string {
  if (heredocs.length === 0) return "";
  let out = "";
  for (const h of heredocs) {
    const body = h.content.endsWith("\n") ? h.content.slice(0, -1) : h.content;
    out += eol + (body === "" ? "" : body.split("\n").join(eol) + eol) + h.delimiter;
  }
  return out;
}

function renderPairs(pairs: { key: string; value: string; noDelim?: boolean }[]): string {
  return pairs
    .map((p) => p.key + "=" + (needsQuote(p.value) ? JSON.stringify(p.value) : p.value))
    .join(" ");
}

function needsQuote(v: string): boolean {
  return v === "" || /\s/.test(v);
}

/** Renders one instruction from its typed fields, ignoring any cached source. */
export function formatInstruction(inst: Instruction, opts: PrintOptions = {}): string {
  const eol = opts.eol ?? "\n";
  const head = kw(inst, opts);

  switch (inst.type) {
    case "From": {
      let s = head + (inst.platform ? " --platform=" + inst.platform : "") + " " + inst.image;
      if (inst.stageName) s += " AS " + inst.stageName;
      return s;
    }
    case "Run": {
      const flags: string[] = [];
      for (const m of inst.mounts) flags.push("--mount=" + m.raw);
      if (inst.network) flags.push("--network=" + inst.network);
      if (inst.security) flags.push("--security=" + inst.security);
      const flagStr = flags.length ? " " + flags.join(" ") : "";
      return head + flagStr + " " + renderCommand(inst.command) + renderHeredocs(inst.heredocs, eol);
    }
    case "Cmd":
      return head + " " + renderCommand(inst.command);
    case "Entrypoint":
      return head + " " + renderCommand(inst.command);
    case "Env":
      return head + " " + renderPairs(inst.pairs);
    case "Label":
      return head + " " + renderPairs(inst.pairs);
    case "Arg":
      return (
        head +
        " " +
        inst.args
          .map((a) => (a.value === undefined ? a.key : a.key + "=" + (needsQuote(a.value) ? JSON.stringify(a.value) : a.value)))
          .join(" ")
      );
    case "Copy":
    case "Add": {
      const flags: string[] = [];
      if (inst.type === "Copy" && inst.from) flags.push("--from=" + inst.from);
      if (inst.chown) flags.push("--chown=" + inst.chown);
      if (inst.chmod) flags.push("--chmod=" + inst.chmod);
      if (inst.link) flags.push("--link");
      if (inst.parents) flags.push("--parents");
      for (const ex of inst.excludes) flags.push("--exclude=" + ex);
      if (inst.type === "Add") {
        if (inst.checksum) flags.push("--checksum=" + inst.checksum);
        if (inst.keepGitDir) flags.push("--keep-git-dir");
        if (inst.unpack !== undefined) flags.push("--unpack=" + String(inst.unpack));
      }
      const flagStr = flags.length ? " " + flags.join(" ") : "";
      const args = [...inst.sources, inst.dest];
      const needsJSON = args.some((a) => /\s/.test(a));
      const body = needsJSON ? JSON.stringify(args) : args.join(" ");
      return head + flagStr + " " + body + renderHeredocs(inst.heredocs, eol);
    }
    case "Workdir":
      return head + " " + inst.path;
    case "User":
      return head + " " + inst.user;
    case "StopSignal":
      return head + " " + inst.signal;
    case "Maintainer":
      return head + " " + inst.maintainer;
    case "Expose":
      return head + " " + inst.ports.join(" ");
    case "Volume":
      return head + " " + inst.volumes.join(" ");
    case "Shell":
      return head + " " + JSON.stringify(inst.shell);
    case "Healthcheck": {
      if (inst.none) return head + " NONE";
      const flags: string[] = [];
      if (inst.interval) flags.push("--interval=" + inst.interval);
      if (inst.timeout) flags.push("--timeout=" + inst.timeout);
      if (inst.startPeriod) flags.push("--start-period=" + inst.startPeriod);
      if (inst.startInterval) flags.push("--start-interval=" + inst.startInterval);
      if (inst.retries !== undefined) flags.push("--retries=" + inst.retries);
      const flagStr = flags.length ? " " + flags.join(" ") : "";
      const test = inst.test ?? [];
      const mode = test[0];
      const rest = test.slice(1);
      const body = mode === "CMD" ? JSON.stringify(rest) : rest.join(" ");
      return head + flagStr + " CMD " + body;
    }
    case "Onbuild":
      return head + " " + (inst.instruction ? formatInstruction(inst.instruction, opts) : inst.body);
    case "Unknown":
      return inst.args ? head + " " + inst.args : head;
  }
}

/** Renders one node, preferring its untouched source text when available. */
export function formatNode(node: Node, opts: PrintOptions = {}): string {
  const eol = opts.eol ?? "\n";
  if (node.type === "Comment") return node.raw !== "" ? stripEol(node.raw) : "#" + node.text;
  if (node.type === "Empty") return "";
  if (node.raw !== "") return stripEol(node.raw);
  return formatInstruction(node, { ...opts, eol });
}

function stripEol(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

export function print(ast: DockerfileAST, opts: PrintOptions = {}): string {
  const eol = opts.eol ?? "\n";
  const lines = ast.nodes.map((n) => formatNode(n, { ...opts, eol }));
  const body = lines.join(eol);
  const trailing = opts.trailingNewline ?? true;
  return trailing && body !== "" ? body + eol : body;
}
