import type { Platform } from "../llb/ops.ts";
import { normalizePlatform } from "./platform.ts";

/**
 * The OCI image config BuildKit's Dockerfile frontend returns alongside the LLB
 * definition, extended with the Docker-specific fields (`Healthcheck`,
 * `ArgsEscaped`, `OnBuild`, `Shell`).
 *
 * This is the half that raw LLB cannot express: feeding a bare definition to
 * `buildctl build` produces a filesystem, and this config is what turns it into
 * a runnable image.
 */

export interface HealthcheckConfig {
  Test?: string[];
  /** Nanoseconds, matching the Docker image spec. */
  Interval?: number;
  Timeout?: number;
  StartPeriod?: number;
  StartInterval?: number;
  Retries?: number;
}

export interface ImageConfig {
  User?: string;
  ExposedPorts?: Record<string, Record<string, never>>;
  Env?: string[];
  Entrypoint?: string[];
  Cmd?: string[];
  Volumes?: Record<string, Record<string, never>>;
  WorkingDir?: string;
  Labels?: Record<string, string>;
  StopSignal?: string;
  ArgsEscaped?: boolean;
  OnBuild?: string[];
  Shell?: string[];
  Healthcheck?: HealthcheckConfig;
}

export interface History {
  created?: string;
  created_by?: string;
  author?: string;
  comment?: string;
  empty_layer?: boolean;
}

export interface Image {
  created?: string;
  author?: string;
  architecture: string;
  os: string;
  variant?: string;
  "os.version"?: string;
  "os.features"?: string[];
  config: ImageConfig;
  rootfs: { type: "layers"; diff_ids: string[] };
  history: History[];
}

export const HISTORY_COMMENT = "buildkit.dockerfile.v0";

export function emptyImage(platform: Platform): Image {
  const p = normalizePlatform(platform);
  const img: Image = {
    architecture: p.Architecture,
    os: p.OS,
    // BuildKit's `emptyImage` seeds a working directory and PATH; Windows is
    // left to the OS (moby/buildkit#5445).
    config: p.OS === "windows" ? { WorkingDir: "/" } : { WorkingDir: "/", Env: ["PATH=" + defaultPathEnv(p.OS)] },
    rootfs: { type: "layers", diff_ids: [] },
    history: [],
  };
  if (p.Variant) img.variant = p.Variant;
  if (p.OSVersion) img["os.version"] = p.OSVersion;
  if (p.OSFeatures?.length) img["os.features"] = [...p.OSFeatures];
  return img;
}

export function cloneImage(img: Image): Image {
  return structuredClone(img);
}

/** Appends a history entry, mirroring `dockerfile2llb.commitToHistory`. */
export function commitToHistory(img: Image, message: string, withLayer: boolean, hasState: boolean, epoch?: Date) {
  const created_by = hasState ? message + " # buildkit" : message;
  const entry: History = { created_by, comment: HISTORY_COMMENT };
  if (!withLayer) entry.empty_layer = true;
  if (epoch) entry.created = epoch.toISOString();
  img.history.push(entry);
}

/** Replaces an existing `KEY=` entry in place, or appends, like Docker does. */
export function addEnv(env: string[], key: string, value: string, caseInsensitive = false): string[] {
  const norm = (s: string) => (caseInsensitive ? s.toUpperCase() : s);
  const out = [...env];
  for (let i = 0; i < out.length; i++) {
    const k = out[i]!.split("=", 1)[0]!;
    if (norm(k) === norm(key)) {
      out[i] = key + "=" + value;
      return out;
    }
  }
  out.push(key + "=" + value);
  return out;
}

export function parseKeyValue(entry: string): [string, string] {
  const i = entry.indexOf("=");
  return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)];
}

/** The default PATH BuildKit injects when the base image does not define one. */
export function defaultPathEnv(os: string): string {
  return os === "windows"
    ? "c:\\Windows\\System32;c:\\Windows"
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
}

/** `[]string{"/bin/sh", "-c"}`, or the cmd shell on Windows. */
export function defaultShell(os: string): string[] {
  return os === "windows" ? ["cmd", "/S", "/C"] : ["/bin/sh", "-c"];
}

/** Wraps shell-form arguments with the image's SHELL. */
export function withShell(img: Image, args: string[]): string[] {
  const shell = img.config.Shell?.length ? [...img.config.Shell] : defaultShell(img.os);
  return [...shell, args.join(" ")];
}

/** Serializes the config the way an image manifest expects it. */
export function imageToJSON(img: Image): string {
  return JSON.stringify(img, null, 2);
}
