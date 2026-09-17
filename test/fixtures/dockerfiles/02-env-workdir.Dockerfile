FROM alpine:3.20
ENV APP_HOME=/srv APP_ENV=prod
WORKDIR $APP_HOME
RUN echo "$APP_ENV" > env.txt
