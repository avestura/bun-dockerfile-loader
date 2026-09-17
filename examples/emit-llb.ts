/**
 * Compile a Dockerfile to LLB and inspect or build it.
 *
 *   bun run examples/emit-llb.ts                 # print the JSON graph
 *   bun run examples/emit-llb.ts --pb out.pb     # write the protobuf definition
 *   bun run examples/emit-llb.ts --online        # resolve FROM against a registry
 *   bun run examples/emit-llb.ts --build         # pipe it into buildctl
 *
 * Feeding the definition to BuildKit by hand:
 *
 *   bun run examples/emit-llb.ts --pb out.pb
 *   buildctl build --local context=. < out.pb
 */
import {
  dockerfileToLLB,
  dumpLLB,
  dumpDot,
  writeDefinition,
  buildWithBuildctl,
  registryResolver,
  imageToJSON,
} from "../src/index.ts";

const SOURCE = `# syntax=docker/dockerfile:1
FROM alpine:3.20 AS base
WORKDIR /app
ENV APP_ENV=production
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \\
    apk add --no-cache ca-certificates
COPY entrypoint.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`;

const online = process.argv.includes("--online");

const result = await dockerfileToLLB(SOURCE, {
  targetPlatform: { OS: "linux", Architecture: "amd64" },
  // Without a resolver, base image ENV/CMD/USER are unknown and the FROM
  // reference is left unpinned. The registry resolver fetches both.
  metaResolver: online ? registryResolver() : undefined,
  // BuildKit randomises this per marshal; pinning it makes output reproducible.
  localUniqueID: "example",
});

console.log("vertices:      ", result.definition.def.length);
console.log("target stage:  ", result.target);
console.log("context paths: ", result.contextPaths.join(", ") || "(whole context)");
console.log("used args:     ", result.usedBuildArgs.join(", ") || "(none)");

const pbIndex = process.argv.indexOf("--pb");
if (pbIndex >= 0) {
  const path = process.argv[pbIndex + 1] ?? "out.pb";
  const size = await writeDefinition(path, result.definition);
  await Bun.write(path.replace(/\.pb$/, "") + ".image.json", imageToJSON(result.image));
  console.log(`\nwrote ${size} bytes to ${path}, image config alongside it`);
} else if (process.argv.includes("--dot")) {
  console.log("\n" + dumpDot(result.definition));
} else {
  console.log("\n" + dumpLLB(result.definition));
}

if (process.argv.includes("--build")) {
  // A raw definition yields a filesystem; the image config has to be applied
  // separately, which is why `--output type=local` is the honest default here.
  const build = await buildWithBuildctl({
    definition: result.definition,
    locals: { context: ".", dockerfile: "." },
    output: "type=local,dest=./llb-out",
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  console.log("buildctl exited with", build.exitCode);
  console.log("ran:", build.command.join(" "));
}
