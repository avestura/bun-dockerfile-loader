import { describe, expect, test } from "bun:test";
import http2 from "node:http2";
import type { Duplex } from "node:stream";
import { connect } from "node:net";
import { runFrontend, optsFromEnv, convertOptionsFromFrontendOpts } from "../src/frontend/main.ts";
import { GrpcClient } from "../src/frontend/grpc.ts";
import { Reader, Writer } from "../src/llb/protobuf.ts";
import type { Image } from "../src/convert/image.ts";

/**
 * Exercises the gateway frontend end to end against an in-process stand-in for
 * buildkitd: real HTTP/2, real gRPC framing, real protobuf on both sides.
 *
 * What this cannot cover is the daemon's own behaviour, so the frontend has
 * still to be smoke-tested against a real BuildKit before it is relied on.
 */

const SERVICE = "/moby.buildkit.v1.frontend.LLBBridge/";

const DOCKERFILE = `FROM alpine:3.20
WORKDIR /app
ENV MODE=prod
COPY app.js .
CMD ["node", "app.js"]
`;

const BASE_CONFIG = JSON.stringify({
  architecture: "amd64",
  os: "linux",
  config: { Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], Cmd: ["/bin/sh"] },
  rootfs: { type: "layers", diff_ids: ["sha256:aaaa"] },
  history: [{ created_by: "base" }],
});

interface Recorded {
  solves: { definitionBytes: number; allowResultReturn: boolean }[];
  readFiles: { ref: string; path: string }[];
  resolves: { ref: string; logName: string }[];
  returned?: { refID: string; metadata: Record<string, string>; errorMessage?: string };
  pings: number;
  warns: string[];
}

/** Reads the first-level fields of a protobuf message, for assertions. */
function fields(bytes: Uint8Array): Map<number, { varint?: bigint; bytes?: Uint8Array }[]> {
  const out = new Map<number, { varint?: bigint; bytes?: Uint8Array }[]>();
  const r = new Reader(bytes);
  while (!r.eof) {
    const f = r.next();
    const list = out.get(f.field) ?? [];
    list.push({ varint: f.varint, bytes: f.bytes });
    out.set(f.field, list);
  }
  return out;
}

function str(bytes: Uint8Array | undefined): string {
  return bytes ? Reader.decodeString(bytes) : "";
}

interface FakeGateway {
  /** The duplex to hand the frontend, standing in for its stdio pipe. */
  clientSide: Duplex;
  recorded: Recorded;
  done: Promise<void>;
  close: () => void;
}

/**
 * An in-process LLBBridge server.
 *
 * It listens on a loopback port and the frontend is given the raw socket, so
 * the transport is a real duplex handed to `createConnection` — exactly how the
 * frontend consumes BuildKit's stdio pipe.
 */
async function fakeGateway(): Promise<FakeGateway> {
  const recorded: Recorded = { solves: [], readFiles: [], resolves: [], pings: 0, warns: [] };
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const server = http2.createServer();
  server.on("stream", async (stream, headers) => {
    const path = String(headers[":path"]);
    const body = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const request = GrpcClient.unframe(body)[0] ?? new Uint8Array();
    let response: Uint8Array<ArrayBufferLike> = new Uint8Array();

    switch (path) {
      case SERVICE + "Ping":
        recorded.pings++;
        break;

      case SERVICE + "Solve": {
        const f = fields(request);
        const def = f.get(1)?.[0]?.bytes;
        recorded.solves.push({
          definitionBytes: def?.length ?? 0,
          allowResultReturn: (f.get(5)?.[0]?.varint ?? 0n) === 1n,
        });
        // SolveResponse{ result: Result{ ref: Ref{ id } } }
        const id = "ref-" + recorded.solves.length;
        const w = new Writer();
        w.messageField(3, (res) => res.messageField(3, (ref) => ref.stringField(1, id)));
        response = w.finish();
        break;
      }

      case SERVICE + "ReadFile": {
        const f = fields(request);
        recorded.readFiles.push({ ref: str(f.get(1)?.[0]?.bytes), path: str(f.get(2)?.[0]?.bytes) });
        const w = new Writer();
        w.bytesField(1, new Uint8Array(new TextEncoder().encode(DOCKERFILE)), { always: true });
        response = w.finish();
        break;
      }

      case SERVICE + "ResolveImageConfig": {
        const f = fields(request);
        recorded.resolves.push({
          ref: str(f.get(1)?.[0]?.bytes),
          logName: str(f.get(4)?.[0]?.bytes),
        });
        const w = new Writer();
        w.stringField(1, "sha256:" + "0".repeat(64));
        w.bytesField(2, new Uint8Array(new TextEncoder().encode(BASE_CONFIG)), { always: true });
        w.stringField(3, "docker.io/library/alpine:3.20@sha256:" + "0".repeat(64));
        response = w.finish();
        break;
      }

      case SERVICE + "Warn": {
        recorded.warns.push(str(fields(request).get(3)?.[0]?.bytes));
        break;
      }

      case SERVICE + "Return": {
        const f = fields(request);
        const resultBytes = f.get(1)?.[0]?.bytes;
        const errBytes = f.get(2)?.[0]?.bytes;
        const metadata: Record<string, string> = {};
        let refID = "";
        if (resultBytes) {
          const rf = fields(resultBytes);
          const ref = rf.get(3)?.[0]?.bytes;
          if (ref) refID = str(fields(ref).get(1)?.[0]?.bytes);
          for (const entry of rf.get(10) ?? []) {
            const kv = fields(entry.bytes!);
            metadata[str(kv.get(1)?.[0]?.bytes)] = str(kv.get(2)?.[0]?.bytes);
          }
        }
        recorded.returned = {
          refID,
          metadata,
          errorMessage: errBytes ? str(fields(errBytes).get(2)?.[0]?.bytes) : undefined,
        };
        resolveDone!();
        break;
      }
    }

    if (stream.destroyed) return;
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    stream.write(GrpcClient.frame(response));
    stream.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  return {
    clientSide: socket,
    recorded,
    done,
    close: () => {
      socket.destroy();
      server.close();
    },
  };
}

describe("gateway frontend", () => {
  test("reads frontend options out of the environment", () => {
    const opts = optsFromEnv({
      BUILDKIT_FRONTEND_OPT_0: "filename=Dockerfile.prod",
      BUILDKIT_FRONTEND_OPT_1: "build-arg:VERSION=1.2.3",
      BUILDKIT_FRONTEND_OPT_2: "no-cache",
      UNRELATED: "ignored",
    });
    expect(opts).toEqual({
      filename: "Dockerfile.prod",
      "build-arg:VERSION": "1.2.3",
      "no-cache": "",
    });
  });

  test("maps frontend options onto converter options", () => {
    const converted = convertOptionsFromFrontendOpts(
      {
        filename: "Dockerfile.prod",
        target: "runtime",
        "build-arg:VERSION": "1.2.3",
        "label:org.opencontainers.image.source": "https://example.com",
        platform: "linux/arm64",
        "no-cache": "",
      },
      "sess-1",
    );
    expect(converted.filename).toBe("Dockerfile.prod");
    expect(converted.target).toBe("runtime");
    expect(converted.buildArgs).toEqual({ VERSION: "1.2.3" });
    expect(converted.labels).toEqual({ "org.opencontainers.image.source": "https://example.com" });
    expect(converted.targetPlatform).toEqual({ OS: "linux", Architecture: "arm64" });
    expect(converted.ignoreCache).toBe(true);
    expect(converted.sessionID).toBe("sess-1");
  });

  test("runs a full build against a stand-in gateway", async () => {
    const gw = await fakeGateway();

    await runFrontend({
      stream: gw.clientSide,
      env: {
        BUILDKIT_SESSION_ID: "sess-xyz",
        BUILDKIT_FRONTEND_OPT_0: "filename=Dockerfile",
        BUILDKIT_FRONTEND_OPT_1: "build-arg:MODE=prod",
      } as NodeJS.ProcessEnv,
    });

    await gw.done;
    const rec = gw.recorded;

    expect(rec.pings).toBe(1);
    // One solve for the dockerfile context, one for the generated definition.
    expect(rec.solves).toHaveLength(2);
    expect(rec.solves[0]!.allowResultReturn).toBe(true);
    expect(rec.solves[1]!.definitionBytes).toBeGreaterThan(rec.solves[0]!.definitionBytes);

    expect(rec.readFiles).toEqual([{ ref: "ref-1", path: "Dockerfile" }]);

    expect(rec.resolves).toHaveLength(1);
    expect(rec.resolves[0]!.ref).toBe("docker.io/library/alpine:3.20");
    expect(rec.resolves[0]!.logName).toContain("load metadata for");

    expect(rec.returned).toBeDefined();
    expect(rec.returned!.errorMessage).toBeUndefined();
    expect(rec.returned!.refID).toBe("ref-2");

    // The image config is what a raw LLB build cannot carry.
    const config = JSON.parse(rec.returned!.metadata["containerimage.config"]!) as Image;
    expect(config.config.WorkingDir).toBe("/app");
    expect(config.config.Cmd).toEqual(["node", "app.js"]);
    expect(config.config.Env).toContain("MODE=prod");
    expect(config.os).toBe("linux");
    expect(config.architecture).toBe("amd64");
    gw.close();
  });

  test("reports a build failure back through Return", async () => {
    const gw = await fakeGateway();

    const failing = runFrontend({
      stream: gw.clientSide,
      env: {
        BUILDKIT_SESSION_ID: "sess-xyz",
        // A stage that does not exist makes the converter throw.
        BUILDKIT_FRONTEND_OPT_0: "target=nope",
      } as NodeJS.ProcessEnv,
    });

    await expect(failing).rejects.toThrow();
    await gw.done;
    expect(gw.recorded.returned!.errorMessage).toContain("nope");
    gw.close();
  });
});
