package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/moby/buildkit/client/llb"
	digest "github.com/opencontainers/go-digest"
	specs "github.com/opencontainers/image-spec/specs-go/v1"
)

var plat = specs.Platform{OS: "linux", Architecture: "amd64"}

type graph struct {
	Name    string   `json:"name"`
	Digests []string `json:"digests"`
	Hexes   []string `json:"hexes"`
}

func dump(name string, st llb.State) graph {
	def, err := st.Marshal(context.TODO(), llb.Platform(plat))
	if err != nil {
		panic(err)
	}
	g := graph{Name: name}
	for _, dt := range def.Def {
		g.Digests = append(g.Digests, string(digest.FromBytes(dt)))
		g.Hexes = append(g.Hexes, fmt.Sprintf("%x", dt))
	}
	return g
}

func basic() llb.State {
	base := llb.Image("docker.io/library/alpine:latest", llb.Platform(plat))
	src := llb.Local("context", llb.SessionID("SESSION"), llb.SharedKeyHint("ctx"))

	st := base.Dir("/app").AddEnv("FOO", "bar").User("root").
		Run(llb.Args([]string{"/bin/sh", "-c", "echo hi > /out.txt"}), llb.WithCustomName("build it")).Root()

	st = st.File(
		llb.Copy(src, "/pkg.json", "/app/pkg.json", &llb.CopyInfo{
			FollowSymlinks: true, CopyDirContentsOnly: true, AttemptUnpack: true,
			CreateDestPath: true, AllowWildcard: true, AllowEmptyWildcard: true,
		}),
		llb.WithCustomName("copy pkg"),
	)

	return st.Run(
		llb.Args([]string{"/bin/sh", "-c", "make"}),
		llb.AddMount("/root/.cache", llb.Scratch(), llb.AsPersistentCacheDir("cacheid", llb.CacheMountShared)),
		llb.AddMount("/src", src, llb.Readonly),
	).Root()
}

// mounts covers every RUN --mount type the Dockerfile frontend can emit.
func mounts() llb.State {
	base := llb.Image("docker.io/library/debian:bookworm", llb.Platform(plat))
	src := llb.Local("context", llb.SessionID("S"))
	return base.Dir("/w").Run(
		llb.Args([]string{"/bin/sh", "-c", "build"}),
		llb.AddMount("/tmpdir", llb.Scratch(), llb.Tmpfs(llb.TmpfsSize(4096))),
		llb.AddMount("/bind", src, llb.SourcePath("/sub"), llb.Readonly),
		llb.AddMount("/cache", llb.Scratch(), llb.AsPersistentCacheDir("np/cid", llb.CacheMountLocked)),
		llb.AddSecret("/run/secrets/tok", llb.SecretID("tok"), llb.SecretFileOpt(1000, 1000, 0400)),
		llb.AddSSHSocket(llb.SSHID("default"), llb.SSHSocketTarget("/run/ssh.sock")),
		llb.Network(llb.NetModeNone),
		llb.Security(llb.SecurityModeInsecure),
	).Root()
}

// files covers the FileOp actions used by WORKDIR, COPY --chown and heredocs.
func files() llb.State {
	base := llb.Image("docker.io/library/busybox:1", llb.Platform(plat))
	src := llb.Local("context", llb.SessionID("S"))
	st := base.File(
		llb.Mkdir("/app/nested", 0755, llb.WithParents(true), llb.WithUser("nobody")),
		llb.WithCustomName("mkdir"),
	)
	st = st.File(
		llb.Mkfile("/app/run.sh", 0755, []byte("#!/bin/sh\necho hi\n")).
			Mkdir("/data", 0700, llb.WithParents(true)).
			Rm("/app/old", llb.WithAllowNotFound(true), llb.WithAllowWildcard(true)),
		llb.WithCustomName("chained"),
	)
	st = st.File(
		llb.Copy(src, "/etc", "/app/etc", &llb.CopyInfo{
			ChownOpt:        &llb.ChownOpt{User: &llb.UserOpt{UID: 1000}, Group: &llb.UserOpt{Name: "grp"}},
			Mode:            &[]llb.ChmodOpt{{Mode: 0640}}[0],
			IncludePatterns: []string{"*.conf"},
			ExcludePatterns: []string{"secret*"},
			CreateDestPath:  true,
		}),
		llb.WithCustomName("copy etc"),
	)
	return st
}

func mergediff() llb.State {
	a := llb.Image("docker.io/library/alpine:3", llb.Platform(plat)).
		Run(llb.Args([]string{"/bin/sh", "-c", "a"})).Root()
	b := llb.Image("docker.io/library/alpine:3", llb.Platform(plat)).
		Run(llb.Args([]string{"/bin/sh", "-c", "b"})).Root()
	m := llb.Merge([]llb.State{a, b}, llb.WithCustomName("merge ab"))
	return llb.Diff(a, m, llb.WithCustomName("diff"))
}

func main() {
	out := []graph{
		dump("basic", basic()),
		dump("mounts", mounts()),
		dump("files", files()),
		dump("mergediff", mergediff()),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}
