import type { Dockerfile } from "../edit/document.ts";

/**
 * Builds an edited Dockerfile with `docker buildx build`.
 *
 * This is the path that "just works": the edited document is printed back to
 * Dockerfile text and handed to the real `dockerfile.v0` frontend, so the
 * resulting image gets its config (ENV, CMD, ENTRYPOINT, ...) the normal way.
 * Use {@link buildWithBuildctl} instead when you want BuildKit to consume the
 * LLB this library generated.
 */

export interface BuildxOptions {
  dockerfile: Dockerfile | string;
  /** Build context directory. Defaults to the current directory. */
  context?: string;
  tags?: string[];
  target?: string;
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  platforms?: string[];
  /** `--output` spec; `--load` and `--push` are shorthands for common ones. */
  output?: string;
  load?: boolean;
  push?: boolean;
  noCache?: boolean;
  pull?: boolean;
  secrets?: string[];
  ssh?: string[];
  cacheFrom?: string[];
  cacheTo?: string[];
  builder?: string;
  progress?: "auto" | "plain" | "tty" | "rawjson";
  /** Extra arguments appended verbatim. */
  extraArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onProgress?: (line: string) => void;
}

export interface BuildxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string[];
}

export async function buildWithBuildx(opts: BuildxOptions): Promise<BuildxResult> {
  const docker = Bun.which("docker");
  if (!docker) throw new Error("docker was not found on PATH");

  const source = typeof opts.dockerfile === "string" ? opts.dockerfile : opts.dockerfile.toString();
  const context = opts.context ?? ".";

  const args = [docker, "buildx", "build"];
  if (opts.builder) args.push("--builder", opts.builder);
  // `-` reads the Dockerfile from stdin, so nothing has to be written to disk.
  args.push("--file", "-");
  for (const tag of opts.tags ?? []) args.push("--tag", tag);
  if (opts.target) args.push("--target", opts.target);
  for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push("--build-arg", k + "=" + v);
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push("--label", k + "=" + v);
  for (const p of opts.platforms ?? []) args.push("--platform", p);
  for (const s of opts.secrets ?? []) args.push("--secret", s);
  for (const s of opts.ssh ?? []) args.push("--ssh", s);
  for (const c of opts.cacheFrom ?? []) args.push("--cache-from", c);
  for (const c of opts.cacheTo ?? []) args.push("--cache-to", c);
  if (opts.noCache) args.push("--no-cache");
  if (opts.pull) args.push("--pull");
  if (opts.output) args.push("--output", opts.output);
  if (opts.load) args.push("--load");
  if (opts.push) args.push("--push");
  if (opts.progress) args.push("--progress", opts.progress);
  args.push(...(opts.extraArgs ?? []));
  args.push(context);

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin: new TextEncoder().encode(source),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    readLines(proc.stderr, opts.onProgress),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr, command: args };
}

async function readLines(
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
