# memento-server: Immich's own server image with Memento's website in it, in place of Immich's.
# The same result as a server built from source, which mounts the website over /build/www.
# Built by .github/workflows/release.yml, from a folder with the website (apps/web/build.sh) in www/:
#
#   docker buildx build --build-arg IMMICH_VERSION=v3.4.2 -f deploy/server/Dockerfile <folder>
#
# IMMICH_VERSION must be immich_version (host/roles/immich/defaults/main.yml), the release the
# website was built from; the deploy checks the label below against it.
ARG IMMICH_VERSION
FROM ghcr.io/immich-app/immich-server:${IMMICH_VERSION}
ARG IMMICH_VERSION
RUN rm -rf /build/www
COPY www/ /build/www/
LABEL org.opencontainers.image.base.name="ghcr.io/immich-app/immich-server:${IMMICH_VERSION}"
