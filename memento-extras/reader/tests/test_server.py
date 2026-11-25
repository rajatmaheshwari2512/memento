"""The HTTP layer and the label helpers, without a model: python -m unittest discover tests"""

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from common import repair, word_labels

from reader.labeller import Reading
from reader.server import make_handler
from reader.settings import Settings


class FakeLabeller:
    model_name = "fake.onnx"

    def label(self, question: str) -> Reading:
        words = question.split()
        return Reading(tokens=words, tags=["B-WORD" if w == "beach" else "O" for w in words])


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(FakeLabeller(), Settings())
        )  # type: ignore[arg-type]
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def post(self, path: str, body: bytes) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base + path,
            data=body,
            method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_reads_a_question(self) -> None:
        status, body = self.post("/read", json.dumps({"question": "mom at the beach"}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(body["tokens"], ["mom", "at", "the", "beach"])
        self.assertEqual(body["tags"], ["O", "O", "O", "B-WORD"])

    def test_refuses_bad_requests(self) -> None:
        self.assertEqual(self.post("/read", b"not json")[0], 400)
        self.assertEqual(self.post("/read", json.dumps({"question": 5}).encode())[0], 400)
        self.assertEqual(self.post("/read", b"x" * 5000)[0], 413)
        self.assertEqual(self.post("/other", b"{}")[0], 404)
        self.assertEqual(self.post("/read", b"\xff\xfe")[0], 400)  # not UTF-8
        self.assertEqual(
            self.post("/read", b'{"question": "\\ud800"}')[0], 400
        )  # a lone surrogate

    def test_health(self) -> None:
        with urllib.request.urlopen(self.base + "/health") as res:
            self.assertEqual(json.loads(res.read()), {"ok": True})


class LabelHelpersTest(unittest.TestCase):
    def test_first_piece_of_each_word(self) -> None:
        labels = ["O", "B-PER", "I-PER"]
        self.assertEqual(
            word_labels([None, 0, 0, 1, None], [labels[i] for i in [0, 1, 2, 0, 0]], 2),
            ["B-PER", "O"],
        )

    def test_repair(self) -> None:
        self.assertEqual(
            repair(["I-DATE", "I-DATE", "O", "I-PER"]), ["B-DATE", "I-DATE", "O", "B-PER"]
        )


if __name__ == "__main__":
    unittest.main()
