import json
import os
import sys
import urllib.request

# Del dump "formatted" salen tres cosas que van juntas porque comparten fichero de 24 MB:
# los nombres por idioma y la tabla por INDICE. Ese indice es la posicion del item en el
# cliente y se MUEVE en cada parche que anade items: es lo que players-feed usa para saber
# que lleva puesto cada jugador, asi que hay que regenerarlo con cada dump nuevo.
DUMP_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json"
HERE = os.path.dirname(os.path.abspath(__file__))
LANGS = {"en": "EN-US", "es": "ES-ES"}


def load(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    with urllib.request.urlopen(DUMP_URL, timeout=900) as resp:
        return json.loads(resp.read().decode("utf-8"))


def write(rel, blob):
    path = os.path.normpath(os.path.join(HERE, "..", "data", rel))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(blob, fh, separators=(",", ":"), ensure_ascii=False)
    return path, os.path.getsize(path) / 1024.0


def main():
    data = load(sys.argv[1] if len(sys.argv) > 1 else None)

    for code, tag in LANGS.items():
        rows = []
        for item in data:
            uid = item.get("UniqueName")
            names = item.get("LocalizedNames")
            name = names.get(tag) if isinstance(names, dict) else None
            if uid and name:
                rows.append({"id": uid, "n": name})
        path, kb = write("items-%s.json" % code, rows)
        print("nombres %s: %d  ->  %s (%.1f KB)" % (code, len(rows), path, kb))

    by_index = []
    for item in data:
        uid = item.get("UniqueName")
        try:
            idx = int(item.get("Index"))
        except (TypeError, ValueError):
            continue
        if not uid or idx < 0:
            continue
        while len(by_index) <= idx:
            by_index.append(None)
        by_index[idx] = uid
    path, kb = write("items-byindex.json", by_index)
    filled = sum(1 for v in by_index if v)
    print("por indice: %d posiciones (%d con item)  ->  %s (%.1f KB)"
          % (len(by_index), filled, path, kb))


if __name__ == "__main__":
    main()
