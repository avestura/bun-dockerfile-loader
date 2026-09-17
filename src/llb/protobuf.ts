/**
 * A minimal proto3 encoder/decoder, deterministic in the same way Go's
 * `proto.MarshalOptions{Deterministic: true}` is.
 *
 * BuildKit content-addresses every LLB vertex by the SHA-256 of its marshaled
 * bytes, so the byte layout has to match Go exactly:
 *   - fields emitted in ascending field number,
 *   - proto3 implicit presence (zero-valued scalars omitted),
 *   - map entries sorted by key and always emitting both key and value.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  Bytes = 2,
  Fixed32 = 5,
}

export class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private pushByte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  rawVarint(value: bigint) {
    let v = value;
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        this.pushByte(byte);
        return;
      }
      this.pushByte(byte | 0x80);
    }
  }

  tag(field: number, wire: WireType) {
    this.rawVarint(BigInt((field << 3) | wire));
  }

  rawBytes(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }

  // --- proto3 field writers ------------------------------------------------

  /** int32/int64/uint32/uint64/bool/enum share varint encoding. */
  varintField(field: number, value: number | bigint, { always = false } = {}) {
    const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (v === 0n && !always) return;
    this.tag(field, WireType.Varint);
    // Negative values are encoded as their 64-bit two's complement, which is
    // always ten bytes; this is what Go does for int32 and int64 alike.
    this.rawVarint(v < 0n ? BigInt.asUintN(64, v) : v);
  }

  boolField(field: number, value: boolean, { always = false } = {}) {
    if (!value && !always) return;
    this.tag(field, WireType.Varint);
    this.rawVarint(value ? 1n : 0n);
  }

  stringField(field: number, value: string, { always = false } = {}) {
    if (value === "" && !always) return;
    this.bytesField(field, textEncoder.encode(value), { always: true });
  }

  bytesField(field: number, value: Uint8Array, { always = false } = {}) {
    if (value.length === 0 && !always) return;
    this.tag(field, WireType.Bytes);
    this.rawVarint(BigInt(value.length));
    this.rawBytes(value);
  }

  /** Writes a nested message. A present-but-empty message still emits a tag. */
  messageField(field: number, encode: (w: Writer) => void) {
    const sub = new Writer();
    encode(sub);
    this.bytesField(field, sub.finish(), { always: true });
  }

  repeatedString(field: number, values: readonly string[]) {
    for (const v of values) this.stringField(field, v, { always: true });
  }

  repeatedMessage<T>(field: number, values: readonly T[], encode: (w: Writer, v: T) => void) {
    for (const v of values) this.messageField(field, (w) => encode(w, v));
  }

  /** Repeated varints in the non-packed form Go uses for `repeated int32`. */
  repeatedVarint(field: number, values: readonly number[]) {
    if (values.length === 0) return;
    // proto3 packs repeated scalars by default.
    const sub = new Writer();
    for (const v of values) sub.rawVarint(v < 0 ? BigInt.asUintN(64, BigInt(v)) : BigInt(v));
    this.bytesField(field, sub.finish(), { always: true });
  }

  /**
   * Writes a `map<string, V>` as repeated entry messages, sorted by the UTF-8
   * bytes of the key. Both key and value are always emitted, even when empty.
   */
  mapField<V>(field: number, entries: Record<string, V> | Map<string, V>, writeValue: (w: Writer, v: V) => void) {
    const pairs: [string, V][] =
      entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
    if (pairs.length === 0) return;
    pairs.sort((a, b) => compareUtf8(a[0], b[0]));
    for (const [k, v] of pairs) {
      this.messageField(field, (w) => {
        w.stringField(1, k, { always: true });
        writeValue(w, v);
      });
    }
  }
}

/** Orders strings by their UTF-8 bytes, the way Go compares map keys. */
export function compareUtf8(a: string, b: string): number {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i]! !== bb[i]!) return ab[i]! - bb[i]!;
  }
  return ab.length - bb.length;
}

export interface Field {
  field: number;
  wire: WireType;
  varint?: bigint;
  bytes?: Uint8Array;
}

export class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  rawVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("protobuf: varint too long");
    }
  }

  next(): Field {
    const key = this.rawVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n) as WireType;
    switch (wire) {
      case WireType.Varint:
        return { field, wire, varint: this.rawVarint() };
      case WireType.Fixed64: {
        const bytes = this.buf.subarray(this.pos, this.pos + 8);
        this.pos += 8;
        return { field, wire, bytes };
      }
      case WireType.Fixed32: {
        const bytes = this.buf.subarray(this.pos, this.pos + 4);
        this.pos += 4;
        return { field, wire, bytes };
      }
      case WireType.Bytes: {
        const len = Number(this.rawVarint());
        const bytes = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return { field, wire, bytes };
      }
      default:
        throw new Error("protobuf: unsupported wire type " + wire);
    }
  }

  static decodeString(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
  }

  /** Reinterprets a varint as a signed 64-bit value. */
  static asInt64(v: bigint): bigint {
    return BigInt.asIntN(64, v);
  }
}
