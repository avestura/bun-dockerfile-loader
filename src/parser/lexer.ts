import type { Directives } from "./ast.ts";

/**
 * Line assembly for Dockerfiles: parser directives, comment stripping,
 * escape-character continuations and heredoc bodies.
 *
 * Mirrors moby/buildkit `frontend/dockerfile/parser`, which is line-oriented:
 * a line ending in the escape character continues, regardless of quoting.
 */

const RE_DIRECTIVE = /^#\s*([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(.+?)\s*$/;
const RE_HEREDOC = /^(\d*)<<(-?)([^<]*)$/;
const UTF8_BOM = "﻿";

export interface LexedHeredoc {
  name: string;
  delimiter: string;
  chomp: boolean;
  expand: boolean;
  content: string;
}

/** One instruction's worth of source: continuations joined, comments removed. */
export interface LogicalLine {
  /** Joined text with continuations resolved and interior comments dropped. */
  text: string;
  startLine: number;
  endLine: number;
  /** Verbatim source slice, including heredoc bodies and trailing newline. */
  raw: string;
  heredocs: LexedHeredoc[];
  /** Comment lines that appeared inside the continuation, in order. */
  innerComments: string[];
}

export type LexedNode =
  | ({ kind: "instruction" } & LogicalLine)
  | { kind: "comment"; text: string; raw: string; startLine: number; endLine: number }
  | { kind: "empty"; raw: string; startLine: number; endLine: number };

export interface LexWarning {
  message: string;
  line: number;
}

export interface LexResult {
  directives: Directives;
  escapeChar: string;
  nodes: LexedNode[];
  /** True when the source ended with a newline, so the printer can restore it. */
  trailingNewline: boolean;
  /** The dominant line ending, so the printer can restore CRLF sources. */
  eol: "\n" | "\r\n";
  warnings: LexWarning[];
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Splits a logical line into words, honouring single/double quotes and the
 * active escape character. Used for heredoc discovery and flag parsing.
 */
export function splitWords(text: string, escapeChar: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (ch === escapeChar && quote !== "'" && i + 1 < text.length) {
      current += ch + text[i + 1];
      i++;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      current += ch;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      current += ch;
      continue;
    }
    current += ch;
  }
  if (started) words.push(current);
  return words;
}

/** Recognises a heredoc opener word; returns null when it is not one. */
function parseHeredocWord(word: string): Omit<LexedHeredoc, "content"> | null {
  // A leading file descriptor is matched so it is not mistaken for a redirect,
  // but BuildKit ignores the descriptor itself.
  const m = RE_HEREDOC.exec(word);
  if (!m) return null;
  const rest = m[3] ?? "";
  if (rest === "") return null;
  // Expansions in the delimiter cannot be resolved at parse time.
  if (rest.includes("$")) return null;

  let delimiter = rest.trim();
  let expand = true;
  const first = delimiter[0];
  if ((first === '"' || first === "'") && delimiter.length > 1 && delimiter.endsWith(first)) {
    delimiter = delimiter.slice(1, -1);
    expand = false;
  } else if (delimiter.includes("\\")) {
    delimiter = delimiter.replace(/\\/g, "");
    expand = false;
  }
  if (delimiter === "") return null;
  return { name: word, delimiter, chomp: m[2] === "-", expand };
}

/** Finds every heredoc opener in a logical line, left to right. */
export function findHeredocs(text: string, escapeChar: string): Omit<LexedHeredoc, "content">[] {
  const out: Omit<LexedHeredoc, "content">[] = [];
  for (const word of splitWords(text, escapeChar)) {
    const hd = parseHeredocWord(word);
    if (hd) out.push(hd);
  }
  return out;
}

/** Strips a trailing escape character (plus trailing blanks) if present. */
function trimContinuation(line: string, escapeChar: string): string | null {
  const re = new RegExp("\\" + escapeChar + "[ \\t]*$");
  if (!re.test(line)) return null;
  return line.replace(re, "");
}

export function lex(source: string): LexResult {
  const eol: "\n" | "\r\n" = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = source.endsWith("\n");
  let src = source;
  if (src.startsWith(UTF8_BOM)) src = src.slice(UTF8_BOM.length);

  const physical = src.split(/\r?\n/);
  // A trailing newline produces a final empty element that is not a real line.
  if (trailingNewline) physical.pop();

  const warnings: LexWarning[] = [];
  const directives: Directives = { raw: [] };
  let escapeChar = "\\";
  const nodes: LexedNode[] = [];
  let i = 0;

  const rawOf = (from: number, to: number) => {
    const body = physical.slice(from, to + 1).join(eol);
    const isLast = to + 1 >= physical.length;
    return isLast && !trailingNewline ? body : body + eol;
  };

  // --- Header: parser directives -------------------------------------------
  while (i < physical.length) {
    const line = physical[i]!;
    const m = RE_DIRECTIVE.exec(line.trim());
    if (!m) break;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    directives.raw.push({ key, value, line: i + 1 });
    if (key === "escape") {
      if (value === "\\" || value === "`") {
        escapeChar = value;
        directives.escape = value;
      } else {
        warnings.push({ message: "invalid escape directive: " + value, line: i + 1 });
      }
    } else if (key === "syntax") {
      directives.syntax = value;
    } else if (key === "check") {
      directives.check = value;
    } else {
      warnings.push({ message: "unknown parser directive: " + key, line: i + 1 });
    }
    nodes.push({
      kind: "comment",
      text: line.trimStart().replace(/^#/, ""),
      raw: rawOf(i, i),
      startLine: i + 1,
      endLine: i + 1,
    });
    i++;
  }

  // --- Body ----------------------------------------------------------------
  while (i < physical.length) {
    const start = i;
    const line = physical[i]!;

    if (isBlank(line)) {
      nodes.push({ kind: "empty", raw: rawOf(i, i), startLine: i + 1, endLine: i + 1 });
      i++;
      continue;
    }
    if (isComment(line)) {
      nodes.push({
        kind: "comment",
        text: line.trimStart().replace(/^#/, ""),
        raw: rawOf(i, i),
        startLine: i + 1,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // Join continuation lines.
    const parts: string[] = [];
    const innerComments: string[] = [];
    let cur = line.trimStart();
    for (;;) {
      const trimmed = trimContinuation(cur, escapeChar);
      if (trimmed === null) {
        parts.push(cur);
        break;
      }
      parts.push(trimmed);
      i++;
      // Comment-only and blank lines inside a continuation are dropped.
      for (; i < physical.length; i++) {
        const next = physical[i]!;
        if (isComment(next)) {
          innerComments.push(next.trimStart().replace(/^#/, ""));
          continue;
        }
        if (isBlank(next)) {
          warnings.push({ message: "empty continuation line", line: i + 1 });
          continue;
        }
        break;
      }
      if (i >= physical.length) break;
      cur = physical[i]!;
    }

    const text = parts.join("").trimEnd();
    const openers = findHeredocs(text, escapeChar);
    const heredocs: LexedHeredoc[] = [];
    let end = i;

    if (openers.length > 0) {
      let j = i + 1;
      for (const opener of openers) {
        const body: string[] = [];
        let closed = false;
        for (; j < physical.length; j++) {
          const bodyLine = physical[j]!;
          const probe = opener.chomp ? bodyLine.replace(/^\t+/, "") : bodyLine;
          if (probe.trimEnd() === opener.delimiter) {
            closed = true;
            j++;
            break;
          }
          body.push(probe);
        }
        if (!closed) {
          warnings.push({
            message: "unterminated heredoc: missing delimiter " + opener.delimiter,
            line: start + 1,
          });
        }
        heredocs.push({ ...opener, content: body.length ? body.join("\n") + "\n" : "" });
      }
      end = j - 1;
      i = j;
    } else {
      i++;
    }

    nodes.push({
      kind: "instruction",
      text,
      startLine: start + 1,
      endLine: end + 1,
      raw: rawOf(start, end),
      heredocs,
      innerComments,
    });
  }

  return { directives, escapeChar, nodes, trailingNewline, eol, warnings };
}
