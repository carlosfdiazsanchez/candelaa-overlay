import json
import os
import re
import sys
import urllib.request

# Ficha estatica de cada mapa de los Caminos de Avalon: los layouts son fijos por plantilla,
# asi que el contenido (cofres/mazmorras/nodos) se puede catalogar offline. La identidad
# (id, nombre, tier, tipo TUNNEL_*) sale de nuestro zones.json; el contenido sale del dataset
# comunitario MIT de AO-Noki (el mismo que usan las webs tipo albionmaps). 313 de sus 316
# mapas casan por nombre con las 400 zonas TUNNEL; las no catalogadas quedan solo con la
# identidad (sin clave "k").
MAPS_URL = "https://raw.githubusercontent.com/AO-Noki/avalon-roads/main/src/data/maps.json"
HERE = os.path.dirname(os.path.abspath(__file__))

SIZE = {"small": "s", "large": "l"}
DUN = {"DUNGEON_SOLO": "SOLO", "DUNGEON_GROUP": "GROUP"}


def fetch(url, cache_name, local):
    if local and os.path.exists(local):
        return local
    tmp = os.path.join(HERE, cache_name)
    if not os.path.exists(tmp):
        print("descargando %s ..." % url)
        urllib.request.urlretrieve(url, tmp)
    return tmp


def norm(name):
    return re.sub(r"[^a-z]", "", name.lower())


def pack(items, type_map=None):
    agg = {}
    for it in items:
        t = (type_map or {}).get(it["type"], it["type"])
        s = SIZE.get(it.get("size"), it.get("size") or "s")
        k = (t, s)
        agg[k] = agg.get(k, 0) + int(it.get("count") or 1)
    return [[t, s, n] for (t, s), n in sorted(agg.items())]


def main():
    zones_path = os.path.normpath(os.path.join(HERE, "..", "data", "zones.json"))
    with open(zones_path, encoding="utf-8") as fh:
        zones = json.load(fh)
    maps_path = fetch(MAPS_URL, "_avalon-maps.json", sys.argv[1] if len(sys.argv) > 1 else None)
    with open(maps_path, encoding="utf-8") as fh:
        catalog = json.load(fh)["maps"]

    out = {}
    by_name = {}
    for zid, z in zones.items():
        ztype = z.get("type") or ""
        if not ztype.startswith("TUNNEL"):
            continue
        entry = {"n": z["name"], "t": int(z.get("tier") or 0),
                 "y": re.sub(r"^TUNNEL_?", "", ztype) or "STANDARD"}
        out[zid] = entry
        by_name[norm(z["name"])] = zid

    matched = 0
    unmatched = []
    for m in catalog:
        zid = by_name.get(norm(m["name"]))
        if not zid:
            unmatched.append(m["name"])
            continue
        e = out[zid]
        e["k"] = 1
        e["c"] = pack(m.get("chests") or [])
        e["d"] = pack(m.get("dungeons") or [], DUN)
        e["r"] = pack(m.get("resources") or [])
        if m.get("tier") and not e["t"]:
            e["t"] = int(m["tier"])
        matched += 1

    path = os.path.normpath(os.path.join(HERE, "..", "data", "roads.json"))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    print("zonas TUNNEL: %d · catalogadas: %d/%d · sin casar en el dataset: %s"
          % (len(out), matched, len(catalog), unmatched or "ninguna"))
    print("-> %s (%.1f KB)" % (path, os.path.getsize(path) / 1024.0))


if __name__ == "__main__":
    main()
