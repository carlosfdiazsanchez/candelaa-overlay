import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import urllib.request

ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/items.xml"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "items-refine.json")

REFINED = re.compile(r"^T(\d)_(PLANKS|METALBAR|CLOTH|LEATHER|STONEBLOCK)(?:_LEVEL(\d))?$")
RAW = re.compile(r"^T(\d)_(WOOD|ORE|FIBER|HIDE|ROCK)(?:_LEVEL(\d))?$")
TOKEN = re.compile(r"_FACTION_.*_TOKEN_")


def fetch(local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, "items.xml")
    if not os.path.exists(tmp):
        print("descargando %s ..." % ITEMS_URL)
        urllib.request.urlretrieve(ITEMS_URL, tmp)
    return tmp


def mats(cr):
    return [[m.get("uniquename"), int(m.get("count") or 0)] for m in cr.findall("craftresource")]


def variants(el):
    out = []
    for cr in el.findall("craftingrequirements"):
        ov = cr.get("craftbuttonlocaoverride") or ""
        out.append({
            "kind": "TRANSMUTE" if "TRANSMUTE" in ov else "REFINE",
            "silver": int(cr.get("silver") or 0),
            "amount": int(cr.get("amountcrafted") or 1),
            "focus": int(float(cr.get("craftingfocus") or 0)),
            "mats": mats(cr),
        })
    return out


def main():
    path = fetch(sys.argv[1] if len(sys.argv) > 1 else None)
    root = ET.parse(path).getroot()

    refine = {}
    transmute = {}
    hearts = {}

    for el in root.iter():
        uid = el.get("uniquename")
        if not uid:
            continue
        rm = REFINED.match(uid)
        tm = RAW.match(uid)
        if not rm and not tm:
            continue
        vs = variants(el)
        if not vs:
            continue

        if tm:
            rows = [[v["mats"][0][0], v["silver"]] for v in vs
                    if v["kind"] == "TRANSMUTE" and len(v["mats"]) == 1 and v["silver"] > 0]
            if rows:
                transmute[uid] = rows
            continue

        base, heart, alts = None, None, []
        for v in vs:
            if v["kind"] != "REFINE" or not v["mats"]:
                continue
            token = [m for m in v["mats"] if TOKEN.search(m[0])]
            if token:
                heart = v
                hearts[rm.group(2)] = token[0][0]
            elif base is None:
                base = v
            else:
                alts.append(v)
        if not base:
            continue

        entry = {
            "v": float(el.get("itemvalue") or 0),
            "f": base["focus"],
            "m": base["mats"],
        }
        if base["amount"] != 1:
            entry["a"] = base["amount"]
        if heart:
            entry["h"] = heart["mats"]
        if alts:
            entry["x"] = [{"a": a["amount"], "m": a["mats"]} for a in alts]
        refine[uid] = entry

    out = {"refine": refine, "transmute": transmute, "hearts": hearts}
    path = os.path.normpath(OUT)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    with_heart = sum(1 for e in refine.values() if e.get("h"))
    with_alt = sum(1 for e in refine.values() if e.get("x"))
    print("refinado: %d (con corazon: %d, con variantes: %d)  transmutacion: %d  corazones: %s"
          % (len(refine), with_heart, with_alt, len(transmute), hearts))
    print("-> %s (%.1f KB)" % (path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
