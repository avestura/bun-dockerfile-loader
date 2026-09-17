/**
 * LLB-only entry point.
 *
 * Re-exports the BuildKit LLB primitives for consumers that want to build
 * definitions directly, without the Dockerfile parser or editor.
 */

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
} from "./state.ts";
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
} from "./ops.ts";
export { digestOf } from "./digest.ts";
export { dumpLLB, dumpDot, toDumpEntries, type DumpEntry } from "./json.ts";
export { Cap, type CapID } from "./caps.ts";
export { Writer, Reader, compareUtf8 } from "./protobuf.ts";
