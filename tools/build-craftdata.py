#!/usr/bin/env python3
"""Genera data/craft-extra.json a partir de los dumps de ao-data/ao-bin-dumps.

Uso: python build-craftdata.py [items.xml] [buildings.xml] [craftingmodifiers.xml]
Sin argumentos descarga los tres (items.xml son ~10 MB).

Contenido del json:
  w     peso por item (kg)
  fame  fama BASE de crafteo por RUN, sin premium ni encantamiento
  a     unidades por craft, solo cuando son mas de una
  jr    familia de diario del item (derivada de la estacion que lo craftea)
  jn    diarios: familia -> tier -> [maxfame, peso]
  loc   localizaciones de crafteo: clave -> {b: bono base, r: bono base de refino,
        c: {craftingcategory: bono}}
  ho    hideouts: bioma -> calidad de cluster -> bonos
"""
import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

RAW = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'craft-extra.json')

# estacion de crafteo -> familia de diario (las que no aparecen no dan diario:
# cocina, alquimia, molino, transmutador, establo)
STATION_JOURNAL = {
    'FORGE': 'warrior',
    'HUNTERSLODGE': 'hunter',
    'MAGICITEMS': 'mage',
    'TOOLMAKER': 'toolmaker',
    'SMELTER': 'ore',
    'CARPENTERSWORKSHOP': 'wood',
    'STONEMASONRY': 'stone',
    'TANNERY': 'hide',
    'WEAVINGMILL': 'fiber',
}
CITY_OF_CLUSTER = {
    '0000': 'Thetford', '1000': 'Lymhurst', '2000': 'Bridgewatch', '3004': 'Martlock',
    '4000': 'FortSterling', '3003': 'Caerleon', '5000': 'Brecilien',
    '4300': "Arthur'sRest", '1012': "Merlyn'sRest", '0008': "Morgana'sRest",
}
ITEM_TAGS = ('equipmentitem', 'weapon', 'simpleitem', 'consumableitem', 'consumablefrominventoryitem',
             'mount', 'furnitureitem', 'journalitem', 'farmableitem', 'trackingitem',
             'transformationweapon', 'crystalleagueitem', 'labourercontract', 'killtrophy')


def fetch(name, arg):
    if arg and os.path.exists(arg):
        return open(arg, 'rb').read()
    sys.stderr.write('descargando %s...\n' % name)
    with urllib.request.urlopen(RAW + name) as r:
        return r.read()


def num(el, key, default=None):
    v = el.get(key)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def main():
    a = sys.argv[1:]
    items = ET.fromstring(fetch('items.xml', a[0] if len(a) > 0 else None))
    buildings = ET.fromstring(fetch('buildings.xml', a[1] if len(a) > 1 else None))
    mods = ET.fromstring(fetch('craftingmodifiers.xml', a[2] if len(a) > 2 else None))

    weight, cat, famevalue, factor, recipe, crafted, journals = {}, {}, {}, {}, {}, {}, {}
    for el in items.iter():
        uid = el.get('uniquename')
        if not uid:
            continue
        w = num(el, 'weight')
        if w is not None:
            weight[uid] = w
        if el.get('craftingcategory'):
            cat[uid] = el.get('craftingcategory')
        fv = num(el, 'famevalue')
        if fv is not None:
            famevalue[uid] = fv
        f = num(el, 'destinyandjournalcraftfamefactor')
        if f is not None:
            factor[uid] = f
        if el.tag == 'journalitem':
            mf = num(el, 'maxfame')
            if mf:
                journals[uid] = (mf, w or 0)
        if el.tag not in ITEM_TAGS or uid in recipe:
            continue
        # la receta base es el craftingrequirements hijo DIRECTO: los de dentro de
        # <enchantments> son las versiones encantadas (fama x2 por nivel)
        cr = el.find('craftingrequirements')
        if cr is None:
            continue
        if 'TRANSMUTE' in (cr.get('craftbuttonlocaoverride') or ''):
            continue
        res = [(r.get('uniquename'), num(r, 'count', 0)) for r in cr.findall('craftresource')]
        res = [(i, c) for i, c in res if i and c]
        if not res:
            continue
        recipe[uid] = res
        crafted[uid] = num(cr, 'amountcrafted', 1.0) or 1.0

    # fama de un craft = suma de la fama de sus materiales / unidades por craft.
    # Los recursos traen famevalue en el dump y cortan la recursion.
    memo = {}

    def fame(uid, depth=0):
        if uid in famevalue:
            return famevalue[uid]
        if uid in memo:
            return memo[uid]
        r = recipe.get(uid)
        if not r or depth > 12:
            return 0.0
        memo[uid] = 0.0
        total = sum(c * fame(mat, depth + 1) for mat, c in r) / (crafted.get(uid) or 1)
        memo[uid] = total * factor.get(uid, 1.0)
        return memo[uid]

    # el json guarda la fama por RUN (no por unidad): es lo que se cobra por pulsar
    # craftear, y con lo que se llenan los diarios
    fames = {}
    for uid in recipe:
        v = fame(uid) * (crafted.get(uid) or 1)
        if v > 0:
            fames[uid] = round(v, 3)

    # item -> familia de diario, por la estacion que lo puede craftear
    jr = {}
    for el in buildings.iter('craftbuilding'):
        uid = el.get('uniquename') or ''
        station = uid.split('_', 1)[1] if uid[:1] == 'T' and '_' in uid else uid
        fam = STATION_JOURNAL.get(station.replace('_TUTORIAL', ''))
        if not fam:
            continue
        for it in el.iter('craftitem'):
            if it.get('uniquename'):
                jr[it.get('uniquename')] = fam

    jn = {}
    for uid, (mf, w) in journals.items():
        parts = uid.split('_')
        if len(parts) != 3 or parts[1] != 'JOURNAL' or not parts[0][1:].isdigit():
            continue
        fam = parts[2].lower()
        jn.setdefault('fish' if fam == 'fishing' else fam, {})[parts[0][1:]] = [mf, w]

    # bonos de retorno por localizacion (ciudades, rests) y por hideout
    loc, ho = {}, {}
    for el in mods.iter('craftinglocation'):
        cats = {m.get('name'): num(m, 'value', 0) for m in el.findall('craftingmodifier')}
        cb = el.find('craftingbonus')
        rb = el.find('refiningbonus')
        entry = {'b': num(cb, 'value', 0.0) if cb is not None else 0.0,
                 'r': num(rb, 'value', 0.0) if rb is not None else 0.0,
                 'c': {k: v for k, v in cats.items() if k}}
        if el.get('clusterid'):
            # los clusterid que no son ciudad ni rest son hideouts de los Caminos: no se
            # ofrecen como localizacion de crafteo
            city = CITY_OF_CLUSTER.get(el.get('clusterid'))
            if city:
                loc[city] = entry
        elif el.get('biome') and el.get('clusterquality'):
            ho.setdefault(el.get('biome'), {})[el.get('clusterquality')] = entry

    keep = set(fames) | set(jr) | set(journals)
    for r in recipe.values():
        keep.update(mat for mat, _ in r)
    out = {
        'w': {k: weight[k] for k in sorted(keep) if k in weight},
        'fame': fames,
        'a': {k: crafted[k] for k in sorted(crafted) if crafted[k] != 1},
        'jr': jr,
        'jn': jn,
        'loc': loc,
        'ho': ho,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'), sort_keys=True)
    sys.stderr.write('craft-extra.json: %d pesos, %d famas, %d diarios de item, %d familias, %d localizaciones, %d biomas\n'
                     % (len(out['w']), len(out['fame']), len(jr), len(jn), len(loc), len(ho)))

    # medido en albionfreemarket con premium desactivado (fama base, 1 run)
    checks = [('T4_BAG', 360), ('T5_BAG', 1440), ('T6_BAG', 4320), ('T8_BAG', 22320),
              ('T4_2H_BOW', 720), ('T6_MEAL_STEW', 960)]
    bad = 0
    for uid, want in checks:
        got = fames.get(uid, 0)
        ok = abs(got - want) < 0.5
        bad += 0 if ok else 1
        sys.stderr.write('  fama %-14s %10.1f  esperado %8d  %s\n' % (uid, got, want, 'ok' if ok else 'MAL'))
    if bad:
        sys.stderr.write('AVISO: %d comprobaciones de fama fallan\n' % bad)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
