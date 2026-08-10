// Resources / treasure radar: connects to OpenRadar's WebSocket and renders
// nearby harvestables, living resources, mobs, loot chests (with quality) and
// Avalon/Mists portals & wisp cages on a mini radar + a distance-sorted list.
// Mirrors OpenRadar's frontend contract (event codes + parameter indices).
//
// Message envelope (batch): { type:'batch', messages:[ {code, dictionary}, ... ] }
//   code = 'event' | 'request' | 'response'; dictionary.parameters keyed by string ints.
//   event:  params['252'] = event code   ·  request/response: params['253'] = op code
//
// Event codes:  39/38 harvestable batch · 40 harvestable single · 46 harvestable change ·
//               123 NewMob (living resource / mob / mist portal) · 47 MobChangeState ·
//               391 NewLootChest · 323 NewRandomDungeonExit (dungeon / mists portal) ·
//               530 NewCagedObject · 531 CagedObjectStateUpdated · 3 Move · 1 Leave
// Op codes:     22/21 Move (local player pos) · 2 Join · 41 ChangeCluster

(function () {
  const WS_URL = 'ws://localhost:5001/ws';
  const MOBS_URL = 'http://localhost:5001/ao-bin-dumps/mobs.min.json';

  // ---- DOM ----
  const canvas = document.getElementById('radar-canvas');
  const listEl = document.getElementById('radar-list');
  const countEl = document.getElementById('rad-count');
  const connEl = document.getElementById('rad-conn');
  const filtersEl = document.getElementById('rad-filters');
  const zoomEl = document.getElementById('rad-zoom');
  if (!canvas || !listEl) return;
  const ctx = canvas.getContext('2d');

  // ---- state ----
  const harvestables = new Map(); // static resource nodes
  const mobs = new Map();         // living resources + hostile creatures (event 123)
  const mists = new Map();        // mists portals (named 123 entities)
  const chests = new Map();       // loot chests
  const portals = new Map();      // dungeon / mists-dungeon portals (event 323)
  const cages = new Map();        // wisp cages
  let lpX = 0, lpY = 0, haveLp = false;
  let selectedId = null;          // entidad fijada: el radar solo la muestra a ella
  let currentMapId = null;
  let mobsDB = null; // Map<typeId,{type,tier,combatTier,uniqueName,category,isHarvestable}>

  const MOBS_OFFSET = 16;

  // ---- filters (persisted) ----
  const FKEY = 'albion-overlay-radar-filters-v1';
  const filters = (() => {
    const def = { chest: true, resource: true, living: true, avalon: true };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(FKEY)) || {}); } catch (_) { return def; }
  })();
  const saveFilters = () => { try { localStorage.setItem(FKEY, JSON.stringify(filters)); } catch (_) {} };

  // sub-filters: resource types, chest qualities, min tier, sort mode (all persisted)
  const SKEY = 'albion-overlay-radar-subfilters-v1';
  const sub = (() => {
    const def = {
      resTypes: { Ore: true, Wood: true, Fiber: true, Hide: true, Rock: true },
      ench: { 0: true, 1: true, 2: true, 3: true, 4: true },
      chestQ: { green: true, blue: true, purple: true, gold: true, unknown: true },
      // nivel de la mazmorra del cofre. Todos activos por defecto: en Caminos la calidad no
      // se puede leer del evento, así que esto es lo que de verdad permite acotar la búsqueda.
      chestTier: { solo: true, group: true, veteran: true, champion: true, elite: true, none: true },
      minTier: 0,      // 0 = todos
      sort: 'dist',    // 'dist' | 'value' | 'tier'
      dir: 'asc',      // 'asc' | 'desc'
    };
    try {
      const s = JSON.parse(localStorage.getItem(SKEY)) || {};
      return {
        resTypes: Object.assign({}, def.resTypes, s.resTypes),
        ench: Object.assign({}, def.ench, s.ench),
        chestQ: Object.assign({}, def.chestQ, s.chestQ),
        chestTier: Object.assign({}, def.chestTier, s.chestTier),
        minTier: s.minTier || 0,
        sort: s.sort || 'dist',
        dir: s.dir || 'asc',
      };
    } catch (_) { return def; }
  })();
  const saveSub = () => { try { localStorage.setItem(SKEY, JSON.stringify(sub)); } catch (_) {} };

  const ZKEY = 'albion-overlay-radar-zoom-v1';
  let zoom = (() => { const z = +localStorage.getItem(ZKEY); return z >= 0.5 && z <= 3 ? z : 1; })();
  const BASE_RANGE_M = 28; // radar view radius (m) at zoom 1 — matches the game's ~27m send bubble

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
  // nominal silver value of a chest by quality (rough Avalon loot avg, for sorting)
  const CHEST_VALUE = { green: 8000, blue: 30000, purple: 120000, gold: 400000 };

  // ---- resource type & colour helpers (from OpenRadar DrawingUtils) ----
  function staticResourceType(typeNumber) {
    if (typeNumber >= 0 && typeNumber <= 5) return 'Wood';
    if (typeNumber >= 6 && typeNumber <= 10) return 'Rock';
    if (typeNumber >= 11 && typeNumber <= 15) return 'Fiber';
    if (typeNumber >= 16 && typeNumber <= 22) return 'Hide';
    if (typeNumber >= 23 && typeNumber <= 27) return 'Ore';
    return null;
  }
  const RES_COLOR = { Fiber: '#4CAF50', Hide: '#A1887F', Wood: '#8D6E63', Ore: '#42A5F5', Rock: '#9C27B0' };
  const RES_ICON = { Fiber: '🧵', Hide: '🐗', Wood: '🪵', Ore: '⛏️', Rock: '🪨' };
  const RES_ES = { Fiber: 'Fiber', Hide: 'Hide', Wood: 'Wood', Ore: 'Ore', Rock: 'Rock' };

  // chest quality: keyword in name first (reliable in Avalon/Mists), else rarity int 0-4
  const QUALITY = {
    green: { color: '#46d160', es: 'Green', rank: 0 },
    blue: { color: '#4aa3ff', es: 'Blue', rank: 1 },
    purple: { color: '#b96bff', es: 'Purple', rank: 2 },
    gold: { color: '#ffcc33', es: 'Gold', rank: 3 },
    unknown: { color: '#9aa0a6', es: 'Unclassified', rank: -1 },
  };
  // De MAYOR a MENOR rareza a propósito: si un nombre trae dos palabras clave, quedarse con
  // la mejor. Equivocarse por arriba cuesta un viaje; por abajo, saltarse un cofre bueno.
  const QUALITY_WORDS = [
    ['gold', ['legendary', 'yellow', 'gold']],
    ['purple', ['rare', 'purple', 'epic']],
    ['blue', ['uncommon', 'blue']],
    // OJO: "regular" NO va aquí. En Caminos los cofres verdes Y los azules llegan como
    // LOOTCHEST_REGULAR_xx (capturado en vivo), así que tomarlo por verde pinta de verde un
    // cofre azul — el error que hace que te lo saltes. Sin color en el nombre => sin clasificar.
    ['green', ['standard', 'green', 'common']],
  ];
  const RARITY_QUALITY = { 0: 'green', 1: 'blue', 2: 'purple', 3: 'gold', 4: 'gold' };
  // nombres que no supimos clasificar: se acumulan para poder añadir su palabra clave
  // (window.__radar.unknownChests). Un cofre mal leído sale como "sin clasificar", NUNCA
  // como verde: marcarlo del color más pobre es justo lo que hace que te lo saltes.
  const unknownChests = new Map();
  // El nombre del cofre no siempre trae el color, pero el CONTEXTO sí puede: en mazmorras
  // llega como HERETIC_VETERAN_LOOTCHEST_STANDARD (capturado en vivo), donde la última parte
  // es la calidad. En Caminos el contexto es AVALON_SMALL_SOLO_BASE y ahí no hay color: por
  // eso se mira primero el nombre, después el contexto, y solo si ninguno dice nada, unknown.
  // El nombre puede traer el BIOMA y no la calidad: FOREST_GREEN_LOOTCHEST_..._RARE es un
  // cofre morado en bosque verde, y FOREST_RED_... no dice nada del color. Por eso se limpia
  // el prefijo de bioma y se mira ANTES el contexto, que es donde el juego pone la calidad
  // de verdad (..._LOOTCHEST_STANDARD, ..._BOOKCHEST_RARE, ..._BOSS_UNCOMMON).
  const BIOMA_RE = /\b(forest|highland|steppe|swamp|mountain|desert)_(green|red|blue|yellow|white|black)\b/gi;
  function chestQuality(name, rarity, ctx) {
    const limpio = (s) => String(s || '').toLowerCase().replace(BIOMA_RE, ' ');
    for (const fuente of [ctx, name]) {
      const n = limpio(fuente);
      if (!n.trim()) continue;
      for (const [quality, words] of QUALITY_WORDS) {
        if (words.some((w) => n.includes(w))) return quality;
      }
    }
    const byRarity = RARITY_QUALITY[rarity];
    if (byRarity) return byRarity;
    const key = `${name || '(sin nombre)'} @ ${ctx || '?'}`;
    unknownChests.set(key, (unknownChests.get(key) || 0) + 1);
    return 'unknown';
  }
  // Recolector PERSISTENTE: cada combinación cofre+contexto vista queda registrada con su
  // cuenta y sobrevive a los reinicios (window.__radar.chestSamples()). Así el mapeo del color
  // se aprende jugando, sin tener que estar capturando el tráfico en directo: los cofres raros
  // (un LEGENDARY, por ejemplo) aparecen cuando aparecen, y lo importante es no perderlos.
  const CSKEY = 'albion-overlay-chest-samples-v1';
  const MAX_SAMPLES = 300;   // techo: son combinaciones distintas, no cofres
  const chestSamples = (() => {
    const m = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(CSKEY)) || {};
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        m.set(k, { name: v.name, ctx: v.ctx, n: v.n || 0, p5: new Set(v.p5 || []), p23: new Set(v.p23 || []) });
      }
    } catch (_) {}
    return m;
  })();
  let samplesDirty = false;
  function saveSamples() {
    if (!samplesDirty) return;
    samplesDirty = false;
    try {
      const o = {};
      for (const [k, v] of chestSamples) o[k] = { name: v.name, ctx: v.ctx, n: v.n, p5: [...v.p5], p23: [...v.p23] };
      localStorage.setItem(CSKEY, JSON.stringify(o));
    } catch (_) {}
  }
  setInterval(saveSamples, 30000);
  window.addEventListener('beforeunload', saveSamples);

  function sampleChest(name, ctx, p) {
    const key = `${name} @ ${ctx || '?'}`;
    const rec = chestSamples.get(key);
    if (!rec && chestSamples.size >= MAX_SAMPLES) return;
    const r = rec || { name, ctx, n: 0, p5: new Set(), p23: new Set() };
    r.n++;
    if (p['5'] != null) r.p5.add(num(p['5']));
    if (p['23'] != null) r.p23.add(num(p['23']));
    chestSamples.set(key, r);
    samplesDirty = true;
  }

  // nivel de la mazmorra a partir del contexto: hoy es el único dato fiable que acompaña al
  // cofre, y ya orienta (una veterana da mejor botín que una solo).
  function dungeonTier(ctx) {
    const u = String(ctx || '').toUpperCase();
    if (!u) return '';
    if (u.includes('ELITE')) return 'elite';
    if (u.includes('VETERAN')) return 'veteran';
    if (u.includes('CHAMPION')) return 'champion';
    if (u.includes('GROUP')) return 'group';
    if (u.includes('SOLO')) return 'solo';
    return '';
  }

  // world / dungeon / mists, para que la etiqueta diga de qué cofre se trata
  function chestKind(name) {
    const u = String(name || '').toUpperCase();
    if (u.includes('MIST')) return 'mists';
    if (u.includes('DUNGEON') || u.includes('BOSS')) return 'dungeon';
    return '';
  }

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
  function loadMobsDB() {
    fetch(MOBS_URL).then((r) => (r.ok ? r.json() : null)).then((arr) => {
      if (!Array.isArray(arr)) return;
      const map = new Map();
      arr.forEach((mob, i) => {
        const typeId = i + MOBS_OFFSET;
        const resType = mob.l ? normResType(mob.l) : null;
        map.set(typeId, {
          type: resType,
          tier: resType ? (mob.lt || mob.t || 0) : (mob.t || 0),
          combatTier: mob.t || 0,
          uniqueName: mob.u || '',
          category: mob.c || '',
          isHarvestable: !!resType,
        });
      });
      mobsDB = map;
    }).catch(() => {});
  }

  // ---- geometry: world -> radar screen (iso rotation, distance preserving) ----
  function rangeM() { return BASE_RANGE_M / zoom; }
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
  function loadZonesDB() {
    fetch(ZONES_URL).then((r) => (r.ok ? r.json() : null)).then((z) => { if (z && typeof z === 'object') zonesDB = z; }).catch(() => {});
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
    harvestables.clear(); mobs.clear(); mists.clear(); chests.clear(); portals.clear(); cages.clear();
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

  // Cofres: se detectan por el PAYLOAD, no por el número de evento. Albion los desplaza con
  // los parches — capturado en vivo el 2026-08-08: llegaban por 391 y hoy llegan por 393, el
  // mismo +2 que se le hizo a la pesca (359 -> 361). El nombre LOOTCHEST es inequívoco y
  // sobrevive a esos cambios. Se excluyen los mobs, que también llevan TREASURE en su nombre
  // (T4_MOB_TREASURE_BOAR y compañía) y se colarían como cofres.
  const CHEST_NAME_RE = /LOOTCHEST|TREASURE_?CHEST/i;
  function chestNameOf(p) {
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (typeof v === 'string' && CHEST_NAME_RE.test(v) && !/_MOB_|MOB_/i.test(v)) return v;
    }
    return null;
  }

  function onEvent(p, code) {
    const id = p['0'];
    const chestName = chestNameOf(p);
    if (chestName && Array.isArray(p['1'])) { newChest(p, chestName); return; }
    switch (code) {
      case 1: removeEverywhere(id); break;
      case 3: { // Move: update mob / mist / cage positions
        const x = p['4'], y = p['5'];
        if (x == null) break;
        const mo = mobs.get(id); if (mo) { mo.posX = x; mo.posY = y; mo.last = Date.now(); }
        const mi = mists.get(id); if (mi) { mi.posX = x; mi.posY = y; mi.last = Date.now(); }
        break;
      }
      case 39: case 38: batchHarvestables(p); break;
      case 40: singleHarvestable(id, p); break;
      case 46: harvestableChange(p); break;
      case 123: newMob(p); break;
      case 47: { const mo = mobs.get(p['0']); if (mo) { mo.ench = num(p['1'], mo.ench); mo.last = Date.now(); } break; }
      // Los códigos ALTOS se desplazaron +2 en algún parche (capturado en vivo 2026-08-08:
      // portales 323->325, cofres 391->393, pesca 359->361); los bajos (recursos 39/40/46,
      // mobs 123/47) siguen igual. Se aceptan ambos: el viejo por si se juega otra versión,
      // el nuevo porque es el que llega hoy. Cada handler valida el payload antes de usarlo.
      case 391: case 393: newChest(p); break;
      case 323: case 325: newPortal(p); break;
      case 530: case 532: newCage(p); break;
      case 531: case 533: cages.delete(id); break;
      default: break;
    }
  }

  function removeEverywhere(id) {
    harvestables.delete(id); mobs.delete(id); mists.delete(id);
    chests.delete(id); portals.delete(id); cages.delete(id);
  }

  // ---- harvestables (static resource nodes) ----
  function addHarvestable(id, typeNum, tier, posX, posY, ench, size, mobileTypeId) {
    const isLiving = mobileTypeId != null && mobileTypeId !== 65535 && mobileTypeId !== -1;
    if (isLiving) return; // living resources arrive via NewMob (123)
    const type = staticResourceType(typeNum);
    if (!type) return;
    const ex = harvestables.get(id);
    if (ex) { ex.tier = tier; ex.ench = ench; if (size != null) { ex.size = size; ex.sizeMax = Math.max(ex.sizeMax || 0, size); } ex.last = Date.now(); return; }
    harvestables.set(id, { id, type, tier, posX, posY, ench: ench || 0, size: size || 0, sizeMax: size || 0, last: Date.now() });
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
    h.size = newSize; h.sizeMax = Math.max(h.sizeMax || 0, newSize); if (ench !== undefined) h.ench = ench; h.last = Date.now();
  }

  // ---- mobs / living resources / mists (event 123) ----
  function newMob(p) {
    const id = p['0'];
    const typeId = num(p['1']);
    const loc = Array.isArray(p['7']) ? p['7'] : [0, 0];
    const posX = num(loc[0]), posY = num(loc[1]);
    const ench = num(p['33'], 0);
    const rarity = num(p['19'], null);
    const name = p['32'] || p['31'] || null;
    if (name) { // named entity in NewMob = Mists portal / feu-follet
      if (!mists.has(id)) mists.set(id, { id, posX, posY, name, ench, last: Date.now() });
      else mists.get(id).last = Date.now();
      return;
    }
    if (mobs.has(id)) { mobs.get(id).last = Date.now(); return; }
    const info = mobsDB && mobsDB.get(typeId);
    const rec = { id, typeId, posX, posY, ench, rarity, last: Date.now(), living: false, resType: null, tier: 0 };
    if (info) {
      if (info.isHarvestable) { rec.living = true; rec.resType = info.type; rec.tier = info.tier || 0; }
      else { rec.tier = info.tier || 0; rec.category = info.category; }
    }
    mobs.set(id, rec);
    if (rec.living) schedulePriceFetch();
  }

  // ---- chests ----
  function newChest(p, knownName) {
    const id = p['0'];
    const pos = p['1']; if (!Array.isArray(pos)) return;
    // el nombre del cofre no está siempre en el mismo parámetro: en Caminos [3] es el tipo de
    // mazmorra ("AVALON_SMALL_SOLO_BASE") y el cofre viene en [4] ("LOOTCHEST_REGULAR_01").
    let name = knownName || chestNameOf(p);
    if (!name) {
      name = p['3'];
      if (typeof name === 'string' && name.toLowerCase().includes('mist')) name = p['4'];
    }
    if (typeof name !== 'string') name = '';
    // [5] NO es la rareza en los LOOTCHEST: dos cofres VERDES distintos llegaron con [5]=2, que
    // el mapeo por entero habría pintado de morado. Ahí manda solo el nombre; el entero se
    // reserva para el formato antiguo, donde sí venía la rareza.
    const rarity = CHEST_NAME_RE.test(name) ? null : (p['5'] == null ? null : num(p['5']));
    // Contexto: [3] es el más informativo (en mazmorras trae facción + nivel + CALIDAD, como
    // HERETIC_VETERAN_LOOTCHEST_STANDARD); [18] es la versión corta y se usa de respaldo.
    const ctx3 = typeof p['3'] === 'string' ? p['3'] : '';
    const ctx = ctx3 || (typeof p['18'] === 'string' ? p['18'] : '');
    const quality = chestQuality(name, rarity, ctx);
    sampleChest(name, ctx, p);
    const ex = chests.get(id);
    // un reenvío del evento puede traer el nombre que la primera vez llegó vacío: si ahora
    // sí se puede clasificar, se reclasifica en lugar de quedarse con "sin clasificar".
    if (ex) {
      ex.last = Date.now();
      ex.posX = pos[0]; ex.posY = pos[1];
      if (quality !== 'unknown' && (ex.quality === 'unknown' || !ex.name)) { ex.quality = quality; ex.name = name; }
      return;
    }
    chests.set(id, { id, posX: pos[0], posY: pos[1], name, quality, kind: chestKind(name), ctx, tier: dungeonTier(ctx), last: Date.now() });
  }

  // ---- dungeon / mists portals (event 323) ----
  function newPortal(p) {
    const id = p['0'];
    const pos = p['1']; if (!Array.isArray(pos)) return;
    const name = p['3'] || p['15'] || '';
    const ench = num(p['8'], 0);
    const ex = portals.get(id);
    if (ex) { ex.last = Date.now(); return; }
    portals.set(id, { id, posX: pos[0], posY: pos[1], name: String(name), ench, last: Date.now() });
  }

  // ---- wisp cages (event 530) ----
  function newCage(p) {
    const id = p['0'];
    const pos = p['2']; if (id === undefined || !Array.isArray(pos)) return;
    if (cages.has(id)) { cages.get(id).last = Date.now(); return; }
    cages.set(id, { id, posX: pos[0], posY: pos[1], name: p['4'] || '', last: Date.now() });
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
    if (e.cat === 'chest') return CHEST_VALUE[e.quality] || 0;
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
      if (d > range * 1.05) return;
      out.push(Object.assign({ cat, id: e.id, hX, hY, d }, meta));
    };
    const okType = (t) => sub.resTypes[t] !== false;
    const okTier = (t) => !sub.minTier || (t || 0) >= sub.minTier;
    const okEnch = (e) => sub.ench[e || 0] !== false;
    if (filters.chest) chests.forEach((c) => {
      const q = QUALITY[c.quality] || QUALITY.unknown;
      if (sub.chestQ[c.quality] === false) return;
      if (sub.chestTier[c.tier || 'none'] === false) return;
      push('chest', c, { color: q.color, icon: '🎁', label: q.es + ' chest', quality: c.quality, kind: c.kind, raw: c.name, ctx: c.ctx, tier: c.tier, value: CHEST_VALUE[c.quality] || 0 });
    });
    if (filters.resource) harvestables.forEach((h) => { if ((h.size || 0) >= 1 && okType(h.type) && okTier(h.tier) && okEnch(h.ench)) push('resource', h, { color: RES_COLOR[h.type] || '#4169E1', icon: RES_ICON[h.type] || '◆', label: RES_ES[h.type] || h.type, tier: h.tier, ench: h.ench, size: h.size, sizeMax: Math.max(h.sizeMax || 0, h.size || 0), value: resourceValue(h.type, h.tier, h.ench, h.size), priced: isPriced(h.type, h.tier, h.ench) }); });
    if (filters.living) {
      mobs.forEach((m) => {
        if (m.living) { if (okType(m.resType) && okTier(m.tier) && okEnch(m.ench)) push('living', m, { color: RES_COLOR[m.resType] || '#8bc34a', icon: RES_ICON[m.resType] || '🐾', label: 'Living ' + (RES_ES[m.resType] || 'resource').toLowerCase(), tier: m.tier, ench: m.ench, size: 1, value: resourceValue(m.resType, m.tier, m.ench, 1), priced: isPriced(m.resType, m.tier, m.ench), living: true }); }
        else if (okTier(m.tier) && okEnch(m.ench)) push('mob', m, { color: m.ench > 0 ? (ENCH_COLOR[m.ench] || '#ed6a5a') : '#ed6a5a', icon: m.ench > 0 ? '✨' : '👹', label: m.ench > 0 ? 'Enchanted creature' : 'Creature', tier: m.tier, ench: m.ench, enchMob: m.ench > 0 });
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

    // cross-hair
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.moveTo(c, 4); ctx.lineTo(c, size - 4); ctx.moveTo(4, c); ctx.lineTo(size - 4, c); ctx.stroke();

    // blips
    entities.forEach((e) => {
      const s = toScreen(e.hX, e.hY, size);
      const r = e.cat === 'chest' ? 5.5 : 4;
      ctx.beginPath();
      if (e.cat === 'chest') {
        ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
      } else {
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = e.color; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      if (e.living) { ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, r + 1.6, 0, Math.PI * 2); ctx.stroke(); }
      else if (e.enchMob) { ctx.strokeStyle = ENCH_COLOR[e.ench] || '#fff'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, r + 1.6, 0, Math.PI * 2); ctx.stroke(); }
      if (e.tier) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 2;
        ctx.fillText('T' + e.tier + (e.ench ? '.' + e.ench : ''), s.x, s.y - r - 5);
        ctx.shadowBlur = 0;
      }
    });
    ctx.restore();

    // local player (centre)
    ctx.beginPath(); ctx.arc(c, c, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#5aa9c4'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();

    if (!haveLp) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('move to get your bearings', c, size - 6);
    } else if (selectedId != null) {
      ctx.fillStyle = 'rgba(90,169,196,0.95)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('focus: 1 selected (click the list to release)', c, size - 6);
    }
  }

  const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
  const fmtK = (n) => { const a = Math.abs(n || 0); if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M'; if (a >= 1e3) return Math.round(n / 1e3) + 'K'; return String(Math.round(n || 0)); };
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
      // cargas del nodo: "x/max" · en cofres, el nivel de la mazmorra (dato real; el color
      // no viene en el evento, así que no se inventa)
      let charges = '';
      if (e.cat === 'chest' && e.tier) charges = `<span class="rc" title="Dungeon level">${esc(e.tier)}</span>`;
      else if ((e.cat === 'resource' || e.cat === 'living') && e.sizeMax > 0) charges = `<span class="rc ${e.size >= e.sizeMax ? 'full' : e.size <= 1 ? 'low' : ''}" title="Charges left">${e.size}/${e.sizeMax}</span>`;
      const sel = e.id === selectedId ? ' selected' : '';
      // en cofres el tooltip lleva el nombre CRUDO del juego: es lo que permite ver por qué
      // uno sale sin clasificar y añadir su palabra clave.
      const tip = e.cat === 'chest' && e.raw ? ` title="${esc(e.raw)}${e.ctx ? ' · ' + esc(e.ctx) : ''}${e.kind ? ' · ' + e.kind : ''}"` : '';
      return `<div class="rad-row cat-${e.cat}${sel}" data-id="${e.id}">
        <span class="ri" style="color:${e.color}">${e.icon}</span>
        <span class="rl"${tip}>${esc(e.label)}${tier}</span>
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
     [chests, STALE_ESTATICO], [portals, STALE_ESTATICO], [cages, STALE_ESTATICO]]
      .forEach(([m, max]) => { m.forEach((v, k) => { if (now - v.last > max) m.delete(k); }); });
  }, 5000);

  // ---- filter chips ----
  const FILTER_DEFS = [
    ['chest', '🎁 Chests'], ['resource', '◆ Resources'], ['living', '🐾 Living/Mobs'], ['avalon', '🌀 Avalon'],
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
      b.setAttribute('aria-pressed', String(filters[k])); saveFilters(); renderSubFilters(); render(true);
    });
  }

  // ---- sub-filters (resource types + chest qualities) ----
  const RES_ORDER = ['Ore', 'Wood', 'Fiber', 'Hide', 'Rock'];
  const QUAL_ORDER = ['green', 'blue', 'purple', 'gold', 'unknown'];
  // "none" = el cofre no trae nivel de mazmorra (mundo abierto, brumas…), para que filtrar
  // por nivel no haga desaparecer en silencio los que no lo tienen.
  const TIER_ORDER = [['solo', 'solo'], ['group', 'group'], ['veteran', 'veteran'], ['champion', 'champion'], ['elite', 'elite'], ['none', '—']];
  const subEl = document.getElementById('rad-subfilters');
  function renderSubFilters() {
    if (!subEl) return;
    let html = '';
    const showRes = filters.resource || filters.living;
    if (showRes) {
      html += RES_ORDER.map((t) => `<button class="rad-schip" data-rt="${t}" aria-pressed="${sub.resTypes[t] !== false}"><span class="sw" style="background:${RES_COLOR[t]}"></span>${RES_ES[t]}</button>`).join('');
      html += '<span class="rad-sub-sep"></span>';
      html += '<span class="rad-sub-lbl">Ench</span>' + [0, 1, 2, 3, 4].map((e) => `<button class="rad-schip re" data-re="${e}" aria-pressed="${sub.ench[e] !== false}">.${e}</button>`).join('');
    }
    if (showRes && filters.chest) html += '<span class="rad-sub-sep"></span>';
    if (filters.chest) {
      html += QUAL_ORDER.map((q) => `<button class="rad-schip" data-cq="${q}" aria-pressed="${sub.chestQ[q] !== false}"><span class="sw" style="background:${QUALITY[q].color}"></span>${QUALITY[q].es}</button>`).join('');
      html += '<span class="rad-sub-sep"></span>';
      html += '<span class="rad-sub-lbl">Level</span>' + TIER_ORDER.map(([k, lbl]) =>
        `<button class="rad-schip" data-ct="${k}" aria-pressed="${sub.chestTier[k] !== false}">${lbl}</button>`).join('');
    }
    subEl.innerHTML = html;
  }
  if (subEl) {
    renderSubFilters();
    subEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rt],[data-re],[data-cq],[data-ct]'); if (!b) return;
      if (b.dataset.rt) { const t = b.dataset.rt; sub.resTypes[t] = !(sub.resTypes[t] !== false); b.setAttribute('aria-pressed', String(sub.resTypes[t])); }
      else if (b.dataset.re != null) { const k = b.dataset.re; sub.ench[k] = !(sub.ench[k] !== false); b.setAttribute('aria-pressed', String(sub.ench[k])); }
      else if (b.dataset.ct) { const t = b.dataset.ct; sub.chestTier[t] = !(sub.chestTier[t] !== false); b.setAttribute('aria-pressed', String(sub.chestTier[t])); }
      else { const q = b.dataset.cq; sub.chestQ[q] = !(sub.chestQ[q] !== false); b.setAttribute('aria-pressed', String(sub.chestQ[q])); }
      saveSub(); render(true);
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
  const tierEl = document.getElementById('rad-tier');
  if (tierEl) { tierEl.value = String(sub.minTier); tierEl.addEventListener('change', () => { sub.minTier = +tierEl.value; saveSub(); render(true); }); }

  if (zoomEl) {
    zoomEl.value = String(zoom);
    zoomEl.addEventListener('input', () => { zoom = +zoomEl.value; localStorage.setItem(ZKEY, String(zoom)); render(true); });
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

  // clic en una fila = fijar ese recurso (el radar solo lo muestra a él); otro clic lo suelta
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.rad-row'); if (!row || !row.dataset.id) return;
      const id = Number(row.dataset.id);
      selectedId = (selectedId === id) ? null : id;
      render(true);
    });
  }

  // ---- debug hook (inspect from devtools: window.__radar) ----
  window.__radar = { harvestables, mobs, mists, chests, portals, cages, filters, sub, priceMap, collect, handleMessage, render, select: (id) => { selectedId = id; }, unknownChests: () => [...unknownChests.entries()].sort((a, b) => b[1] - a[1]), chestSamples: () => [...chestSamples.values()].sort((a, b) => b.n - a.n).map((r) => ({ cofre: r.name, mazmorra: r.ctx, calidad: chestQuality(r.name, null, r.ctx), nivel: dungeonTier(r.ctx) || '-', vistos: r.n, p5: [...r.p5], p23: [...r.p23] })), sinResolver: () => [...chestSamples.values()].filter((r) => chestQuality(r.name, null, r.ctx) === 'unknown').sort((a, b) => b.n - a.n).map((r) => `${r.ctx || '(sin contexto)'}  x${r.n}`), state: () => ({ lp: [lpX, lpY], haveLp, map: currentMapId, zoom, selectedId }) };

  // ---- boot ----
  try { new ResizeObserver(fitCanvas).observe(canvas); } catch (_) { window.addEventListener('resize', fitCanvas); }
  fitCanvas();
  loadMobsDB();
  loadZonesDB();
  connect();
  requestAnimationFrame(loop);
})();
