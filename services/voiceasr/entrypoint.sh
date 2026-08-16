#!/usr/bin/env bash
# Fetch the model artifacts into the models volume, checksum-pinned, then serve.
#
# WHY DOWNLOADED AT START AND NOT BAKED IN. The ASR model is 338 MB: over
# GitHub's 100 MiB per-file blob limit (so it cannot live in this public repo),
# and the expert review additionally demonstrated that pushing a blob that
# size silently DISABLES scripts/scan-push.mjs for the batch (the ENOBUFS path
# fails open) — so committing it would also blind the PII gate. Baking it into
# the image instead would work but makes every code-only rebuild push ~350 MB
# to GHCR and pull it to the NAS. A named volume + start-time fetch keeps the
# image at ~200 MB and downloads the weights exactly once per NAS.
#
# The sha256 pins are the integrity boundary: a release asset can be replaced
# server-side, a pinned hash cannot be satisfied by a different file.
set -euo pipefail

MODELS_DIR="${VOICEASR_MODELS_DIR:-/models}"
BASE="https://github.com/directorscut82/microrealestate/releases/download/voiceasr-models-v1"

declare -A SHA=(
  [model.int8.onnx]="91da7f797f5c783fdf26fe8eef3600ca90a0f70d912197ec62a9c63955b2f2b0"
  [silero_vad.onnx]="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
)

mkdir -p "$MODELS_DIR"
for f in "${!SHA[@]}"; do
  want="${SHA[$f]}"
  path="$MODELS_DIR/$f"
  if [ -f "$path" ] && echo "$want  $path" | sha256sum -c --status; then
    echo "voiceasr: $f present and verified"
    continue
  fi
  echo "voiceasr: fetching $f ..."
  curl -fSL --retry 5 --retry-delay 5 -o "$path.tmp" "$BASE/$f"
  echo "$want  $path.tmp" | sha256sum -c --status || {
    echo "voiceasr: CHECKSUM MISMATCH for $f — refusing to serve" >&2
    rm -f "$path.tmp"
    exit 1
  }
  mv "$path.tmp" "$path"
  echo "voiceasr: $f fetched and verified"
done

exec python3 /app/src/server.py
