import http2 from "node:http2";
import type { Duplex } from "node:stream";

/**
 * A minimal gRPC client for unary calls over an arbitrary duplex stream.
 *
 * BuildKit runs a gateway frontend as a container and speaks gRPC to it over
 * the container's stdin/stdout, so the transport cannot be a socket dialled by
 * address. Node's HTTP/2 client accepts a `createConnection` hook, which lets
 * the whole session ride on that pipe.
 */

export class GrpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super("grpc error " + code + ": " + message);
    this.name = "GrpcError";
  }
}

/** gRPC status codes that matter here. */
export const Status = { OK: 0, UNKNOWN: 2, NOT_FOUND: 5, UNIMPLEMENTED: 12 } as const;

export interface GrpcClientOptions {
  /** Authority pseudo-header; BuildKit does not check it. */
  authority?: string;
  /** Milliseconds before a call is abandoned. */
  timeout?: number;
}

export class GrpcClient {
  private session: http2.ClientHttp2Session;
  private closed = false;

  constructor(
    stream: Duplex,
    private readonly opts: GrpcClientOptions = {},
  ) {
    this.session = http2.connect("http://" + (opts.authority ?? "localhost"), {
      createConnection: () => stream as never,
    });
    this.session.on("error", () => {
      this.closed = true;
    });
  }

  /** Frames one protobuf message the way gRPC expects: flag + length + body. */
  static frame(payload: Uint8Array): Buffer {
    const out = Buffer.allocUnsafe(5 + payload.length);
    out[0] = 0; // not compressed
    out.writeUInt32BE(payload.length, 1);
    Buffer.from(payload).copy(out, 5);
    return out;
  }

  /** Splits a concatenated gRPC body into its individual messages. */
  static unframe(body: Buffer): Uint8Array[] {
    const out: Uint8Array[] = [];
    let offset = 0;
    while (offset + 5 <= body.length) {
      const compressed = body[offset]!;
      const length = body.readUInt32BE(offset + 1);
      if (compressed) throw new GrpcError(Status.UNKNOWN, "compressed gRPC messages are not supported");
      if (offset + 5 + length > body.length) break;
      out.push(new Uint8Array(body.subarray(offset + 5, offset + 5 + length)));
      offset += 5 + length;
    }
    return out;
  }

  /** Performs a unary call and returns the single response message. */
  call(path: string, request: Uint8Array): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new GrpcError(Status.UNKNOWN, "session is closed"));

    return new Promise((resolve, reject) => {
      const req = this.session.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/grpc+proto",
        te: "trailers",
      });

      const chunks: Buffer[] = [];
      let status: number = Status.OK;
      let message = "";
      let settled = false;

      const timer = this.opts.timeout
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            req.close(http2.constants.NGHTTP2_CANCEL);
            reject(new GrpcError(Status.UNKNOWN, "call to " + path + " timed out"));
          }, this.opts.timeout)
        : null;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      };

      req.on("error", fail);
      // gRPC reports the real outcome in trailers, not in the HTTP status.
      req.on("response", (headers) => {
        const inline = headers["grpc-status"];
        if (inline !== undefined) status = Number(inline);
        const msg = headers["grpc-message"];
        if (typeof msg === "string") message = decodeURIComponent(msg);
      });
      req.on("trailers", (trailers) => {
        const s = trailers["grpc-status"];
        if (s !== undefined) status = Number(s);
        const m = trailers["grpc-message"];
        if (typeof m === "string") message = decodeURIComponent(m);
      });
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (status !== Status.OK) return reject(new GrpcError(status, message || "call failed"));
        const messages = GrpcClient.unframe(Buffer.concat(chunks));
        if (messages.length === 0) return resolve(new Uint8Array());
        resolve(messages[0]!);
      });

      req.end(GrpcClient.frame(request));
    });
  }

  close(): void {
    this.closed = true;
    this.session.close();
  }
}
