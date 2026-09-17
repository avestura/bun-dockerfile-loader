import { describe, expect, test } from "bun:test";
import { Dockerfile } from "../src/edit/document.ts";
import * as b from "../src/edit/builders.ts";
import { ShellLex, envsFromMap } from "../src/parser/shell.ts";

const SAMPLE = `# syntax=docker/dockerfile:1
# escape=\\

ARG NODE=20

FROM node:\${NODE}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun \\
    # install only production deps
    bun install --frozen-lockfile

FROM deps AS build
ENV NODE_ENV=production
COPY . .
RUN <<EOF
set -e
bun run build
EOF

FROM gcr.io/distroless/nodejs20 AS runtime
COPY --from=build --chown=1000:1000 --link /app/dist /app
EXPOSE 3000/tcp
ENTRYPOINT ["node", "/app/index.js"]
`;

describe("parser", () => {
  test("round-trips untouched source byte for byte", () => {
    const df = Dockerfile.parse(SAMPLE);
    expect(df.toString()).toBe(SAMPLE);
  });

  test("reads parser directives", () => {
    const df = Dockerfile.parse(SAMPLE);
    expect(df.syntax).toBe("docker/dockerfile:1");
    expect(df.escapeChar).toBe("\\");
  });

  test("splits stages and names them", () => {
    const df = Dockerfile.parse(SAMPLE);
    expect(df.stages.map((s) => s.name)).toEqual(["deps", "build", "runtime"]);
    expect(df.stage("build")!.baseImage).toBe("deps");
    expect(df.target!.name).toBe("runtime");
  });

  test("keeps global ARG before the first FROM", () => {
    const df = Dockerfile.parse(SAMPLE);
    expect(df.globalArgs).toHaveLength(1);
    expect(df.globalArgs[0]!.type).toBe("Arg");
  });

  test("parses mount flags", () => {
    const df = Dockerfile.parse(SAMPLE);
    const run = df.stage("deps")!.find("Run")[0]!;
    expect(run.mounts).toHaveLength(1);
    expect(run.mounts[0]!.type).toBe("cache");
    expect(run.mounts[0]!.target).toBe("/root/.bun");
    // The comment inside the continuation is dropped from the command.
    expect(run.command.args[0]).toContain("bun install --frozen-lockfile");
  });

  test("captures heredoc bodies", () => {
    const df = Dockerfile.parse(SAMPLE);
    const run = df.stage("build")!.find("Run")[0]!;
    expect(run.heredocs).toHaveLength(1);
    expect(run.heredocs[0]!.delimiter).toBe("EOF");
    expect(run.heredocs[0]!.content).toBe("set -e\nbun run build\n");
  });

  test("parses COPY flags", () => {
    const df = Dockerfile.parse(SAMPLE);
    const copy = df.stage("runtime")!.find("Copy")[0]!;
    expect(copy.from).toBe("build");
    expect(copy.chown).toBe("1000:1000");
    expect(copy.link).toBe(true);
    expect(copy.sources).toEqual(["/app/dist"]);
    expect(copy.dest).toBe("/app");
  });

  test("parses exec-form entrypoint", () => {
    const df = Dockerfile.parse(SAMPLE);
    const ep = df.stage("runtime")!.find("Entrypoint")[0]!;
    expect(ep.command).toEqual({ kind: "exec", args: ["node", "/app/index.js"] });
  });

  test("supports the backtick escape directive", () => {
    const df = Dockerfile.parse("# escape=`\nFROM alpine\nRUN echo a `\n  && echo b\n");
    expect(df.escapeChar).toBe("`");
    const run = df.find("Run")[0]!;
    expect(run.command.args[0]).toContain("echo a");
    expect(run.command.args[0]).toContain("echo b");
  });

  test("legacy ENV form takes the rest of the line", () => {
    const df = Dockerfile.parse("FROM alpine\nENV MSG hello world\n");
    expect(df.find("Env")[0]!.pairs).toEqual([{ key: "MSG", value: "hello world", noDelim: true }]);
  });

  test("ONBUILD wraps an inner instruction", () => {
    const df = Dockerfile.parse("FROM alpine\nONBUILD RUN echo hi\n");
    const ob = df.find("Onbuild")[0]!;
    expect(ob.instruction?.type).toBe("Run");
    expect(ob.instruction?.onbuild).toBe(true);
  });

  test("HEALTHCHECK parses options and exec form", () => {
    const df = Dockerfile.parse(
      'FROM alpine\nHEALTHCHECK --interval=5s --retries=3 CMD ["curl", "-f", "http://localhost/"]\n',
    );
    const hc = df.find("Healthcheck")[0]!;
    expect(hc.interval).toBe("5s");
    expect(hc.retries).toBe(3);
    expect(hc.test).toEqual(["CMD", "curl", "-f", "http://localhost/"]);
  });
});

describe("editing", () => {
  test("re-renders only the nodes that changed", () => {
    const df = Dockerfile.parse(SAMPLE);
    df.stage("runtime")!.setBaseImage("gcr.io/distroless/nodejs22");
    const out = df.toString();
    expect(out).toContain("FROM gcr.io/distroless/nodejs22 AS runtime");
    // An untouched line keeps its original spacing and comment.
    expect(out).toContain("    # install only production deps");
  });

  test("setEnv updates in place and appends when absent", () => {
    const df = Dockerfile.parse(SAMPLE);
    df.stage("build")!.setEnv("NODE_ENV", "development");
    df.stage("build")!.setEnv("PORT", "3000");
    const out = df.toString();
    expect(out).toContain("ENV NODE_ENV=development");
    expect(out).toContain("ENV PORT=3000");
  });

  test("insertAfter places new instructions", () => {
    const df = Dockerfile.parse(SAMPLE);
    const wd = df.stage("deps")!.find("Workdir")[0]!;
    df.insertAfter(wd, b.run("apk add --no-cache git"));
    expect(df.toString()).toContain("WORKDIR /app\nRUN apk add --no-cache git");
  });

  test("mapBaseImages rewrites every FROM", () => {
    const df = Dockerfile.parse(SAMPLE);
    df.mapBaseImages((img) => (img.includes("/") ? "registry.local/" + img : img));
    expect(df.toString()).toContain("FROM registry.local/gcr.io/distroless/nodejs20 AS runtime");
    // `deps` is a stage reference, not an image, and has no slash.
    expect(df.toString()).toContain("FROM deps AS build");
  });

  test("builds a document from scratch", () => {
    const df = Dockerfile.empty();
    df.append(
      b.from("oven/bun:1", { as: "base" }),
      b.workdir("/srv"),
      b.copy(["."], "."),
      b.run(["bun", "test"]),
      b.cmd(["bun", "start"]),
    );
    expect(df.toString()).toBe(
      "FROM oven/bun:1 AS base\nWORKDIR /srv\nCOPY . .\nRUN [\"bun\",\"test\"]\nCMD [\"bun\",\"start\"]\n",
    );
  });

  test("syntax setter adds and replaces the directive", () => {
    const df = Dockerfile.parse("FROM alpine\n");
    df.syntax = "docker/dockerfile:1.7";
    expect(df.toString().startsWith("# syntax=docker/dockerfile:1.7\n")).toBe(true);
  });
});

describe("shell expansion", () => {
  const lex = new ShellLex("\\");
  const env = (vars: Record<string, string>) => envsFromMap(vars);

  test("expands plain and braced variables", () => {
    expect(lex.processWord("$A/b", env({ A: "x" })).result).toBe("x/b");
    expect(lex.processWord("${A}b", env({ A: "x" })).result).toBe("xb");
  });

  test("honours default and alternate forms", () => {
    expect(lex.processWord("${A:-def}", env({})).result).toBe("def");
    expect(lex.processWord("${A:-def}", env({ A: "" })).result).toBe("def");
    expect(lex.processWord("${A-def}", env({ A: "" })).result).toBe("");
    expect(lex.processWord("${A:+alt}", env({ A: "v" })).result).toBe("alt");
    expect(lex.processWord("${A:+alt}", env({})).result).toBe("");
  });

  test("strips prefixes and suffixes", () => {
    expect(lex.processWord("${F%.*}", env({ F: "a.tar.gz" })).result).toBe("a.tar");
    expect(lex.processWord("${F%%.*}", env({ F: "a.tar.gz" })).result).toBe("a");
    expect(lex.processWord("${P#*/}", env({ P: "x/y/z" })).result).toBe("y/z");
    expect(lex.processWord("${P##*/}", env({ P: "x/y/z" })).result).toBe("z");
  });

  test("replaces with / and //", () => {
    expect(lex.processWord("${V/a/b}", env({ V: "aaa" })).result).toBe("baa");
    expect(lex.processWord("${V//a/b}", env({ V: "aaa" })).result).toBe("bbb");
  });

  test("single quotes suppress expansion", () => {
    expect(lex.processWord("'$A'", env({ A: "x" })).result).toBe("$A");
    expect(lex.processWord('"$A"', env({ A: "x" })).result).toBe("x");
  });

  test("tracks matched and unmatched names", () => {
    const r = lex.processWord("$A$B", env({ A: "1" }));
    expect([...r.matched]).toEqual(["A"]);
    expect([...r.unmatched]).toEqual(["B"]);
  });

  test("splits unquoted expansions into words", () => {
    expect(lex.processWords("$A", env({ A: "a b" }))).toEqual(["a", "b"]);
    expect(lex.processWords('"$A"', env({ A: "a b" }))).toEqual(["a b"]);
  });

  test("patterns are regex-based, so * crosses path separators", () => {
    // BuildKit compiles `*` to `.*`, unlike filepath.Match.
    expect(lex.processWord("${P##*/}", env({ P: "x/y/z" })).result).toBe("z");
    expect(lex.processWord("${P#*/}", env({ P: "x/y/z" })).result).toBe("y/z");
  });

  test("special parameters resolve to the empty string", () => {
    expect(lex.processWord("$$", env({})).result).toBe("");
    expect(lex.processWord("a$@b", env({})).result).toBe("ab");
  });

  test("rejects bad substitutions", () => {
    expect(() => lex.processWord("${}", env({}))).toThrow("bad substitution");
    expect(() => lex.processWord("${A:#x}", env({ A: "v" }))).toThrow("unsupported modifier");
  });

  test("errors on ${A:?msg} when unset or empty", () => {
    expect(() => lex.processWord("${A:?boom}", env({}))).toThrow("A: boom");
    expect(() => lex.processWord("${A?}", env({}))).toThrow("is not allowed to be unset");
  });

  test("skipUnsetEnv leaves references intact", () => {
    const keep = new ShellLex("\\", { skipUnsetEnv: true });
    expect(keep.processWord("$A/${B}", env({})).result).toBe("$A/${B}");
  });
});

describe("lossless round-trip", () => {
  // Everything awkward at once: directives, continuations with interior
  // comments, a chomped non-expanding heredoc, JSON and shell forms, ONBUILD.
  const GNARLY = [
    "# syntax=docker/dockerfile:1",
    "# escape=\\",
    "",
    "# a leading comment",
    "ARG BASE=alpine:3.20",
    "",
    "FROM --platform=$BUILDPLATFORM ${BASE} AS base",
    'SHELL ["/bin/bash", "-o", "pipefail", "-c"]',
    "RUN set -e \\",
    "    # inline comment inside a continuation",
    "    && echo 'quoted  spaces' \\",
    '    && echo "$HOME"',
    "COPY --chown=1000:1000 --chmod=755 --link ./a ./b /dst/",
    "ADD --checksum=sha256:deadbeef https://example.com/x.tgz /tmp/",
    "ONBUILD RUN echo triggered",
    "HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD curl -f http://localhost/ || exit 1",
    "RUN <<-'EOT'",
    "\tset -eux",
    "\techo $NOT_EXPANDED",
    "\tEOT",
    'VOLUME ["/data", "/logs"]',
    "ENV MULTI=1 \\",
    "    OTHER=2",
    'LABEL a=1 b="two words"',
    "STOPSIGNAL SIGQUIT",
    'ENTRYPOINT ["/entry"]',
    "",
  ].join("\n");

  const df = Dockerfile.parse(GNARLY);

  test("re-prints the source byte for byte", () => {
    expect(df.toString()).toBe(GNARLY);
  });

  test("parses a chomped, non-expanding heredoc", () => {
    const heredoc = df.find("Run").at(-1)!.heredocs[0]!;
    expect(heredoc.chomp).toBe(true);
    expect(heredoc.expand).toBe(false);
    expect(heredoc.content).toBe("set -eux\necho $NOT_EXPANDED\n");
  });

  test("keeps flags on COPY and ADD", () => {
    const copy = df.find("Copy")[0]!;
    expect({ chown: copy.chown, chmod: copy.chmod, link: copy.link }).toEqual({
      chown: "1000:1000",
      chmod: "755",
      link: true,
    });
    expect(df.find("Add")[0]!.checksum).toBe("sha256:deadbeef");
  });

  test("parses the FROM platform flag and expands nothing at parse time", () => {
    const from = df.find("From")[0]!;
    expect(from.platform).toBe("$BUILDPLATFORM");
    expect(from.image).toBe("${BASE}");
    expect(from.stageName).toBe("base");
  });

  test("reports no warnings for valid syntax", () => {
    expect(df.warnings).toEqual([]);
  });
});
