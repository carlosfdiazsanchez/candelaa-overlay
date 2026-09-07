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

  // ---- Caminos de Avalon: ficha estática del mapa (tools/build-roads.py → data/roads.json) ----
  // Los layouts de los Caminos son fijos por plantilla: con el id de zona basta para saber
  // tier, si admite HO (tipo TUNNEL_HIDEOUT*) y el contenido catalogado (cofres/mazmorras/nodos).
  const rzSearchEl = document.getElementById('rz-search');
  const rzCardEl = document.getElementById('rz-card');
  const rzPortalsEl = document.getElementById('rz-portals');
  const rzCountEl = document.getElementById('rz-count');
  const radViewRadar = document.getElementById('rad-view-radar');
  const radViewRoads = document.getElementById('rad-view-roads');
  const radTabRadar = document.getElementById('rad-tab-radar');
  const radTabRoads = document.getElementById('rad-tab-roads');

  // Portales vistos por zona: el servidor solo anuncia entidades dentro de la burbuja (~25 m),
  // así que la lista se acumula al pasar cerca de cada portal y se recuerda por mapa. Las
  // conexiones de Caminos rotan sobre horas: 8h de TTL para no enseñar portales muertos.
  const RSKEY = 'albion-overlay-roads-seen-v1';
  const roadsSeen = (() => {
    try {
      const m = JSON.parse(localStorage.getItem(RSKEY)) || {};
      const cut = Date.now() - 8 * 3600e3;
      for (const map in m) {
        for (const d in m[map]) if (!m[map][d] || m[map][d].t < cut) delete m[map][d];
        if (!Object.keys(m[map]).length) delete m[map];
      }
      return m;
    } catch (_) { return {}; }
  })();
  let roadsSeenT = null;
  function saveRoadsSeen() {
    if (roadsSeenT) return;
    roadsSeenT = setTimeout(() => { roadsSeenT = null; try { localStorage.setItem(RSKEY, JSON.stringify(roadsSeen)); } catch (_) {} }, 1500);
  }

  const TABKEY = 'albion-overlay-radar-tab-v1';
  function setTab(t) {
    const roads = t === 'roads';
    if (radViewRadar) radViewRadar.hidden = roads;
    if (radViewRoads) radViewRoads.hidden = !roads;
    if (radTabRadar) radTabRadar.setAttribute('aria-pressed', String(!roads));
    if (radTabRoads) radTabRoads.setAttribute('aria-pressed', String(roads));
    try { localStorage.setItem(TABKEY, t); } catch (_) {}
    if (roads) { renderZoneCard(); renderPortals(); }
  }
  if (radTabRadar) radTabRadar.addEventListener('click', () => setTab('radar'));
  if (radTabRoads) radTabRoads.addEventListener('click', () => setTab('roads'));
  try { if (localStorage.getItem(TABKEY) === 'roads') setTab('roads'); } catch (_) {}

  let roadsDB = null;
  let roadsByName = null;
  const tunnelExits = new Map(); // portales de Caminos con destino identificado en el payload
  // Cofres reales del mapa: ev286 llega AL ENTRAR con TODOS los cofres del mapa (posición +
  // código de color en [2]), no limitado a la burbuja — arregla el catálogo desfasado.
  const roadsChests286 = new Map(); // id -> { x, y, q }
  // Código de color [2] -> color. 101 = verde CONFIRMADO en vivo (Sases-Avuotum, 6/6).
  // Los demás son hipótesis por orden ascendente; se registran en window.__roads.chestCodes().
  const ROAD_CHEST_Q = { 101: 'green', 102: 'blue', 103: 'gold', 104: 'gold' };
  const CHEST_Q_ICON = { green: '🟩', blue: '🟦', gold: '🟨' };
  const roadsSamples = [];       // eventos crudos que nombraron un mapa de Caminos (diagnóstico)
  const normRoad = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  function loadRoadsDB(attempt) {
    const p = (() => { try { return window.overlay.roadsIndex().catch(() => null); } catch (_) { return Promise.resolve(null); } })();
    p.then((db) => {
      if (db && typeof db === 'object' && Object.keys(db).length) {
        roadsDB = db;
        roadsByName = {};
        for (const id in db) roadsByName[normRoad(db[id].n)] = id;
        renderZoneCard();
        renderPortals();
        if (currentMapId && roadsDB[currentMapId]) setTab('roads');
      } else if ((attempt || 0) < 5) setTimeout(() => loadRoadsDB((attempt || 0) + 1), 5000);
    });
  }
  loadRoadsDB(0);

  const RZ_CHEST = { GREEN: '🟩', BLUE: '🟦', GOLD: '🟨' };
  const RZ_RES = { ORE: '⛏️', WOOD: '🪵', FIBER: '🌿', HIDE: '🐾', STONE: '🪨' };
  const RZ_CHEST_WORD = { GREEN: 'green', BLUE: 'blue', GOLD: 'gold' };
  const RZ_RES_WORD = { ORE: 'ore', WOOD: 'wood', FIBER: 'fiber', HIDE: 'hide', STONE: 'stone' };
  function roadTags(e) {
    const y = e.y || '';
    const tags = [];
    tags.push(y.startsWith('HIDEOUT')
      ? ['HO ✓', 'ok', 'A hideout can be placed in this map']
      : ['HO ✗', 'no', 'No hideouts can be placed in this map']);
    if (y.startsWith('ROYAL')) tags.push([y === 'ROYAL_RED' ? 'Royal red' : 'Royal', '', 'Connects to the Royal continent']);
    if (y.startsWith('BLACK')) tags.push(['Black', '', 'Connects to the black zones']);
    if (y.includes('DEEP')) tags.push(['Deep', '', 'Deep roads — better content, further from the outside world']);
    if (y === 'DEEP_RAID') tags.push(['Raid', '', 'Raid map (large-group content)']);
    const q = /(HIGH|MEDIUM|LOW)$/.exec(y);
    if (q) tags.push([{ HIGH: 'High', MEDIUM: 'Mid', LOW: 'Low' }[q[1]], '', 'Content quality of this map']);
    return tags;
  }
  const rzSize = (s) => (s === 'l' ? 'large' : 'small');
  function rzTagsHTML(e) {
    return roadTags(e).map(([txt, cls, tip]) => `<span class="rz-tag ${cls}" title="${tip}">${txt}</span>`).join('');
  }
  // Líneas de cofres desde el ev286 (dato REAL del mapa, llega al entrar). Agrupadas por color;
  // un código de color aún no confirmado se cuenta igual como "chest" para que el total no mienta.
  function rzChestLiveRows() {
    const byColor = {};
    let unknown = 0;
    roadsChests286.forEach((c) => {
      const color = ROAD_CHEST_Q[c.q];
      if (color) byColor[color] = (byColor[color] || 0) + 1;
      else unknown += 1;
    });
    const rows = [];
    ['green', 'blue', 'gold'].forEach((col) => {
      if (byColor[col]) rows.push(`${CHEST_Q_ICON[col]} ${byColor[col]}× ${col} chest`);
    });
    if (unknown) rows.push(`🎁 ${unknown}× chest`);
    return rows;
  }
  function rzBodyRows(e, isCurrent) {
    const rows = [];
    const liveChests = isCurrent && roadsChests286.size ? rzChestLiveRows() : null;
    if (liveChests) liveChests.forEach((r) => rows.push(r));
    else if (e.k) (e.c || []).forEach(([t, s, n]) => rows.push(`${RZ_CHEST[t] || ''} ${n}× ${rzSize(s)} ${RZ_CHEST_WORD[t] || String(t).toLowerCase()} chest`));
    if (e.k) {
      (e.d || []).forEach(([t, , n]) => rows.push(`🚪 ${n}× ${t === 'SOLO' ? 'Solo dungeon' : 'Group dungeon'}`));
      (e.r || []).forEach(([t, s, n]) => rows.push(`${RZ_RES[t] || ''} ${n}× ${rzSize(s)} ${RZ_RES_WORD[t] || String(t).toLowerCase()} node`));
    }
    if (!rows.length) return e.k ? '<div class="rz-row dim">Nothing cataloged inside</div>' : '<div class="rz-row dim">Contents not cataloged</div>';
    return rows.map((r) => `<div class="rz-row">${r}</div>`).join('');
  }
  function zoneCardHTML(e, isCurrent) {
    return `<div class="rz-head"><span class="rz-name">${esc(e.n)}</span><span class="rz-tier">T${e.t || '?'}</span>${rzTagsHTML(e)}</div>` + rzBodyRows(e, isCurrent);
  }
  // El catálogo es dato comunitario y se desfasa cuando un parche repuebla plantillas: esta
  // fila contrasta con lo que el radar HA VISTO de verdad en esta visita. Solo totales de
  // cofres — en Caminos el color no viaja en el evento (verde y azul llegan idénticos).
  const RZ_LIVE_RES = { Ore: '⛏️', Wood: '🪵', Fiber: '🌿', Hide: '🐾', Rock: '🪨' };
  function rzLiveRow() {
    let nDun = 0;
    portals.forEach((pt) => {
      const u = String(pt.name).toUpperCase();
      if (!u.startsWith('MISTS_') && !u.includes('HELLGATE') && !u.includes('CORRUPTED')) nDun++;
    });
    const res = {};
    harvestables.forEach((h) => { res[h.type] = (res[h.type] || 0) + 1; });
    const parts = [];
    if (nDun) parts.push(`🚪 ${nDun}`);
    for (const t in res) parts.push(`${RZ_LIVE_RES[t] || t} ${res[t]}`);
    if (!parts.length) return '';
    return `<div class="rz-row dim" title="Counted by the radar as you walk — only what you have passed near counts">Seen live: ${parts.join(' · ')}</div>`;
  }
  function portalCardHTML(destId, liveX, seenRec) {
    const e = roadsDB[destId];
    if (!e) return '';
    let foot = '';
    if (liveX && haveLp && liveX.posX != null) {
      const { hX, hY } = relative(liveX.posX, liveX.posY);
      foot = `📍 ${Math.round(distMeters(hX, hY))} m`;
    } else if (seenRec) {
      foot = `👁 ${Math.max(1, Math.round((Date.now() - seenRec.t) / 60000))} min`;
    }
    return `<div class="rz-card"><div class="rz-head">🌀 <span class="rz-name">${esc(e.n)}</span><span class="rz-tier">T${e.t || '?'}</span>${rzTagsHTML(e)}</div>`
      + rzBodyRows(e) + (foot ? `<div class="rz-foot">${foot}</div>` : '') + '</div>';
  }
  function renderPortals() {
    if (!rzPortalsEl || !roadsDB) return;
    const seen = (currentMapId && roadsSeen[currentMapId]) || {};
    const live = {};
    tunnelExits.forEach((x) => { if (x.destId) live[x.destId] = x; });
    const ids = Object.keys(Object.assign({}, seen, live));
    if (rzCountEl) rzCountEl.textContent = ids.length ? String(ids.length) : '';
    if (!ids.length) {
      rzPortalsEl.innerHTML = '<div class="rz-row dim">No Roads portals seen in this zone yet — walk close to one</div>';
      return;
    }
    ids.sort((a, b) => {
      const la = live[a] ? 1 : 0, lb = live[b] ? 1 : 0;
      if (la !== lb) return lb - la;
      return ((seen[b] && seen[b].t) || 0) - ((seen[a] && seen[a].t) || 0);
    });
    rzPortalsEl.innerHTML = ids.map((d) => portalCardHTML(d, live[d], seen[d])).join('');
  }
  function findRoad(q) {
    if (roadsDB[q]) return q;
    const nq = normRoad(q);
    if (!nq) return null;
    if (roadsByName[nq]) return roadsByName[nq];
    for (const n in roadsByName) if (n.startsWith(nq)) return roadsByName[n];
    for (const n in roadsByName) if (n.includes(nq)) return roadsByName[n];
    return null;
  }
  function renderZoneCard() {
    if (!rzCardEl || !roadsDB) return;
    const q = rzSearchEl ? rzSearchEl.value.trim() : '';
    let id = null;
    if (q) {
      id = findRoad(q);
      if (!id) { rzCardEl.hidden = false; rzCardEl.innerHTML = '<div class="rz-row dim">No Roads map matches</div>'; return; }
    } else if (currentMapId && roadsDB[currentMapId]) {
      id = currentMapId;
    }
    if (!id) { rzCardEl.hidden = true; rzCardEl.innerHTML = ''; return; }
    rzCardEl.hidden = false;
    const isCurrent = !q && id === currentMapId;
    rzCardEl.innerHTML = zoneCardHTML(roadsDB[id], isCurrent) + (isCurrent ? rzLiveRow() : '');
  }
  if (rzSearchEl) rzSearchEl.addEventListener('input', renderZoneCard);
  setInterval(() => {
    if (!radViewRoads || radViewRoads.hidden) return;
    if (tunnelExits.size) renderPortals();
    if (!(rzSearchEl && rzSearchEl.value.trim())) renderZoneCard();
  }, 3000);

  // ev286 (detectado por FORMA, no por número — los códigos altos bailan con los parches):
  // llega al ENTRAR con la lista de cofres del mapa entero. [1]=ids, [3]=coords (2 por id),
  // [2]=código de color. No limitado a la burbuja: es la verdad que arregla el catálogo.
  function parseRoads286(p) {
    const ids = p['1'], coords = p['3'], q = p['2'];
    if (!Array.isArray(ids) || !ids.length || !Array.isArray(coords) || !Array.isArray(q)) return false;
    if (coords.length !== ids.length * 2 || q.length !== ids.length) return false;
    if (ids.length > 60) return false;
    for (let i = 0; i < ids.length; i++) {
      const x = coords[i * 2], y = coords[i * 2 + 1];
      if (!Number.isInteger(ids[i]) || ids[i] < 0) return false;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 3000 || Math.abs(y) > 3000) return false;
      // color de cofre: 101-104 confirmados; banda amplia para no romper con un parche, pero
      // estrecha para que ningún otro evento con arrays entre por error y borre la lista.
      if (!Number.isInteger(q[i]) || q[i] < 64 || q[i] > 160) return false;
    }
    roadsChests286.clear();
    for (let i = 0; i < ids.length; i++) roadsChests286.set(ids[i], { x: coords[i * 2], y: coords[i * 2 + 1], q: num(q[i], 0) });
    renderZoneCard();
    return true;
  }

  // Trampa de identificación del NewTunnelExit: el código de evento baila con los parches y su
  // payload no está documentado, pero el DESTINO tiene que viajar (el juego pinta el nombre del
  // mapa al acercarse al portal). Cualquier evento no manejado cuyo payload contenga un id o un
  // nombre de mapa de Caminos se registra (window.__roads.samples) y, si además trae posición,
  // se pinta como portal con destino. Cuando el código quede confirmado en vivo, se fija aquí.
  function maybeTunnelExit(p, code) {
    if (!roadsDB) return;
    let destId = null;
    for (const k in p) {
      const v = p[k];
      if (typeof v !== 'string' || v.length < 4 || v.length > 40) continue;
      if (roadsDB[v]) { destId = v; break; }
      const byName = roadsByName[normRoad(v)];
      if (byName) { destId = byName; break; }
    }
    if (!destId) return;
    if (roadsSamples.length < 40) roadsSamples.push({ code, p: JSON.parse(JSON.stringify(p)) });
    if (currentMapId) {
      const zone = roadsSeen[currentMapId] = roadsSeen[currentMapId] || {};
      zone[destId] = { t: Date.now() };
      saveRoadsSeen();
    }
    const id = p['0'];
    if (id !== undefined && id !== null && typeof id !== 'string') {
      let pos = null;
      for (const k in p) {
        const v = p[k];
        if (Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Math.abs(v[0]) < 4000 && Math.abs(v[1]) < 4000) { pos = v; break; }
      }
      const ex = tunnelExits.get(id);
      if (ex) { ex.last = Date.now(); if (pos) { ex.posX = pos[0]; ex.posY = pos[1]; } }
      else tunnelExits.set(id, { id, destId, posX: pos ? pos[0] : null, posY: pos ? pos[1] : null, last: Date.now() });
    }
    renderPortals();
  }
  // Resultado del OCR (Ctrl+Alt+R en el proceso principal): el destino leído pasa a la ficha
  // y se apunta como portal de esta zona, igual que si el paquete lo hubiera traído.
  const rzOcrEl = document.getElementById('rz-ocr');
  function setOcrState(cls, txt) { if (!rzOcrEl) return; rzOcrEl.className = 'rz-ocr' + (cls ? ' ' + cls : ''); rzOcrEl.textContent = txt || ''; }
  function onRoadsOcr(r) {
    if (!r) return;
    if (r.state === 'busy') { setTab('roads'); setOcrState('', 'Reading the screen…'); return; }
    if (r.state === 'done' && roadsDB && roadsDB[r.id]) {
      if (currentMapId) {
        const zone = roadsSeen[currentMapId] = roadsSeen[currentMapId] || {};
        zone[r.id] = { t: Date.now() };
        saveRoadsSeen();
      }
      if (rzSearchEl) rzSearchEl.value = roadsDB[r.id].n;
      setTab('roads');
      renderZoneCard();
      renderPortals();
      setOcrState('ok', 'Portal read: ' + roadsDB[r.id].n);
      return;
    }
    if (r.state === 'none') { setOcrState('bad', 'No Roads map name under the cursor' + (r.text ? ' — read: “' + r.text + '”' : '')); return; }
    if (r.state === 'error') setOcrState('bad', 'Could not read the screen');
  }
  try { if (window.overlay && window.overlay.onRoadsOcr) window.overlay.onRoadsOcr(onRoadsOcr); } catch (_) {}
  window.__roads = {
    samples: roadsSamples,
    exits: tunnelExits,
    seen: roadsSeen,
    chests: roadsChests286,
    chestCodes: () => { const h = {}; roadsChests286.forEach((c) => { h[c.q] = (h[c.q] || 0) + 1; }); return h; },
    db: () => roadsDB,
    current: () => currentMapId,
    show: (q) => { setTab('roads'); if (rzSearchEl) { rzSearchEl.value = q || ''; renderZoneCard(); } },
  };

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
    tunnelExits.clear();
    roadsChests286.clear();
    selectedId = null;
    haveLp = false;
    lpX = 0; lpY = 0;
    renderZoneCard();
    renderPortals();
    if (roadsDB && roadsDB[mapId]) setTab('roads');
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

  function onEvent(p, code) {
    const id = p['0'];
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
      case 98: newNamedMob(p); break;
      case 47: { const mo = mobs.get(p['0']); if (mo) { mo.ench = num(p['1'], mo.ench); mo.last = Date.now(); } break; }
      // Los códigos ALTOS se desplazaron +2 en algún parche (capturado en vivo 2026-08-08:
      // portales 323->325, cofres 391->393, pesca 359->361); los bajos (recursos 39/40/46,
      // mobs 123/47) siguen igual. Se aceptan ambos: el viejo por si se juega otra versión,
      // el nuevo porque es el que llega hoy. Cada handler valida el payload antes de usarlo.
      case 323: case 325: newPortal(p); break;
      case 530: case 532: newCage(p); break;
      case 531: case 533: cages.delete(id); break;
      default: if (!parseRoads286(p)) maybeTunnelExit(p, code); break;
    }
  }

  function removeEverywhere(id) {
    harvestables.delete(id); mobs.delete(id); mists.delete(id);
    portals.delete(id); cages.delete(id);
    tunnelExits.delete(id);
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

  // ---- mobs / living resources / mists (event 123) ----
  function newMob(p) {
    const id = p['0'];
    const typeId = num(p['1']);
    const loc = Array.isArray(p['7']) ? p['7'] : [0, 0];
    const posX = num(loc[0]), posY = num(loc[1]);
    const ench = num(p['33'], 0);
    const name = p['32'] || p['31'] || null;
    if (name) { // named entity in NewMob = Mists portal / feu-follet
      if (!mists.has(id)) mists.set(id, { id, posX, posY, name, ench, last: Date.now() });
      else mists.get(id).last = Date.now();
      return;
    }
    if (mobs.has(id)) { mobs.get(id).last = Date.now(); return; }
    // vida máxima en [14], energía máxima en [19] (los [13]/[18] son los valores ACTUALES y
    // bajan en cuanto al bicho le pegan, así que con ellos la firma no encontraría nada)
    const info = mobBySig(p['14'], p['19']);
    const rec = mobRecord(id, typeId, posX, posY, ench, info);
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
  window.__radar = { harvestables, mobs, mists, portals, cages, filters, sub, priceMap, collect, handleMessage, render, setMobs: (d) => { mobsDB = d; markDirty(); render(); }, select: (id) => { selectedId = id; }, state: () => ({ lp: [lpX, lpY], haveLp, map: currentMapId, selectedId }), livingSamples: () => livingSamples, regenDB, nodeMem };

  // ---- boot ----
  try { new ResizeObserver(fitCanvas).observe(canvas); } catch (_) { window.addEventListener('resize', fitCanvas); }
  fitCanvas();
  loadMobsDB();
  loadZonesDB();
  connect();
  requestAnimationFrame(loop);
})();
