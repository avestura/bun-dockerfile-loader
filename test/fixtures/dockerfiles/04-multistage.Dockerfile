FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM alpine:3.20 AS runtime
COPY --from=build /app/dist /srv
CMD ["/srv/start"]
