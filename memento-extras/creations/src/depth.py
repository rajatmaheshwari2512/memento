# Depth of a photo for cinematic photos (cinematic.ts), by Depth Anything V2 Small.
#
#   python3 depth.py <model.onnx> <in.ppm> <out.pgm>
#
# Reads a small upright 8-bit PPM (each side a multiple of 14) and writes its depth as a 16-bit PGM
# of the same size: 65535 nearest, 0 farthest.

import re
import sys

import numpy as np
import onnxruntime as ort

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
HEADER = re.compile(rb"P6\s+(?:#[^\n]*\n\s*)*(\d+)\s+(?:#[^\n]*\n\s*)*(\d+)\s+(?:#[^\n]*\n\s*)*255\s")


def read_ppm(path: str) -> np.ndarray:
    with open(path, "rb") as f:
        data = f.read()
    m = HEADER.match(data)
    if not m:
        raise ValueError("not an 8-bit PPM")
    w, h = int(m[1]), int(m[2])
    if not (14 <= w <= 1022 and 14 <= h <= 1022 and w % 14 == 0 and h % 14 == 0):
        raise ValueError("unexpected size")
    return np.frombuffer(data, np.uint8, w * h * 3, m.end()).reshape(h, w, 3)


def main(model: str, src: str, dst: str) -> None:
    rgb = read_ppm(src)
    x = (rgb.astype(np.float32) / 255 - MEAN) / STD
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.log_severity_level = 3
    session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    depth = session.run(None, {session.get_inputs()[0].name: x})[0].reshape(rgb.shape[:2])
    lo, hi = np.percentile(depth, [1, 99])
    near = np.clip((depth - lo) / max(float(hi - lo), 1e-6), 0, 1)
    h, w = near.shape
    with open(dst, "wb") as f:
        f.write(b"P5\n%d %d\n65535\n" % (w, h))
        f.write(np.round(near * 65535).astype(">u2").tobytes())


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: depth.py <model.onnx> <in.ppm> <out.pgm>")
    main(*sys.argv[1:])
