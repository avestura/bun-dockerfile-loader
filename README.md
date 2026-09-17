# bun-dockerfile-loader

Load a Dockerfile in Bun, edit it as a typed AST, print it back losslessly, and
compile it to BuildKit **LLB** — byte-for-byte identical to what
`moby/buildkit`'s own `dockerfile2llb` produces.

```ts
import df from "./Dockerfile.prod";

df.stage("build")!.setBaseImage("oven/bun:1-alpine");
df.stage("runtime")!.setEnv("NODE_ENV", "production");

await Bun.write("Dockerfile.prod", df.toString());

const { definition, image } = await df.toLLB();
```

---

<details>
<summary><strong>Why the parity claim is checkable</strong></summary>

<br>

The test suite does not compare against hand-written expectations. It compares
against **BuildKit itself**:

- `test/fixtures/llb-golden.go` builds four LLB graphs with the real Go
  `client/llb` package and dumps every marshaled `Op` as hex.
- `test/fixtures/df-golden.go` runs the real
  `frontend/dockerfile/dockerfile2llb` over `test/fixtures/dockerfiles/*` and
  dumps the definition, the op metadata and the resulting image config.

`bun test` then asserts that this library produces **the same bytes, the same
SHA-256 vertex digests, the same progress names, the same capability sets and
the same image config**. Regenerate the fixtures with:

```sh
go run test/fixtures/llb-golden.go > test/fixtures/llb-golden.json
go run test/fixtures/df-golden.go test/fixtures/dockerfiles > test/fixtures/df-golden.json
```

Getting this right required matching several things that are easy to miss:

- Go's protobuf runtime emits **oneof fields last** (`order.LegacyFieldOrder`),
  so `Op.platform` (field 10) and `Op.constraints` (11) are written *before* the
  `op` oneof (2–8). Field-number order gives different digests.
- Maps are sorted by the **UTF-8 bytes** of the key, and map entries always emit
  both key and value even when empty.
- `Op.platform` is stripped for `local://`, `git://` and HTTP sources, and for
  `FileOp`, `MergeOp` and `DiffOp`.
- `${v#p}` / `${v%p}` / `${v/p/r}` are **regex**-based in BuildKit, not glob —
  so `*` crosses `/`, unlike `filepath.Match`.
- Exec mounts are sorted by target, but secret and SSH mounts are appended
  afterwards and carry no output index.

</details>

---

## Install

```sh
bun add bun-dockerfile-loader
```

## The loader

```toml
# bunfig.toml
preload = ["bun-dockerfile-loader/preload"]

[test]
preload = ["bun-dockerfile-loader/preload"]
```

```ts
import df, { source, toLLB, warnings } from "./Dockerfile.prod";
```

Or in the bundler:

```ts
import { dockerfileLoader } from "bun-dockerfile-loader";

await Bun.build({
  entrypoints: ["./src/index.ts"],
  plugins: [dockerfileLoader()],
});
```

### Which file names work where

| Name | Bundler | Runtime |
| --- | --- | --- |
| `Dockerfile.prod`, `app.dockerfile`, `Containerfile.dev` | ✅ | ✅ |
| bare `Dockerfile` / `Containerfile` | ✅ | ❌ |

Bun's **runtime** picks a loader from the file extension *before* plugins are
consulted, so an extensionless `Dockerfile` is parsed as JavaScript and never
reaches `onLoad`. There is no plugin-side workaround — `onResolve` is not
consulted for it either. Read those explicitly:

```ts
import { Dockerfile } from "bun-dockerfile-loader";
const df = await Dockerfile.fromFile("Dockerfile");
```

The bundler has no such restriction.

### Types

```jsonc
// tsconfig.json
{ "compilerOptions": { "types": ["bun", "bun-dockerfile-loader/types"] } }
```

---

## Editing

Parsing is **lossless**: untouched instructions keep their original bytes, so a
parse/print round-trip is byte-identical, comments, spacing, continuations,
heredocs and `# escape=` directives included. Only nodes you actually edit get
re-rendered.

```ts
import { Dockerfile, builders as b } from "bun-dockerfile-loader";

const df = await Dockerfile.fromFile("Dockerfile");

df.syntax = "docker/dockerfile:1.7";                   // parser directives
df.mapBaseImages((img) => `mirror.internal/${img}`);   // rewrite every FROM

const build = df.stage("build")!;                      // by name, index or -1
build.setEnv("CGO_ENABLED", "0");
build.setLabel("org.opencontainers.image.revision", rev);
build.add(b.run("go build ./...", { mounts: [b.mount({ type: "cache", target: "/root/.cache/go-build" })] }));

df.insertAfter(build.find("Workdir")[0]!, b.copy(["go.mod", "go.sum"], "./"));
df.removeWhere((i) => i.type === "Maintainer");

console.log(df.toString());
```

`Dockerfile.empty()` plus the `builders` module constructs a file from scratch.

Every instruction is a discriminated union member — `From`, `Run`, `Copy`,
`Add`, `Env`, `Arg`, `Label`, `Expose`, `Volume`, `User`, `Workdir`, `Cmd`,
`Entrypoint`, `Healthcheck`, `Shell`, `StopSignal`, `Onbuild`, `Maintainer` —
with flags, mounts and heredocs already parsed.

---

## Compiling to LLB

```ts
import { dockerfileToLLB, registryResolver, writeDefinition, dumpLLB } from "bun-dockerfile-loader";

const result = await dockerfileToLLB(df, {
  target: "runtime",
  buildArgs: { VERSION: "1.4.0" },
  targetPlatform: { OS: "linux", Architecture: "arm64" },
  metaResolver: registryResolver(),   // pin FROM and read the base config
});

await writeDefinition("out.pb", result.definition);
console.log(dumpLLB(result.definition));   // same shape as `buildctl debug dump-llb`
```

`result` carries the `state`, the marshaled `definition`, the OCI `image`
config, the reachable `stages`, the `contextPaths` (what would become
`local.followpaths`) and the build args that were actually referenced.

### Resolvers

`FROM` resolution decides whether the base image's `ENV`, `WORKDIR`, `USER`,
`CMD` and `ENTRYPOINT` are inherited, and whether the reference gets pinned to a
digest.

| Resolver | Behaviour |
| --- | --- |
| `nullResolver()` (default) | Offline. No inherited config, references unpinned. |
| `registryResolver()` | Talks to the registry over HTTPS with anonymous or basic auth; pins digests and reads the real config. |
| `staticResolver({...})` | Serves configs you supply, for tests and hermetic builds. |

### Reproducibility

BuildKit generates a **random** `local.unique` for the build context on every
marshal, so definitions differ between runs. Pass `localUniqueID` (or a
`sessionID`) to pin it.

---

## Getting to an actual image

There are three routes, and they are not equivalent.

### 1. `docker buildx build` (recommended)

```ts
import { buildWithBuildx } from "bun-dockerfile-loader";
await buildWithBuildx({ dockerfile: df, context: ".", tags: ["app:dev"], load: true });
```

The edited document is printed back to Dockerfile text and handed to the real
frontend over stdin. Everything works, including the image config.

### 2. `buildctl` with raw LLB

```ts
import { buildWithBuildctl } from "bun-dockerfile-loader";
await buildWithBuildctl({
  definition: result.definition,
  locals: { context: "." },
  output: "type=local,dest=./out",
});
```

**A raw LLB definition produces a filesystem, not a configured image.** `ENV`,
`CMD`, `ENTRYPOINT`, `LABEL`, `USER`, `WORKDIR` and `EXPOSE` live in the OCI
image config, which BuildKit only accepts from a *frontend* through the gateway
API — stdin-fed LLB has no channel for it. `dockerfileToLLB` returns that config
as `result.image` so you can apply it yourself, e.g.:

```sh
bun run examples/emit-llb.ts --pb out.pb        # writes out.pb + out.image.json
buildctl build --local context=. --output type=oci,dest=img.tar < out.pb
crane mutate ... # or regctl / oras, using out.image.json
```

If `buildctl` is not on `PATH`, the driver falls back to
`docker run --rm -i --network=host moby/buildkit buildctl`.

### 3. Gateway frontend (LLB *and* image config)

```dockerfile
# syntax=your-registry/bun-dockerfile-frontend:latest
FROM alpine:3.20
...
```

```sh
docker buildx build -f frontend.Dockerfile -t your-registry/bun-dockerfile-frontend:latest --push .
```

The frontend speaks gRPC to buildkitd over its stdio pipe (HTTP/2 via
`node:http2` with a custom `createConnection`), reads the Dockerfile through
`ReadFile`, resolves base images through the daemon's own resolver, solves the
generated definition, and returns the result **with** `containerimage.config`.
That is the only way to get both your LLB and a properly configured image.

> **Status of the frontend.** The full protocol flow — Ping, Solve, ReadFile,
> ResolveImageConfig, Return, error propagation, image-config metadata — is
> covered by `test/frontend.test.ts` against an in-process LLBBridge server over
> a real HTTP/2 socket. It has **not** been run against a live buildkitd in this
> repository, because that needs a running Docker engine. Smoke-test it before
> depending on it.

---

## Coverage

Full `dockerfile.v0` instruction set: multi-stage builds and stage references by
name or index, `FROM --platform`, global and stage `ARG` with the built-in
`TARGET*`/`BUILD*` variables, `ENV`/`LABEL` in both modern and legacy forms,
`RUN` in shell and exec form, heredocs (including the shebang-becomes-a-script
case), `RUN --mount` of every type (bind, cache, tmpfs, secret, ssh) with
sharing modes and uid/gid/mode, `--network`, `--security`, `COPY`/`ADD` with
`--from`, `--chown`, `--chmod`, `--link` (via MergeOp), `--parents`,
`--exclude`, `--checksum`, `--keep-git-dir`, `--unpack`, HTTP and Git sources,
`ONBUILD`, `HEALTHCHECK`, `SHELL`, `VOLUME`, `STOPSIGNAL`, `EXPOSE`,
`# syntax`/`# escape`/`# check` directives, and the full bash-style parameter
expansion BuildKit implements.

### Known gaps

- Named contexts (`--build-context foo=...`) are not wired through.
- `ONBUILD` triggers inherited from a base image are recorded in the image
  config but not replayed (BuildKit's `initOnBuildTriggers`).
- Source maps (`Definition.Source`) are not populated, so frontend errors do not
  point back at Dockerfile lines.
- Linter rules and build outlines are not implemented.
- SBOM/provenance attestations are not emitted.

---

## Development

```sh
bun install
bun test          # 89 tests, including the BuildKit parity suites
bun run typecheck
```

The Go golden generators need a Go toolchain; they are only required when
regenerating fixtures.

## License

MIT
