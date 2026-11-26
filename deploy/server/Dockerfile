# memento-server: Immich's server image with Memento's website (apps/web/build.sh) in www/:
#   docker buildx build --build-arg IMMICH_VERSION=<immich_version> -f deploy/server/Dockerfile <folder>
ARG IMMICH_VERSION
FROM ghcr.io/immich-app/immich-server:${IMMICH_VERSION}
ARG IMMICH_VERSION
RUN rm -rf /build/www
COPY www/ /build/www/
LABEL org.opencontainers.image.base.name="ghcr.io/immich-app/immich-server:${IMMICH_VERSION}"
