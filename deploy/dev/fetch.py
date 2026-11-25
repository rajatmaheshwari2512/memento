# Downloads a file and checks its sha256; a file that doesn't match isn't kept.
#   python -I fetch.py <url> <sha256> <file>
import hashlib
import os
import sys
import urllib.request

url, want, out = sys.argv[1:4]
part = out + ".part"
digest = hashlib.sha256()
try:
    with urllib.request.urlopen(url, timeout=60) as response, open(part, "wb") as f:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            f.write(chunk)
    if digest.hexdigest() != want:
        sys.exit(f"{os.path.basename(out)}: its sha256 doesn't match; deleted")
    os.replace(part, out)
finally:
    if os.path.exists(part):
        os.remove(part)
