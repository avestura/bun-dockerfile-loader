import type { Platform } from "../llb/ops.ts";

/**
 * Platform parsing and normalisation, following `github.com/containerd/platforms`.
 * BuildKit normalises every platform string before it reaches LLB, so the same
 * rules have to apply here or `--platform=linux/x86_64` would produce a
 * different digest than the real frontend.
 */

export const DEFAULT_PLATFORM: Platform = { OS: "linux", Architecture: "amd64" };

export function normalizeOS(os: string): string {
  const v = os.toLowerCase();
  return v === "macos" ? "darwin" : v;
}

export function normalizeArch(arch: string, variant: string): [string, string] {
  let a = arch.toLowerCase();
  let v = variant.toLowerCase();
  switch (a) {
    case "i386":
      a = "386";
      v = "";
      break;
    case "x86_64":
    case "x86-64":
    case "amd64":
      a = "amd64";
      if (v === "v1") v = "";
      break;
    case "aarch64":
    case "arm64":
      a = "arm64";
      if (v === "8" || v === "v8") v = "";
      break;
    case "armhf":
      a = "arm";
      v = "v7";
      break;
    case "armel":
      a = "arm";
      v = "v6";
      break;
    case "arm":
      if (v === "" || v === "7") v = "v7";
      else if (v === "5" || v === "6" || v === "8") v = "v" + v;
      break;
  }
  return [a, v];
}

export function normalizePlatform(p: Platform): Platform {
  const [Architecture, Variant] = normalizeArch(p.Architecture, p.Variant ?? "");
  const out: Platform = { OS: normalizeOS(p.OS), Architecture };
  if (Variant) out.Variant = Variant;
  if (p.OSVersion) out.OSVersion = p.OSVersion;
  if (p.OSFeatures?.length) out.OSFeatures = [...p.OSFeatures];
  return out;
}

/** Parses `os/arch[/variant]`, `os` or `arch`, as `platforms.Parse` does. */
export function parsePlatform(specifier: string): Platform {
  const parts = specifier.split("/");
  if (parts.length > 3) throw new Error("invalid platform specifier: " + specifier);

  // An OS may carry a version in parentheses, e.g. `windows(10.0.17763)/amd64`.
  const splitOSVersion = (s: string): [string, string | undefined] => {
    const m = /^([^(]+)\(([^)]*)\)$/.exec(s);
    return m ? [m[1]!, m[2]!] : [s, undefined];
  };

  if (parts.length === 1) {
    const [name, osVersion] = splitOSVersion(parts[0]!);
    if (KNOWN_OS.has(normalizeOS(name))) {
      const p: Platform = { OS: normalizeOS(name), Architecture: DEFAULT_PLATFORM.Architecture };
      if (osVersion) p.OSVersion = osVersion;
      return p;
    }
    const [arch, variant] = normalizeArch(name, "");
    if (KNOWN_ARCH.has(arch)) {
      const p: Platform = { OS: DEFAULT_PLATFORM.OS, Architecture: arch };
      if (variant) p.Variant = variant;
      return p;
    }
    throw new Error("unknown operating system or architecture: " + specifier);
  }

  const [osName, osVersion] = splitOSVersion(parts[0]!);
  const [arch, variant] = normalizeArch(parts[1]!, parts[2] ?? "");
  const p: Platform = { OS: normalizeOS(osName), Architecture: arch };
  if (variant) p.Variant = variant;
  if (osVersion) p.OSVersion = osVersion;
  return p;
}

/** `platforms.Format`: `os/arch[/variant]`. */
export function formatPlatform(p: Platform): string {
  return p.OS + "/" + p.Architecture + (p.Variant ? "/" + p.Variant : "");
}

/** `platforms.FormatAll`: like Format but keeps the OS version. */
export function formatPlatformAll(p: Platform): string {
  const os = p.OSVersion ? p.OS + "(" + p.OSVersion + ")" : p.OS;
  return os + "/" + p.Architecture + (p.Variant ? "/" + p.Variant : "");
}

export function platformsEqual(a: Platform, b: Platform): boolean {
  return (
    a.OS === b.OS &&
    a.Architecture === b.Architecture &&
    (a.Variant ?? "") === (b.Variant ?? "") &&
    (a.OSVersion ?? "") === (b.OSVersion ?? "")
  );
}

const KNOWN_OS = new Set([
  "aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios",
  "js", "linux", "nacl", "netbsd", "openbsd", "plan9", "solaris", "windows", "zos",
]);

const KNOWN_ARCH = new Set([
  "386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "loong64",
  "mips", "mipsle", "mips64", "mips64le", "mips64p32", "mips64p32le", "ppc",
  "ppc64", "ppc64le", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm",
]);

/**
 * The built-in build arguments BuildKit predefines
 * (`dockerfile2llb.defaultArgs`).
 */
export function defaultArgs(
  buildPlatform: Platform,
  targetPlatform: Platform,
  target: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const pairs: [string, string][] = [
    ["BUILDPLATFORM", formatPlatform(buildPlatform)],
    ["BUILDOS", buildPlatform.OS],
    ["BUILDOSVERSION", buildPlatform.OSVersion ?? ""],
    ["BUILDARCH", buildPlatform.Architecture],
    ["BUILDVARIANT", buildPlatform.Variant ?? ""],
    ["TARGETPLATFORM", formatPlatformAll(targetPlatform)],
    ["TARGETOS", targetPlatform.OS],
    ["TARGETOSVERSION", targetPlatform.OSVersion ?? ""],
    ["TARGETARCH", targetPlatform.Architecture],
    ["TARGETVARIANT", targetPlatform.Variant ?? ""],
    ["TARGETSTAGE", target === "" ? "default" : target],
  ];
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = overrides[k] ?? v;
  return out;
}

/** Build args BuildKit forwards into `ProxyEnv` rather than the shell env. */
export const PROXY_ARGS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "ftp_proxy",
  "FTP_PROXY",
  "no_proxy",
  "NO_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;
