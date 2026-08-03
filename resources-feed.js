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
//               530 NewCagedObject · 531 CagedObjectStateUpdated · 359 NewFishingZoneObject ·
//               356 FishingFinished · 3 Move · 1 Leave
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
  const fishes = new Map();       // fishing zones
  let lpX = 0, lpY = 0, haveLp = false;
  let selectedId = null;          // entidad fijada: el radar solo la muestra a ella
  let currentMapId = null;
  let mobsDB = null; // Map<typeId,{type,tier,combatTier,uniqueName,category,isHarvestable}>

  const MOBS_OFFSET = 16;

  // ---- filters (persisted) ----
  const FKEY = 'albion-overlay-radar-filters-v1';
  const filters = (() => {
    const def = { chest: true, resource: true, living: true, avalon: true, fish: true };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(FKEY)) || {}); } catch (_) { return def; }
  })();
  const saveFilters = () => { try { localStorage.setItem(FKEY, JSON.stringify(filters)); } catch (_) {} };

  // sub-filters: resource types, chest qualities, min tier, sort mode (all persisted)
  const SKEY = 'albion-overlay-radar-subfilters-v1';
  const sub = (() => {
    const def = {
      resTypes: { Ore: true, Wood: true, Fiber: true, Hide: true, Rock: true },
      ench: { 0: true, 1: true, 2: true, 3: true, 4: true },
      chestQ: { green: true, blue: true, purple: true, gold: true },
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
  const RES_ES = { Fiber: 'Fibra', Hide: 'Piel', Wood: 'Madera', Ore: 'Mineral', Rock: 'Piedra' };

  // chest quality: keyword in name first (reliable in Avalon/Mists), else rarity int 0-4
  const QUALITY = {
    green: { color: '#46d160', es: 'Verde', rank: 0 },
    blue: { color: '#4aa3ff', es: 'Azul', rank: 1 },
    purple: { color: '#b96bff', es: 'Morado', rank: 2 },
    gold: { color: '#ffcc33', es: 'Dorado', rank: 3 },
  };
  function chestQuality(name, rarity) {
    const n = (name || '').toLowerCase();
    if (['standard', 'green'].some((s) => n.includes(s))) return 'green';
    if (['uncommon', 'blue'].some((s) => n.includes(s))) return 'blue';
    if (['rare', 'purple'].some((s) => n.includes(s))) return 'purple';
    if (['legendary', 'yellow', 'gold'].some((s) => n.includes(s))) return 'gold';
    switch (rarity) {
      case 0: return 'green';
      case 1: return 'blue';
      case 2: return 'purple';
      case 3: case 4: return 'gold';
      default: return 'green';
    }
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
  function toScreen(hX, hY, size) {
    const u = (hX - hY) * Math.SQRT1_2;
    const v = (hX + hY) * Math.SQRT1_2;
    const scale = (size / 2) / (rangeM() * 3);
    return { x: size / 2 + u * scale, y: size / 2 + v * scale };
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
    connEl.title = 'OpenRadar: ' + (s === 'ok' ? 'conectado' : s === 'bad' ? 'desconectado' : 'conectando…');
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

    // map / zone change -> wipe everything (positions are relative to a cluster)
    if ((op === 2 || op === 3) && typeof p['8'] === 'string') return onMapChange(p['8']);
    if (op === 41 && typeof p['0'] === 'string') return onMapChange(p['0']);

    if (kind === 'request') return onRequest(p, op);
    if (kind === 'response') return onResponse(p, op);
    if (window.__fishDiag) fishDiag(p, p['252']);
    onEvent(p, p['252']);
  }

  // ---- live fishing diagnostic (window.__fishDiag = true to enable) ----
  // Detecta eventos "con forma de pesca" por su PAYLOAD, sin depender del código,
  // para descubrir en vivo qué código real trae la pool (los códigos de Albion se
  // desplazan por parche). Ver window.__radar.diag tras pararte junto a una pool.
  const diag = { codeHist: new Map(), fishy: [] };
  function fishDiag(p, code) {
    diag.codeHist.set(code, (diag.codeHist.get(code) || 0) + 1);
    const pos = p['1'];
    const looksFishy =
      Object.values(p).some((v) => typeof v === 'string' && /fish/i.test(v)) ||
      (Array.isArray(pos) && pos.length === 2 && typeof pos[0] === 'number' &&
        Number.isInteger(p['2']) && p['2'] >= 0 && p['2'] <= 60 && p['4'] !== undefined);
    if (looksFishy && diag.fishy.length < 60) {
      diag.fishy.push({ code, id: p['0'], p1: p['1'], p2: p['2'], p3: p['3'], p4: p['4'] });
      // eslint-disable-next-line no-console
      console.log('[fishDiag] code', code, 'id', p['0'], 'pos', p['1'], 'spawned', p['2'], 'left', p['3'], 'type', p['4']);
    }
  }

  function onMapChange(mapId) {
    if (!mapId || mapId === currentMapId) return;
    currentMapId = mapId;
    harvestables.clear(); mobs.clear(); mists.clear(); chests.clear(); portals.clear(); cages.clear(); fishes.clear();
    selectedId = null;
    haveLp = false;
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
    // Zonas de pesca: se detectan por su PAYLOAD (tipo "FishingNode*"), no por el
    // número de código de evento — los códigos de Albion se DESPLAZAN cada parche
    // (visto: era 359 en OpenRadar v2.2.0, hoy llega como 361). El prefijo del tipo
    // es inequívoco y sobrevive a esos cambios.
    if (typeof p['4'] === 'string' && p['4'].indexOf('FishingNode') === 0 && Array.isArray(p['1'])) { newFish(p); return; }
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
      case 391: newChest(p); break;
      case 323: newPortal(p); break;
      case 530: newCage(p); break;
      case 531: cages.delete(id); break;
      default: break;
    }
  }

  function removeEverywhere(id) {
    harvestables.delete(id); mobs.delete(id); mists.delete(id);
    chests.delete(id); portals.delete(id); cages.delete(id); fishes.delete(id);
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
  function newChest(p) {
    const id = p['0'];
    const pos = p['1']; if (!Array.isArray(pos)) return;
    let name = p['3'];
    if (typeof name === 'string' && name.toLowerCase().includes('mist')) name = p['4'];
    const rarity = p['5'] == null ? null : num(p['5']);
    const ex = chests.get(id);
    if (ex) { ex.last = Date.now(); return; }
    chests.set(id, { id, posX: pos[0], posY: pos[1], name: name || '', quality: chestQuality(name, rarity), last: Date.now() });
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

  // ---- fishing zones (NewFishingZoneObject) ----
  // Params: [0]=id, [1]=[x,y], [2]=peces disponibles, [3]=por aparecer, [4]=tipo
  // (string "FishingNode*"). total = [2]+[3]. Igual que OpenRadar, solo son pools reales
  // las que traen tipo; se enrutan aquí por el tipo (ver onEvent).
  function newFish(p) {
    const id = p['0']; if (id === undefined) return;
    const pos = p['1']; if (!Array.isArray(pos) || pos.length < 2 || typeof pos[0] !== 'number') return;
    const type = p['4']; if (typeof type !== 'string' || !type) return;
    const spawned = num(p['2'], 0), left = num(p['3'], 0);
    const total = spawned + left;
    const ex = fishes.get(id);
    if (ex) { ex.posX = pos[0]; ex.posY = pos[1]; ex.spawned = spawned; ex.left = left; ex.total = total; ex.type = type; ex.last = Date.now(); return; }
    fishes.set(id, { id, posX: pos[0], posY: pos[1], type, spawned, left, total, last: Date.now() });
  }
  // clasificación de la pool por tipo (banco normal vs cardumen/rico)
  function fishInfo(type) {
    const u = String(type || '').toUpperCase();
    if (u.includes('SWARM')) return { es: 'Cardumen', color: '#ffb02e' };   // más peces / mejor
    if (u.includes('EPIC') || u.includes('LEGEND')) return { es: 'Pesca épica', color: '#b96bff' };
    return { es: 'Pesca', color: '#33c9ff' };
  }

  // ---- portal classification (label + colour) ----
  const ENCH_COLOR = ['#c9d1d9', '#46d160', '#4aa3ff', '#b96bff', '#ffcc33'];
  function portalInfo(pt) {
    const u = pt.name.toUpperCase();
    if (u.startsWith('MISTS_')) return { es: u.includes('_SOLO') ? 'Bruma solo' : 'Bruma dúo', icon: '🌫️', color: ENCH_COLOR[pt.ench] || '#7ee3d0' };
    if (u.includes('CORRUPTED')) return { es: 'Corrupta', icon: '🕳️', color: '#b96bff' };
    if (u.includes('HELLGATE')) return { es: 'Hellgate', icon: '🔥', color: '#ff6644' };
    if (u.includes('SOLO')) return { es: 'Mazmorra solo', icon: '🚪', color: ENCH_COLOR[pt.ench] || '#c9d1d9' };
    return { es: 'Mazmorra grupo', icon: '🚪', color: ENCH_COLOR[pt.ench] || '#c9d1d9' };
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
    if (filters.chest) chests.forEach((c) => { if (sub.chestQ[c.quality] !== false) push('chest', c, { color: QUALITY[c.quality].color, icon: '🎁', label: 'Cofre ' + QUALITY[c.quality].es, quality: c.quality, value: CHEST_VALUE[c.quality] || 0 }); });
    if (filters.resource) harvestables.forEach((h) => { if ((h.size || 0) >= 1 && okType(h.type) && okTier(h.tier) && okEnch(h.ench)) push('resource', h, { color: RES_COLOR[h.type] || '#4169E1', icon: RES_ICON[h.type] || '◆', label: RES_ES[h.type] || h.type, tier: h.tier, ench: h.ench, size: h.size, sizeMax: Math.max(h.sizeMax || 0, h.size || 0), value: resourceValue(h.type, h.tier, h.ench, h.size), priced: isPriced(h.type, h.tier, h.ench) }); });
    if (filters.living) {
      mobs.forEach((m) => {
        if (m.living) { if (okType(m.resType) && okTier(m.tier) && okEnch(m.ench)) push('living', m, { color: RES_COLOR[m.resType] || '#8bc34a', icon: RES_ICON[m.resType] || '🐾', label: (RES_ES[m.resType] || 'Recurso') + ' vivo', tier: m.tier, ench: m.ench, size: 1, value: resourceValue(m.resType, m.tier, m.ench, 1), priced: isPriced(m.resType, m.tier, m.ench), living: true }); }
        else if (okTier(m.tier) && okEnch(m.ench)) push('mob', m, { color: m.ench > 0 ? (ENCH_COLOR[m.ench] || '#ed6a5a') : '#ed6a5a', icon: m.ench > 0 ? '✨' : '👹', label: m.ench > 0 ? 'Criatura encantada' : 'Criatura', tier: m.tier, ench: m.ench, enchMob: m.ench > 0 });
      });
    }
    if (filters.avalon) {
      mists.forEach((mi) => { const u = mi.name.toUpperCase(); push('avalon', mi, { color: ENCH_COLOR[mi.ench] || '#7ee3d0', icon: '🌀', label: u.includes('_SOLO') ? 'Portal bruma solo' : 'Portal bruma dúo', ench: mi.ench }); });
      portals.forEach((pt) => { const inf = portalInfo(pt); push('avalon', pt, { color: inf.color, icon: inf.icon, label: inf.es, ench: pt.ench }); });
      cages.forEach((c) => push('avalon', c, { color: '#ff7ac6', icon: '🧚', label: 'Jaula wisp' }));
    }
    if (filters.fish) fishes.forEach((f) => { if ((f.total || 0) >= 1) { const inf = fishInfo(f.type); push('fish', f, { color: inf.color, icon: '🎣', label: inf.es, spawned: f.spawned, total: f.total, fishType: f.type }); } });
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

    // distance rings
    const rings = [10, 20, 30, 40, 50].filter((m) => m < rangeM() + 1);
    ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    rings.forEach((m) => {
      const rad = (size / 2) * (m / rangeM());
      if (rad > c - 2) return;
      ctx.beginPath(); ctx.arc(c, c, rad, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(m + 'm', c + rad + 3, c);
    });
    ctx.setLineDash([]);

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
      ctx.fillText('muévete para ubicarte', c, size - 6);
    } else if (selectedId != null) {
      ctx.fillStyle = 'rgba(90,169,196,0.95)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('foco: 1 seleccionado (clic en la lista para soltar)', c, size - 6);
    }
  }

  const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
  const fmtK = (n) => { const a = Math.abs(n || 0); if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M'; if (a >= 1e3) return Math.round(n / 1e3) + 'K'; return String(Math.round(n || 0)); };
  function drawList(entities) {
    if (!entities.length) {
      listEl.innerHTML = '<div class="rad-empty">Nada en rango.<br>Muévete por el mundo, o revisa los filtros.</div>';
      return;
    }
    listEl.innerHTML = entities.slice(0, 40).map((e) => {
      const s = toScreen(e.hX, e.hY, 100);
      const arrow = arrowFor(s.x - 50, s.y - 50);
      const tier = e.tier ? ` <b class="rt">T${e.tier}${e.ench ? '.' + e.ench : ''}</b>` : (e.ench ? ` <b class="rt">✨${e.ench}</b>` : '');
      const dm = e.d < 1 ? '0' : Math.round(e.d);
      const val = e.priced ? `<span class="rv" title="Valor de mercado estimado del nodo">≈${fmtK(e.value)}</span>` : '';
      // cargas: recursos "x/max" · pesca "disponibles/total" (p. ej. 4/5)
      let charges = '';
      if (e.cat === 'fish') charges = `<span class="rc ${e.spawned >= e.total ? 'full' : e.spawned <= 1 ? 'low' : ''}" title="Peces disponibles / total${e.fishType != null ? ' · tipo de zona ' + esc(String(e.fishType)) : ''}">🐟 ${e.spawned}/${e.total}</span>`;
      else if ((e.cat === 'resource' || e.cat === 'living') && e.sizeMax > 0) charges = `<span class="rc ${e.size >= e.sizeMax ? 'full' : e.size <= 1 ? 'low' : ''}" title="Cargas restantes">${e.size}/${e.sizeMax}</span>`;
      const sel = e.id === selectedId ? ' selected' : '';
      return `<div class="rad-row cat-${e.cat}${sel}" data-id="${e.id}">
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

  // stale cleanup: drop entities not refreshed in 90s
  setInterval(() => {
    const now = Date.now(); const max = 90000;
    [harvestables, mobs, mists, chests, portals, cages, fishes].forEach((m) => {
      m.forEach((v, k) => { if (now - v.last > max) m.delete(k); });
    });
  }, 5000);

  // ---- filter chips ----
  const FILTER_DEFS = [
    ['chest', '🎁 Cofres'], ['resource', '◆ Recursos'], ['living', '🐾 Vivos/Mobs'], ['fish', '🎣 Pesca'], ['avalon', '🌀 Avalon'],
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
  const QUAL_ORDER = ['green', 'blue', 'purple', 'gold'];
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
    }
    subEl.innerHTML = html;
  }
  if (subEl) {
    renderSubFilters();
    subEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rt],[data-re],[data-cq]'); if (!b) return;
      if (b.dataset.rt) { const t = b.dataset.rt; sub.resTypes[t] = !(sub.resTypes[t] !== false); b.setAttribute('aria-pressed', String(sub.resTypes[t])); }
      else if (b.dataset.re != null) { const k = b.dataset.re; sub.ench[k] = !(sub.ench[k] !== false); b.setAttribute('aria-pressed', String(sub.ench[k])); }
      else { const q = b.dataset.cq; sub.chestQ[q] = !(sub.chestQ[q] !== false); b.setAttribute('aria-pressed', String(sub.chestQ[q])); }
      saveSub(); render(true);
    });
  }

  const sortEl = document.getElementById('rad-sort');
  const dirEl = document.getElementById('rad-dir');
  const DIR_DEFAULT = { dist: 'asc', value: 'desc', tier: 'desc' };
  function updateDirBtn() { if (dirEl) { dirEl.textContent = sub.dir === 'asc' ? '↑' : '↓'; dirEl.title = sub.dir === 'asc' ? 'Ascendente (menor primero) — clic para invertir' : 'Descendente (mayor primero) — clic para invertir'; } }
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
  window.__radar = { harvestables, mobs, mists, chests, portals, cages, fishes, filters, sub, priceMap, collect, handleMessage, render, select: (id) => { selectedId = id; }, diag, fishDiagOn: (on = true) => { window.__fishDiag = on; if (on) { diag.codeHist.clear(); diag.fishy.length = 0; } return 'fishDiag ' + (on ? 'ON' : 'OFF'); }, state: () => ({ lp: [lpX, lpY], haveLp, map: currentMapId, zoom, selectedId }) };

  // ---- boot ----
  try { new ResizeObserver(fitCanvas).observe(canvas); } catch (_) { window.addEventListener('resize', fitCanvas); }
  fitCanvas();
  loadMobsDB();
  connect();
  requestAnimationFrame(loop);
})();
