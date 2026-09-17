/**
 * bun-dockerfile-loader
 *
 * Parse, edit and print Dockerfiles, and compile them to BuildKit LLB with
 * byte-for-byte parity against `moby/buildkit`'s own `dockerfile2llb`.
 */

// --- Parsing and editing ----------------------------------------------------
export { Dockerfile, Stage, type DockerfileOptions } from "./edit/document.ts";
export * as builders from "./edit/builders.ts";
export { formatInstruction, formatNode, print, type PrintOptions } from "./edit/printer.ts";
export { parse, DockerfileParseError, type ParseResult } from "./parser/parser.ts";
export { lex, splitWords, findHeredocs, type LexResult, type LexWarning } from "./parser/lexer.ts";
export {
  ShellLex,
  ShellError,
  envsFromMap,
  envsFromSlice,
  convertShellPatternToRegex,
  type EnvGetter,
  type ProcessWordResult,
} from "./parser/shell.ts";
export type * from "./parser/ast.ts";
export { isInstruction } from "./parser/ast.ts";

// --- LLB --------------------------------------------------------------------
export {
  State,
  Vertex,
  image,
  local,
  git,
  http,
  run,
  file,
  merge,
  diff,
  marshalState,
  DEFAULT_PATH_ENV,
  type Output,
  type RunMount,
  type RunOptions,
  type ExecResult,
  type FileActionSpec,
  type MarshaledDefinition,
  type LLBOp,
} from "./llb/state.ts";
export {
  encodeDefinition,
  marshalOp,
  MountType,
  NetMode,
  SecurityMode,
  CacheSharingOpt,
  SKIP_OUTPUT,
  EMPTY_INPUT,
  ROOT_MOUNT,
  type Definition,
  type Op,
  type OpMetadata,
  type Platform,
} from "./llb/ops.ts";
export { digestOf } from "./llb/digest.ts";
export { dumpLLB, dumpDot, toDumpEntries, type DumpEntry } from "./llb/json.ts";
export { Cap, type CapID } from "./llb/caps.ts";
export { Writer, Reader, compareUtf8 } from "./llb/protobuf.ts";

// --- Dockerfile -> LLB ------------------------------------------------------
export {
  dockerfileToLLB,
  ConvertError,
  SCRATCH,
  type ConvertOptions,
  type ConvertResult,
  type StageResult,
} from "./convert/dockerfile2llb.ts";
export {
  emptyImage,
  cloneImage,
  imageToJSON,
  defaultPathEnv,
  defaultShell,
  withShell,
  type Image,
  type ImageConfig,
  type HealthcheckConfig,
  type History,
} from "./convert/image.ts";
export {
  nullResolver,
  staticResolver,
  registryResolver,
  pinReference,
  type MetaResolver,
  type ResolvedImage,
  type RegistryResolverOptions,
} from "./convert/resolver.ts";
export {
  parseReference,
  normalizeReference,
  familiarReference,
  registryHost,
  type ParsedReference,
} from "./convert/reference.ts";
export {
  parsePlatform,
  formatPlatform,
  formatPlatformAll,
  normalizePlatform,
  platformsEqual,
  defaultArgs,
} from "./convert/platform.ts";

// --- Building ---------------------------------------------------------------
export {
  buildWithBuildctl,
  writeDefinition,
  detectBuildkit,
  type BuildctlOptions,
  type BuildResult,
} from "./build/buildctl.ts";
export { buildWithBuildx, type BuildxOptions } from "./build/buildx.ts";

// --- Bun plugin -------------------------------------------------------------
export { dockerfileLoader, DEFAULT_FILTER, type DockerfileLoaderOptions } from "./plugin/index.ts";
