# -*- coding: utf-8 -*-
"""voiceasr HTTP server — one endpoint, stdlib only.

WHY NO FRAMEWORK. The service has exactly two routes and one caller (the api
container, over the compose network). Every dependency in this container is an
audit surface on a box that handles a landlord's money data, and Flask/uvicorn
buy nothing here: requests are serialized on purpose anyway (below).

WHY SERIALIZED. The measured forward pass costs ~0.3-0.9 s of 3 threads on the
J4125, and the OCR container may be running concurrently. Two decodes at once
would not finish faster — they would contend the same 4 cores and both slow
down, exactly the contention pattern measured at 2x. A lock keeps the worst
case additive, and the api's parse queue is already single-flight so a second
concurrent caller does not exist in practice.

Routes:
  GET  /healthz            -> {ok, model, uptime}
  POST /recognize?mode=X   body: raw audio bytes (any ffmpeg-readable container)
                           mode: command | amount | yesno | month
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from pipeline import Pipeline

START = time.time()
MAX_BODY = 8 * 1024 * 1024  # Telegram voice notes are ~100KB/10s; 8MB is generous

_pipeline = None
_lock = threading.Lock()


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline


class Handler(BaseHTTPRequestHandler):
    server_version = "voiceasr/1"

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/healthz":
            return self._send(404, {"ok": False, "error": "not found"})
        # health does NOT lazily build the pipeline: a health probe must stay
        # cheap, and the model load is triggered by the warmup in main() so a
        # healthy container is one whose model already loaded
        self._send(
            200,
            {
                "ok": _pipeline is not None,
                "model": "wav2vec2-large-xlsr-53-greek int8",
                "uptimeSec": int(time.time() - START),
            },
        )

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/recognize":
            return self._send(404, {"ok": False, "error": "not found"})
        mode = (parse_qs(url.query).get("mode") or ["command"])[0]
        if mode not in ("command", "amount", "yesno", "month"):
            return self._send(400, {"ok": False, "error": f"bad mode {mode}"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"ok": False, "error": "bad body size"})
        data = self.rfile.read(length)
        try:
            with _lock:
                result = get_pipeline().recognize(data, mode)
            self._send(200, result)
        except Exception as exc:  # noqa: BLE001
            # Detail goes to the LOG, not the wire: the raw text carries ffmpeg
            # command lines and container paths. The api discards the body
            # anyway (recognize() returns null on any failure), so the generic
            # string costs nothing and leaks nothing.
            print(f"recognize failed: {exc!r}"[:500], flush=True)
            self._send(500, {"ok": False, "error": "recognition failed"})

    def log_message(self, fmt, *args):  # stdlib logs to stderr per request;
        pass  # the api logs the call anyway, and double logging is noise


def main():
    # Warm up BEFORE accepting traffic: the model load costs ~1.4 s and the
    # first caller should not pay it, nor should /healthz report ok until the
    # 338MB mmap actually succeeded.
    get_pipeline()
    port = int(os.environ.get("PORT", "8500"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"voiceasr listening on :{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
