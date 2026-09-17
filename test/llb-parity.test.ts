import { describe, expect, test } from "bun:test";
import {
  diff,
  file,
  image,
  local,
  marshalState,
  merge,
  run,
  State,
  type FileActionSpec,
} from "../src/llb/state.ts";
import { CacheSharingOpt, NetMode, SecurityMode } from "../src/llb/ops.ts";
import { digestOf } from "../src/llb/digest.ts";

/**
 * Byte-for-byte parity with `github.com/moby/buildkit/client/llb`.
 *
 * `llb-golden.json` is produced by `llb-golden.go` (same directory), which
 * builds the same graphs with the real Go client and dumps every marshaled Op
 * as hex. Regenerate with:
 *
 *   go run test/fixtures/llb-golden.go > test/fixtures/llb-golden.json
 *
 * Any encoder drift shows up here as a hex or digest mismatch.
 */
import golden from "./fixtures/llb-golden.json" with { type: "json" };

const PLATFORM = { Architecture: "amd64", OS: "linux" };

function goldenFor(name: string): { digests: string[]; hexes: string[] } {
  const g = (golden as { name: string; digests: string[]; hexes: string[] }[]).find(
    (x) => x.name === name,
  );
  if (!g) throw new Error("no golden graph named " + name);
  return g;
}

// --- Graphs, mirroring llb-golden.go one for one ----------------------------

function basic(): State {
  const base = image("docker.io/library/alpine:latest", { platform: PLATFORM });
  const src = local("context", { sessionID: "SESSION", sharedKeyHint: "ctx" });

  const step1 = run(base.dir("/app").addEnv("FOO", "bar").user("root"), {
    args: ["/bin/sh", "-c", "echo hi > /out.txt"],
    description: { "llb.customname": "build it" },
  }).root;

  const copied = file(
    step1,
    [
      {
        kind: "copy",
        from: src,
        src: "/pkg.json",
        dest: "/app/pkg.json",
        followSymlink: true,
        dirCopyContents: true,
        attemptUnpack: true,
        createDestPath: true,
        allowWildcard: true,
        allowEmptyWildcard: true,
      },
    ],
    { description: { "llb.customname": "copy pkg" } },
  );

  return run(copied, {
    args: ["/bin/sh", "-c", "make"],
    mounts: [
      { target: "/root/.cache", cacheID: "cacheid", cacheSharing: CacheSharingOpt.SHARED },
      { target: "/src", source: src, readonly: true },
    ],
  }).root;
}

function mounts(): State {
  const base = image("docker.io/library/debian:bookworm", { platform: PLATFORM });
  const src = local("context", { sessionID: "S" });
  return run(base.dir("/w"), {
    args: ["/bin/sh", "-c", "build"],
    network: NetMode.NONE,
    security: SecurityMode.INSECURE,
    mounts: [
      { target: "/tmpdir", tmpfs: true, tmpfsSize: 4096 },
      { target: "/bind", source: src, selector: "/sub", readonly: true },
      { target: "/cache", cacheID: "np/cid", cacheSharing: CacheSharingOpt.LOCKED },
      { target: "/run/secrets/tok", secret: { id: "tok", uid: 1000, gid: 1000, mode: 0o400 } },
      { target: "/run/ssh.sock", ssh: { id: "default" } },
    ],
  }).root;
}

function files(): State {
  const base = image("docker.io/library/busybox:1", { platform: PLATFORM });
  const src = local("context", { sessionID: "S" });

  let st = file(
    base,
    [{ kind: "mkdir", path: "/app/nested", mode: 0o755, makeParents: true, owner: { user: { byName: { name: "nobody", input: 0 } } } }],
    { description: { "llb.customname": "mkdir" } },
  );

  const chained: FileActionSpec[] = [
    { kind: "mkfile", path: "/app/run.sh", mode: 0o755, data: new TextEncoder().encode("#!/bin/sh\necho hi\n") },
    { kind: "mkdir", path: "/data", mode: 0o700, makeParents: true },
    { kind: "rm", path: "/app/old", allowNotFound: true, allowWildcard: true },
  ];
  st = file(st, chained, { description: { "llb.customname": "chained" } });

  return file(
    st,
    [
      {
        kind: "copy",
        from: src,
        src: "/etc",
        dest: "/app/etc",
        owner: { user: { byID: 1000 }, group: { byName: { name: "grp", input: 0 } } },
        mode: 0o640,
        includePatterns: ["*.conf"],
        excludePatterns: ["secret*"],
        createDestPath: true,
      },
    ],
    { description: { "llb.customname": "copy etc" } },
  );
}

function mergediff(): State {
  const img = () => image("docker.io/library/alpine:3", { platform: PLATFORM });
  const a = run(img(), { args: ["/bin/sh", "-c", "a"] }).root;
  const b = run(img(), { args: ["/bin/sh", "-c", "b"] }).root;
  const m = merge([a, b], { description: { "llb.customname": "merge ab" } });
  return diff(a, m, { description: { "llb.customname": "diff" } });
}

// --- Assertions -------------------------------------------------------------

const GRAPHS: [string, () => State][] = [
  ["basic", basic],
  ["mounts", mounts],
  ["files", files],
  ["mergediff", mergediff],
];

describe("LLB wire format parity with moby/buildkit", () => {
  for (const [name, build] of GRAPHS) {
    describe(name, () => {
      const def = marshalState(build());
      const want = goldenFor(name);

      test("emits the same vertices", () => {
        expect(def.def.length).toBe(want.digests.length);
      });

      test("marshals byte for byte like Go", () => {
        expect(def.def.map((b) => Buffer.from(b).toString("hex"))).toEqual(want.hexes);
      });

      test("computes the same vertex digests", () => {
        expect(def.def.map(digestOf)).toEqual(want.digests);
      });

      test("is stable across repeated marshaling", () => {
        expect(marshalState(build()).def.map(digestOf)).toEqual(def.def.map(digestOf));
      });
    });
  }

  test("scratch marshals to an empty definition", () => {
    const def = marshalState(State.scratch());
    expect(def.def).toEqual([]);
    expect(def.ops).toEqual([]);
  });
});
