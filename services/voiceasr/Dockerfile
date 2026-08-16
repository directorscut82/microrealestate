# voiceasr — Greek voice-command recognition (shadow mode).
#
# debian-slim, NOT alpine: flashlight-text and onnxruntime ship glibc manylinux
# wheels only; on musl pip either fails or silently builds from source without
# the toolchain. The rest of the stack is alpine — this container is the
# documented exception and this comment is why.
#
# All three wheels were verified AVX2-free in the August 2026 evaluation and
# run on the NAS J4125 (SSE4.2-only); the model itself was measured there at
# ~0.9 RTF with 3 threads.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/voiceasr/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/voiceasr/src ./src
COPY services/voiceasr/selftest ./selftest
COPY services/voiceasr/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The 338MB weights are NOT in this image — entrypoint.sh fetches them into
# the /models volume with pinned sha256 (see the rationale there).
ENV VOICEASR_MODELS_DIR=/models
EXPOSE 8500

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://localhost:8500/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
