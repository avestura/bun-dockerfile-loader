FROM alpine:3.20
WORKDIR /app
COPY package.json ./
COPY src /app/src
