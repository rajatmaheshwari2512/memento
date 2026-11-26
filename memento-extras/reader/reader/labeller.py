"""The model: a question in, one label per word out."""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from common import tokenize, word_labels
from tokenizers import Tokenizer


@dataclass(frozen=True)
class Reading:
    """The question's words, and one label each (B-/I- plus a label from common.LABELS, or O)."""

    tokens: list[str]
    tags: list[str]


class Labeller:
    """Loads the exported model once; `label` is safe to call from several threads."""

    def __init__(self, model_dir: Path, model_file: str, threads: int, max_chars: int) -> None:
        config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        by_id = sorted((int(i), label) for i, label in config["id2label"].items())
        self._labels = [label for _, label in by_id]
        self._tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self._tokenizer.enable_truncation(max_length=96)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_dir / model_file), options, providers=["CPUExecutionProvider"]
        )
        self._max_chars = max_chars
        self.model_name = model_file

    def label(self, question: str) -> Reading:
        """Label each word of `question` (cut to the length limit)."""
        words = tokenize(question[: self._max_chars])
        if not words:
            return Reading(tokens=[], tags=[])
        encoding = self._tokenizer.encode(words, is_pretokenized=True)
        feed = {
            "input_ids": np.array([encoding.ids], dtype=np.int64),
            "attention_mask": np.array([encoding.attention_mask], dtype=np.int64),
        }
        best = self._session.run(None, feed)[0][0].argmax(-1).tolist()
        tags = word_labels(encoding.word_ids, [self._labels[i] for i in best], len(words))
        return Reading(tokens=words, tags=tags)
