import { Duplex } from "node:stream";
import { GatewayClient } from "./gateway.ts";
import { dockerfileToLLB, type ConvertOptions } from "../convert/dockerfile2llb.ts";
import { imageToJSON, type Image } from "../convert/image.ts";
import { local, marshalState } from "../llb/state.ts";
import { parsePlatform } from "../convert/platform.ts";
import type { MetaResolver } from "../convert/resolver.ts";
import { normalizeReference } from "../convert/reference.ts";
import { pinReference } from "../convert/resolver.ts";

/**
 * A BuildKit gateway frontend backed by this library's converter.
 *
 * Point a Dockerfile at it and BuildKit will use this compiler instead of its
 * own, while still getting a properly configured image — the frontend returns
 * the OCI config in the result metadata, which raw LLB piped to `buildctl`
 * cannot do:
 *
 *   # syntax=your-registry/bun-dockerfile-frontend:latest
 *   FROM alpine:3.20
 *   ...
 *
 * BuildKit runs this as a container and speaks gRPC over stdio, so the process
 * must not write anything else to stdout.
 */

export const FRONTEND_OPT_PREFIX = "BUILDKIT_FRONTEND_OPT_";
export const DEFAULT_LOCAL_NAME_CONTEXT = "context";
export const DEFAULT_LOCAL_NAME_DOCKERFILE = "dockerfile";
export const EXPORTER_IMAGE_CONFIG_KEY = "containerimage.config";

/** Reads `BUILDKIT_FRONTEND_OPT_n=key=value` pairs out of the environment. */
export function optsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(FRONTEND_OPT_PREFIX) || v === undefined) continue;
    const eq = v.indexOf("=");
    if (eq < 0) opts[v] = "";
    else opts[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return opts;
}

/** Translates gateway frontend options into converter options. */
export function convertOptionsFromFrontendOpts(
  opts: Record<string, string>,
  sessionID: string,
): ConvertOptions & { filename: string } {
  const buildArgs: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (k.startsWith("build-arg:")) buildArgs[k.slice("build-arg:".length)] = v;
    else if (k.startsWith("label:")) labels[k.slice("label:".length)] = v;
  }

  const noCache = opts["no-cache"];
  const platform = opts.platform?.split(",")[0]?.trim();

  return {
    filename: opts.filename || "Dockerfile",
    target: opts.target || undefined,
    buildArgs,
    labels,
    sessionID,
    cacheIDNamespace: opts["build-arg:BUILDKIT_CACHE_MOUNT_NS"] || undefined,
    targetPlatform: platform ? parsePlatform(platform) : undefined,
    multiPlatform: (opts.platform ?? "").includes(","),
    imageResolveMode: opts["image-resolve-mode"] === "pull" ? "pull" : undefined,
    hostname: opts.hostname || undefined,
    // `--no-cache` arrives as an empty-valued option; a comma list names stages.
    ignoreCache: noCache === undefined ? undefined : noCache === "" ? true : noCache.split(","),
  };
}

/** Resolves base images through buildkitd rather than talking to a registry. */
export function gatewayResolver(client: GatewayClient, sessionID: string): MetaResolver {
  return {
    async resolve(ref, opts) {
      const normalized = normalizeReference(ref);
      const res = await client.resolveImageConfig({
        ref: normalized,
        platform: opts.platform,
        resolveMode: opts.resolveMode === "default" ? "" : opts.resolveMode,
        logName: "[internal] load metadata for " + normalized,
        sessionID,
      });
      const config = res.config.length
        ? (JSON.parse(new TextDecoder().decode(res.config)) as Image)
        : ({ architecture: "", os: "", config: {}, rootfs: { type: "layers", diff_ids: [] }, history: [] } as Image);
      config.config ??= {};
      config.history ??= [];
      config.rootfs ??= { type: "layers", diff_ids: [] };
      return {
        ref: res.ref || pinReference(normalized, res.digest || undefined),
        digest: res.digest || undefined,
        config,
      };
    },
  };
}

export interface RunFrontendOptions {
  /** Defaults to the process stdio pair BuildKit connects. */
  stream?: Duplex;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one build: read the Dockerfile from the dockerfile context, compile it,
 * solve the definition, and return the ref with its image config.
 */
export async function runFrontend(options: RunFrontendOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const stream =
    options.stream ?? (Duplex.from({ readable: process.stdin, writable: process.stdout }) as Duplex);

  const client = new GatewayClient(stream);
  const sessionID = env.BUILDKIT_SESSION_ID ?? "";
  const frontendOpts = optsFromEnv(env);

  try {
    await client.ping();

    const convertOpts = convertOptionsFromFrontendOpts(frontendOpts, sessionID);
    const dockerfileContext = frontendOpts["contextkey:dockerfile"] || DEFAULT_LOCAL_NAME_DOCKERFILE;

    // The Dockerfile itself lives in its own local context; solve it first so
    // there is a ref to read from.
    const dfState = local(dockerfileContext, {
      sessionID,
      followPaths: [convertOpts.filename],
      sharedKeyHint: convertOpts.filename,
      metadata: { description: { "llb.customname": "[internal] load build definition" } },
    });
    const dfSolve = await client.solve({
      definition: marshalState(dfState),
      allowResultReturn: true,
      allowResultArrayRef: true,
    });
    const dfRef = dfSolve.result?.ref?.id ?? dfSolve.ref;
    if (!dfRef) throw new Error("gateway returned no ref for the dockerfile context");

    const source = new TextDecoder().decode(
      await client.readFile({ ref: dfRef, filePath: convertOpts.filename }),
    );

    const result = await dockerfileToLLB(source, {
      ...convertOpts,
      contextName: frontendOpts["contextkey:context"] || DEFAULT_LOCAL_NAME_CONTEXT,
      metaResolver: gatewayResolver(client, sessionID),
    });

    for (const warning of result.warnings) {
      await client.warn({ short: warning, level: 1 });
    }

    const solved = await client.solve({
      definition: result.definition,
      allowResultReturn: true,
      allowResultArrayRef: true,
    });
    const ref = solved.result?.ref ?? (solved.ref ? { id: solved.ref } : undefined);
    if (!ref) throw new Error("gateway returned no ref for the build result");

    await client.return_({
      result: {
        ref,
        // This is the piece raw LLB cannot carry: ENV, CMD, ENTRYPOINT, LABEL,
        // USER, WORKDIR and EXPOSE all live in the image config.
        metadata: {
          [EXPORTER_IMAGE_CONFIG_KEY]: new TextEncoder().encode(imageToJSON(result.image)),
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client
      .return_({ error: { code: 2, message } })
      .catch(() => {
        // The connection may already be gone; the daemon reports the failure.
      });
    throw err;
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  runFrontend().catch((err) => {
    process.stderr.write("frontend failed: " + (err instanceof Error ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}
