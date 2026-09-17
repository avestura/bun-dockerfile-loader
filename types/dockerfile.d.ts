/**
 * Ambient types for imported Dockerfiles.
 *
 * Add to your tsconfig so `import df from "./Dockerfile.prod"` is typed:
 *
 *   { "compilerOptions": { "types": ["bun-dockerfile-loader/types"] } }
 *
 * or reference it directly:
 *
 *   /// <reference types="bun-dockerfile-loader/types" />
 */

declare module "*.dockerfile" {
  import type { Dockerfile, ConvertOptions, ConvertResult, LexWarning, DockerfileAST } from "bun-dockerfile-loader";

  const doc: Dockerfile;
  export default doc;

  /** The file's text, exactly as it was on disk. */
  export const source: string;
  /** Absolute path the document was loaded from. */
  export const path: string;
  export const ast: DockerfileAST;
  export const warnings: LexWarning[];

  export function toLLB(opts?: ConvertOptions): Promise<ConvertResult>;
  export function toLLBBytes(opts?: ConvertOptions): Promise<Uint8Array>;
  export function toLLBJSON(opts?: ConvertOptions): Promise<string>;
}

declare module "*.containerfile" {
  export * from "*.dockerfile";
  export { default } from "*.dockerfile";
}
