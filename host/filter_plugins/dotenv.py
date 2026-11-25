# Reads .env text (KEY=value lines) into a dict. Only the file: the shell's environment isn't read.
#   "{{ lookup('ansible.builtin.file', path) | dotenv }}"
import re

LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def dotenv(text):
    values = {}
    for line in str(text).splitlines():
        match = LINE.match(line)
        if not match:
            continue
        value = re.sub(r"\s#.*$", "", match.group(2)).rstrip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[match.group(1)] = value
    return values


class FilterModule:
    def filters(self):
        return {"dotenv": dotenv}
