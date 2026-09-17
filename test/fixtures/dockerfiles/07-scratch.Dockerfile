FROM scratch
COPY bin/app /app
ENTRYPOINT ["/app"]
