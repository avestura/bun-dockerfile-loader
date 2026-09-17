/**
 * Shell-style word lexing and variable expansion.
 *
 * Port of moby/buildkit `frontend/dockerfile/shell/lex.go`, including its
 * regex-based (not glob-based) `${v#p}` / `${v%p}` / `${v/p/r}` semantics.
 */

export interface EnvGetter {
  get(name: string): string | undefined;
  keys(): string[];
}

export interface ProcessWordResult {
  result: string;
  words: string[];
  /** Names that were referenced and found. */
  matched: Set<string>;
  /** Names that were referenced and not found. */
  unmatched: Set<string>;
}

export class ShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellError";
  }
}

const EOF = null;
type Char = string | null;

/** Windows env lookups are case-insensitive; Linux ones are not. */
export function normalizeEnvKey(key: string, caseInsensitive: boolean): string {
  return caseInsensitive ? key.toUpperCase() : key;
}

export function envsFromMap(vars: Record<string, string>, caseInsensitive = false): EnvGetter {
  const map = new Map<string, string>();
  const order: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    order.push(k);
    map.set(normalizeEnvKey(k, caseInsensitive), v);
  }
  return {
    get: (name) => map.get(normalizeEnvKey(name, caseInsensitive)),
    keys: () => order,
  };
}

export function envsFromSlice(env: string[], caseInsensitive = false): EnvGetter {
  const vars: Record<string, string> = {};
  for (const e of env) {
    const i = e.indexOf("=");
    if (i < 0) vars[e] = "";
    else vars[e.slice(0, i)] = e.slice(i + 1);
  }
  return envsFromMap(vars, caseInsensitive);
}

/** Word accumulator that splits on unquoted whitespace, like `wordsStruct`. */
class Words {
  private words: string[] = [];
  private buf = "";
  private inWord = false;

  addChar(ch: string) {
    if (isSpace(ch) && this.inWord) {
      this.words.push(this.buf);
      this.buf = "";
      this.inWord = false;
    } else if (!isSpace(ch)) {
      this.addRawChar(ch);
    }
  }

  addRawChar(ch: string) {
    this.buf += ch;
    this.inWord = true;
  }

  addString(str: string) {
    for (const ch of str) this.addChar(ch);
  }

  addRawString(str: string) {
    this.buf += str;
    this.inWord = true;
  }

  getWords(): string[] {
    if (this.inWord) {
      this.words.push(this.buf);
      this.buf = "";
      this.inWord = false;
    }
    return this.words;
  }
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\v" || ch === "\f";
}

class Scanner {
  pos = 0;
  constructor(readonly src: string) {}
  peek(): Char {
    return this.pos < this.src.length ? this.src[this.pos]! : EOF;
  }
  next(): Char {
    return this.pos < this.src.length ? this.src[this.pos++]! : EOF;
  }
}

/**
 * Converts a shell wildcard pattern to a regular expression.
 * `*` becomes `.*?` or `.*` (greedy), `?` becomes `.`. Bracket expressions are
 * deliberately not supported, matching BuildKit.
 */
export function convertShellPatternToRegex(pattern: string, greedy: boolean, anchored: boolean): RegExp {
  let out = anchored ? "^" : "";
  const star = greedy ? ".*" : ".*?";
  const sc = new Scanner(pattern);

  for (let tok = sc.next(); tok !== EOF; tok = sc.next()) {
    if (tok === "*") {
      out += star;
      continue;
    }
    if (tok === "?") {
      out += ".";
      continue;
    }
    if (tok === "\\") {
      // `}` and `/` need escaping inside `${}`, but the escape is not part of
      // the pattern itself.
      const p = sc.peek();
      if (p === "}" || p === "/") continue;
      out += "\\";
      tok = sc.next();
      if (tok !== "*" && tok !== "?" && tok !== "\\") {
        throw new ShellError("invalid escape '\\" + (tok ?? "") + "'");
      }
      out += tok;
      continue;
    }
    if ("[]{}.+()|^$".includes(tok)) out += "\\";
    out += tok;
  }
  return new RegExp(out);
}

function trimPrefix(pattern: string, value: string, greedy: boolean): string {
  const re = convertShellPatternToRegex(pattern, greedy, true);
  const m = re.exec(value);
  return m ? value.slice(m.index + m[0].length) : value;
}

/** Reverses a pattern without splitting escape pairs (`a\*c` -> `c\*a`). */
function reversePattern(pattern: string): string {
  const runes = [...pattern];
  const out = new Array<string>(runes.length);
  const lastIdx = runes.length - 1;
  for (let i = 0; i <= lastIdx; ) {
    const tok = runes[i]!;
    const outIdx = lastIdx - i;
    if (tok === "\\" && i !== lastIdx) {
      out[outIdx - 1] = tok;
      out[outIdx] = runes[i + 1]!;
      i += 2;
    } else {
      out[outIdx] = tok;
      i++;
    }
  }
  return out.join("");
}

function reverseString(str: string): string {
  return [...str].reverse().join("");
}

/** Regexes cannot find a shortest rightmost match, so both sides are reversed. */
function trimSuffix(pattern: string, word: string, greedy: boolean): string {
  return reverseString(trimPrefix(reversePattern(pattern), reverseString(word), greedy));
}

function isSpecialParam(ch: string): boolean {
  return "@*#?-$!0".includes(ch);
}

export interface LexOptions {
  /** Keep quote characters in the result. */
  rawQuotes?: boolean;
  /** Keep escape characters in the result. */
  rawEscapes?: boolean;
  /** Leave `$FOO` as written when FOO is unset. */
  skipUnsetEnv?: boolean;
  /** Do not treat quotes as quotes. */
  skipProcessQuotes?: boolean;
}

export class ShellLex {
  rawQuotes: boolean;
  rawEscapes: boolean;
  skipUnsetEnv: boolean;
  skipProcessQuotes: boolean;

  constructor(
    readonly escapeToken: string = "\\",
    opts: LexOptions = {},
  ) {
    this.rawQuotes = opts.rawQuotes ?? false;
    this.rawEscapes = opts.rawEscapes ?? false;
    this.skipUnsetEnv = opts.skipUnsetEnv ?? false;
    this.skipProcessQuotes = opts.skipProcessQuotes ?? false;
  }

  /** Expands a word, keeping interior spacing. */
  processWord(word: string, env: EnvGetter): ProcessWordResult {
    return this.process(word, env);
  }

  /** Expands a word and splits it on unquoted whitespace. */
  processWords(word: string, env: EnvGetter): string[] {
    return this.process(word, env).words;
  }

  private process(word: string, env: EnvGetter): ProcessWordResult {
    const state = new WordState(this, env, word);
    const [result, words] = state.processStopOn(EOF, this.rawEscapes);
    return { result, words, matched: state.matched, unmatched: state.unmatched };
  }
}

class WordState {
  readonly scanner: Scanner;
  readonly matched = new Set<string>();
  readonly unmatched = new Set<string>();
  private rawEscapes: boolean;

  constructor(
    private readonly lex: ShellLex,
    private readonly env: EnvGetter,
    source: string,
  ) {
    this.scanner = new Scanner(source);
    this.rawEscapes = lex.rawEscapes;
  }

  private get escapeToken(): string {
    return this.lex.escapeToken;
  }

  processStopOn(stopChar: Char, rawEscapes: boolean): [string, string[]] {
    let result = "";
    const words = new Words();
    const previousRawEscapes = this.rawEscapes;
    this.rawEscapes = rawEscapes;

    try {
      for (;;) {
        const ch = this.scanner.peek();
        if (ch === EOF) break;
        if (stopChar !== EOF && ch === stopChar) {
          this.scanner.next();
          return [result, words.getWords()];
        }

        if (ch === "$") {
          const tmp = this.processDollar();
          result += tmp;
          words.addString(tmp);
          continue;
        }
        if (ch === "<") {
          const tmp = this.processPossibleHeredoc();
          result += tmp;
          words.addRawString(tmp);
          continue;
        }
        if (!this.lex.skipProcessQuotes && ch === "'") {
          const tmp = this.processSingleQuote();
          result += tmp;
          words.addRawString(tmp);
          continue;
        }
        if (!this.lex.skipProcessQuotes && ch === '"') {
          const tmp = this.processDoubleQuote();
          result += tmp;
          words.addRawString(tmp);
          continue;
        }

        let c = this.scanner.next()!;
        if (c === this.escapeToken) {
          if (this.rawEscapes) {
            words.addRawChar(c);
            result += c;
          }
          const nxt = this.scanner.next();
          if (nxt === EOF) break;
          c = nxt;
          words.addRawChar(c);
        } else {
          words.addChar(c);
        }
        result += c;
      }

      if (stopChar !== EOF) {
        throw new ShellError("unexpected end of statement while looking for matching " + stopChar);
      }
      return [result, words.getWords()];
    } finally {
      this.rawEscapes = previousRawEscapes;
    }
  }

  private processSingleQuote(): string {
    // Everything between single quotes is literal; `'` cannot be escaped.
    let result = "";
    const open = this.scanner.next()!;
    if (this.lex.rawQuotes) result += open;
    for (;;) {
      const ch = this.scanner.next();
      if (ch === EOF) throw new ShellError("unexpected end of statement while looking for matching single-quote");
      if (ch === "'") {
        if (this.lex.rawQuotes) result += ch;
        return result;
      }
      result += ch;
    }
  }

  private processDoubleQuote(): string {
    let result = "";
    const open = this.scanner.next()!;
    if (this.lex.rawQuotes) result += open;

    for (;;) {
      const peeked = this.scanner.peek();
      if (peeked === EOF) throw new ShellError("unexpected end of statement while looking for matching double-quote");
      if (peeked === '"') {
        const ch = this.scanner.next()!;
        if (this.lex.rawQuotes) result += ch;
        return result;
      }
      if (peeked === "$") {
        result += this.processDollar();
        continue;
      }
      let ch = this.scanner.next()!;
      if (ch === this.escapeToken) {
        if (this.rawEscapes) result += ch;
        const nxt = this.scanner.peek();
        // Only these can be escaped inside double quotes; every other escape
        // character stays literal.
        if (nxt === EOF) continue;
        if (nxt === '"' || nxt === "$" || nxt === this.escapeToken) {
          ch = this.scanner.next()!;
        }
      }
      result += ch;
    }
  }

  private processPossibleHeredoc(): string {
    this.scanner.next();
    if (this.scanner.peek() !== "<") return "<";
    this.scanner.next();
    // A heredoc may have whitespace between `<<` and the delimiter word.
    let space = "";
    while (this.scanner.peek() !== EOF && isHeredocSpace(this.scanner.peek()!)) {
      space += this.scanner.peek();
      this.scanner.next();
    }
    return "<<" + space;
  }

  private processName(): string {
    let name = "";
    for (;;) {
      const ch = this.scanner.peek();
      if (ch === EOF) break;
      if (name.length === 0 && /[0-9]/.test(ch)) {
        while (this.scanner.peek() !== EOF && /[0-9]/.test(this.scanner.peek()!)) {
          name += this.scanner.next();
        }
        return name;
      }
      if (name.length === 0 && isSpecialParam(ch)) {
        return this.scanner.next()!;
      }
      if (!/[A-Za-z0-9_]/.test(ch)) break;
      name += this.scanner.next();
    }
    return name;
  }

  private getEnv(name: string): { value: string; found: boolean } {
    const v = this.env.get(name);
    if (v !== undefined) {
      this.matched.add(name);
      return { value: v, found: true };
    }
    this.unmatched.add(name);
    return { value: "", found: false };
  }

  private processDollar(): string {
    this.scanner.next();

    if (this.scanner.peek() !== "{") {
      const name = this.processName();
      if (name === "") return "$";
      const { value, found } = this.getEnv(name);
      if (!found && this.lex.skipUnsetEnv) return "$" + name;
      return value;
    }

    this.scanner.next();
    const lead = this.scanner.peek();
    if (lead === EOF) throw new ShellError("syntax error: missing '}'");
    if (lead === "{" || lead === "}" || lead === ":") throw new ShellError("syntax error: bad substitution");

    const name = this.processName();
    let ch = this.scanner.next();
    let chs = ch ?? "";
    let nullIsUnset = false;

    if (ch === "}") {
      const { value, found } = this.getEnv(name);
      if (!found && this.lex.skipUnsetEnv) return "${" + name + "}";
      return value;
    }

    if (ch === ":") {
      nullIsUnset = true;
      ch = this.scanner.next();
      chs += ch ?? "";
    }

    if (ch === "+" || ch === "-" || ch === "?" || ch === "#" || ch === "%") {
      const rawEscapes = ch === "#" || ch === "%";
      if (nullIsUnset && rawEscapes) {
        throw new ShellError("unsupported modifier (" + chs + ") in substitution");
      }
      const [word] = this.processStopOn("}", rawEscapes);
      const { value, found } = this.getEnv(name);
      if (this.lex.skipUnsetEnv && !found) return "${" + name + chs + word + "}";

      switch (ch) {
        case "-":
          return !found || (nullIsUnset && value === "") ? word : value;
        case "+":
          return !found || (nullIsUnset && value === "") ? "" : word;
        case "?":
          if (!found) throw new ShellError(name + ": " + (word !== "" ? word : "is not allowed to be unset"));
          if (nullIsUnset && value === "") {
            throw new ShellError(name + ": " + (word !== "" ? word : "is not allowed to be empty"));
          }
          return value;
        case "%":
        case "#": {
          // A doubled modifier means the longest match instead of the shortest.
          let pattern = word;
          let greedy = false;
          if (pattern.length > 0 && pattern[0] === ch) {
            greedy = true;
            pattern = pattern.slice(1);
          }
          return ch === "%" ? trimSuffix(pattern, value, greedy) : trimPrefix(pattern, value, greedy);
        }
      }
    }

    if (ch === "/") {
      const replaceAll = this.scanner.peek() === "/";
      if (replaceAll) this.scanner.next();

      const [pattern] = this.processStopOn("/", true);
      const [replacement] = this.processStopOn("}", true);
      const { value, found } = this.getEnv(name);
      if (this.lex.skipUnsetEnv && !found) return "${" + name + "/" + pattern + "/" + replacement + "}";

      const re = convertShellPatternToRegex(pattern, true, false);
      if (replaceAll) {
        return value.replace(new RegExp(re.source, "g"), () => replacement);
      }
      const m = re.exec(value);
      if (!m) return value;
      return value.slice(0, m.index) + replacement + value.slice(m.index + m[0].length);
    }

    throw new ShellError("unsupported modifier (" + chs + ") in substitution");
  }
}

function isHeredocSpace(r: string): boolean {
  return r === "\t" || r === "\r" || r === " ";
}
