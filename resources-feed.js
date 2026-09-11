// Resources / treasure radar: connects to OpenRadar's WebSocket and renders
// nearby harvestables, living resources, mobs, and
// Avalon/Mists portals & wisp cages on a mini radar + a distance-sorted list.
// Mirrors OpenRadar's frontend contract (event codes + parameter indices).
//
// Message envelope (batch): { type:'batch', messages:[ {code, dictionary}, ... ] }
//   code = 'event' | 'request' | 'response'; dictionary.parameters keyed by string ints.
//   event:  params['252'] = event code   ·  request/response: params['253'] = op code
//
// Event codes:  39/38 harvestable batch · 40 harvestable single · 46 harvestable change ·
//               123 NewMob (living resource / mob / mist portal) · 47 MobChangeState ·
//               98 NewMob NOMBRADO (los de Avalon llegan por aquí, con @MOB_… y posición) ·
//               323 NewRandomDungeonExit (dungeon / mists portal) ·
//               530 NewCagedObject · 531 CagedObjectStateUpdated · 3 Move · 1 Leave
// Op codes:     22/21 Move (local player pos) · 2 Join · 41 ChangeCluster

(function () {
  const WS_URL = 'ws://localhost:5001/ws';

  // ---- DOM ----
  const canvas = document.getElementById('radar-canvas');
  const listEl = document.getElementById('radar-list');
  const countEl = document.getElementById('rad-count');
  const connEl = document.getElementById('rad-conn');
  const filtersEl = document.getElementById('rad-filters');
  if (!canvas || !listEl) return;
  const ctx = canvas.getContext('2d');

  // ---- state ----
  const harvestables = new Map(); // static resource nodes
  const mobs = new Map();         // living resources + hostile creatures (event 123)
  const mists = new Map();        // mists portals (named 123 entities)
  const portals = new Map();      // dungeon / mists-dungeon portals (event 323)
  const cages = new Map();        // wisp cages
  let lpX = 0, lpY = 0, haveLp = false;
  let selectedId = null;          // entidad fijada: el radar solo la muestra a ella
  let hoverId = null;             // fila bajo el ratón: su punto se resalta en el radar
  let currentMapId = null;
  // { list:[[tier,recurso,nombre]], sig:{"vidaMax:energiaMax":idx}, name:{uniquename:idx} }
  let mobsDB = null;

  // ---- filters (persisted) ----
  const FKEY = 'albion-overlay-radar-filters-v1';
  const filters = (() => {
    const def = { resource: true, living: true, avalon: true };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(FKEY)) || {}); } catch (_) { return def; }
  })();
  const saveFilters = () => { try { localStorage.setItem(FKEY, JSON.stringify(filters)); } catch (_) {} };

  // sub-filters: resource types, tiers, enchant, sort mode (all persisted)
  const SKEY = 'albion-overlay-radar-subfilters-v1';
  const sub = (() => {
    const def = {
      resTypes: { Ore: true, Wood: true, Fiber: true, Hide: true, Rock: true },
      ench: { 0: true, 1: true, 2: true, 3: true, 4: true },
      // 0 = la entidad no trae tier (mobs fuera de la DB): que filtrar por tier no los haga
      // desaparecer en silencio.
      tiers: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true },
      sort: 'dist',    // 'dist' | 'value' | 'tier'
      dir: 'asc',      // 'asc' | 'desc'
      empty: true,     // mostrar nodos vaciados (0 cargas) — se quedan para cronometrar el regen
      ghosts: true,    // nodos recordados fuera de la burbuja, con cargas estimadas
    };
    try {
      const s = JSON.parse(localStorage.getItem(SKEY)) || {};
      // el antiguo select "Tier >=" se convierte en chips para no perder lo que tuviera guardado
      let tiers = s.tiers;
      if (!tiers && s.minTier > 0) { tiers = {}; for (let t = 0; t <= 8; t++) tiers[t] = t === 0 || t >= s.minTier; }
      return {
        resTypes: Object.assign({}, def.resTypes, s.resTypes),
        ench: Object.assign({}, def.ench, s.ench),
        tiers: Object.assign({}, def.tiers, tiers),
        sort: s.sort || 'dist',
        dir: s.dir || 'asc',
        empty: s.empty !== false,
        ghosts: s.ghosts !== false,
      };
    } catch (_) { return def; }
  })();
  const saveSub = () => { try { localStorage.setItem(SKEY, JSON.stringify(sub)); } catch (_) {} };

  const BASE_RANGE_M = 28; // radar view radius (m) — matches the game's ~27m send bubble

  // ---- market value (silver) for resources ----
  const PRICE_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling'];
  const RES_ITEM_TYPE = { Ore: 'ORE', Wood: 'WOOD', Fiber: 'FIBER', Hide: 'HIDE', Rock: 'ROCK' };
  const priceMap = {};   // itemId -> min sell price (silver/unit)
  let priceT = null;
  function resItemId(type, tier, ench) {
    const t = RES_ITEM_TYPE[type]; if (!t || !tier) return null;
    return ench > 0 ? `T${tier}_${t}_LEVEL${ench}@${ench}` : `T${tier}_${t}`;
  }
  // approximate raw units a node yields (from OpenRadar's calculateRealResources)
  function nodeYield(size, tier) {
    const s = size > 0 ? size : 1;
    if (tier <= 3) return s * 3;
    if (tier === 4) return s * 2;
    return s;
  }
  function neededPriceIds() {
    const ids = new Set();
    const add = (type, tier, ench) => { const id = resItemId(type, tier, ench); if (id && !(id in priceMap)) ids.add(id); };
    harvestables.forEach((h) => add(h.type, h.tier, h.ench));
    mobs.forEach((m) => { if (m.living) add(m.resType, m.tier, m.ench); });
    return [...ids];
  }
  function schedulePriceFetch() { if (!priceT) priceT = setTimeout(fetchPrices, 1200); }
  async function fetchPrices() {
    priceT = null;
    const ids = neededPriceIds(); if (!ids.length) return;
    ids.forEach((id) => { priceMap[id] = 0; }); // mark requested so we don't re-ask
    try {
      if (!window.overlay || !window.overlay.scanPrices) return;
      const rows = await window.overlay.scanPrices(ids, PRICE_CITIES, 0);
      (rows || []).forEach((r) => { const s = r.sell_price_min || 0; if (s > 0 && (!priceMap[r.item_id] || s < priceMap[r.item_id])) priceMap[r.item_id] = s; });
    } catch (_) {}
  }

  // ---- resource type & colour helpers (from OpenRadar DrawingUtils) ----
  // Rangos = índice en harvestables.xml del dump ACTUAL (2026-08, 89 entradas). Los rangos
  // clásicos de OpenRadar/ZQRadar (0-5 Wood … 23-27 Ore) son de un dump viejo: al añadir el
  // juego *_TREASURE y las variantes de Caminos, todo se desplazó — ORE es hoy 27-32, así que
  // el mineral dinámico (28) era invisible y HIDE_CRITTER (23) salía pintado como mena.
  // 33-57 son los critters/guardianes de los Caminos de Ávalon, 58 DEADRAT, 59+ plata.
  function staticResourceType(typeNumber) {
    if (typeNumber >= 0 && typeNumber <= 6) return 'Wood';
    if (typeNumber >= 7 && typeNumber <= 13) return 'Rock';
    if (typeNumber >= 14 && typeNumber <= 19) return 'Fiber';
    if (typeNumber >= 20 && typeNumber <= 26) return 'Hide';
    if (typeNumber >= 27 && typeNumber <= 32) return 'Ore';
    if (typeNumber >= 33 && typeNumber <= 37) return 'Wood';
    if (typeNumber >= 38 && typeNumber <= 42) return 'Rock';
    if (typeNumber >= 43 && typeNumber <= 47) return 'Fiber';
    if (typeNumber >= 48 && typeNumber <= 52) return 'Hide';
    if (typeNumber >= 53 && typeNumber <= 57) return 'Ore';
    if (typeNumber === 58) return 'Hide';
    return null;
  }
  const RES_COLOR = { Fiber: '#4CAF50', Hide: '#A1887F', Wood: '#8D6E63', Ore: '#42A5F5', Rock: '#9C27B0' };
  const RES_ICON = { Fiber: '🧵', Hide: '🐗', Wood: '🪵', Ore: '⛏️', Rock: '🪨' };
  const RES_ES = { Fiber: 'Fiber', Hide: 'Hide', Wood: 'Wood', Ore: 'Ore', Rock: 'Rock' };

  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  // ---- mobs database (living resource type/tier + mob classification) ----
  function normResType(t) {
    if (!t) return null;
    const u = String(t).toUpperCase();
    if (u.startsWith('SILVERCOINS') || u.startsWith('DEADRAT')) return null;
    if (u.startsWith('HIDE') || u.startsWith('LEATHER')) return 'Hide';
    if (u.startsWith('FIBER')) return 'Fiber';
    if (u.startsWith('WOOD')) return 'Wood';
    if (u.startsWith('ROCK') || u.startsWith('STONE')) return 'Rock';
    if (u.startsWith('ORE')) return 'Ore';
    return null;
  }
  // El motor de datos DEJÓ de servir /ao-bin-dumps/mobs.min.json (404 comprobado el 2026-08-21),
  // así que la tabla de mobs se empaqueta con el overlay (tools/build-mobs.py) y llega por IPC.
  // Mientras estuvo caída, ningún mob tenía tier ni nombre y los recursos VIVOS no se detectaban
  // nunca: el panel los enseñaba a todos como "Creature".
  function loadMobsDB() {
    try {
      window.overlay.mobsIndex(window.__lang).then((d) => {
        if (d && Array.isArray(d.list)) { mobsDB = d; markDirty(); render(); }
      }).catch(() => {});
    } catch (_) {}
  }
  // El mob NO se identifica por su typeId: ese número es la posición en mobs.xml y se desplaza
  // en cuanto un parche añade criaturas (medido: el dump de hoy va 16 posiciones por delante del
  // cliente). La vida y la energía MÁXIMAS, que vienen en el propio evento, son una firma estable
  // — y única para 4.970 de los 5.186 mobs del dump; en los empates gana el recurso vivo.
  const mobBySig = (hpMax, enMax) => {
    if (!mobsDB || hpMax == null || enMax == null) return null;
    const i = mobsDB.sig[String(hpMax) + ':' + String(enMax)];
    return i == null ? null : mobsDB.list[i];
  };
  const mobByName = (raw) => {
    if (!mobsDB || !raw) return null;
    const i = mobsDB.name[String(raw).replace(/^@MOB_/, '')];
    return i == null ? null : mobsDB.list[i];
  };
  // respaldo cuando la tabla no tiene ese mob: el tier va en el propio nombre
  // (@MOB_T4_MOB_TN_AVALON_MONK_STANDARD -> 4)
  const tierFromName = (raw) => { const m = /T(\d)_MOB_/.exec(String(raw || '')); return m ? +m[1] : 0; };

  // ---- geometry: world -> radar screen (iso rotation, distance preserving) ----
  function rangeM() { return BASE_RANGE_M; }
  function relative(posX, posY) { return { hX: lpX - posX, hY: posY - lpY }; }
  function distMeters(hX, hY) { return Math.sqrt(hX * hX + hY * hY) / 3; }
  // OJO CON LOS SIGNOS: la rotación va en sentido NEGATIVO (-45°), no positivo. Con el signo
  // al revés el radar sale girado 180° — el norte cae al sur y el este al oeste, que es
  // exactamente lo que se veía. El motor de datos usa x*a - y*a / x*a + y*a con a NEGATIVO
  // (-0.785398), y el fondo de mapa (ctx.rotate(-45°)) solo cuadra con esta orientación.
  function toScreen(hX, hY, size) {
    const u = (hY - hX) * Math.SQRT1_2;
    const v = -(hX + hY) * Math.SQRT1_2;
    return { x: size / 2 + u * pxPerUnit(size), y: size / 2 + v * pxPerUnit(size) };
  }
  function pxPerUnit(size) { return (size / 2) / (rangeM() * 3); }
  // ---- fondo: el mapa de la zona ----
  // El motor de datos ya sirve los renders de cada zona (/images/Maps/<id>.webp) y sus límites
  // en zones.json, así que no hay que empaquetar nada: se piden por HTTP como los mobs.
  // La imagen está en coordenadas de mundo (x a la derecha, y hacia abajo) y se orienta con el
  // mismo giro de -45° que los blips; por eso ambos tienen que compartir píxeles-por-unidad.
  const ZONES_URL = 'http://localhost:5001/ao-bin-dumps/zones.json';
  const MAP_IMG_BASE = 'http://localhost:5001/images/Maps/';
  const MAPKEY = 'albion-overlay-radar-map-v1';
  let showMap = localStorage.getItem(MAPKEY) !== '0';
  let zonesDB = null;
  const mapImgs = new Map();
  // Primero el zones.json empaquetado (IPC, siempre está); el HTTP del motor solo de respaldo.
  // El fetch único de antes corría una carrera con el arranque del motor hijo: si perdía,
  // zonesDB quedaba null TODA la sesión y el fondo de mapa desaparecía sin síntoma alguno.
  function loadZonesDB(attempt) {
    const ok = (z) => z && typeof z === 'object' && Object.keys(z).length > 0;
    const fromHttp = () => fetch(ZONES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const fromIpc = () => { try { return window.overlay.zones().catch(() => null); } catch (_) { return Promise.resolve(null); } };
    fromIpc().then((z) => (ok(z) ? z : fromHttp())).then((z) => {
      if (ok(z)) { zonesDB = z; markDirty(); }
      else if ((attempt || 0) < 5) setTimeout(() => loadZonesDB((attempt || 0) + 1), 5000 * ((attempt || 0) + 1));
    });
  }
  // los ids compuestos ("1234-5", instancias) comparten el render de su zona base
  function zoneAsset(id) {
    if (!id) return null;
    const s = String(id);
    for (const key of [s, s.split('-')[0]]) {
      const b = zonesDB && zonesDB[key] && zonesDB[key].bounds;
      if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) continue;
      const v = [b.min[0], b.min[1], b.max[0], b.max[1]];
      if (!v.every(Number.isFinite)) continue;
      const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
      if (!(extent > 0)) continue;
      return { key, extent, cx: (b.min[0] + b.max[0]) / 2, cy: (b.min[1] + b.max[1]) / 2 };
    }
    return null;
  }
  function mapImage(key) {
    if (mapImgs.has(key)) return mapImgs.get(key);
    mapImgs.set(key, null); // una sola petición por zona, haya render o no
    const img = new Image();
    img.onload = () => { mapImgs.set(key, img); markDirty(); };
    // si la petición falla (motor aún arrancando), soltar la marca pasado un rato para
    // reintentar: antes un fallo dejaba esa zona sin render el resto de la sesión
    img.onerror = () => { setTimeout(() => { if (mapImgs.get(key) === null) mapImgs.delete(key); }, 15000); };
    img.src = MAP_IMG_BASE + encodeURIComponent(key) + '.webp';
    return null;
  }
  function drawMapBackground(size) {
    if (!showMap || !haveLp) return;
    const a = zoneAsset(currentMapId); if (!a) return;
    const img = mapImage(a.key); if (!img) return;
    const sf = pxPerUnit(size);
    const w = a.extent * sf;
    const c = size / 2;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.scale(1, -1);
    ctx.translate(c, -c);
    ctx.rotate(-Math.PI / 4);
    ctx.translate(-(lpX - a.cx) * sf, (-lpY + a.cy) * sf);
    ctx.drawImage(img, -w / 2, -w / 2, w, w);
    ctx.restore();
  }

  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  function arrowFor(dx, dy) {
    let a = Math.atan2(dy, dx); // screen space
    if (a < 0) a += Math.PI * 2;
    return ARROWS[Math.round(a / (Math.PI / 4)) % 8];
  }

  // ---- WebSocket ----
  let ws = null, reconnectT = null;
  function setConn(s) {
    if (!connEl) return;
    connEl.className = 'conn ' + (s === 'ok' ? 'ok' : s === 'bad' ? 'bad' : '');
    connEl.title = 'Data engine: ' + (s === 'ok' ? 'connected' : s === 'bad' ? 'disconnected' : 'connecting…');
  }
  function connect() {
    setConn('...');
    try { ws = new WebSocket(WS_URL); } catch (_) { return scheduleReconnect(); }
    ws.onopen = () => setConn('ok');
    ws.onclose = () => { setConn('bad'); scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch (_) {} };
  }
  function scheduleReconnect() { clearTimeout(reconnectT); reconnectT = setTimeout(connect, 3000); }

  const safeParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  function handleMessage(msg) {
    if (msg.type === 'batch' && Array.isArray(msg.messages)) msg.messages.forEach(handleOne);
    else handleOne(msg);
  }
  function handleOne(m) {
    const dict = typeof m.dictionary === 'string' ? safeParse(m.dictionary) : m.dictionary;
    const p = dict && dict.parameters; if (!p) return;
    const kind = m.code; // 'event' | 'request' | 'response'
    const op = p['253'];

    // JoinMap trae DOS cosas en el mismo mensaje: el mapa nuevo [8] y la posición de spawn [9].
    // Antes se hacía return al cambiar de mapa y la posición se perdía, así que al entrar en una
    // zona todo se pintaba respecto a las coordenadas de la zona ANTERIOR hasta que te movías.
    if (kind === 'response' && op === 2) {
      if (typeof p['8'] === 'string') onMapChange(p['8']);
      setLpFromParam(p['9']);
      return;
    }
    // map / zone change -> wipe everything (positions are relative to a cluster)
    if ((op === 2 || op === 3) && typeof p['8'] === 'string') return onMapChange(p['8']);
    if (op === 41 && typeof p['0'] === 'string') return onMapChange(p['0']);

    if (kind === 'request') return onRequest(p, op);
    if (kind === 'response') return onResponse(p, op);
    onEvent(p, p['252']);
  }

  function onMapChange(mapId) {
    if (!mapId || mapId === currentMapId) return;
    currentMapId = mapId;
    harvestables.clear(); mobs.clear(); mists.clear(); portals.clear(); cages.clear();
    selectedId = null;
    haveLp = false;
    lpX = 0; lpY = 0;
  }

  function onRequest(p, op) {
    if (op === 22 || op === 21) setLpFromParam(p['1']);
  }
  function onResponse(p, op) {
    if (op === 2) setLpFromParam(p['9']); // JoinMap: local player spawn position
  }
  function setLpFromParam(v) {
    if (Array.isArray(v) && v.length >= 2) { lpX = num(v[0]); lpY = num(v[1]); haveLp = true; }
    else if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
      try { const dv = new DataView(new Uint8Array(v.data).buffer); lpX = dv.getFloat32(0, true); lpY = dv.getFloat32(4, true); haveLp = true; } catch (_) {}
    }
  }

  // ---- ¿siguen valiendo los números? ----
  // Los eventos de recursos y mobs se despachan por número porque son BAJOS (<150) y llevan
  // años quietos, pero los altos ya se movieron dos veces (los portales pasaron de 323 a 528 y
  // las jaulas al 533, que encima era el case de borrado) y el layout del NewMob cambió sin
  // cambiar de número. Si un parche mueve uno de estos, el radar se queda ciego SIN SÍNTOMA:
  // simplemente no aparecen nodos, que es indistinguible de "no hay nada cerca".
  // Así que cada parser tiene ahora un respaldo por FORMA en el default, con un filtro que
  // mira el payload y —donde la forma sola no distingue— exige que el id ya sea una entidad
  // conocida. Si el número acierta, el respaldo no se usa; si se mueve, el radar sigue viendo.
  // `bump` cuenta por qué vía entró cada cosa: window.__radar.audit() lo enseña, y eso es lo
  // que dice si los números de hoy son los correctos SIN tener que adivinarlo.
  const hits = {};
  const bump = (k) => { hits[k] = (hits[k] || 0) + 1; };
  const seenCodes = {};
  const unknownSamples = {};
  function noteUnknown(code, p) {
    const k = String(code);
    const u = unknownSamples[k] = unknownSamples[k] || { n: 0, sample: null };
    u.n++;
    if (!u.sample) { try { u.sample = JSON.parse(JSON.stringify(p)); } catch (_) {} }
  }
  const numArr = (v) => { const a = (v && v.data) || v; return Array.isArray(a) ? a : null; };
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  // lote de harvestables: tres arrays en paralelo (ids, tipo, tier) y uno de coordenadas con
  // dos por nodo. Imposible de confundir con otro evento.
  function shapeBatchHarvest(p) {
    const a0 = numArr(p['0']), a1 = numArr(p['1']), a2 = numArr(p['2']), a3 = numArr(p['3']);
    if (!a0 || !a1 || !a2 || !a3 || !a0.length) return false;
    if (a1.length !== a0.length || a2.length !== a0.length || a3.length < a0.length * 2) return false;
    if (!a0.every((v) => Number.isFinite(+v)) || !a2.every((v) => isInt(+v, 0, 8))) return false;
    if (!isPos([a3[0], a3[1]])) return false;
    bump('harvest-batch/shape'); batchHarvestables(p); return true;
  }
  // nodo suelto: posición en [8], tipo en [5], tier 0-8 en [7]
  function shapeSingleHarvest(p) {
    if (typeof p['0'] !== 'number' || !isPos(p['8'])) return false;
    if (!Number.isInteger(p['5']) || !isInt(p['7'], 0, 8)) return false;
    bump('harvest-single/shape'); singleHarvestable(p['0'], p); return true;
  }
  // mob nuevo: posición en [7] y vida máxima en [14] (la firma con la que se identifica)
  function shapeMob(p) {
    if (typeof p['0'] !== 'number' || !isPos(p['7']) || !Number.isInteger(p['1'])) return false;
    if (!(num(p['14']) > 0)) return false;
    bump('mob/shape'); newMob(p); return true;
  }
  // mob con nombre: uniquename de mob en [3] y posición en [4]
  function shapeNamedMob(p) {
    if (typeof p['0'] !== 'number' || !isPos(p['4'])) return false;
    if (typeof p['3'] !== 'string' || !/_MOB_/.test(p['3'])) return false;
    bump('mob-named/shape'); newNamedMob(p); return true;
  }
  // cambio de cargas: la forma (dos enteros) no distingue nada, así que se exige que el id sea
  // un nodo que YA tenemos. Eso lo hace inequívoco.
  function shapeHarvestChange(p) {
    if (!harvestables.has(p['0']) || !isInt(p['1'], 0, 9)) return false;
    bump('harvest-change/shape'); harvestableChange(p); return true;
  }
  // encantamiento de un mob conocido. Se exige 1-4: el 0 no aporta nada y es el entero más
  // común en cualquier payload, así que aceptarlo sería pedir un falso positivo.
  function shapeMobEnch(p) {
    const mo = mobs.get(p['0']);
    if (!mo || !isInt(p['1'], 1, 4)) return false;
    bump('mob-ench/shape'); mo.ench = p['1']; mo.last = Date.now(); return true;
  }
  // movimiento de una entidad que ya tenemos (los jugadores van cifrados; mobs y candilejas no)
  function shapeMove(p) {
    const id = p['0'];
    const mo = mobs.get(id), mi = mists.get(id);
    if (!mo && !mi) return false;
    if (!isPos([p['4'], p['5']])) return false;
    bump('move/shape');
    if (mo) { mo.posX = p['4']; mo.posY = p['5']; mo.last = Date.now(); }
    if (mi) { mi.posX = p['4']; mi.posY = p['5']; mi.last = Date.now(); }
    return true;
  }

  function onEvent(p, code) {
    const id = p['0'];
    if (typeof code === 'number') seenCodes[code] = (seenCodes[code] || 0) + 1;
    switch (code) {
      case 1: bump('leave/code'); removeEverywhere(id); break;
      case 3: { // Move: update mob / mist / cage positions
        const x = p['4'], y = p['5'];
        if (x == null) break;
        bump('move/code');
        const mo = mobs.get(id); if (mo) { mo.posX = x; mo.posY = y; mo.last = Date.now(); }
        const mi = mists.get(id); if (mi) { mi.posX = x; mi.posY = y; mi.last = Date.now(); }
        break;
      }
      case 39: case 38: bump('harvest-batch/code'); batchHarvestables(p); break;
      case 40: bump('harvest-single/code'); singleHarvestable(id, p); break;
      case 46: bump('harvest-change/code'); harvestableChange(p); break;
      case 123: bump('mob/code'); newMob(p); break;
      case 98: bump('mob-named/code'); newNamedMob(p); break;
      case 47: { const mo = mobs.get(p['0']); if (mo) { bump('mob-ench/code'); mo.ench = num(p['1'], mo.ench); mo.last = Date.now(); } break; }
      // Los códigos ALTOS bailan con cada parche y ya no se despachan por número: se acepta
      // cualquier evento cuyo PAYLOAD tenga la forma del portal o de la jaula. Medido en vivo
      // 2026-09-10: los portales llegan en 528 (antes 323 -> 325) y las jaulas en 533, que
      // además era el case de BORRADO, así que cada jaula que llegaba se borraba al instante.
      // El borrado por código se quita: para eso están el Leave (evt 1), el cambio de mapa y
      // el barrido de caducados, que no dependen de ningún número.
      default:
        if (newPortal(p)) { bump('portal/shape'); break; }
        if (newCage(p)) { bump('cage/shape'); break; }
        if (shapeBatchHarvest(p)) break;
        if (shapeSingleHarvest(p)) break;
        if (shapeNamedMob(p)) break;
        if (shapeMob(p)) break;
        if (shapeHarvestChange(p)) break;
        if (shapeMove(p)) break;
        if (shapeMobEnch(p)) break;
        noteUnknown(code, p);
        break;
    }
  }

  function removeEverywhere(id) {
    harvestables.delete(id); mobs.delete(id); mists.delete(id);
    portals.delete(id); cages.delete(id);
  }

  // media aprendida de segundos-por-carga, por recurso:tier:ench, persistida entre sesiones:
  // permite estimar la espera en nodos que aún no hemos cronometrado en persona
  const RGKEY = 'albion-overlay-regen-v1';
  const regenDB = (() => { try { return JSON.parse(localStorage.getItem(RGKEY)) || {}; } catch (_) { return {}; } })();
  function learnRegen(type, tier, ench, secs) {
    const k = `${type}:${tier}:${ench || 0}`;
    const r = regenDB[k] || { avg: 0, n: 0 };
    const n = Math.min(r.n, 49);
    r.avg = Math.round((r.avg * n + secs) / (n + 1));
    r.n += 1;
    regenDB[k] = r;
    try { localStorage.setItem(RGKEY, JSON.stringify(regenDB)); } catch (_) {}
  }
  // base oficial de segundos-por-carga (respawntimeseconds de harvestables.xml, coincide con
  // lo medido por la comunidad); el aprendizaje en vivo la sustituye a partir de 2 muestras.
  // Hide T7/T8 no tiene regen estática en el XML — ahí no se estima nada.
  const REGEN_BASE = {
    Wood: { 1: 120, 2: 60, 3: 120, 4: 240, 5: 720, 6: 900, 7: 900, 8: 900 },
    Rock: { 1: 60, 2: 60, 3: 120, 4: 240, 5: 720, 6: 900, 7: 900, 8: 900 },
    Fiber: { 2: 60, 3: 120, 4: 240, 5: 720, 6: 900, 7: 900, 8: 900 },
    Hide: { 2: 60, 3: 180, 4: 500, 5: 1500, 6: 10000 },
    Ore: { 2: 60, 3: 120, 4: 240, 5: 720, 6: 900, 7: 900, 8: 900 },
  };
  function regenAvg(type, tier, ench) {
    const r = regenDB[`${type}:${tier}:${ench || 0}`];
    if (r && r.n >= 2) return r.avg;
    return (REGEN_BASE[type] && REGEN_BASE[type][tier]) || 0;
  }

  // memoria de nodos por mapa+posición (el id de entidad cambia entre sesiones, la posición no):
  // guarda el último size confirmado y CUÁNDO, para estimar cargas al volver a la zona.
  // El ench no va en la clave: la zona lo rerollea cada hora.
  const NKEY = 'albion-overlay-nodes-v1';
  const nodeMem = (() => {
    try {
      const m = JSON.parse(localStorage.getItem(NKEY)) || {};
      const cut = Date.now() - 24 * 3600e3;
      for (const k in m) if (!m[k] || m[k].t < cut) delete m[k];
      return m;
    } catch (_) { return {}; }
  })();
  let nodeMemT = null;
  function saveNodeMem() {
    if (nodeMemT) return;
    nodeMemT = setTimeout(() => {
      nodeMemT = null;
      try {
        const ks = Object.keys(nodeMem);
        if (ks.length > 600) ks.sort((a, b) => nodeMem[a].t - nodeMem[b].t).slice(0, ks.length - 500).forEach((k) => delete nodeMem[k]);
        localStorage.setItem(NKEY, JSON.stringify(nodeMem));
      } catch (_) {}
    }, 1500);
  }
  function nodeMemKey(type, tier, x, y) { return `${currentMapId}|${type}|${tier}|${Math.round(x)}|${Math.round(y)}`; }
  function rememberNode(h) {
    if (!currentMapId || h.size == null) return;
    const k = nodeMemKey(h.type, h.tier, h.posX, h.posY);
    const prev = nodeMem[k];
    nodeMem[k] = { s: h.size, m: Math.max(h.sizeMax || 0, (prev && prev.m) || 0), e: h.ench || 0, x: h.posX, y: h.posY, t: Date.now() };
    saveNodeMem();
  }

  // ---- harvestables (static resource nodes) ----
  function addHarvestable(id, typeNum, tier, posX, posY, ench, size, mobileTypeId) {
    const isLiving = mobileTypeId != null && mobileTypeId !== 65535 && mobileTypeId !== -1;
    if (isLiving) return; // living resources arrive via NewMob (123)
    const type = staticResourceType(typeNum);
    if (!type) return;
    const ex = harvestables.get(id);
    // un re-anuncio significa que acabamos de REENTRAR en la burbuja del nodo: el cronómetro
    // anterior queda invalidado (pudo cambiar sin que lo viéramos) — medir solo bajo
    // observación continua, o el aprendizaje se contamina con intervalos falsos
    if (ex) { ex.tier = tier; ex.ench = ench; ex.regenMark = 0; if (size != null) { ex.size = size; ex.sizeMax = Math.max(ex.sizeMax || 0, size); rememberNode(ex); } ex.last = Date.now(); return; }
    const h = { id, type, tier, posX, posY, ench: ench || 0, size: size || 0, sizeMax: size || 0, last: Date.now() };
    harvestables.set(id, h);
    rememberNode(h);
    schedulePriceFetch();
  }
  function singleHarvestable(id, p) {
    const loc = p['8']; if (!Array.isArray(loc)) return;
    addHarvestable(id, p['5'], p['7'], loc[0], loc[1], p['11'] === undefined ? 0 : p['11'], p['10'] === undefined ? 0 : p['10'], p['6']);
  }
  function batchHarvestables(p) {
    const a0 = (p['0'] && p['0'].data) || p['0'];
    if (!Array.isArray(a0) || !a0.length) return;
    const a1 = (p['1'] && p['1'].data) || p['1'];
    const a2 = (p['2'] && p['2'].data) || p['2'];
    const a3 = p['3'];
    const a4 = (p['4'] && p['4'].data) || p['4'];
    if (!Array.isArray(a1) || !Array.isArray(a2) || !Array.isArray(a3)) return;
    for (let i = 0; i < a0.length; i++) {
      addHarvestable(a0[i], a1[i], a2[i], a3[i * 2], a3[i * 2 + 1], 0, Array.isArray(a4) ? a4[i] : 0, null);
    }
  }
  function harvestableChange(p) {
    const id = p['0'], newSize = p['1'], ench = p['2'];
    const h = harvestables.get(id);
    if (newSize === undefined) { harvestables.delete(id); return; }
    if (!h) return;
    // cronómetro de regeneración: cada subida de size es UNA carga regenerada, y el evento
    // solo llega con el nodo dentro de tu burbuja — el intervalo entre dos cambios seguidos
    // es tiempo real por stack (el ritmo depende de la actividad de la zona, no es fijo).
    if (newSize > h.size && h.regenMark) {
      const secs = Math.round((Date.now() - h.regenMark) / 1000);
      h.regenSecs = secs;
      // solo aprende saltos de +1 carga con intervalo plausible: un salto mayor o un
      // intervalo enorme significa que hubo eventos perdidos fuera de la burbuja
      if (newSize === h.size + 1 && secs >= 5 && secs <= 1800) learnRegen(h.type, h.tier, h.ench, secs);
    }
    h.regenMark = Date.now();
    h.size = newSize; h.sizeMax = Math.max(h.sizeMax || 0, newSize); if (ench !== undefined) h.ench = ench; h.last = Date.now();
    rememberNode(h);
  }

  // El índice donde viaja el nombre en el NewMob se mueve con los parches: hasta 2026-08 el
  // nombre estaba en [32]/[31] y el encantamiento en [33], y hoy esos tres índices ni siquiera
  // llegan en el payload (medido en vivo 2026-09-10: el NewMob acaba en [34]). Leerlos por
  // número dejaba a las candilejas sin nombre, y sin nombre caen por la rama de mob normal y
  // no salen nunca en el radar. Se busca por FORMA: el primer uniquename del payload, mire en
  // el índice que mire.
  function namedKey(p) {
    for (const k in p) {
      if (k === '252' || k === '253') continue;
      const v = p[k];
      if (typeof v === 'string' && /^[A-Z][A-Z0-9_]{3,}$/.test(v)) return k;
    }
    return null;
  }
  // El encantamiento viaja pegado al nombre (era [33] con el nombre en [32]): se acepta el
  // primer entero 0-4 de los índices siguientes.
  function enchNear(p, k) {
    const base = Number(k);
    if (!Number.isFinite(base)) return 0;
    for (let i = base + 1; i <= base + 3; i++) {
      const v = p[String(i)];
      if (Number.isInteger(v) && v >= 0 && v <= 4) return v;
    }
    return 0;
  }

  // ---- mobs / living resources / mists (event 123) ----
  function newMob(p) {
    const id = p['0'];
    const typeId = num(p['1']);
    const loc = Array.isArray(p['7']) ? p['7'] : [0, 0];
    const posX = num(loc[0]), posY = num(loc[1]);
    const nk = namedKey(p);
    const name = nk ? p[nk] : null;
    const ench = nk ? enchNear(p, nk) : 0;
    // Una entidad con nombre dentro del NewMob es un portal de las Brumas (candileja), salvo
    // que el nombre diga _MOB_: esos son mobs de Avalon con nombre y van por la rama de mob.
    if (name && !/_MOB_/.test(name)) {
      sampleShape('mists', p);
      if (!mists.has(id)) mists.set(id, { id, posX, posY, name, ench, last: Date.now() });
      else mists.get(id).last = Date.now();
      return;
    }
    if (mobs.has(id)) { mobs.get(id).last = Date.now(); return; }
    // vida máxima en [14], energía máxima en [19] (los [13]/[18] son los valores ACTUALES y
    // bajan en cuanto al bicho le pegan, así que con ellos la firma no encontraría nada)
    const info = mobBySig(p['14'], p['19']);
    const rec = mobRecord(id, typeId, posX, posY, ench, info, name || undefined);
    // muestreo de vivos: aún no sabemos en qué parámetro viaja el nº de cargas del bicho
    // (el [19] que ZQRadar llama "rarity" es aquí la energía máxima, verificado con la firma).
    // Se guarda el payload crudo de cada recurso vivo para compararlo en vivo entre un
    // ejemplar pequeño y uno grande (window.__radar.livingSamples()).
    if (rec.living && livingSamples.length < 60) livingSamples.push({ id, label: rec.label, tier: rec.tier, res: rec.resType, p: JSON.parse(JSON.stringify(p)) });
    mobs.set(id, rec);
  }
  const livingSamples = [];
  function mobRecord(id, typeId, posX, posY, ench, info, rawName) {
    const res = info ? normResType(info[1]) : null;
    const rec = { id, typeId, posX, posY, ench, last: Date.now(),
      living: !!res, resType: res, tier: (info && info[0]) || tierFromName(rawName),
      label: (info && info[2]) || null };
    if (rec.living) schedulePriceFetch();
    return rec;
  }
  // Los mobs de Avalon (y en general los que el servidor anuncia con nombre) NO llegan por el
  // 123: vienen por el 98 con su uniquename en [3] y la posición en [4]. Sin esto, la mitad de
  // un campamento de Caminos no salía en el radar. Se filtra por la FORMA del payload —un nombre
  // de mob y un par de coordenadas—, no por el número de evento, que se mueve con los parches.
  function newNamedMob(p) {
    const id = p['0'];
    const raw = typeof p['3'] === 'string' ? p['3'] : '';
    const pos = Array.isArray(p['4']) ? p['4'] : null;
    if (id == null || !pos || pos.length < 2 || !/_MOB_/.test(raw)) return;
    if (mobs.has(id)) { mobs.get(id).last = Date.now(); return; }
    mobs.set(id, mobRecord(id, num(p['1']), num(pos[0]), num(pos[1]), 0, mobByName(raw), raw));
  }

  // Un par de coordenadas de mundo plausible, para no aceptar cualquier array del payload.
  function isPos(v) {
    return Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1])
      && Math.abs(v[0]) < 4000 && Math.abs(v[1]) < 4000;
  }

  // ---- dungeon / mists portals (forma: id + posición en [1] + uniquename en [3]/[15]) ----
  const PORTAL_NAME = /MISTS_|DUNGEON|HELLGATE|CORRUPTED|EXPEDITION|ENTRANCE|PORTAL|TUNNEL|AVALON|RANDOM/i;
  function newPortal(p) {
    const id = p['0'];
    const name = typeof p['3'] === 'string' ? p['3'] : (typeof p['15'] === 'string' ? p['15'] : '');
    if (typeof id !== 'number' || !isPos(p['1']) || !PORTAL_NAME.test(name)) return false;
    sampleShape('portal', p);
    const ex = portals.get(id);
    if (ex) { ex.last = Date.now(); return true; }
    portals.set(id, { id, posX: p['1'][0], posY: p['1'][1], name, ench: num(p['8'], 0), last: Date.now() });
    return true;
  }

  // ---- wisp cages (forma: id + posición en [2] + uniquename de jaula en [4]) ----
  const CAGE_NAME = /CAGE|WISP/i;
  function newCage(p) {
    const id = p['0'];
    const name = typeof p['4'] === 'string' ? p['4'] : '';
    if (typeof id !== 'number' || !isPos(p['2']) || !CAGE_NAME.test(name)) return false;
    sampleShape('cage', p);
    if (cages.has(id)) { cages.get(id).last = Date.now(); return true; }
    cages.set(id, { id, posX: p['2'][0], posY: p['2'][1], name, last: Date.now() });
    return true;
  }

  // Muestras crudas por tipo de entidad, para poder comprobar en vivo contra el tráfico real
  // cuando un parche vuelva a mover algo: window.__radar.shapes().
  const shapeSamples = {};
  function sampleShape(kind, p) {
    const arr = shapeSamples[kind] = shapeSamples[kind] || [];
    if (arr.length < 20) arr.push({ code: p['252'], p: JSON.parse(JSON.stringify(p)) });
  }

  // ---- portal classification (label + colour) ----
  const ENCH_COLOR = ['#c9d1d9', '#46d160', '#4aa3ff', '#b96bff', '#ffcc33'];
  function portalInfo(pt) {
    const u = pt.name.toUpperCase();
    if (u.startsWith('MISTS_')) return { es: u.includes('_SOLO') ? 'Mists solo' : 'Mists duo', icon: '🌫️', color: ENCH_COLOR[pt.ench] || '#7ee3d0' };
    if (u.includes('CORRUPTED')) return { es: 'Corrupted', icon: '🕳️', color: '#b96bff' };
    if (u.includes('HELLGATE')) return { es: 'Hellgate', icon: '🔥', color: '#ff6644' };
    if (u.includes('SOLO')) return { es: 'Solo dungeon', icon: '🚪', color: ENCH_COLOR[pt.ench] || '#c9d1d9' };
    return { es: 'Group dungeon', icon: '🚪', color: ENCH_COLOR[pt.ench] || '#c9d1d9' };
  }

  // value (silver) of an entity, for the "Valor" sort + list display
  function resourceValue(type, tier, ench, size) {
    const id = resItemId(type, tier, ench);
    const price = id ? priceMap[id] : 0;
    if (price > 0) return price * nodeYield(size, tier);
    return (tier || 0) * 1000 * (1 + (ench || 0)); // proxy until prices load
  }
  function isPriced(type, tier, ench) { const id = resItemId(type, tier, ench); return !!(id && priceMap[id] > 0); }
  function valueOf(e) {
    if (e.cat === 'resource' || e.cat === 'living') return e.value || 0;
    if (e.cat === 'avalon') return (e.ench || 0) * 2000;
    if (e.cat === 'mob') return (e.ench || 0) * 8000; // enchanted mobs rank above trash
    return 0;
  }

  // ---- unified entity view (respects filters + sub-filters + range) ----
  function collect() {
    const out = [];
    // Sin posición propia no hay nada que orientar: todo saldría en una dirección inventada.
    // Antes se pintaba igualmente contra la última posición conocida (la de la zona anterior).
    if (!haveLp) { out._radar = out; return out; }
    const range = rangeM();
    const push = (cat, e, meta) => {
      const { hX, hY } = relative(e.posX, e.posY);
      const d = distMeters(hX, hY);
      if (d > range * 1.05 && !meta.ghost) return;
      out.push(Object.assign({ cat, id: e.id, hX, hY, d }, meta));
    };
    const okType = (t) => sub.resTypes[t] !== false;
    const okTier = (t) => sub.tiers[t || 0] !== false;
    const okEnch = (e) => sub.ench[e || 0] !== false;
    if (filters.resource) harvestables.forEach((h) => { const sz = h.size || 0; if ((sz >= 1 || sub.empty !== false) && okType(h.type) && okTier(h.tier) && okEnch(h.ench)) push('resource', h, { color: RES_COLOR[h.type] || '#4169E1', icon: RES_ICON[h.type] || '◆', label: RES_ES[h.type] || h.type, tier: h.tier, ench: h.ench, size: sz, empty: sz < 1, mark: h.regenMark, sizeMax: Math.max(h.sizeMax || 0, sz), regen: h.regenSecs, regenAvgS: regenAvg(h.type, h.tier, h.ench), value: resourceValue(h.type, h.tier, h.ench, sz), priced: isPriced(h.type, h.tier, h.ench) }); });
    // nodos recordados de ESTE mapa que ahora mismo no están en la burbuja: se pintan como
    // fantasma con las cargas ESTIMADAS desde la última vez que se les vio (base XML o media
    // aprendida). El size real manda en cuanto el nodo vuelve a anunciarse.
    if (filters.resource && sub.ghosts !== false && currentMapId) {
      const seen = new Set();
      harvestables.forEach((h) => seen.add(nodeMemKey(h.type, h.tier, h.posX, h.posY)));
      const pre = currentMapId + '|';
      for (const k in nodeMem) {
        if (!k.startsWith(pre) || seen.has(k)) continue;
        const r = nodeMem[k];
        const parts = k.split('|');
        const type = parts[1], tier = +parts[2];
        if (!okType(type) || !okTier(tier) || !okEnch(r.e)) continue;
        const per = regenAvg(type, tier, r.e);
        const est = per > 0 && r.m > 0 ? Math.min(r.m, r.s + Math.floor((Date.now() - r.t) / (per * 1000))) : r.s;
        if (est < 1 && sub.empty === false) continue;
        const toFull = per > 0 && r.m > 0 && r.m > est ? Math.max(0, Math.round((r.m - r.s) * per - (Date.now() - r.t) / 1000)) : 0;
        push('resource', { id: 'g|' + k, posX: r.x, posY: r.y }, {
          ghost: true, color: RES_COLOR[type] || '#4169E1', icon: RES_ICON[type] || '◆', label: RES_ES[type] || type,
          tier, ench: r.e, size: est, sizeMax: r.m, empty: est < 1, regenAvgS: per, toFull,
          value: resourceValue(type, tier, r.e, est), priced: isPriced(type, tier, r.e),
        });
      }
    }
    if (filters.living) {
      mobs.forEach((m) => {
        // el nombre real del bicho manda sobre la etiqueta genérica: "Gran búho místico" dice
        // qué tienes delante, "Living hide" no. El tipo de recurso ya lo dan icono y color.
        if (m.living) { if (okType(m.resType) && okTier(m.tier) && okEnch(m.ench)) push('living', m, { color: RES_COLOR[m.resType] || '#8bc34a', icon: RES_ICON[m.resType] || '🐾', label: m.label || 'Living ' + (RES_ES[m.resType] || 'resource').toLowerCase(), tier: m.tier, ench: m.ench, size: 1, value: resourceValue(m.resType, m.tier, m.ench, 1), priced: isPriced(m.resType, m.tier, m.ench), living: true }); }
        else if (okTier(m.tier) && okEnch(m.ench)) push('mob', m, { color: m.ench > 0 ? (ENCH_COLOR[m.ench] || '#ed6a5a') : '#ed6a5a', icon: m.ench > 0 ? '✨' : '👹', label: m.label || (m.ench > 0 ? 'Enchanted creature' : 'Creature'), tier: m.tier, ench: m.ench, enchMob: m.ench > 0 });
      });
    }
    if (filters.avalon) {
      mists.forEach((mi) => { const u = mi.name.toUpperCase(); push('avalon', mi, { color: ENCH_COLOR[mi.ench] || '#7ee3d0', icon: '🌀', label: u.includes('_SOLO') ? 'Mists portal solo' : 'Mists portal duo', ench: mi.ench }); });
      portals.forEach((pt) => { const inf = portalInfo(pt); push('avalon', pt, { color: inf.color, icon: inf.icon, label: inf.es, ench: pt.ench }); });
      cages.forEach((c) => push('avalon', c, { color: '#ff7ac6', icon: '🧚', label: 'Wisp cage' }));
    }
    // selección: si hay un recurso fijado, el radar solo muestra ese (la lista sigue completa)
    let radar = out;
    if (selectedId != null) { const sel = out.find((e) => e.id === selectedId); radar = sel ? [sel] : out; if (!sel) selectedId = null; }
    const metric = sub.sort === 'value' ? valueOf : sub.sort === 'tier' ? (e) => (e.tier || 0) : (e) => e.d;
    const s = sub.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => s * (metric(a) - metric(b)) || a.d - b.d); // tie-break siempre por cercanía
    out._radar = radar;
    return out;
  }

  // ---- render ----
  let dirty = true;
  function markDirty() { dirty = true; }

  function fitCanvas() {
    const w = Math.max(180, Math.min(360, canvas.clientWidth || 260));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._size = w;
    markDirty();
  }

  function drawRadar(entities) {
    const size = canvas._size || (canvas.clientWidth || 260);
    const c = size / 2;
    ctx.clearRect(0, 0, size, size);

    // backdrop
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,12,16,0.55)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.clip();

    drawMapBackground(size);

    // cross-hair + distance rings (10 m / 20 m) so a blip reads as a distance at a glance
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.moveTo(c, 4); ctx.lineTo(c, size - 4); ctx.moveTo(4, c); ctx.lineTo(size - 4, c); ctx.stroke();
    const ppu = pxPerUnit(size);
    ctx.font = '8px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    [10, 20].forEach((m) => {
      const rr = m * 3 * ppu;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.arc(c, c, rr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillText(m + 'm', c + 3, c - rr - 1);
    });

    // blips
    entities.forEach((e) => {
      const s = toScreen(e.hX, e.hY, size);
      const r = 4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      // nodo vacío = anillo hueco del color del recurso: el relleno translúcido de antes se
      // perdía sobre el fondo oscuro y parecía que el nodo no estaba; fantasma = anillo punteado
      if (e.ghost) {
        ctx.globalAlpha = 0.55; ctx.setLineDash([3, 2]); ctx.lineWidth = 1.2; ctx.strokeStyle = e.color; ctx.stroke(); ctx.setLineDash([]);
      } else if (e.empty) {
        ctx.globalAlpha = 0.85; ctx.lineWidth = 1.4; ctx.strokeStyle = e.color; ctx.stroke();
      } else {
        ctx.fillStyle = e.color; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      }
      if (hoverId != null && String(e.id) === hoverId) { ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(s.x, s.y, r + 4.5, 0, Math.PI * 2); ctx.stroke(); }
      if (e.living) { ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, r + 1.6, 0, Math.PI * 2); ctx.stroke(); }
      else if (e.enchMob) { ctx.strokeStyle = ENCH_COLOR[e.ench] || '#fff'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, r + 1.6, 0, Math.PI * 2); ctx.stroke(); }
      if (e.tier) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 2;
        ctx.fillText('T' + e.tier + (e.ench ? '.' + e.ench : ''), s.x, s.y - r - 5);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    // local player (centre)
    ctx.beginPath(); ctx.arc(c, c, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#5aa9c4'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();

    if (!haveLp) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(window.__t ? window.__t('move to get your bearings') : 'move to get your bearings', c, size - 6);
    } else if (selectedId != null) {
      ctx.fillStyle = 'rgba(90,169,196,0.95)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(window.__t ? window.__t('focus: 1 selected (click the list to release)') : 'focus: 1 selected (click the list to release)', c, size - 6);
    }
  }

  const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
  const fmtK = (n) => { const a = Math.abs(n || 0); if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M'; if (a >= 1e3) return Math.round(n / 1e3) + 'K'; return String(Math.round(n || 0)); };
  const fmtSecs = (s) => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  function drawList(entities) {
    if (!entities.length) {
      listEl.innerHTML = haveLp
        ? '<div class="rad-empty">Nothing in range.<br>Move around the world, or check the filters.</div>'
        : '<div class="rad-empty">Take a step so the game tells us where you are.</div>';
      return;
    }
    listEl.innerHTML = entities.slice(0, 40).map((e) => {
      const s = toScreen(e.hX, e.hY, 100);
      const arrow = arrowFor(s.x - 50, s.y - 50);
      const tier = e.tier ? ` <b class="rt">T${e.tier}${e.ench ? '.' + e.ench : ''}</b>` : (e.ench ? ` <b class="rt">✨${e.ench}</b>` : '');
      const dm = e.d < 1 ? '0' : Math.round(e.d);
      const val = e.priced ? `<span class="rv" title="Estimated market value of the node">≈${fmtK(e.value)}</span>` : '';
      // cargas del nodo: "x/max"
      let charges = '';
      if ((e.cat === 'resource' || e.cat === 'living') && (e.sizeMax > 0 || e.empty)) charges = `<span class="rc ${e.sizeMax > 0 && e.size >= e.sizeMax ? 'full' : e.size <= 1 ? 'low' : ''}" title="${e.ghost ? 'Estimated charges since last seen' : 'Charges left'}">${e.ghost ? '~' : ''}${e.size}/${e.sizeMax || '?'}</span>`;
      const notFull = e.cat === 'resource' && (e.empty || e.size < e.sizeMax);
      if (notFull && e.ghost && e.toFull > 0) charges += `<span class="rc" title="Estimated time until full">⌛${fmtSecs(e.toFull)}</span>`;
      if (notFull && e.regen) charges += `<span class="rc" title="Measured time for the last charge to regrow">⏱${fmtSecs(e.regen)}</span>`;
      else if (notFull && !e.ghost && e.regenAvgS) charges += `<span class="rc" title="Estimated time per charge (learned or game data)">⏱~${fmtSecs(e.regenAvgS)}</span>`;
      if (notFull && e.mark) charges += `<span class="rc" title="Time since the charges last changed">⏳${fmtSecs(Math.max(0, Math.round((Date.now() - e.mark) / 1000)))}</span>`;
      const sel = e.id === selectedId ? ' selected' : '';
      const hov = hoverId != null && String(e.id) === hoverId ? ' is-hover' : '';
      return `<div class="rad-row cat-${e.cat}${e.empty ? ' is-empty' : ''}${e.ghost ? ' is-ghost' : ''}${sel}${hov}" data-id="${e.id}">
        <span class="ri" style="color:${e.color}">${e.icon}</span>
        <span class="rl">${esc(e.label)}${tier}</span>
        ${charges}${val}
        <span class="rd">${arrow} ${dm}m</span>
      </div>`;
    }).join('');
  }

  // El minimapa se redibuja fluido; la LISTA solo cada ~600ms o forzada (al cambiar
  // selección/filtros), para no reconstruir su DOM bajo el ratón y comerse los clics.
  let lastListAt = 0;
  function render(forceList) {
    const entities = collect();
    drawRadar(entities._radar || entities);
    const now = performance.now();
    if (forceList || now - lastListAt > 600) { drawList(entities); lastListAt = now; }
    if (countEl) countEl.textContent = String(entities.length);
    dirty = false;
  }

  // rAF loop ~12fps (positions relative to a moving player, so refresh steadily)
  let lastFrame = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (ts - lastFrame < 80) return;
    lastFrame = ts;
    if (!panelVisible()) return;
    render();
  }
  function panelVisible() {
    const el = document.getElementById('p-radar');
    if (!el || el.classList.contains('collapsed')) return false;
    return getComputedStyle(el).display !== 'none';
  }

  // Limpieza de entidades caducadas, por tipo.
  // Los mobs se mueven y mueren: si dejan de refrescarse, fuera a los 90s.
  // Lo ESTÁTICO (recursos, cofres, portales, jaulas) solo emite evento al ENTRAR en tu radio
  // y no vuelve a emitir mientras te quedas al lado: con 90s desaparecía del panel justo
  // mientras lo mirabas (visto en vivo con un cofre de jefe). Para eliminarlos ya está el
  // Leave (evt1), que sí llega cuando el objeto desaparece de verdad, y el borrado al cambiar
  // de mapa; este plazo largo es solo una red por si se perdiera un Leave.
  const STALE_MOVIL = 90000;
  const STALE_ESTATICO = 15 * 60000;
  setInterval(() => {
    const now = Date.now();
    [[mobs, STALE_MOVIL], [mists, STALE_MOVIL], [harvestables, STALE_ESTATICO],
     [portals, STALE_ESTATICO], [cages, STALE_ESTATICO]]
      .forEach(([m, max]) => { m.forEach((v, k) => { if (now - v.last > max) m.delete(k); }); });
  }, 5000);

  // ---- filter chips ----
  const FILTER_DEFS = [
    ['resource', '◆ Resources'], ['living', '🐾 Living/Mobs'], ['avalon', '🌀 Avalon'],
  ];
  function renderFilters() {
    if (!filtersEl) return;
    filtersEl.innerHTML = FILTER_DEFS.map(([k, lbl]) =>
      `<button class="rad-chip" data-f="${k}" aria-pressed="${filters[k]}">${lbl}</button>`).join('');
  }
  if (filtersEl) {
    renderFilters();
    filtersEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      const k = b.dataset.f; filters[k] = !filters[k];
      b.setAttribute('aria-pressed', String(filters[k])); saveFilters(); renderSubFilters(); paintFilterToggle(); render(true);
    });
  }
  // los filtros ocupaban medio panel: van plegados tras "⚙ Filters" y el punto naranja avisa
  // de que hay algo apagado (si no, uno se pregunta por qué no sale tal nodo)
  const FBKEY = 'albion-overlay-radar-filterbox-v1';
  const filterBox = document.getElementById('rad-filterbox');
  const filterToggle = document.getElementById('rad-filters-toggle');
  function anyFilterOff() {
    if (Object.keys(filters).some((k) => !filters[k])) return true;
    for (const g of [sub.resTypes, sub.ench, sub.tiers]) if (Object.keys(g).some((k) => g[k] === false)) return true;
    return sub.empty === false || sub.ghosts === false;
  }
  function paintFilterToggle() {
    if (!filterToggle) return;
    const open = !!(filterBox && !filterBox.hidden);
    filterToggle.setAttribute('aria-pressed', String(open));
    filterToggle.innerHTML = '⚙ Filters' + (anyFilterOff() ? '<span class="fdot" title="Some filters are off"></span>' : '');
  }
  if (filterBox && filterToggle) {
    try { filterBox.hidden = localStorage.getItem(FBKEY) !== '1'; } catch (_) {}
    filterToggle.addEventListener('click', () => {
      filterBox.hidden = !filterBox.hidden;
      try { localStorage.setItem(FBKEY, filterBox.hidden ? '0' : '1'); } catch (_) {}
      paintFilterToggle();
    });
    paintFilterToggle();
  }

  // ---- sub-filters (resource types, enchant, tier) ----
  const RES_ORDER = ['Ore', 'Wood', 'Fiber', 'Hide', 'Rock'];
  const TIERS_ORDER = [[1, 'T1'], [2, 'T2'], [3, 'T3'], [4, 'T4'], [5, 'T5'], [6, 'T6'], [7, 'T7'], [8, 'T8'], [0, '—']];
  const subEl = document.getElementById('rad-subfilters');
  function renderSubFilters() {
    if (!subEl) return;
    let html = '';
    const showRes = filters.resource || filters.living;
    if (showRes) {
      html += RES_ORDER.map((t) => `<button class="rad-schip" data-rt="${t}" aria-pressed="${sub.resTypes[t] !== false}"><span class="sw" style="background:${RES_COLOR[t]}"></span>${RES_ES[t]}</button>`).join('');
      html += '<span class="rad-sub-sep"></span>';
      html += '<span class="rad-sub-lbl">Ench</span>' + [0, 1, 2, 3, 4].map((e) => `<button class="rad-schip re" data-re="${e}" aria-pressed="${sub.ench[e] !== false}">.${e}</button>`).join('');
      html += '<span class="rad-sub-sep"></span>';
      html += '<span class="rad-sub-lbl">Tier</span>' + TIERS_ORDER.map(([t, lbl]) => `<button class="rad-schip re" data-rtier="${t}" aria-pressed="${sub.tiers[t] !== false}">${lbl}</button>`).join('');
      html += '<span class="rad-sub-sep"></span>';
      html += `<button class="rad-schip" data-rempty="1" aria-pressed="${sub.empty !== false}" title="Show emptied nodes (0 charges) to time their regen">⏳ Empty</button>`;
      html += `<button class="rad-schip" data-rghost="1" aria-pressed="${sub.ghosts !== false}" title="Remembered nodes outside your bubble, with estimated charges">👻 Memory</button>`;
    }
    subEl.innerHTML = html;
  }
  if (subEl) {
    renderSubFilters();
    subEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rt],[data-re],[data-rtier],[data-rempty],[data-rghost]'); if (!b) return;
      if (b.dataset.rt) { const t = b.dataset.rt; sub.resTypes[t] = !(sub.resTypes[t] !== false); b.setAttribute('aria-pressed', String(sub.resTypes[t])); }
      else if (b.dataset.rempty) { sub.empty = !(sub.empty !== false); b.setAttribute('aria-pressed', String(sub.empty)); }
      else if (b.dataset.rghost) { sub.ghosts = !(sub.ghosts !== false); b.setAttribute('aria-pressed', String(sub.ghosts)); }
      else if (b.dataset.rtier != null) { const k = b.dataset.rtier; sub.tiers[k] = !(sub.tiers[k] !== false); b.setAttribute('aria-pressed', String(sub.tiers[k])); }
      else if (b.dataset.re != null) { const k = b.dataset.re; sub.ench[k] = !(sub.ench[k] !== false); b.setAttribute('aria-pressed', String(sub.ench[k])); }
      saveSub(); paintFilterToggle(); render(true);
    });
  }

  const sortEl = document.getElementById('rad-sort');
  const dirEl = document.getElementById('rad-dir');
  const DIR_DEFAULT = { dist: 'asc', value: 'desc', tier: 'desc' };
  function updateDirBtn() { if (dirEl) { dirEl.textContent = sub.dir === 'asc' ? '↑' : '↓'; dirEl.title = sub.dir === 'asc' ? 'Ascending (lowest first) — click to flip' : 'Descending (highest first) — click to flip'; } }
  if (sortEl) {
    sortEl.value = sub.sort;
    sortEl.addEventListener('change', () => { sub.sort = sortEl.value; sub.dir = DIR_DEFAULT[sub.sort] || 'asc'; updateDirBtn(); saveSub(); render(true); });
  }
  if (dirEl) {
    updateDirBtn();
    dirEl.addEventListener('click', () => { sub.dir = sub.dir === 'asc' ? 'desc' : 'asc'; updateDirBtn(); saveSub(); render(true); });
  }
  const mapBtn = document.getElementById('rad-map');
  if (mapBtn) {
    const paint = () => { mapBtn.style.opacity = showMap ? '1' : '.4'; mapBtn.setAttribute('aria-pressed', String(showMap)); };
    paint();
    mapBtn.addEventListener('click', () => {
      showMap = !showMap;
      localStorage.setItem(MAPKEY, showMap ? '1' : '0');
      paint(); render(true);
    });
  }
  setInterval(() => { for (const k in priceMap) if (priceMap[k] === 0) delete priceMap[k]; schedulePriceFetch(); }, 120000);

  // clic en una fila = fijar ese recurso (el radar solo lo muestra a él); otro clic lo suelta.
  // Pasar el ratón por una fila resalta su punto en el radar, para saber cuál es cuál.
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.rad-row'); if (!row || !row.dataset.id) return;
      const raw = row.dataset.id;
      const id = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      selectedId = (selectedId === id) ? null : id;
      render(true);
    });
    listEl.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.rad-row');
      const id = row && row.dataset.id != null ? row.dataset.id : null;
      if (id !== hoverId) { hoverId = id; render(true); }
    });
    listEl.addEventListener('mouseleave', () => { if (hoverId != null) { hoverId = null; render(true); } });
  }

  // ---- debug hook (inspect from devtools: window.__radar) ----
  window.__radar = { harvestables, mobs, mists, portals, cages, filters, sub, priceMap, collect, handleMessage, render, setMobs: (d) => { mobsDB = d; markDirty(); render(); }, select: (id) => { selectedId = id; }, state: () => ({ lp: [lpX, lpY], haveLp, map: currentMapId, selectedId }), livingSamples: () => livingSamples, shapes: () => shapeSamples, regenDB, nodeMem,
    // Qué ha entrado y por dónde. Si una fila `.../shape` tiene cuenta y su `.../code` está a
    // cero, ese número se movió con un parche y hay que actualizarlo aquí.
    audit: () => ({
      map: currentMapId,
      entities: { harvestables: harvestables.size, mobs: mobs.size, mists: mists.size, portals: portals.size, cages: cages.size },
      via: Object.keys(hits).sort().reduce((o, k) => { o[k] = hits[k]; return o; }, {}),
      topCodes: Object.entries(seenCodes).map(([c, n]) => [+c, n]).sort((a, b) => b[1] - a[1]).slice(0, 25),
      unknown: Object.entries(unknownSamples).map(([c, u]) => [+c, u.n]).sort((a, b) => b[1] - a[1]).slice(0, 25),
      unknownSample: (code) => (unknownSamples[String(code)] || {}).sample || null,
    }) };

  // ---- boot ----
  try { new ResizeObserver(fitCanvas).observe(canvas); } catch (_) { window.addEventListener('resize', fitCanvas); }
  fitCanvas();
  loadMobsDB();
  loadZonesDB();
  connect();
  requestAnimationFrame(loop);
})();
