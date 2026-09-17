FROM alpine:3.20
LABEL org.opencontainers.image.source=https://example.com
USER 1000:1000
EXPOSE 8080 9090/udp
VOLUME /data
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --retries=3 CMD ["/bin/check"]
ENTRYPOINT ["/bin/app"]
CMD ["--serve"]
