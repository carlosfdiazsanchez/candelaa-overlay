import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/items.xml"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "items-enchant.json")

# Cantidades exactas de la receta de MEJORA (upgraderequirements), no del craft: son las
# mismas para los tres niveles de un item, y el material va por familias.
#   0 = linea runa/alma/reliquia (Tn_RUNE / Tn_SOUL / Tn_RELIC del tier del item)
#   1 = extracto alquimico (pociones)   2 = salsa de pescado (comida)
# No se filtra por nombre de etiqueta: vale cualquier elemento con uniquename y un hijo
# <enchantments>. Con una lista fija se caian los 40 metamorfos (viven en
# <transformationweapon>, que no esta en la lista tipica de secciones del dump).
KIND = [(re.compile(r"ALCHEMY_EXTRACT"), 1), (re.compile(r"FISHSAUCE"), 2)]


def fetch(local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, "items.xml")
    if not os.path.exists(tmp):
        print("descargando %s ..." % ITEMS_URL)
        urllib.request.urlretrieve(ITEMS_URL, tmp)
    return tmp


def kind_of(mat):
    for rx, code in KIND:
        if rx.search(mat):
            return code
    return 0


def main():
    path = fetch(sys.argv[1] if len(sys.argv) > 1 else None)
    out = {}
    mismatch = 0
    for _, el in ET.iterparse(path, events=("end",)):
        uid = el.get("uniquename")
        if not uid:
            continue
        ench = el.find("enchantments")
        if ench is not None:
            steps = []
            for e in ench.findall("enchantment"):
                res = e.find("upgraderequirements/upgraderesource")
                if res is not None and res.get("uniquename"):
                    steps.append((int(res.get("count") or 0), kind_of(res.get("uniquename"))))
            if steps:
                if len(set(steps)) > 1:
                    mismatch += 1
                out[uid] = list(steps[0])
            el.clear()
    blob = {k: out[k] for k in sorted(out)}
    dst = os.path.normpath(OUT)
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(blob, fh, separators=(",", ":"), ensure_ascii=False)
    kinds = {}
    for c, k in blob.values():
        kinds[k] = kinds.get(k, 0) + 1
    print("encantables: %d  por familia: %s  (con niveles dispares: %d)  ->  %s (%.1f KB)"
          % (len(blob), kinds, mismatch, dst, os.path.getsize(dst) / 1024.0))


if __name__ == "__main__":
    main()
