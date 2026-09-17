/**
 * Load a Dockerfile, rewrite it, and build the result.
 *
 *   bun run examples/edit-and-build.ts
 */
import { Dockerfile, builders as b, buildWithBuildx } from "../src/index.ts";

const df = Dockerfile.parse(`# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
COPY --from=build /app/dist /srv
CMD ["node", "/srv/index.js"]
`);

// --- Inspect ----------------------------------------------------------------
console.log("stages:", df.stages.map((s) => `${s.name} (${s.baseImage})`).join(", "));
console.log("target:", df.target?.name);

// --- Rewrite ----------------------------------------------------------------
// Move every Node base image to Bun, and switch the install step to match.
df.mapBaseImages((image) => (image.startsWith("node:") ? "oven/bun:1-alpine" : image));

const build = df.stage("build")!;
for (const run of build.find("Run")) {
  const command = run.command.args[0] ?? "";
  df.update(run, {
    command: { kind: "shell", args: [command.replace(/^npm ci$/, "bun install --frozen-lockfile").replace(/^npm run /, "bun run ")] },
  });
}

// Pin the runtime image and add provenance metadata.
const runtime = df.stage("runtime")!;
runtime.setLabel("org.opencontainers.image.source", "https://github.com/acme/app");
runtime.setEnv("NODE_ENV", "production");
runtime.add(b.expose("3000"), b.user("1000:1000"));

// Cache the dependency install.
const install = build.find("Run")[0]!;
df.update(install, {
  mounts: [b.mount({ type: "cache", target: "/root/.bun", sharing: "locked" })],
});

console.log("\n--- rewritten ---\n" + df.toString());

// --- Build ------------------------------------------------------------------
// Printing back to Dockerfile text and handing it to buildx is the path that
// gets a fully configured image, because the real frontend runs server side.
if (process.argv.includes("--build")) {
  const result = await buildWithBuildx({
    dockerfile: df,
    context: ".",
    tags: ["acme/app:dev"],
    load: true,
    progress: "plain",
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  console.log("buildx exited with", result.exitCode);
}
