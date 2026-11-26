# Checks that a Memento release's four images can be pulled without logging in, as a server
# pulls them, for both linux/amd64 and linux/arm64. Used by ./memento prod update and by the
# release workflow.
#
#   python3 -I scripts/check-release.py <images> <version>     like: ghcr.io/<owner> v1.2.0
#
# Prints one line per image. Exit: 0 all there, 1 one or more missing, not public or not for both
# platforms, 2 the registry couldn't be reached or answered with an error (try again).
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

IMAGES = ("memento-server", "memento-extras", "memento-reader", "memento-creations")
PLATFORMS = ("linux/amd64", "linux/arm64")
ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
MISSING = (401, 403, 404)


class RegistryError(Exception):
    pass


def registry(prefix):
    """The registry's address and the path in it: ghcr.io/owner, docker.io/user, or user (Docker Hub)."""
    host, _, path = prefix.partition("/")
    if "." not in host and ":" not in host and host != "localhost":
        return "registry-1.docker.io", prefix
    return ("registry-1.docker.io" if host == "docker.io" else host), path


def get_json(url, token=None):
    """GETs url as JSON; a busy registry (429, 5xx) is asked twice more, after 2 and 4 seconds."""
    request = urllib.request.Request(url, headers={"Accept": ACCEPT})
    if token:
        request.add_header("Authorization", "Bearer " + token)
    for wait in (2, 4, None):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if wait is None or (error.code != 429 and error.code < 500):
                raise
            time.sleep(wait)


def missing_or_error(error):
    """None for "not there, or not public"; anything else is the registry's problem."""
    if error.code in MISSING:
        return None
    raise RegistryError(f"HTTP {error.code} from {urllib.parse.urlsplit(error.url).netloc}")


def manifest(host, repository, tag):
    """The tag's manifest (a list of platforms, or one), or None when it's missing or not public."""
    url = f"https://{host}/v2/{repository}/manifests/{urllib.parse.quote(tag)}"
    try:
        return get_json(url)
    except urllib.error.HTTPError as error:
        challenge = error.headers.get("WWW-Authenticate", "")
        if error.code != 401 or "realm=" not in challenge:
            return missing_or_error(error)
    fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    query = urllib.parse.urlencode({key: fields[key] for key in ("service", "scope") if key in fields})
    try:
        body = get_json(fields["realm"] + "?" + query)
        token = body.get("token") or body.get("access_token")
        return get_json(url, token) if token else None
    except urllib.error.HTTPError as error:
        return missing_or_error(error)


def platforms(found):
    return {f"{m['platform'].get('os')}/{m['platform'].get('architecture')}"
            for m in found.get("manifests", []) if m.get("platform")}


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: check-release.py <images, like ghcr.io/owner> <version, like v1.2.0>")
    prefix, version = sys.argv[1].rstrip("/"), sys.argv[2]
    host, path = registry(prefix)
    problems = 0
    for name in IMAGES:
        image = f"{prefix}/{name}:{version}"
        try:
            found = manifest(host, f"{path}/{name}", version)
        except RegistryError as error:
            print(f"Registry error ({error}) for {image}: try again.", file=sys.stderr)
            return 2
        except ValueError:
            print(f"Registry error (an answer that isn't JSON) for {image}: try again.", file=sys.stderr)
            return 2
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"Couldn't reach {host}: {getattr(error, 'reason', error)}. Try again.", file=sys.stderr)
            return 2
        if found is None:
            print(f"  MISSING  {image} (not there, or not public)")
            problems += 1
            continue
        lacking = [platform for platform in PLATFORMS if platform not in platforms(found)]
        if lacking:
            print(f"  MISSING  {image} has no {' or '.join(lacking)} image")
            problems += 1
        else:
            print(f"  ok       {image}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
