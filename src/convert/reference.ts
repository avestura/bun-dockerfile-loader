/**
 * Image reference parsing, following `distribution/reference`.
 *
 * BuildKit normalises `alpine` to `docker.io/library/alpine:latest` before the
 * reference reaches the `docker-image://` source identifier, so the same
 * normalisation has to happen here for digests to line up.
 */

export const DEFAULT_DOMAIN = "docker.io";
export const LEGACY_DEFAULT_DOMAIN = "index.docker.io";
export const OFFICIAL_REPO_PREFIX = "library/";
export const DEFAULT_TAG = "latest";

export interface ParsedReference {
  /** Registry host, e.g. `docker.io` or `ghcr.io`. */
  domain: string;
  /** Repository path without the domain, e.g. `library/alpine`. */
  path: string;
  tag?: string;
  digest?: string;
}

function splitDomain(name: string): [string, string] {
  const i = name.indexOf("/");
  if (i < 0) return ["", name];
  const head = name.slice(0, i);
  // A first component is a registry only if it looks like a host.
  if (!head.includes(".") && !head.includes(":") && head !== "localhost" && head === head.toLowerCase()) {
    return ["", name];
  }
  return [head, name.slice(i + 1)];
}

export function parseReference(ref: string): ParsedReference {
  if (ref === "") throw new Error("invalid reference format: repository name must not be empty");

  let rest = ref;
  let digest: string | undefined;
  let tag: string | undefined;

  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  // A colon after the last slash is a tag; before it, it is a registry port.
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  let [domain, path] = splitDomain(rest);
  if (domain === "") {
    domain = DEFAULT_DOMAIN;
    if (!path.includes("/")) path = OFFICIAL_REPO_PREFIX + path;
  } else if (domain === LEGACY_DEFAULT_DOMAIN) {
    domain = DEFAULT_DOMAIN;
  }

  if (path === "") throw new Error("invalid reference format: repository name must not be empty: " + ref);
  return { domain, path, tag, digest };
}

/** Fully qualified form, with `:latest` filled in when nothing was specified. */
export function normalizeReference(ref: string): string {
  const p = parseReference(ref);
  let out = p.domain + "/" + p.path;
  if (p.tag) out += ":" + p.tag;
  else if (!p.digest) out += ":" + DEFAULT_TAG;
  if (p.digest) out += "@" + p.digest;
  return out;
}

/** Adds `:latest` only when neither a tag nor a digest is present. */
export function withDefaultTag(ref: ParsedReference): ParsedReference {
  if (ref.tag || ref.digest) return ref;
  return { ...ref, tag: DEFAULT_TAG };
}

/** The short form a human would write, e.g. `alpine` for `docker.io/library/alpine:latest`. */
export function familiarReference(ref: string): string {
  const p = parseReference(ref);
  let path = p.path;
  let domain = p.domain;
  if (domain === DEFAULT_DOMAIN) {
    domain = "";
    if (path.startsWith(OFFICIAL_REPO_PREFIX)) path = path.slice(OFFICIAL_REPO_PREFIX.length);
  }
  let out = domain ? domain + "/" + path : path;
  if (p.tag && p.tag !== DEFAULT_TAG) out += ":" + p.tag;
  if (p.digest) out += "@" + p.digest;
  return out;
}

/** The host to actually contact; Docker Hub is served from a different name. */
export function registryHost(domain: string): string {
  return domain === DEFAULT_DOMAIN ? "registry-1.docker.io" : domain;
}
