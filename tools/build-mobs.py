import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

MOBS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/mobs.xml"
LOC_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/localization.xml"
HERE = os.path.dirname(os.path.abspath(__file__))
LANGS = {"en": "EN-US", "es": "ES-ES"}
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# El tipo de recurso vivo va en el propio uniquename, y son TRES familias distintas:
#   animales de cuero      T5_MOB_HIDE_MISTS_OWL
#   bichos de recurso      T5_MOB_CRITTER_FIBER_SWAMP_RED  (y T3_MOB_CRITTER_FIBER, sin sufijo)
#   guardianes de nodo     T6_MOB_GUARDIAN_WOOD_FOREST_RED
# El "_" o fin de cadena al final es obligatorio: sin el, MOB_UNIQUE_POWERCRYSTAL_HIDEOUT
# entraba como recurso de CUERO porque "HIDEout" empieza por HIDE.
RES = re.compile(r"_MOB_(?:DYNAMIC_)?(?:CRITTER_|GUARDIAN_|MINIGUARDIAN_)?"
                 r"(HIDE|ORE|WOOD|FIBER|ROCK)(?:_|$)")
# Invocaciones, cosmeticos y mobs de prueba: no son fauna del mundo y solo ensucian los empates
JUNK = re.compile(r"(SUMMON|VANITY|TUTORIAL|_TEST|DUMMY|LOCATOR)")


def fetch(url, cache_name, local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, cache_name)
    if not os.path.exists(tmp):
        print("descargando %s ..." % url)
        urllib.request.urlretrieve(url, tmp)
    return tmp


def mob_rows(path):
    rows = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag != "Mob":
            continue
        unique = el.get("uniquename") or ""
        hp = el.get("hitpointsmax")
        en = el.get("energymax")
        if unique and hp is not None and en is not None:
            mres = RES.search(unique)
            rows.append({
                "u": unique,
                "t": int(el.get("tier") or 0),
                "r": mres.group(1) if mres else None,
                "sig": "%s:%s" % (hp, en),
            })
        el.clear()
    return rows


def localization(path, wanted):
    out = {code: {} for code in LANGS}
    for _, el in ET.iterparse(path, events=("end",)):
        # OJO: aqui NO se puede limpiar el nodo. El "end" de cada <tuv>/<seg> llega ANTES que el
        # de su <tu>, asi que vaciarlos deja el <tu> sin hijos y no se localiza absolutamente nada.
        if el.tag != "tu":
            continue
        tuid = el.get("tuid") or ""
        if tuid in wanted:
            for tuv in el.findall("tuv"):
                lang = tuv.get(XML_LANG) or tuv.get("lang")
                seg = tuv.find("seg")
                for code, tag in LANGS.items():
                    if lang == tag and seg is not None and seg.text:
                        out[code][tuid] = seg.text.strip()
        el.clear()
    return out


def pretty(unique):
    """Nombre de emergencia para lo que el juego no traduce.

    No se inventa traduccion: solo se limpia. Se quitan el prefijo de tier y los tokens de
    contexto interno (TN/RD/ROADS/ROAMING/DYNAMIC), que no dicen nada al jugador; lo que
    describe a la criatura (AVALON MONK ELITE RECRUIT) se deja tal cual.
    """
    base = re.sub(r"^T\d_MOB_", "", unique)
    base = re.sub(r"^(TN|RD|ROADS|ROAMING|DYNAMIC|CRITTER)_", "", base)
    base = base.replace("_", " ").strip().lower()
    return base.capitalize() if base else unique


def pick(cands):
    """Cual de los mobs que comparten firma se queda con ella.

    Manda el que es recurso vivo: un zorro invocado etiquetado como cuero T2 no molesta a nadie,
    perderse un recurso vivo de verdad si. Despues, lo que no sea invocacion ni mob de prueba.
    """
    live = [c for c in cands if c["r"]]
    if live:
        return sorted(live, key=lambda c: (JUNK.search(c["u"]) is not None, c["t"]))[0]
    real = [c for c in cands if not JUNK.search(c["u"])]
    return (real or cands)[0]


def main():
    mobs_path = fetch(MOBS_URL, "_mobs.xml", sys.argv[1] if len(sys.argv) > 1 else None)
    loc_path = fetch(LOC_URL, "_localization.xml", sys.argv[2] if len(sys.argv) > 2 else None)

    rows = mob_rows(mobs_path)
    print("mobs: %d" % len(rows))

    wanted = set("@MOB_" + r["u"] for r in rows)
    loc = localization(loc_path, wanted)

    by_sig = {}
    for r in rows:
        by_sig.setdefault(r["sig"], []).append(r)
    collisions = sum(1 for v in by_sig.values() if len(v) > 1)
    print("firmas vida:energia -> %d (%d con empate)" % (len(by_sig), collisions))

    for code in LANGS:
        entries = []       # [tier, resource, label]
        idx_of = {}        # uniquename -> posicion en entries
        for r in rows:
            label = loc[code].get("@MOB_" + r["u"]) or pretty(r["u"])
            idx_of[r["u"]] = len(entries)
            entries.append([r["t"], r["r"], label])
        sig = {}
        for s, cands in by_sig.items():
            sig[s] = idx_of[pick(cands)["u"]]
        name = {r["u"]: idx_of[r["u"]] for r in rows}
        blob = {"list": entries, "sig": sig, "name": name}
        path = os.path.normpath(os.path.join(HERE, "..", "data", "mobs-%s.json" % code))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(blob, fh, separators=(",", ":"), ensure_ascii=False)
        localized = sum(1 for r in rows if loc[code].get("@MOB_" + r["u"]))
        print("%s: %d mobs (%d localizados), %d firmas -> %s (%.1f KB)"
              % (code, len(entries), localized, len(sig), path, os.path.getsize(path) / 1024.0))


if __name__ == "__main__":
    main()
