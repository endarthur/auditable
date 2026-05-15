#!/usr/bin/env python
"""Helper for the cross-parser invariant test: loads a YAML file with
ruamel.yaml's safe-typed loader (YAML 1.2) and emits the result as JSON
to stdout.

We use ruamel.yaml instead of PyYAML because PyYAML 6's safe_load defaults
to YAML 1.1 resolvers, which mis-parse 1.2 octal `0o755` (treated as a
string) and unsigned float exponents `1.5e10` (treated as strings). ruamel
targets 1.2 properly with `YAML(typ='safe')`.

Usage: python _ruamel_load.py <path>
Exit 0 on success, 1 with diagnostic on stderr on parse failure or
unsupported value (e.g. dates that don't JSON-encode), 2 if ruamel.yaml
is not installed.
"""
import json
import sys

try:
    from ruamel.yaml import YAML
except ImportError:
    sys.stderr.write("ruamel.yaml not installed (pip install ruamel.yaml)\n")
    sys.exit(2)

if len(sys.argv) != 2:
    sys.stderr.write("usage: python _ruamel_load.py <path>\n")
    sys.exit(2)

with open(sys.argv[1], "rb") as f:
    src = f.read().decode("utf-8")

yaml = YAML(typ="safe")  # YAML 1.2, no arbitrary object construction
try:
    value = yaml.load(src)
except Exception as e:
    sys.stderr.write(f"ruamel.yaml load failed: {e}\n")
    sys.exit(1)

try:
    payload = json.dumps(value, ensure_ascii=False)
except TypeError as e:
    sys.stderr.write(f"value not JSON-serializable: {e}\n")
    sys.exit(1)
# Force UTF-8 on stdout to avoid Windows cp1252 encode errors on non-ASCII.
sys.stdout.buffer.write(payload.encode("utf-8"))
