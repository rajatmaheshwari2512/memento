# Sets up dev's Immich: the test admin (credentials.env), a login session (session.env, kept while
# it works), machine learning on or off (DEV_ML), and the test photos. Run by ./memento dev up:
#   python -I seed.py <folder>    (IMMICH_API: Immich's API address)
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid

API = os.environ.get("IMMICH_API", "http://immich-server:2283/api")
DATA = sys.argv[1]
PHOTOS = os.path.join(DATA, "photos")
CREDENTIALS = os.path.join(DATA, "credentials.env")
SESSION = os.path.join(DATA, "session.env")
EMAIL = "admin@local.test"


def call(method, path, body=None, token=None, raw=None, content_type="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(API + path, data=data, method=method)
    if data is not None:
        request.add_header("content-type", content_type)
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        sys.exit(f"{method} {path}: {error.code} {error.read()[:300].decode(errors='replace')}")


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def read_env(path):
    values = {}
    with open(path) as f:
        for line in f:
            if "=" in line:
                key, value = line.rstrip("\n").split("=", 1)
                values[key] = value
    return values


def upload(token, name, created):
    boundary = uuid.uuid4().hex
    with open(os.path.join(PHOTOS, name), "rb") as f:
        content = f.read()
    parts = []
    for key, value in (("filename", name), ("fileCreatedAt", created), ("fileModifiedAt", created)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="{name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode() + content + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return call("POST", "/assets", raw=b"".join(parts), token=token, content_type=f"multipart/form-data; boundary={boundary}")["id"]


if not os.path.exists(CREDENTIALS):
    password = secrets.token_urlsafe(18)
    call("POST", "/auth/admin-sign-up", {"email": EMAIL, "password": password, "name": "Test Admin"})
    write_private(CREDENTIALS, f"EMAIL={EMAIL}\nPASSWORD={password}\n")
    print("created the test admin (credentials.env)")

def saved_token():
    token = read_env(SESSION).get("LOCAL_TOKEN") if os.path.exists(SESSION) else None
    if not token:
        return None
    request = urllib.request.Request(API + "/users/me")
    request.add_header("authorization", f"Bearer {token}")
    try:
        urllib.request.urlopen(request).close()
        return token
    except urllib.error.HTTPError:
        return None


token = saved_token()
if not token:
    credentials = read_env(CREDENTIALS)
    token = call("POST", "/auth/login", {"email": credentials["EMAIL"], "password": credentials["PASSWORD"]})["accessToken"]
    write_private(SESSION, f"LOCAL_TOKEN={token}\n")

config = call("GET", "/system-config", token=token)
config["machineLearning"]["enabled"] = os.environ.get("DEV_ML", "1") != "0"
config["newVersionCheck"]["enabled"] = False
call("PUT", "/system-config", config, token=token)

marker = os.path.join(DATA, "seeded")
if not os.path.exists(marker):
    photos = {
        "big-50mp.jpg": ("2024-12-24T18:30:00.000+05:30", (15.4989, 73.8278)),
        "portrait-exif6.jpg": ("2025-03-02T09:15:00.000+05:30", (12.9716, 77.5946)),
        "transparent.png": ("2025-06-10T12:00:00.000+05:30", None),
        "goa.jpg": ("2023-11-05T17:45:00.000+05:30", (15.5527, 73.7517)),
        "cropped.jpg": ("2022-01-01T10:00:00.000+05:30", (28.6139, 77.2090)),
    }
    if os.path.exists(os.path.join(PHOTOS, "photo.heic")):
        photos["photo.heic"] = ("2025-08-15T08:00:00.000+05:30", (19.0760, 72.8777))
    ids = {}
    for name, (date, place) in photos.items():
        ids[name] = upload(token, name, date)
        update = {"dateTimeOriginal": date}
        if place:
            update["latitude"], update["longitude"] = place
        call("PUT", f"/assets/{ids[name]}", update, token=token)
    for _ in range(60):
        if (call("GET", f"/assets/{ids['cropped.jpg']}", token=token).get("exifInfo") or {}).get("exifImageWidth"):
            break
        time.sleep(1)
    call("PUT", f"/assets/{ids['cropped.jpg']}/edits",
         {"edits": [{"action": "crop", "parameters": {"x": 516, "y": 512, "width": 3000, "height": 2000}}]}, token=token)
    with open(marker, "w") as f:
        json.dump(ids, f, indent=1)
    print(f"uploaded {len(ids)} test photos")
