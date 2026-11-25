# Adds two "on this day" memories of the test photos, shown now, and gives one a Memento title in
# memento-extras' database. Prints the two memory ids. Run by ./memento dev sample-memories:
#   python -I sample-memories.py <seed folder> <memento-extras data folder>
import datetime
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

API = os.environ.get("IMMICH_API", "http://immich-server:2283/api")
SEED, DATA = sys.argv[1], sys.argv[2]
LABEL = "Spotlight: Grandma Lakshmi"


def call(method, path, body=None):
    token = open(os.path.join(SEED, "session.env")).read().strip().split("=", 1)[1]
    request = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    request.add_header("content-type", "application/json")
    request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        sys.exit(f"{method} {path}: {error.code} {error.read()[:300].decode(errors='replace')}")


me = call("GET", "/users/me")
assets = call("POST", "/search/metadata", {"size": 50, "type": "IMAGE"})["assets"]["items"]
today = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
iso = lambda d: d.isoformat().replace("+00:00", ".000Z")
made = []
for year, picked in ((2023, assets[:3]), (2021, assets[3:6])):
    memory = call("POST", "/memories", {
        "type": "on_this_day",
        "data": {"year": year},
        "memoryAt": iso(today.replace(year=year)),
        "showAt": iso(today - datetime.timedelta(days=1)),
        "hideAt": iso(today + datetime.timedelta(days=2)),
        "assetIds": [a["id"] for a in picked],
    })
    made.append(memory["id"])

db = sqlite3.connect(os.path.join(DATA, "data.db"))
db.execute(
    "INSERT INTO themed_memories (user_id, theme, theme_key, memory_id, status, label, memory_at, show_at, hide_at, made_on, created_at)"
    " VALUES (?, 'spotlight', ?, ?, 'created', ?, ?, ?, ?, ?, ?)",
    (me["id"], f"spotlight:dev-sample-{made[0]}", made[0], LABEL, iso(today.replace(year=2023)),
     iso(today - datetime.timedelta(days=1)), iso(today + datetime.timedelta(days=2)), today.date().isoformat(), iso(today)),
)
db.commit()
print(f"labelled memory: {made[0]} ({LABEL}); Immich's own: {made[1]}")
