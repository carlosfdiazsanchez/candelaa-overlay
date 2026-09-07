import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import urllib.request

ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/items.xml"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "items-recipes.json")

# Recetas que NO son crafteo y no deben entrar al panel:
#  - transmutacion (craftbuttonlocaoverride=...TRANSMUTE): recurso crudo + tarifa de plata,
#    sin retorno de recursos y sin foco. Tratarla como craft inventaba ROIs absurdos
#    (Piel pesada "+368/ud" cuando la transmutacion real cuesta 781 de plata y pierde ~525).
#  - recetas sin craftresource (diarios vacios, muebles, mapas: solo plata).
# De las recetas alternativas (faccion/favor) se elige la primera SIN tokens; si todas
# llevan token, la primera tal cual (asi era el json historico).
TOKEN_MAT = re.compile(r"_TOKEN|_FACTION_")
ENCH_ONLY_MAT = re.compile(r"ALCHEMY_EXTRACT|FISHSAUCE")


def fetch(local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, "items.xml")
    if not os.path.exists(tmp):
        print("descargando %s ..." % ITEMS_URL)
        urllib.request.urlretrieve(ITEMS_URL, tmp)
    return tmp


def cr_parse(cr):
    mats = []
    for m in cr.findall("craftresource"):
        uid = m.get("uniquename")
        if not uid:
            continue
        mats.append({"id": uid, "c": int(m.get("count") or 0), "mr": int(m.get("maxreturnamount") or 0)})
    return {
        "silver": int(cr.get("silver") or 0),
        "amount": int(cr.get("amountcrafted") or 1),
        "transmute": "TRANSMUTE" in (cr.get("craftbuttonlocaoverride") or ""),
        "mats": mats,
    }


def pick(crs):
    usable = [c for c in crs if not c["transmute"] and c["mats"]]
    if not usable:
        return None
    clean = [c for c in usable if not any(TOKEN_MAT.search(m["id"]) for m in c["mats"])]
    return (clean or usable)[0]


def main():
    local = sys.argv[1] if len(sys.argv) > 1 else None
    path = fetch(local)
    tree = ET.parse(path)
    root = tree.getroot()

    values = {}
    base = {}
    ench = {}
    for el in root.iter():
        uid = el.get("uniquename")
        if not uid:
            continue
        iv = el.get("itemvalue")
        if iv is not None:
            try:
                values[uid] = float(iv)
            except ValueError:
                pass
        crs = [cr_parse(c) for c in el.findall("craftingrequirements")]
        chosen = pick(crs)
        if chosen and uid not in base:
            base[uid] = chosen
        for enchs in el.findall("enchantments"):
            for en in enchs.findall("enchantment"):
                lvl = en.get("enchantmentlevel")
                ecrs = [cr_parse(c) for c in en.findall("craftingrequirements")]
                echosen = pick(ecrs)
                # solo los consumibles (extracto/salsa) llevan clave @n propia; el equipo
                # encantado se deriva en el panel sufijando _LEVELn@n a los materiales
                if lvl and echosen and any(ENCH_ONLY_MAT.search(m["id"]) for m in echosen["mats"]):
                    ench["%s@%s" % (uid, lvl)] = echosen

    # item value real (nutricion de la fee de estacion): atributo itemvalue si existe,
    # si no la suma recursiva del valor de sus materiales, por UNIDAD producida
    memo = {}

    def value_of(uid, seen):
        if uid in values:
            return values[uid]
        if uid in memo:
            return memo[uid]
        rec = base.get(uid)
        if not rec or uid in seen:
            return 0.0
        seen = seen | {uid}
        total = sum(value_of(m["id"], seen) * m["c"] for m in rec["mats"])
        v = total / rec["amount"] if total > 0 else 0.0
        memo[uid] = v
        return v

    out = {}

    def emit(key, rec, vuid):
        entry = {"v": round(value_of_entry(rec, vuid), 2), "r": rec["mats"]}
        if rec["amount"] > 1:
            entry["a"] = rec["amount"]
        out[key] = entry

    def value_of_entry(rec, vuid):
        if vuid in values:
            return values[vuid]
        total = sum(value_of(m["id"], {vuid}) * m["c"] for m in rec["mats"])
        return total / rec["amount"] if total > 0 else 0.0

    for uid, rec in base.items():
        emit(uid, rec, uid)
    for key, rec in ench.items():
        emit(key, rec, key)

    stats_batch = sum(1 for e in out.values() if e.get("a"))
    stats_v = sum(1 for e in out.values() if e["v"] > 0)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("recetas: %d (lotes>1: %d, con item value: %d) -> %s" % (len(out), stats_batch, stats_v, os.path.normpath(OUT)))


if __name__ == "__main__":
    main()
