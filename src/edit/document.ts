import type {
  DockerfileAST,
  FromInstruction,
  Instruction,
  Node,
} from "../parser/ast.ts";
import { isInstruction } from "../parser/ast.ts";
import { parse, type LexWarning } from "../parser/parser.ts";
import { formatInstruction, print, type PrintOptions } from "./printer.ts";
import * as build from "./builders.ts";

export interface DockerfileOptions {
  /** Path the source came from, used in error messages and as the LLB filename. */
  filename?: string;
}

/**
 * A parsed, mutable Dockerfile.
 *
 * Untouched instructions keep their original source bytes, so a parse/print
 * round-trip is lossless; only nodes you edit get re-rendered.
 */
export class Dockerfile {
  readonly ast: DockerfileAST;
  readonly warnings: LexWarning[];
  readonly filename: string;
  private eol: "\n" | "\r\n";
  private trailingNewline: boolean;

  private constructor(
    ast: DockerfileAST,
    warnings: LexWarning[],
    filename: string,
    eol: "\n" | "\r\n",
    trailingNewline: boolean,
  ) {
    this.ast = ast;
    this.warnings = warnings;
    this.filename = filename;
    this.eol = eol;
    this.trailingNewline = trailingNewline;
  }

  static parse(source: string, opts: DockerfileOptions = {}): Dockerfile {
    const { ast, warnings } = parse(source);
    return new Dockerfile(
      ast,
      warnings,
      opts.filename ?? "Dockerfile",
      source.includes("\r\n") ? "\r\n" : "\n",
      source.endsWith("\n") || source === "",
    );
  }

  static async fromFile(path: string): Promise<Dockerfile> {
    const source = await Bun.file(path).text();
    return Dockerfile.parse(source, { filename: path });
  }

  /** Builds an empty document you can append to. */
  static empty(opts: DockerfileOptions = {}): Dockerfile {
    return new Dockerfile(
      { directives: { raw: [] }, nodes: [], escapeChar: "\\" },
      [],
      opts.filename ?? "Dockerfile",
      "\n",
      true,
    );
  }

  // --- Reading -------------------------------------------------------------

  get nodes(): Node[] {
    return this.ast.nodes;
  }

  get instructions(): Instruction[] {
    return this.ast.nodes.filter(isInstruction);
  }

  /** The `# syntax=` frontend reference, if the file declares one. */
  get syntax(): string | undefined {
    return this.ast.directives.syntax;
  }

  set syntax(value: string | undefined) {
    this.ast.directives.syntax = value;
    const existing = this.ast.nodes.findIndex(
      (n) => n.type === "Comment" && /^\s*syntax\s*=/.test(n.text),
    );
    if (value === undefined) {
      if (existing >= 0) this.ast.nodes.splice(existing, 1);
      return;
    }
    const node = build.comment(" syntax=" + value);
    if (existing >= 0) this.ast.nodes[existing] = node;
    else this.ast.nodes.unshift(node);
  }

  get escapeChar(): string {
    return this.ast.escapeChar;
  }

  /** Build stages in declaration order. */
  get stages(): Stage[] {
    const out: Stage[] = [];
    let current: { from: FromInstruction; body: Instruction[] } | null = null;
    for (const node of this.ast.nodes) {
      if (!isInstruction(node)) continue;
      if (node.type === "From") {
        if (current) out.push(new Stage(this, out.length, current.from, current.body));
        current = { from: node, body: [] };
      } else if (current) {
        current.body.push(node);
      }
    }
    if (current) out.push(new Stage(this, out.length, current.from, current.body));
    return out;
  }

  /** Instructions that appear before the first FROM: global ARGs and comments. */
  get globalArgs(): Instruction[] {
    const out: Instruction[] = [];
    for (const node of this.ast.nodes) {
      if (!isInstruction(node)) continue;
      if (node.type === "From") break;
      out.push(node);
    }
    return out;
  }

  /** Looks a stage up by name (case-insensitive) or index. */
  stage(ref: string | number): Stage | undefined {
    const stages = this.stages;
    if (typeof ref === "number") return stages[ref < 0 ? stages.length + ref : ref];
    const lower = ref.toLowerCase();
    return stages.find((s) => s.name?.toLowerCase() === lower);
  }

  /** The stage an image build would produce by default: the last one. */
  get target(): Stage | undefined {
    const stages = this.stages;
    return stages[stages.length - 1];
  }

  find<T extends Instruction["type"]>(type: T): Extract<Instruction, { type: T }>[] {
    return this.instructions.filter((i): i is Extract<Instruction, { type: T }> => i.type === type);
  }

  // --- Mutation ------------------------------------------------------------

  /** Invalidates a node's cached source so the printer re-renders it. */
  touch(node: Node): void {
    (node as { raw: string }).raw = "";
  }

  /**
   * Applies a partial update to an instruction and marks it for re-rendering.
   * Fields not named are left alone.
   */
  update<T extends Instruction>(node: T, patch: Partial<T>): T {
    Object.assign(node, patch);
    this.touch(node);
    return node;
  }

  indexOf(node: Node): number {
    return this.ast.nodes.indexOf(node);
  }

  append(...nodes: Node[]): this {
    this.ast.nodes.push(...nodes);
    return this;
  }

  prepend(...nodes: Node[]): this {
    const firstFrom = this.ast.nodes.findIndex((n) => n.type === "From");
    this.ast.nodes.splice(firstFrom < 0 ? 0 : firstFrom, 0, ...nodes);
    return this;
  }

  insertAt(index: number, ...nodes: Node[]): this {
    this.ast.nodes.splice(index, 0, ...nodes);
    return this;
  }

  insertBefore(anchor: Node, ...nodes: Node[]): this {
    const i = this.indexOf(anchor);
    if (i < 0) throw new Error("anchor node is not part of this document");
    this.ast.nodes.splice(i, 0, ...nodes);
    return this;
  }

  insertAfter(anchor: Node, ...nodes: Node[]): this {
    const i = this.indexOf(anchor);
    if (i < 0) throw new Error("anchor node is not part of this document");
    this.ast.nodes.splice(i + 1, 0, ...nodes);
    return this;
  }

  remove(node: Node): boolean {
    const i = this.indexOf(node);
    if (i < 0) return false;
    this.ast.nodes.splice(i, 1);
    return true;
  }

  replace(node: Node, ...replacements: Node[]): this {
    const i = this.indexOf(node);
    if (i < 0) throw new Error("node is not part of this document");
    this.ast.nodes.splice(i, 1, ...replacements);
    return this;
  }

  /** Removes every instruction for which the predicate returns true. */
  removeWhere(predicate: (inst: Instruction) => boolean): number {
    let removed = 0;
    for (let i = this.ast.nodes.length - 1; i >= 0; i--) {
      const n = this.ast.nodes[i]!;
      if (isInstruction(n) && predicate(n)) {
        this.ast.nodes.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Rewrites every base image through a mapping function. */
  mapBaseImages(fn: (image: string, stage: Stage) => string): this {
    for (const stage of this.stages) {
      const next = fn(stage.baseImage, stage);
      if (next !== stage.baseImage) stage.setBaseImage(next);
    }
    return this;
  }

  // --- Output --------------------------------------------------------------

  toString(opts: PrintOptions = {}): string {
    return print(this.ast, {
      eol: this.eol,
      trailingNewline: this.trailingNewline,
      ...opts,
    });
  }

  async writeFile(path: string = this.filename): Promise<void> {
    await Bun.write(path, this.toString());
  }

  clone(): Dockerfile {
    return Dockerfile.parse(this.toString(), { filename: this.filename });
  }

  toJSON(): DockerfileAST {
    return this.ast;
  }
}

/** A view over one `FROM ... ` block, with edits that write through to the document. */
export class Stage {
  constructor(
    private readonly doc: Dockerfile,
    readonly index: number,
    readonly from: FromInstruction,
    readonly instructions: Instruction[],
  ) {}

  get name(): string | undefined {
    return this.from.stageName;
  }

  set name(value: string | undefined) {
    this.doc.update(this.from, { stageName: value });
  }

  get baseImage(): string {
    return this.from.image;
  }

  get platform(): string | undefined {
    return this.from.platform;
  }

  setBaseImage(image: string): this {
    this.doc.update(this.from, { image });
    return this;
  }

  setPlatform(platform: string | undefined): this {
    this.doc.update(this.from, { platform });
    return this;
  }

  /** Appends an instruction at the end of this stage. */
  add(...nodes: Node[]): this {
    const last = this.instructions[this.instructions.length - 1] ?? this.from;
    // Anchor after the last node that belongs to this stage, comments included.
    let anchorIdx = this.doc.indexOf(last);
    const all = this.doc.nodes;
    for (let i = anchorIdx + 1; i < all.length; i++) {
      const n = all[i]!;
      if (isInstruction(n)) break;
      anchorIdx = i;
    }
    this.doc.insertAt(anchorIdx + 1, ...nodes);
    return this;
  }

  /** Inserts instructions immediately after this stage's FROM. */
  addFirst(...nodes: Node[]): this {
    this.doc.insertAfter(this.from, ...nodes);
    return this;
  }

  find<T extends Instruction["type"]>(type: T): Extract<Instruction, { type: T }>[] {
    return this.instructions.filter((i): i is Extract<Instruction, { type: T }> => i.type === type);
  }

  /** ENV values declared in this stage, later declarations winning. */
  get env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const inst of this.find("Env")) for (const p of inst.pairs) out[p.key] = p.value;
    return out;
  }

  /** Sets an ENV, updating an existing pair in place when one exists. */
  setEnv(key: string, value: string): this {
    for (const inst of this.find("Env")) {
      const pair = inst.pairs.find((p) => p.key === key);
      if (pair) {
        pair.value = value;
        pair.noDelim = false;
        this.doc.touch(inst);
        return this;
      }
    }
    return this.add(build.env({ [key]: value }));
  }

  removeEnv(key: string): boolean {
    let found = false;
    for (const inst of this.find("Env")) {
      const before = inst.pairs.length;
      inst.pairs = inst.pairs.filter((p) => p.key !== key);
      if (inst.pairs.length !== before) {
        found = true;
        if (inst.pairs.length === 0) this.doc.remove(inst);
        else this.doc.touch(inst);
      }
    }
    return found;
  }

  get labels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const inst of this.find("Label")) for (const p of inst.pairs) out[p.key] = p.value;
    return out;
  }

  setLabel(key: string, value: string): this {
    for (const inst of this.find("Label")) {
      const pair = inst.pairs.find((p) => p.key === key);
      if (pair) {
        pair.value = value;
        this.doc.touch(inst);
        return this;
      }
    }
    return this.add(build.label({ [key]: value }));
  }

  toString(): string {
    return [this.from, ...this.instructions].map((i) => formatInstruction(i)).join("\n");
  }
}

export { build as builders };
