# Checks that a Memento release's four images can be pulled without logging in, as a server
# pulls them. Used by ./memento prod update and by the release workflow.
#
#   python3 -I scripts/check-release.py <images> <version>     like: ghcr.io/<owner> v1.2.0
#
# Prints one line per image. Exit: 0 all there, 1 one or more missing or not public,
# 2 the registry couldn't be reached.
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

IMAGES = ("memento-server", "memento-extras", "memento-reader", "memento-creations")
ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


def registry(prefix):
    """The registry's address and the path in it: ghcr.io/owner, docker.io/user, or user (Docker Hub)."""
    host, _, path = prefix.partition("/")
    if "." not in host and ":" not in host and host != "localhost":
        return "registry-1.docker.io", prefix
    return ("registry-1.docker.io" if host == "docker.io" else host), path


def head(url, token=None):
    request = urllib.request.Request(url, method="HEAD", headers={"Accept": ACCEPT})
    if token:
        request.add_header("Authorization", "Bearer " + token)
    urllib.request.urlopen(request, timeout=30).close()


def anonymous_token(challenge):
    """A pull token for anyone, from the registry's WWW-Authenticate challenge (realm, service, scope)."""
    fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    query = urllib.parse.urlencode({key: fields[key] for key in ("service", "scope") if key in fields})
    with urllib.request.urlopen(fields["realm"] + "?" + query, timeout=30) as response:
        body = json.load(response)
    return body.get("token") or body.get("access_token")


def available(host, repository, tag):
    url = f"https://{host}/v2/{repository}/manifests/{urllib.parse.quote(tag)}"
    try:
        head(url)
        return True
    except urllib.error.HTTPError as error:
        challenge = error.headers.get("WWW-Authenticate", "")
        if error.code != 401 or "realm=" not in challenge:
            return False
    try:
        head(url, anonymous_token(challenge))
        return True
    except urllib.error.HTTPError:
        return False


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: check-release.py <images, like ghcr.io/owner> <version, like v1.2.0>")
    prefix, version = sys.argv[1].rstrip("/"), sys.argv[2]
    host, path = registry(prefix)
    missing = 0
    for name in IMAGES:
        try:
            ok = available(host, f"{path}/{name}", version)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"Couldn't reach {host}: {getattr(error, 'reason', error)}", file=sys.stderr)
            return 2
        print(f"  {'ok     ' if ok else 'MISSING'}  {prefix}/{name}:{version}")
        missing += not ok
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
