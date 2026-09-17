import type { MarshaledDefinition } from "./state.ts";
import type { Op, OpMetadata } from "./ops.ts";

/**
 * Renders a definition the way `buildctl debug dump-llb` does: one JSON object
 * per vertex, so output can be diffed directly against real BuildKit.
 *
 * Field names follow the protobuf JSON tags in `solver/pb`, including the
 * capitalised outer keys from `cmd/buildctl/debug/dumpllb.go`.
 */

interface JSONOp {
  inputs?: unknown;
  Op: Record<string, unknown>;
  platform?: unknown;
  constraints?: unknown;
}

function omitEmpty<T extends Record<string, unknown>>(obj: T): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (v === "" || v === 0 || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function opToJSON(op: Op): JSONOp {
  const inner: Record<string, unknown> = {};
  if (op.exec) inner.exec = pruneDeep(op.exec);
  if (op.source) inner.source = pruneDeep(op.source);
  if (op.file) inner.file = pruneDeep(op.file);
  if (op.merge) inner.merge = pruneDeep(op.merge);
  if (op.diff) inner.diff = pruneDeep(op.diff);

  const out: JSONOp = { Op: inner };
  if (op.inputs.length) out.inputs = op.inputs.map((i) => ({ digest: i.digest, index: i.index || undefined }));
  if (op.platform) out.platform = pruneDeep(op.platform);
  if (op.constraints) out.constraints = pruneDeep(op.constraints) ?? {};
  return out;
}

/** Drops zero-valued fields the way Go's `json:",omitempty"` tags do. */
function pruneDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneDeep);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value && typeof value === "object") {
    const pruned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = pruneDeep(v);
      if (p === undefined || p === null) continue;
      if (p === "" || p === 0 || p === false) continue;
      if (Array.isArray(p) && p.length === 0) continue;
      pruned[k] = p;
    }
    return pruned;
  }
  return value;
}

export interface DumpEntry {
  Op: JSONOp;
  Digest: string;
  OpMetadata?: Record<string, unknown>;
}

export function toDumpEntries(def: MarshaledDefinition): DumpEntry[] {
  return def.ops.map((entry) => {
    const out: DumpEntry = { Op: opToJSON(entry.op), Digest: entry.digest };
    const md = entry.metadata ?? def.metadata[entry.digest];
    if (md) out.OpMetadata = metadataToJSON(md);
    return out;
  });
}

function metadataToJSON(md: OpMetadata): Record<string, unknown> {
  return (
    omitEmpty({
      ignore_cache: md.ignore_cache,
      description: md.description,
      export_cache: md.export_cache,
      caps: md.caps,
      progress_group: md.progress_group,
      linux_resources: md.linux_resources,
    }) ?? {}
  );
}

/** Newline-delimited JSON, matching `buildctl debug dump-llb` byte layout. */
export function dumpLLB(def: MarshaledDefinition): string {
  return toDumpEntries(def)
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
}

/** Graphviz output, matching `buildctl debug dump-llb --dot`. */
export function dumpDot(def: MarshaledDefinition): string {
  const lines = ["digraph {"];
  for (const entry of def.ops) {
    const { name, shape } = describe(entry.op, entry.digest);
    lines.push(`  ${JSON.stringify(entry.digest)} [label=${JSON.stringify(name)} shape=${JSON.stringify(shape)}];`);
  }
  for (const entry of def.ops) {
    for (const input of entry.op.inputs) {
      lines.push(`  ${JSON.stringify(input.digest)} -> ${JSON.stringify(entry.digest)};`);
    }
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function describe(op: Op, digest: string): { name: string; shape: string } {
  if (op.source) return { name: op.source.identifier, shape: "ellipse" };
  if (op.exec) return { name: op.exec.meta.args.join(" "), shape: "box" };
  if (op.file) return { name: "file " + op.file.actions.length + " action(s)", shape: "note" };
  if (op.merge) return { name: "merge", shape: "invtriangle" };
  if (op.diff) return { name: "diff", shape: "invtriangle" };
  return { name: digest.slice(0, 19), shape: "plaintext" };
}
