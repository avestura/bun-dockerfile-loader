import { plugin } from "bun";
import { dockerfileLoader } from "./index.ts";

/**
 * Registers the loader with the Bun runtime.
 *
 * Add it to `bunfig.toml` so plain `bun run` picks up Dockerfile imports:
 *
 *   preload = ["bun-dockerfile-loader/preload"]
 *
 * For tests, add the same entry under `[test]`.
 */
plugin(dockerfileLoader());
