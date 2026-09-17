import { describe, expect, test } from "bun:test";
import { CryptoHasher } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dockerfileToLLB } from "../src/convert/dockerfile2llb.ts";
import type { MetaResolver } from "../src/convert/resolver.ts";
import { pinReference } from "../src/convert/resolver.ts";
import { normalizeReference } from "../src/convert/reference.ts";
import type { Image } from "../src/convert/image.ts";
import { digestOf } from "../src/llb/digest.ts";

/**
 * Parity with the real `frontend/dockerfile/dockerfile2llb`.
 *
 * `df-golden.json` is produced by `df-golden.go`, which runs BuildKit's own
 * converter over the same fixtures with a deterministic fake image resolver.
 * Regenerate with:
 *
 *   go run test/fixtures/df-golden.go test/fixtures/dockerfiles > test/fixtures/df-golden.json
 */
import golden from "./fixtures/df-golden.json" with { type: "json" };

interface GoldenEntry {
  name: string;
  digests: string[];
  hexes: string[];
  image: Image;
  metadata: Record<string, { description?: Record<string, string>; caps?: string[] }>;
  err?: string;
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "dockerfiles");
const PLATFORM = { OS: "linux", Architecture: "amd64" };

const BASE_CONFIGS: Record<string, string> = {
  "docker.io/library/alpine:3.20":
    '{"architecture":"amd64","os":"linux","config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Cmd":["/bin/sh"]},"rootfs":{"type":"layers","diff_ids":["sha256:aaaa"]},"history":[{"created_by":"base"}]}',
  "docker.io/library/node:20-alpine":
    '{"architecture":"amd64","os":"linux","config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","NODE_VERSION=20.0.0"],"Cmd":["node"],"WorkingDir":"/srv","User":"node"},"rootfs":{"type":"layers","diff_ids":["sha256:bbbb"]},"history":[{"created_by":"base"}]}',
};

const DEFAULT_CONFIG =
  '{"architecture":"amd64","os":"linux","config":{},"rootfs":{"type":"layers","diff_ids":["sha256:aaaa"]},"history":[{"created_by":"base"}]}';

/** Mirrors the Go harness: `digest.FromString(normalizedRef)`. */
function digestFromString(s: string): string {
  return "sha256:" + new CryptoHasher("sha256").update(s).digest("hex");
}

const fakeResolver: MetaResolver = {
  async resolve(ref) {
    const normalized = normalizeReference(ref);
    const raw = BASE_CONFIGS[normalized] ?? DEFAULT_CONFIG;
    const digest = digestFromString(normalized);
    return { ref: pinReference(normalized, digest), digest, config: JSON.parse(raw) as Image };
  },
};

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".Dockerfile"))
  .sort();

function goldenFor(name: string): GoldenEntry {
  const g = (golden as unknown as GoldenEntry[]).find((x) => x.name === name);
  if (!g) throw new Error("no golden entry for " + name);
  return g;
}

describe("dockerfile2llb parity", () => {
  for (const fixture of fixtures) {
    const name = fixture.replace(/\.Dockerfile$/, "");

    describe(name, () => {
      test("marshals to the same LLB as BuildKit", async () => {
        const source = await Bun.file(join(FIXTURE_DIR, fixture)).text();
        const want = goldenFor(name);
        expect(want.err).toBeUndefined();

        const result = await dockerfileToLLB(source, {
          metaResolver: fakeResolver,
          targetPlatform: PLATFORM,
          buildPlatform: PLATFORM,
          localUniqueID: "fixed-unique-id",
          filename: fixture,
        });

        const ours = result.definition.def.map((b) => Buffer.from(b).toString("hex"));
        expect(ours).toEqual(want.hexes);
        expect(result.definition.def.map(digestOf)).toEqual(want.digests);
      });

      test("produces the same op metadata", async () => {
        const source = await Bun.file(join(FIXTURE_DIR, fixture)).text();
        const want = goldenFor(name);
        const result = await dockerfileToLLB(source, {
          metaResolver: fakeResolver,
          targetPlatform: PLATFORM,
          buildPlatform: PLATFORM,
          localUniqueID: "fixed-unique-id",
          filename: fixture,
        });

        for (const [digest, wantMeta] of Object.entries(want.metadata)) {
          const got = result.definition.metadata[digest];
          expect(got, "missing metadata for " + digest).toBeDefined();
          if (wantMeta.description) {
            expect(got!.description, "description for " + digest).toEqual(wantMeta.description);
          }
          if (wantMeta.caps) {
            expect(Object.keys(got!.caps ?? {}).sort(), "caps for " + digest).toEqual(wantMeta.caps);
          }
        }
      });

      test("produces the same image config", async () => {
        const source = await Bun.file(join(FIXTURE_DIR, fixture)).text();
        const want = goldenFor(name);
        const result = await dockerfileToLLB(source, {
          metaResolver: fakeResolver,
          targetPlatform: PLATFORM,
          buildPlatform: PLATFORM,
          localUniqueID: "fixed-unique-id",
          filename: fixture,
        });

        // Compare the runtime-relevant config; history text and layer digests
        // are produced by the exporter, not the frontend.
        expect(result.image.config).toEqual(want.image.config ?? {});
        expect(result.image.os).toBe(want.image.os);
        expect(result.image.architecture).toBe(want.image.architecture);
      });
    });
  }
});
