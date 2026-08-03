import json
import os
import sys
import urllib.request

DUMP_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/items.json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "items-focus.json")
SECTIONS = [
    "simpleitem", "consumableitem", "consumablefrominventoryitem", "equipmentitem",
    "weapon", "mount", "furnitureitem", "journalitem", "farmableitem", "trackingitem",
]


def load_dump(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    with urllib.request.urlopen(DUMP_URL, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def as_list(node):
    if node is None:
        return []
    return node if isinstance(node, list) else [node]


def focus_of(req):
    if not isinstance(req, dict):
        return 0
    try:
        return int(float(req.get("@craftingfocus", 0)))
    except (TypeError, ValueError):
        return 0


def collect(items):
    out = {}
    for section in SECTIONS:
        for item in as_list(items.get(section)):
            if not isinstance(item, dict):
                continue
            uid = item.get("@uniquename")
            if not uid:
                continue
            base = 0
            for req in as_list(item.get("craftingrequirements")):
                base = max(base, focus_of(req))
            ench = {}
            for node in as_list(item.get("enchantments")):
                for e in as_list(node.get("enchantment") if isinstance(node, dict) else None):
                    if not isinstance(e, dict):
                        continue
                    lvl = e.get("@enchantmentlevel")
                    cost = 0
                    for req in as_list(e.get("craftingrequirements")):
                        cost = max(cost, focus_of(req))
                    if lvl and cost:
                        ench[str(lvl)] = cost
            if not base and not ench:
                continue
            rec = {"f": base}
            if ench:
                rec["e"] = ench
            cat = item.get("@craftingcategory")
            if cat:
                rec["c"] = cat
            out[uid] = rec
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    data = load_dump(src)["items"]
    focus = collect(data)
    path = os.path.normpath(OUT)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(focus, fh, separators=(",", ":"), ensure_ascii=False)
    cats = {r.get("c") for r in focus.values() if r.get("c")}
    print("items: %d  categorias: %d  ->  %s (%.1f KB)"
          % (len(focus), len(cats), path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
