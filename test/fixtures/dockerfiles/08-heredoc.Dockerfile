FROM alpine:3.20
RUN <<EOT
set -eux
echo building
EOT
COPY <<CONF /etc/app.conf
name = app
CONF
