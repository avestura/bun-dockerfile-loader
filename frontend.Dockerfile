# Builds the BuildKit gateway frontend image.
#
#   docker buildx build -f frontend.Dockerfile -t your-registry/bun-dockerfile-frontend:latest --push .
#
# Then point a Dockerfile at it:
#
#   # syntax=your-registry/bun-dockerfile-frontend:latest
#   FROM alpine:3.20
#   ...
#
# BuildKit runs this image and speaks gRPC over stdin/stdout, so the entrypoint
# must never write anything but protocol data to stdout.
FROM oven/bun:1-alpine AS build
WORKDIR /src
COPY package.json ./
COPY src ./src
# A single file keeps the runtime image free of a module resolution step.
RUN bun build ./src/frontend/main.ts \
      --target=bun \
      --outfile=/out/frontend.js \
      --minify

FROM oven/bun:1-alpine
COPY --from=build /out/frontend.js /frontend.js
# BuildKit inspects this label to recognise the image as a frontend.
LABEL moby.buildkit.frontend.network.none="true"
ENTRYPOINT ["bun", "run", "/frontend.js"]
