"""Settings, read from the environment when the reader starts."""

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    """How the reader runs. Every value has a default that suits the main server."""

    model_dir: Path = field(default_factory=lambda: Path(_env("MODEL_DIR", "/app/model")))
    model_file: str = field(default_factory=lambda: _env("MODEL_FILE", "model.onnx"))
    port: int = field(default_factory=lambda: int(_env("PORT", "8000")))
    threads: int = field(
        default_factory=lambda: int(_env("THREADS", "2"))
    )  # the server has 2 cores
    max_chars: int = 300  # the extras service's limit on a question
    max_body_bytes: int = 4096
    request_timeout_s: float = 10.0  # a client that stops sending is dropped after this long
