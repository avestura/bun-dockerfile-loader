// Reference generator: runs the real dockerfile2llb on fixture Dockerfiles and
// dumps the marshaled LLB plus the resulting image config.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/moby/buildkit/client/llb"
	"github.com/moby/buildkit/client/llb/sourceresolver"
	"github.com/moby/buildkit/frontend/dockerfile/dockerfile2llb"
	"github.com/moby/buildkit/frontend/dockerui"
	"github.com/moby/buildkit/solver/pb"
	digest "github.com/opencontainers/go-digest"
	specs "github.com/opencontainers/image-spec/specs-go/v1"
)

// fakeResolver returns a fixed config for every reference so results are
// deterministic and no network access is needed.
type fakeResolver struct{ configs map[string]string }

func (r *fakeResolver) ResolveImageConfig(ctx context.Context, ref string, opt sourceresolver.Opt) (string, digest.Digest, []byte, error) {
	cfg, ok := r.configs[ref]
	if !ok {
		cfg = `{"architecture":"amd64","os":"linux","config":{},"rootfs":{"type":"layers","diff_ids":["sha256:aaaa"]},"history":[{"created_by":"base"}]}`
	}
	dgst := digest.FromString(ref)
	return ref, dgst, []byte(cfg), nil
}

type out struct {
	Name     string            `json:"name"`
	Digests  []string          `json:"digests"`
	Hexes    []string          `json:"hexes"`
	Image    json.RawMessage   `json:"image"`
	Metadata map[string]any    `json:"metadata"`
	Err      string            `json:"err,omitempty"`
}

func main() {
	dir := os.Args[1]
	entries, err := os.ReadDir(dir)
	if err != nil {
		panic(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".Dockerfile") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	resolver := &fakeResolver{configs: map[string]string{
		"docker.io/library/alpine:3.20": `{"architecture":"amd64","os":"linux","config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Cmd":["/bin/sh"]},"rootfs":{"type":"layers","diff_ids":["sha256:aaaa"]},"history":[{"created_by":"base"}]}`,
		"docker.io/library/node:20-alpine": `{"architecture":"amd64","os":"linux","config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","NODE_VERSION=20.0.0"],"Cmd":["node"],"WorkingDir":"/srv","User":"node"},"rootfs":{"type":"layers","diff_ids":["sha256:bbbb"]},"history":[{"created_by":"base"}]}`,
	}}

	plat := specs.Platform{OS: "linux", Architecture: "amd64"}
	// A current daemon supports every LLB capability; without this the frontend
	// takes legacy paths (no MergeOp for COPY --link, no default-PATH cap).
	llbCaps := pb.Caps.CapSet(pb.Caps.All())
	var results []out

	for _, name := range names {
		dt, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			panic(err)
		}
		o := out{Name: strings.TrimSuffix(name, ".Dockerfile"), Metadata: map[string]any{}}
		res, err := dockerfile2llb.Dockerfile2LLB(context.TODO(), dt, dockerfile2llb.ConvertOpt{
			Config: dockerui.Config{
				BuildPlatforms: []specs.Platform{plat},
			},
			MetaResolver:   resolver,
			TargetPlatform: &plat,
			LLBCaps:        &llbCaps,
		})
		if err != nil {
			o.Err = err.Error()
			results = append(results, o)
			continue
		}
		def, err := res.State.Marshal(context.TODO(), llb.Platform(plat), llb.LocalUniqueID("fixed-unique-id"))
		if err != nil {
			o.Err = err.Error()
			results = append(results, o)
			continue
		}
		for _, b := range def.Def {
			o.Digests = append(o.Digests, string(digest.FromBytes(b)))
			o.Hexes = append(o.Hexes, fmt.Sprintf("%x", b))
		}
		imgJSON, _ := json.Marshal(res.Image)
		o.Image = imgJSON
		for d, md := range def.Metadata {
			pb := md.ToPB()
			m := map[string]any{}
			if len(pb.Description) > 0 {
				m["description"] = pb.Description
			}
			if len(pb.Caps) > 0 {
				caps := []string{}
				for c := range pb.Caps {
					caps = append(caps, c)
				}
				sort.Strings(caps)
				m["caps"] = caps
			}
			o.Metadata[string(d)] = m
		}
		results = append(results, o)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	_ = enc.Encode(results)
}
