"""HTTP: POST /read {"question": "..."} -> {"tokens": [...], "tags": [...], "ms": n}; GET /health."""

import json
import logging
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from reader.labeller import Labeller
from reader.settings import Settings

log = logging.getLogger("reader")


class BadRequestError(Exception):
    """A request we refuse, with the status and message to answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def make_handler(labeller: Labeller, settings: Settings) -> type[BaseHTTPRequestHandler]:
    """Make a request handler bound to one labeller and its settings."""

    class Handler(BaseHTTPRequestHandler):
        """Answers /health and /read; refuses everything else."""

        timeout = settings.request_timeout_s

        def do_GET(self) -> None:
            """Health check for Docker."""
            if self.path == "/health":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"error": "Not found."})

        def do_POST(self) -> None:
            """Labels the posted question."""
            if self.path != "/read":
                self._send(404, {"error": "Not found."})
                return
            try:
                question = self._question()
            except BadRequestError as error:
                self._send(error.status, {"error": str(error)})
                return
            started = time.perf_counter()
            reading = labeller.label(question)
            ms = round((time.perf_counter() - started) * 1000, 1)
            self._send(200, {"tokens": reading.tokens, "tags": reading.tags, "ms": ms})

        def _question(self) -> str:
            """Return the request's question; raise BadRequestError for anything else."""
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                raise BadRequestError(400, "Content-Length must be a number.") from None
            if length < 0:
                raise BadRequestError(400, "Content-Length must be a number.")
            if length > settings.max_body_bytes:
                raise BadRequestError(413, "Too large.")
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise BadRequestError(400, "Send JSON.") from None
            question = body.get("question") if isinstance(body, dict) else None
            if not isinstance(question, str):
                raise BadRequestError(400, "question must be text.")
            try:
                question.encode("utf-8")
            except UnicodeEncodeError:
                raise BadRequestError(400, "question must be text.") from None
            return question

        def _send(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (stdlib name)
            """Logs no request lines."""

    return Handler


class Server(ThreadingHTTPServer):
    """Waits for requests in hand on shutdown, instead of dropping them."""

    daemon_threads = False
    block_on_close = True


def main() -> None:
    """Load the model, then serve until Docker stops the container."""
    logging.basicConfig(level=logging.INFO, format='{"time":"%(asctime)s","event":"%(message)s"}')
    settings = Settings()
    labeller = Labeller(
        settings.model_dir, settings.model_file, settings.threads, settings.max_chars
    )
    labeller.label("warm up")
    with Server(("0.0.0.0", settings.port), make_handler(labeller, settings)) as server:
        signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
        log.info("started model=%s port=%d", labeller.model_name, settings.port)
        server.serve_forever()
    log.info("stopped")


if __name__ == "__main__":
    main()
