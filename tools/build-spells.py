import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

SPELLS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/spells.xml"
LOC_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/localization.xml"
HERE = os.path.dirname(os.path.abspath(__file__))
LANGS = {"en": "EN-US", "es": "ES-ES"}
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# Sufijos internos de las variantes de un mismo hechizo: el juego traduce solo el hechizo base,
# asi que se van quitando hasta dar con una clave que exista en la localizacion.
SUFFIX = re.compile(r"_(MULTI(_\d+)?|EFFECT|PULSING|IMPACT|IMPACTED|ROOT|AREA|AURA|BUFF|DEBUFF|DOT|HOT|"
                    r"CHANNEL(ING)?|CAST|HIT|TICK|STACK|SELF|TARGET|ENEMY|ALLY|SLOW|STUN|SILENCE|"
                    r"PASSIVE|ACTIVE|TOGGLE|V\d+|Q|W|E|R|\d+)$")


def fetch(url, cache_name, local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, cache_name)
    if not os.path.exists(tmp):
        print("descargando %s ..." % url)
        urllib.request.urlretrieve(url, tmp)
    return tmp


def spell_names(path):
    """Indice -> uniquename, en el mismo orden en que el juego los numera."""
    names = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag.endswith("spell") and el.tag in ("activespell", "passivespell", "togglespell"):
            names.append(el.get("uniquename") or "")
            el.clear()
    return names


def localization(path, wanted):
    """Solo las claves @SPELLS_* que nos hacen falta, por idioma."""
    out = {code: {} for code in LANGS}
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag != "tu":
            continue
        tuid = el.get("tuid") or ""
        if tuid.startswith("@SPELLS_") and tuid in wanted:
            for tuv in el.findall("tuv"):
                lang = tuv.get(XML_LANG) or tuv.get("lang")
                seg = tuv.find("seg")
                for code, tag in LANGS.items():
                    if lang == tag and seg is not None and seg.text:
                        out[code][tuid] = seg.text.strip()
        el.clear()
    return out


def pretty(unique):
    """Nombre de emergencia para lo que el juego no traduce, marcado con ~.

    Ese ~ NO es decorativo: separa las habilidades de verdad (las 2.1k que el jugador ve en su
    barra y que el juego traduce) de los miles de efectos internos —banderas, comida, monturas,
    pulsos de mob— que tambien viajan como casteos. Sin la marca, el panel de combate listaba
    "Flag blue x47" y "Mob territory boss fork lightning pulse hit" en casi todos los jugadores.
    """
    base = unique.replace("_", " ").strip()
    return "~" + base.capitalize() if base else "~"


def main():
    spells_path = fetch(SPELLS_URL, "_spells.xml", sys.argv[1] if len(sys.argv) > 1 else None)
    loc_path = fetch(LOC_URL, "_localization.xml", sys.argv[2] if len(sys.argv) > 2 else None)

    uniques = spell_names(spells_path)
    print("hechizos: %d" % len(uniques))

    # todas las claves candidatas (el hechizo y sus recortes) para no recorrer 74 MB dos veces
    wanted = set()
    chains = []
    for u in uniques:
        chain = []
        cur = u
        seen = set()
        while cur and cur not in seen:
            seen.add(cur)
            key = "@SPELLS_" + cur
            chain.append(key)
            wanted.add(key)
            nxt = SUFFIX.sub("", cur)
            if nxt == cur:
                break
            cur = nxt
        chains.append(chain)

    loc = localization(loc_path, wanted)
    for code in LANGS:
        out = []
        for unique, chain in zip(uniques, chains):
            name = ""
            for key in chain:
                if loc[code].get(key):
                    name = loc[code][key]
                    break
            out.append(name or pretty(unique))
        path = os.path.normpath(os.path.join(HERE, "..", "data", "spells-%s.json" % code))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
        hit = sum(1 for n in out if not n.startswith("~"))
        print("%s: %d nombres (%d localizados) -> %s (%.1f KB)"
              % (code, len(out), hit, path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
