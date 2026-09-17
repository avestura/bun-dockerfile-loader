import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import { dockerfileLoader, DEFAULT_FILTER } from "../src/plugin/index.ts";
import { Dockerfile } from "../src/edit/document.ts";

/**
 * The loader itself: `import df from "./Dockerfile"` has to yield a live,
 * editable document, not a string.
 */

const SOURCE = `# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /srv
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS release
COPY . .
CMD ["bun", "start"]
`;

let dir: string;

beforeAll(() => {
  plugin(dockerfileLoader());
  dir = mkdtempSync(join(tmpdir(), "dockerfile-loader-"));
  writeFileSync(join(dir, "Dockerfile"), SOURCE);
  writeFileSync(join(dir, "Dockerfile.stages"), SOURCE);
  writeFileSync(join(dir, "app.dockerfile"), "FROM scratch\nCOPY x /x\n");
  writeFileSync(join(dir, "Dockerfile.prod"), "FROM alpine:3.20\nCMD [\"/app\"]\n");
});

describe("filter", () => {
  const matches = (p: string) => DEFAULT_FILTER.test(p);

  test("matches the names Docker recognises", () => {
    expect(matches("/repo/Dockerfile")).toBe(true);
    expect(matches("/repo/Dockerfile.prod")).toBe(true);
    expect(matches("/repo/app.dockerfile")).toBe(true);
    expect(matches("/repo/Containerfile")).toBe(true);
    expect(matches("C:\\repo\\Dockerfile")).toBe(true);
  });

  test("does not match unrelated files that merely contain the word", () => {
    expect(matches("/repo/dockerfile-utils.ts")).toBe(false);
    expect(matches("/repo/DockerfileParser.js")).toBe(false);
    expect(matches("/repo/src/index.ts")).toBe(false);
  });
});

describe("importing a Dockerfile", () => {
  test("default export is a live document", async () => {
    const mod = (await import(join(dir, "Dockerfile.stages"))) as {
      default: Dockerfile;
      source: string;
      path: string;
    };

    expect(mod.source).toBe(SOURCE);
    expect(mod.path).toBe(join(dir, "Dockerfile.stages"));

    const df = mod.default;
    expect(df.stages.map((s) => s.name)).toEqual(["base", "release"]);
    expect(df.syntax).toBe("docker/dockerfile:1");
  });

  test("edits round-trip through the imported document", async () => {
    const mod = (await import(join(dir, "Dockerfile.stages"))) as { default: Dockerfile };
    const df = mod.default;

    df.stage("base")!.setBaseImage("oven/bun:1.2-alpine");
    df.stage("release")!.setEnv("NODE_ENV", "production");

    const out = df.toString();
    expect(out).toContain("FROM oven/bun:1.2-alpine AS base");
    expect(out).toContain("ENV NODE_ENV=production");
    // Untouched lines keep their original bytes.
    expect(out).toContain("RUN bun install --frozen-lockfile");
  });

  test("exposes an LLB compiler for the imported file", async () => {
    const mod = (await import(join(dir, "Dockerfile.prod"))) as {
      toLLB: (opts?: unknown) => Promise<{ definition: { def: Uint8Array[] } }>;
      toLLBBytes: (opts?: unknown) => Promise<Uint8Array>;
      toLLBJSON: (opts?: unknown) => Promise<string>;
    };

    const result = await mod.toLLB();
    expect(result.definition.def.length).toBeGreaterThan(0);

    const bytes = await mod.toLLBBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);

    const json = await mod.toLLBJSON();
    expect(json.split("\n").filter(Boolean).length).toBe(result.definition.def.length);
    expect(JSON.parse(json.split("\n")[0]!)).toHaveProperty("Digest");
  });

  test("loads the .dockerfile extension too", async () => {
    const mod = (await import(join(dir, "app.dockerfile"))) as { default: Dockerfile };
    expect(mod.default.stages[0]!.baseImage).toBe("scratch");
  });

  test("an extensionless Dockerfile is read through fromFile instead", async () => {
    // Bun chooses a loader from the extension before plugins run, so a bare
    // `Dockerfile` never reaches onLoad at runtime.
    await expect(import(join(dir, "Dockerfile"))).rejects.toThrow();

    const df = await Dockerfile.fromFile(join(dir, "Dockerfile"));
    expect(df.stages.map((s) => s.name)).toEqual(["base", "release"]);
  });
});

describe("bundler", () => {
  test("handles even an extensionless Dockerfile", async () => {
    writeFileSync(
      join(dir, "entry.ts"),
      ['import df from "./Dockerfile";', "export const names = df.stages.map((s) => s.name);", ""].join("\n"),
    );

    const built = await Bun.build({
      entrypoints: [join(dir, "entry.ts")],
      plugins: [dockerfileLoader()],
      target: "bun",
    });

    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();
    expect(code).toContain("FROM oven/bun:1 AS base");
  });
});
