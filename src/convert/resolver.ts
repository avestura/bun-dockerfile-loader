import type { Platform } from "../llb/ops.ts";
import { emptyImage, type Image } from "./image.ts";
import { formatPlatform, normalizePlatform } from "./platform.ts";
import { normalizeReference, parseReference, registryHost } from "./reference.ts";

/**
 * Resolves a `FROM` reference to a pinned digest and its image config.
 *
 * The real frontend asks buildkitd through the gateway; here it is an interface
 * so a build can run fully offline (`staticResolver`), hit a registry directly
 * (`registryResolver`), or skip resolution altogether (`nullResolver`).
 */
export interface MetaResolver {
  resolve(
    ref: string,
    opts: { platform?: Platform; resolveMode?: "default" | "pull" | "local" },
  ): Promise<ResolvedImage>;
}

export interface ResolvedImage {
  /** Canonical reference, digest-pinned when the resolver could pin it. */
  ref: string;
  /** Manifest digest, when known. */
  digest?: string;
  config: Image;
  /**
   * Whether the image has any layers. BuildKit treats a layerless base as
   * `scratch`, so a resolver that does not know the layer list must say so
   * explicitly rather than let an empty `rootfs` be mistaken for emptiness.
   */
  hasLayers?: boolean;
}

/**
 * Appends a digest while keeping the tag, the way `reference.WithDigest` does:
 * `docker.io/library/alpine:3.20@sha256:...`.
 */
export function pinReference(normalized: string, digest?: string): string {
  if (!digest) return normalized;
  const at = normalized.indexOf("@");
  const base = at < 0 ? normalized : normalized.slice(0, at);
  return base + "@" + digest;
}

/**
 * Leaves references unpinned and assumes an empty config.
 *
 * Builds still work, but anything inherited from the base image — its ENV,
 * WORKDIR, USER, CMD, ENTRYPOINT — is unknown, so the emitted image config
 * only reflects what the Dockerfile itself sets.
 */
export function nullResolver(): MetaResolver {
  return {
    async resolve(ref, opts) {
      return {
        ref: normalizeReference(ref),
        config: emptyImage(opts.platform ?? { OS: "linux", Architecture: "amd64" }),
        // The layer list is unknown, not empty; assuming emptiness would
        // silently compile the whole build down to scratch.
        hasLayers: true,
      };
    },
  };
}

/**
 * Serves configs from a map, keyed by normalized reference.
 * Unknown references fall through to `fallback`.
 */
export function staticResolver(
  entries: Record<string, { digest?: string; config: Image }>,
  fallback: MetaResolver = nullResolver(),
): MetaResolver {
  const table = new Map<string, { digest?: string; config: Image }>();
  for (const [k, v] of Object.entries(entries)) table.set(normalizeReference(k), v);
  return {
    async resolve(ref, opts) {
      const key = normalizeReference(ref);
      const hit = table.get(key);
      if (!hit) return fallback.resolve(ref, opts);
      return { ref: pinReference(key, hit.digest), digest: hit.digest, config: hit.config };
    },
  };
}

export interface RegistryResolverOptions {
  /** Per-registry credentials, keyed by domain (e.g. `ghcr.io`). */
  auth?: Record<string, { username: string; password: string }>;
  /** Cache resolved configs for the lifetime of the resolver. Default true. */
  cache?: boolean;
  fetch?: typeof fetch;
  /** Extra headers, e.g. a custom User-Agent. */
  headers?: Record<string, string>;
}

const MEDIA_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const MEDIA_MANIFEST_V2 = "application/vnd.docker.distribution.manifest.v2+json";
const MEDIA_OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const MEDIA_OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const ACCEPT = [MEDIA_OCI_INDEX, MEDIA_OCI_MANIFEST, MEDIA_MANIFEST_LIST, MEDIA_MANIFEST_V2].join(", ");

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os: string; architecture: string; variant?: string; "os.version"?: string };
}

/**
 * Talks to an OCI registry over HTTPS, with anonymous Bearer-token auth.
 *
 * This is the online path: it pins `FROM` to a manifest digest and reads the
 * real base-image config, which is what makes inherited ENV/CMD/ENTRYPOINT and
 * platform auto-detection behave like a real `docker build`.
 */
export function registryResolver(opts: RegistryResolverOptions = {}): MetaResolver {
  const doFetch = opts.fetch ?? fetch;
  const cache = opts.cache === false ? null : new Map<string, ResolvedImage>();
  const tokens = new Map<string, string>();

  async function authorizedFetch(host: string, url: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept, ...opts.headers };
    const cached = tokens.get(host);
    if (cached) headers.Authorization = cached;

    let res = await doFetch(url, { headers });
    if (res.status !== 401) return res;

    const challenge = res.headers.get("www-authenticate");
    if (!challenge) return res;
    const auth = await negotiate(host, challenge);
    if (!auth) return res;
    tokens.set(host, auth);
    res = await doFetch(url, { headers: { ...headers, Authorization: auth } });
    return res;
  }

  async function negotiate(host: string, challenge: string): Promise<string | null> {
    const creds = opts.auth?.[host] ?? opts.auth?.[host.replace("registry-1.", "")];
    if (/^basic/i.test(challenge)) {
      if (!creds) return null;
      return "Basic " + Buffer.from(creds.username + ":" + creds.password).toString("base64");
    }
    const params = new Map<string, string>();
    for (const m of challenge.matchAll(/(\w+)="([^"]*)"/g)) params.set(m[1]!, m[2]!);
    const realm = params.get("realm");
    if (!realm) return null;

    const url = new URL(realm);
    for (const key of ["service", "scope"]) {
      const v = params.get(key);
      if (v) url.searchParams.set(key, v);
    }
    const headers: Record<string, string> = {};
    if (creds) {
      headers.Authorization =
        "Basic " + Buffer.from(creds.username + ":" + creds.password).toString("base64");
    }
    const res = await doFetch(url.toString(), { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    return token ? "Bearer " + token : null;
  }

  function matches(d: Descriptor, want: Platform): boolean {
    if (!d.platform) return false;
    const p = normalizePlatform({
      OS: d.platform.os,
      Architecture: d.platform.architecture,
      Variant: d.platform.variant,
    });
    return p.OS === want.OS && p.Architecture === want.Architecture &&
      (want.Variant ? (p.Variant ?? "") === want.Variant : true);
  }

  return {
    async resolve(ref, resolveOpts) {
      const platform = normalizePlatform(resolveOpts.platform ?? { OS: "linux", Architecture: "amd64" });
      const normalized = normalizeReference(ref);
      const cacheKey = normalized + "|" + formatPlatform(platform);
      const hit = cache?.get(cacheKey);
      if (hit) return hit;

      const parsed = parseReference(normalized);
      const host = registryHost(parsed.domain);
      const base = "https://" + host + "/v2/" + parsed.path;
      const referenceTag = parsed.digest ?? parsed.tag ?? "latest";

      let res = await authorizedFetch(host, base + "/manifests/" + referenceTag, ACCEPT);
      if (!res.ok) {
        throw new Error(
          "failed to resolve " + normalized + ": " + res.status + " " + res.statusText,
        );
      }
      let manifestDigest = res.headers.get("docker-content-digest") ?? parsed.digest;
      let manifest = (await res.json()) as {
        mediaType?: string;
        manifests?: Descriptor[];
        config?: Descriptor;
      };

      // An index has to be narrowed to the requested platform first.
      if (manifest.manifests) {
        const pick =
          manifest.manifests.find((d) => matches(d, platform)) ??
          manifest.manifests.find((d) => d.platform?.os === platform.OS);
        if (!pick) {
          throw new Error(
            "no manifest for " + formatPlatform(platform) + " in " + normalized,
          );
        }
        manifestDigest = pick.digest;
        res = await authorizedFetch(host, base + "/manifests/" + pick.digest, ACCEPT);
        if (!res.ok) throw new Error("failed to fetch manifest " + pick.digest + ": " + res.status);
        manifest = (await res.json()) as typeof manifest;
      }

      if (!manifest.config) throw new Error("manifest for " + normalized + " has no config descriptor");
      const blob = await authorizedFetch(host, base + "/blobs/" + manifest.config.digest, manifest.config.mediaType);
      if (!blob.ok) throw new Error("failed to fetch image config: " + blob.status);
      const config = (await blob.json()) as Image;
      config.config ??= {};
      config.history ??= [];
      config.rootfs ??= { type: "layers", diff_ids: [] };

      const out: ResolvedImage = {
        ref: pinReference(normalized, manifestDigest ?? undefined),
        digest: manifestDigest ?? undefined,
        config,
      };
      cache?.set(cacheKey, out);
      return out;
    },
  };
}
