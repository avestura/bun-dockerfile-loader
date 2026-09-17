FROM alpine:3.20
COPY --chown=1000:1000 --chmod=640 a.txt /dst/a.txt
COPY --link b.txt /dst/b.txt
ADD --unpack=false archive.tar.gz /dst/
