import { Reader, Writer, WireType } from "../llb/protobuf.ts";
import { encodeDefinition, type Definition, type Platform } from "../llb/ops.ts";

/**
 * Wire encoding for the subset of `moby.buildkit.v1.frontend.LLBBridge` a
 * Dockerfile frontend needs: read the Dockerfile, resolve base images, solve
 * the generated LLB, and return the result with its image config.
 */

export interface Ref {
  id: string;
  def?: Definition;
}

export interface Result {
  ref?: Ref;
  refs?: Record<string, Ref>;
  metadata?: Record<string, Uint8Array>;
}

// --- Requests ---------------------------------------------------------------

export interface SolveRequest {
  definition?: Definition;
  frontend?: string;
  frontendOpt?: Record<string, string>;
  allowResultReturn?: boolean;
  allowResultArrayRef?: boolean;
  evaluate?: boolean;
}

export function encodeSolveRequest(req: SolveRequest): Uint8Array {
  const w = new Writer();
  if (req.definition) w.bytesField(1, encodeDefinition(req.definition), { always: true });
  w.stringField(2, req.frontend ?? "");
  w.mapField(3, req.frontendOpt ?? {}, (sub, v) => sub.stringField(2, v, { always: true }));
  w.boolField(5, req.allowResultReturn ?? false);
  w.boolField(6, req.allowResultArrayRef ?? false);
  w.boolField(14, req.evaluate ?? false);
  return w.finish();
}

export interface ReadFileRequest {
  ref: string;
  filePath: string;
  range?: { offset: number; length: number };
}

export function encodeReadFileRequest(req: ReadFileRequest): Uint8Array {
  const w = new Writer();
  w.stringField(1, req.ref);
  w.stringField(2, req.filePath);
  if (req.range) {
    w.messageField(3, (sub) => {
      sub.varintField(1, req.range!.offset);
      sub.varintField(2, req.range!.length);
    });
  }
  return w.finish();
}

export interface ResolveImageConfigRequest {
  ref: string;
  platform?: Platform;
  resolveMode?: string;
  logName?: string;
  sessionID?: string;
}

export function encodeResolveImageConfigRequest(req: ResolveImageConfigRequest): Uint8Array {
  const w = new Writer();
  w.stringField(1, req.ref);
  if (req.platform) {
    w.messageField(2, (sub) => {
      sub.stringField(1, req.platform!.Architecture);
      sub.stringField(2, req.platform!.OS);
      sub.stringField(3, req.platform!.Variant ?? "");
      sub.stringField(4, req.platform!.OSVersion ?? "");
    });
  }
  w.stringField(3, req.resolveMode ?? "");
  w.stringField(4, req.logName ?? "");
  w.stringField(6, req.sessionID ?? "");
  return w.finish();
}

function encodeRef(w: Writer, ref: Ref) {
  w.stringField(1, ref.id);
  if (ref.def) w.bytesField(2, encodeDefinition(ref.def), { always: true });
}

export function encodeResult(result: Result): Uint8Array {
  const w = new Writer();
  if (result.ref) w.messageField(3, (sub) => encodeRef(sub, result.ref!));
  if (result.refs) {
    w.messageField(4, (sub) => {
      sub.mapField(1, result.refs!, (s2, v) => s2.messageField(2, (s3) => encodeRef(s3, v)));
    });
  }
  w.mapField(10, result.metadata ?? {}, (sub, v) => sub.bytesField(2, v, { always: true }));
  return w.finish();
}

export interface ReturnRequest {
  result?: Result;
  error?: { code: number; message: string };
}

export function encodeReturnRequest(req: ReturnRequest): Uint8Array {
  const w = new Writer();
  if (req.result) w.bytesField(1, encodeResult(req.result), { always: true });
  if (req.error) {
    // google.rpc.Status { code = 1, message = 2 }
    w.messageField(2, (sub) => {
      sub.varintField(1, req.error!.code);
      sub.stringField(2, req.error!.message);
    });
  }
  return w.finish();
}

export interface WarnRequest {
  digest?: string;
  level?: number;
  short?: string;
  detail?: string[];
  url?: string;
}

export function encodeWarnRequest(req: WarnRequest): Uint8Array {
  const w = new Writer();
  const enc = new TextEncoder();
  w.stringField(1, req.digest ?? "");
  w.varintField(2, req.level ?? 0);
  w.bytesField(3, enc.encode(req.short ?? ""));
  for (const d of req.detail ?? []) w.bytesField(4, enc.encode(d), { always: true });
  w.stringField(5, req.url ?? "");
  return w.finish();
}

export function encodeEmpty(): Uint8Array {
  return new Uint8Array();
}

// --- Responses --------------------------------------------------------------

export function decodeRef(bytes: Uint8Array): Ref {
  const r = new Reader(bytes);
  const ref: Ref = { id: "" };
  while (!r.eof) {
    const f = r.next();
    if (f.field === 1 && f.wire === WireType.Bytes) ref.id = Reader.decodeString(f.bytes!);
  }
  return ref;
}

export function decodeResult(bytes: Uint8Array): Result {
  const r = new Reader(bytes);
  const result: Result = {};
  while (!r.eof) {
    const f = r.next();
    if (f.wire !== WireType.Bytes) continue;
    switch (f.field) {
      case 3:
        result.ref = decodeRef(f.bytes!);
        break;
      case 4: {
        result.refs = {};
        const inner = new Reader(f.bytes!);
        while (!inner.eof) {
          const entry = inner.next();
          if (entry.field !== 1 || entry.wire !== WireType.Bytes) continue;
          const kv = new Reader(entry.bytes!);
          let key = "";
          let value: Ref = { id: "" };
          while (!kv.eof) {
            const kf = kv.next();
            if (kf.field === 1 && kf.wire === WireType.Bytes) key = Reader.decodeString(kf.bytes!);
            if (kf.field === 2 && kf.wire === WireType.Bytes) value = decodeRef(kf.bytes!);
          }
          result.refs[key] = value;
        }
        break;
      }
      case 10: {
        result.metadata ??= {};
        const kv = new Reader(f.bytes!);
        let key = "";
        let value: Uint8Array = new Uint8Array();
        while (!kv.eof) {
          const kf = kv.next();
          if (kf.field === 1 && kf.wire === WireType.Bytes) key = Reader.decodeString(kf.bytes!);
          if (kf.field === 2 && kf.wire === WireType.Bytes) value = new Uint8Array(kf.bytes!);
        }
        result.metadata[key] = value;
        break;
      }
    }
  }
  return result;
}

export interface SolveResponse {
  /** Deprecated single-ref form, still returned by older daemons. */
  ref?: string;
  result?: Result;
}

export function decodeSolveResponse(bytes: Uint8Array): SolveResponse {
  const r = new Reader(bytes);
  const out: SolveResponse = {};
  while (!r.eof) {
    const f = r.next();
    if (f.wire !== WireType.Bytes) continue;
    if (f.field === 1) out.ref = Reader.decodeString(f.bytes!);
    if (f.field === 3) out.result = decodeResult(f.bytes!);
  }
  return out;
}

export function decodeReadFileResponse(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  while (!r.eof) {
    const f = r.next();
    if (f.field === 1 && f.wire === WireType.Bytes) return f.bytes!;
  }
  return new Uint8Array();
}

export interface ResolveImageConfigResponse {
  digest: string;
  config: Uint8Array;
  ref: string;
}

export function decodeResolveImageConfigResponse(bytes: Uint8Array): ResolveImageConfigResponse {
  const r = new Reader(bytes);
  const out: ResolveImageConfigResponse = { digest: "", config: new Uint8Array(), ref: "" };
  while (!r.eof) {
    const f = r.next();
    if (f.wire !== WireType.Bytes) continue;
    if (f.field === 1) out.digest = Reader.decodeString(f.bytes!);
    if (f.field === 2) out.config = f.bytes!;
    if (f.field === 3) out.ref = Reader.decodeString(f.bytes!);
  }
  return out;
}
