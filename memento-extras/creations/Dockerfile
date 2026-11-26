# Memento's creations container: renders collages, recap videos, animations and cinematic photos, and
# cleans up videos' sound, from files the extras service hands it. Built by Ansible (host/roles/memento_extras).

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS glibc
ARG TARGETARCH
RUN mkdir /glibc && case "${TARGETARCH:-$(uname -m)}" in \
      arm64 | aarch64) cd /usr/lib/aarch64-linux-gnu && cp -L ld-linux-aarch64.so.1 libc.so.6 libm.so.6 libdl.so.2 \
                         libpthread.so.0 libgcc_s.so.1 /glibc/ ;; \
    esac

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS deepfilter
ARG TARGETARCH
RUN case "${TARGETARCH:-$(uname -m)}" in \
      arm64 | aarch64) build=aarch64-unknown-linux-gnu sum=14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166 ;; \
      amd64 | x86_64) build=x86_64-unknown-linux-musl sum=70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da ;; \
      *) echo "No deep-filter build for this CPU ($(uname -m)): ARM64 and x86-64 only." >&2; exit 1 ;; \
    esac \
 && node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require("fs").writeFileSync("/deep-filter", Buffer.from(await r.arrayBuffer()), { mode: 0o755 }); })' \
      "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-$build" \
 && echo "$sum  /deep-filter" | sha256sum -c -

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

RUN apk add --no-cache vips-tools=8.18.2-r0 ffmpeg=8.1.3-r0 py3-onnxruntime=1.24.4-r1 py3-numpy=2.4.6-r0 '!pyc'

RUN mkdir /app && wget -q -O /app/depth.onnx \
      https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx \
 && echo "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d  /app/depth.onnx" | sha256sum -c - \
 && mkdir /app/model && mv /app/depth.onnx /app/model/depth.onnx

COPY --from=glibc /glibc/ /opt/glibc/
COPY --from=deepfilter /deep-filter /app/deep-filter

ENV NODE_ENV=production \
    # vips: only its own file readers.
    VIPS_BLOCK_UNTRUSTED=1 \
    VIPS_CONCURRENCY=2 \
    # The depth step: no bytecode written, numpy on one thread.
    PYTHONDONTWRITEBYTECODE=1 \
    OPENBLAS_NUM_THREADS=1 \
    WORK_DIR=/work \
    MUSIC_DIR=/music
WORKDIR /app
COPY src ./src

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
