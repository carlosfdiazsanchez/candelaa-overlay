"""Escucha el WS del motor de datos en paralelo al overlay y caza el evento de los portales
de Caminos (NewTunnelExit): vuelca a JSONL todo lo que no sea ruido conocido y avisa en
consola cuando un payload menciona un mapa de Caminos o algo con pinta de portal/exit.
No toca la app instalada: el WS admite varios clientes (el overlay ya usa tres)."""
import asyncio
import json
import os
import re
import sys
import time
from collections import Counter

import websockets

WS_URL = "ws://localhost:5001/ws"
HERE = os.path.dirname(os.path.abspath(__file__))
NOISE_EVENTS = {3, 38, 39, 40, 46}
NOISE_OPS = {21, 22}
TRAP_RE = re.compile(r"TUNNEL|_EXIT|EXIT_|AVALON_ROAD", re.I)


def load_roads():
    with open(os.path.join(HERE, "..", "data", "roads.json"), encoding="utf-8") as fh:
        db = json.load(fh)
    norm = lambda s: re.sub(r"[^a-z]", "", s.lower())
    names = {norm(e["n"]): zid for zid, e in db.items()}
    return db, names, norm


ROADS, NAMES, NORM = load_roads()


def strings_of(params):
    for k, v in (params or {}).items():
        if isinstance(v, str) and 3 < len(v) < 64:
            yield k, v


def trap(params):
    hits = []
    for k, v in strings_of(params):
        if v in ROADS or NAMES.get(NORM(v)) or TRAP_RE.search(v):
            hits.append((k, v))
    return hits


async def run(out_path):
    written = 0
    codes = Counter()
    last_report = time.time()
    with open(out_path, "a", encoding="utf-8") as out:
        while True:
            try:
                async with websockets.connect(WS_URL, max_size=None) as ws:
                    print("conectado a %s" % WS_URL, flush=True)
                    async for raw in ws:
                        msg = json.loads(raw)
                        items = msg.get("messages") if msg.get("type") == "batch" else [msg]
                        for m in items or []:
                            d = m.get("dictionary")
                            if isinstance(d, str):
                                try:
                                    d = json.loads(d)
                                except Exception:
                                    d = None
                            p = (d or {}).get("parameters") or {}
                            code = p.get("252") if m.get("code") == "event" else None
                            op = p.get("253")
                            key = "ev%s" % code if code is not None else "op%s:%s" % (m.get("code"), op)
                            codes[key] += 1
                            if code in NOISE_EVENTS or (code is None and op in NOISE_OPS):
                                continue
                            hits = trap(p)
                            rec = {"ts": time.time(), "kind": m.get("code"), "code": code,
                                   "op": op, "p": p}
                            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                            written += 1
                            if hits:
                                print("\n*** TRAP %s hits=%s\n    %s" % (key, hits, json.dumps(p, ensure_ascii=False)[:1200]), flush=True)
                        if time.time() - last_report > 60:
                            last_report = time.time()
                            top = ", ".join("%s×%d" % (c, n) for c, n in codes.most_common(12))
                            print("[%s] escritos=%d · top: %s" % (time.strftime("%H:%M:%S"), written, top), flush=True)
                            out.flush()
            except (OSError, websockets.WebSocketException) as e:
                print("WS no disponible (%s), reintento en 5s..." % type(e).__name__, flush=True)
                await asyncio.sleep(5)


def main():
    os.makedirs(os.path.join(HERE, "captures"), exist_ok=True)
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HERE, "captures", "roads-%s.jsonl" % time.strftime("%Y%m%d-%H%M%S"))
    print("volcando a %s" % out_path, flush=True)
    asyncio.run(run(out_path))


if __name__ == "__main__":
    main()
