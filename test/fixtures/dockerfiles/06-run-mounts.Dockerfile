FROM alpine:3.20
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    --mount=type=bind,source=/etc,target=/mnt/etc,ro \
    --mount=type=tmpfs,target=/tmp/work,size=1024 \
    --mount=type=secret,id=token \
    --mount=type=ssh \
    --network=none \
    apk add curl
