import type { BunPlugin } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Bun plugin that makes Dockerfiles importable.
 *
 *   import df from "./Dockerfile.prod";
 *   df.stage("build")!.setBaseImage("oven/bun:1.2");
 *   await Bun.write("Dockerfile.prod", df.toString());
 *
 * Works in the bundler (`Bun.build({ plugins: [...] })`) for every file name,
 * and in the runtime (`bunfig.toml` preload) for any name that carries an
 * extension — `Dockerfile.prod`, `app.dockerfile`, `Containerfile.dev`.
 *
 * A bare, extensionless `Dockerfile` cannot be imported at runtime: Bun picks a
 * loader from the extension before plugins are consulted, so the file is parsed
 * as JavaScript and never reaches `onLoad`. Read those with
 * `Dockerfile.fromFile("Dockerfile")` instead.
 */

export interface DockerfileLoaderOptions {
  /**
   * Which files to treat as Dockerfiles. Defaults to `Dockerfile`,
   * `Dockerfile.<suffix>`, `<name>.dockerfile` and `*.Containerfile`.
   */
  filter?: RegExp;
  /**
   * Emit `warnings` as console warnings at import time. Off by default so a
   * build does not become noisy.
   */
  warn?: boolean;
}

/**
 * Matches the names Docker itself recognises. Anchored on a path separator so
 * `my-Dockerfile-helper.ts` is not caught.
 */
export const DEFAULT_FILTER =
  /(?:^|[\\/])(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$|\.(?:dockerfile|containerfile)$/i;

/**
 * Absolute path of the library entrypoint, for the generated module to import.
 *
 * A plain path with forward slashes is used rather than a `file://` URL: the
 * runtime accepts either, but the bundler's resolver only accepts the path.
 */
function libraryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "index.ts").replace(/\\/g, "/");
}

export function dockerfileLoader(options: DockerfileLoaderOptions = {}): BunPlugin {
  const filter = options.filter ?? DEFAULT_FILTER;

  return {
    name: "dockerfile-loader",
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const source = await Bun.file(args.path).text();
        const lib = JSON.stringify(libraryPath());
        const src = JSON.stringify(source);
        const path = JSON.stringify(args.path);

        // The module keeps the raw text and re-parses at runtime, so the
        // resulting document is live and editable rather than a frozen snapshot.
        const contents = `
import { Dockerfile, dockerfileToLLB, encodeDefinition, dumpLLB } from ${lib};

export const source = ${src};
export const path = ${path};

const doc = Dockerfile.parse(source, { filename: path });
${options.warn ? "for (const w of doc.warnings) console.warn('[dockerfile] ' + path + ': ' + w.message);" : ""}

export default doc;
export const ast = doc.ast;
export const warnings = doc.warnings;

/** Compiles this Dockerfile to an LLB definition and image config. */
export function toLLB(opts) {
  return dockerfileToLLB(doc, opts);
}

/** Compiles and serializes to the protobuf bytes \`buildctl build\` reads. */
export async function toLLBBytes(opts) {
  const result = await dockerfileToLLB(doc, opts);
  return encodeDefinition(result.definition);
}

/** Compiles and renders the \`buildctl debug dump-llb\` JSON view. */
export async function toLLBJSON(opts) {
  const result = await dockerfileToLLB(doc, opts);
  return dumpLLB(result.definition);
}
`;
        return { contents, loader: "js" };
      });
    },
  };
}

export default dockerfileLoader;
