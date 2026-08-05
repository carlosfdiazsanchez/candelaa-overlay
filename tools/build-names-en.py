import json
import os
import sys
import urllib.request

DUMP_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "items-en.json")


def load(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    with urllib.request.urlopen(DUMP_URL, timeout=900) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    data = load(sys.argv[1] if len(sys.argv) > 1 else None)
    out = []
    for item in data:
        uid = item.get("UniqueName")
        name = (item.get("LocalizedNames") or {}).get("EN-US") if isinstance(item.get("LocalizedNames"), dict) else None
        if uid and name:
            out.append({"id": uid, "n": name})
    path = os.path.normpath(OUT)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    print("nombres EN: %d  ->  %s (%.1f KB)" % (len(out), path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
