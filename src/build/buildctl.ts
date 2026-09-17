import { encodeDefinition, type Definition } from "../llb/ops.ts";
import { imageToJSON, type Image } from "../convert/image.ts";

/**
 * Drives `buildctl` with a raw LLB definition.
 *
 * `buildctl build` reads an LLB definition from stdin when no `--frontend` is
 * given, which is the only supported way to hand BuildKit a definition you
 * produced yourself.
 *
 * Important limitation: a raw definition produces a *filesystem*, not a
 * configured image. Everything in the OCI image config — ENV, CMD, ENTRYPOINT,
 * LABEL, USER, WORKDIR, EXPOSE — is returned by a frontend through the gateway
 * API, which stdin-fed LLB has no way to do. {@link buildWithBuildctl} therefore
 * writes the config next to the definition so it can be applied afterwards; see
 * `applyImageConfig` in the README for the crane/regctl one-liner.
 */

export interface BuildctlOptions {
  definition: Definition;
  /** Local directories to expose, e.g. `{ context: ".", dockerfile: "." }`. */
  locals?: Record<string, string>;
  /** `--output` specification, e.g. `type=docker,name=app:dev`. */
  output?: string;
  /** `--export-cache` / `--import-cache` entries. */
  exportCache?: string[];
  importCache?: string[];
  /** `--secret id=...,src=...` entries. */
  secrets?: string[];
  /** `--ssh` entries. */
  ssh?: string[];
  /** Explicit buildctl binary; otherwise the PATH entry, else `docker run`. */
  buildctl?: string;
  /** Address of buildkitd, e.g. `docker-container://buildkitd`. */
  addr?: string;
  /** Image config to write alongside, when `configPath` is set. */
  image?: Image;
  configPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Extra arguments appended verbatim. */
  extraArgs?: string[];
  /** Receives buildctl's stderr progress stream line by line. */
  onProgress?: (line: string) => void;
}

export interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The exact argv that was run, useful for reproducing by hand. */
  command: string[];
}

/** Locates a usable buildctl, preferring a real binary over the container. */
export async function detectBuildkit(): Promise<
  { kind: "binary"; command: string[] } | { kind: "docker"; command: string[] } | null
> {
  const which = Bun.which("buildctl");
  if (which) return { kind: "binary", command: [which] };
  const docker = Bun.which("docker");
  if (docker) {
    return {
      kind: "docker",
      // The buildkit image ships buildctl; --network=host lets it reach a
      // daemon exposed on the host.
      command: [docker, "run", "--rm", "-i", "--network=host", "moby/buildkit:latest", "buildctl"],
    };
  }
  return null;
}

/** Writes the serialized definition to disk, ready to pipe into buildctl. */
export async function writeDefinition(path: string, definition: Definition): Promise<number> {
  const bytes = encodeDefinition(definition);
  await Bun.write(path, bytes);
  return bytes.byteLength;
}

export async function buildWithBuildctl(opts: BuildctlOptions): Promise<BuildResult> {
  let base: string[];
  if (opts.buildctl) {
    base = [opts.buildctl];
  } else {
    const found = await detectBuildkit();
    if (!found) {
      throw new Error(
        "neither buildctl nor docker was found on PATH; install buildkit or pass `buildctl`",
      );
    }
    base = found.command;
  }

  const args = [...base];
  if (opts.addr) args.push("--addr", opts.addr);
  args.push("build");
  for (const [name, dir] of Object.entries(opts.locals ?? {})) {
    args.push("--local", name + "=" + dir);
  }
  if (opts.output) args.push("--output", opts.output);
  for (const c of opts.exportCache ?? []) args.push("--export-cache", c);
  for (const c of opts.importCache ?? []) args.push("--import-cache", c);
  for (const s of opts.secrets ?? []) args.push("--secret", s);
  for (const s of opts.ssh ?? []) args.push("--ssh", s);
  args.push(...(opts.extraArgs ?? []));

  if (opts.image && opts.configPath) {
    await Bun.write(opts.configPath, imageToJSON(opts.image));
  }

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin: encodeDefinition(opts.definition),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    readProgress(proc.stderr, opts.onProgress),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr, command: args };
}

async function readProgress(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (line: string) => void,
): Promise<string> {
  if (!onProgress) return new Response(stream).text();
  const decoder = new TextDecoder();
  let buffered = "";
  let all = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    buffered += text;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onProgress(line);
  }
  if (buffered) onProgress(buffered);
  return all;
}
