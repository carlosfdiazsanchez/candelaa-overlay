// Radar feed: connects to OpenRadar's WebSocket, tracks the local player
// position and world entities, and draws them on the radar canvas using
// OpenRadar's coordinate projection. All config lives in the widget itself.
//
// Local pos:  Join (op 2, param 9 buffer/array) · Move (op 21/22, param 1)
// Entities:   harvestables 39/40/46 · mobs 123/47 · move 3 · chest 391 ·
//             dungeon 323 · mist = mob(123) con nombre · leave 1
// Projection (DrawingUtils): hX=-posX+lpX, hY=posY-lpY; ang=-0.785398;
//             nx=ang*(hX-hY), ny=ang*(hX+hY); *BASE_ZOOM*zoom; +center.

(function () {
  const WS_URL = 'ws://localhost:5001/ws';
  const CFG_KEY = 'albion-overlay-radar-v1';
  const canvas = document.getElementById('radar');
  const ctx = canvas.getContext('2d');

  // ---- config (persisted in the widget) ----
  const defaults = {
    layers: { resources: true, mobs: true, players: true, zones: true, mists: true, chests: true },
    zoom: 1, iconSize: 1,
    tiers: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true },
    enchants: { 0: true, 1: true, 2: true, 3: true, 4: true },
    materials: { log: true, rock: true, fiber: true, hide: true, ore: true },
    cfgOpen: true, showMap: true, alertFlash: true, alertSound: true,
  };
  let cfg = loadCfg();
  function loadCfg() {
    try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(CFG_KEY)) || {}); }
    catch (_) { return JSON.parse(JSON.stringify(defaults)); }
  }
  function saveCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

  // ---- alerta de enemigo (parpadeo rojo + sonido) ----
  let audioCtx = null, lastAlert = 0;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; g.gain.value = 0.09;
      o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(1180, t + 0.12);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.28);
    } catch (_) {}
  }
  function flashAlert() {
    const el = document.getElementById('radar-alert'); if (!el) return;
    let n = 0; el.style.opacity = '1';
    const iv = setInterval(() => { n++; el.style.opacity = (n % 2 === 0) ? '1' : '0'; if (n >= 7) { clearInterval(iv); el.style.opacity = '0'; } }, 240);
  }
  function fireAlert() { if (cfg.alertFlash) flashAlert(); if (cfg.alertSound) beep(); }
  function alertEnemy() { const now = Date.now(); if (now - lastAlert < 2500) return; lastAlert = now; fireAlert(); }
  function isHidden(name) { try { return (JSON.parse(localStorage.getItem('albion-overlay-hidden-v1')) || []).includes(name); } catch (_) { return false; } }
  function getHidden() { try { return new Set(JSON.parse(localStorage.getItem('albion-overlay-hidden-v1')) || []); } catch (_) { return new Set(); } }
  function getAllies() { const s = getHidden(); try { (JSON.parse(localStorage.getItem('albion-overlay-party-v1')) || []).forEach((n) => s.add(n)); } catch (_) {} return s; }
  function isAlly(name) { return !!(name && getAllies().has(name)); }

  // ---- world state ----
  let lpX = null, lpY = null;
  const harvest = new Map();  // id -> {posX,posY,tier,type,ench,size,last}
  const mobs = new Map();     // id -> {posX,posY,tier,ench,enemyType,last,isMist,name}
  const players = new Map();  // id -> {posX,posY,faction,last}
  const chests = new Map();   // id -> {posX,posY,rarity,last}
  const dungeons = new Map(); // id -> {posX,posY,type,ench,last}

  const COL = {
    resource: '#3ba55d', mob: '#d9822b', player: '#ed4245',
    chest: '#e7c14d', mist: '#b06cf6', dungeon: '#9b6cf6', me: '#ffffff',
  };

  // typeNumber del recurso -> material (para icono y filtro)
  const MAT = {};
  [[0, 5, 'log'], [6, 10, 'rock'], [11, 15, 'fiber'], [16, 22, 'hide'], [23, 27, 'ore']]
    .forEach(([a, b, n]) => { for (let i = a; i <= b; i++) MAT[i] = n; });
  const matOf = (t) => MAT[t];

  // cache de iconos .webp servidos por OpenRadar
  const iconCache = new Map();
  function icon(name) {
    let im = iconCache.get(name);
    if (!im) { im = new Image(); im._ok = false; im.onload = () => { im._ok = true; }; im.src = 'http://localhost:5001/images/Resources/' + name + '.webp'; iconCache.set(name, im); }
    return im;
  }

  // ---- mapa de fondo ----
  let currentMapId = null;
  let mapBounds = {};
  const mapImgCache = new Map();
  const PVP_ES = { safe: 'Segura', yellow: 'Amarilla', red: 'Roja', black: 'Negra' };
  function zonePvp() { const z = mapBounds[currentMapId]; return z ? z.pvpType : null; }
  function updateZoneLabel() {
    const el = document.getElementById('radar-zone'); if (!el) return;
    if (currentMapId == null) { el.textContent = '—'; return; }
    const z = mapBounds[currentMapId];
    el.textContent = (z && z.name) ? (z.name + (z.pvpType ? ' · ' + (PVP_ES[z.pvpType] || z.pvpType) : '')) : currentMapId;
  }
  fetch('http://localhost:5001/ao-bin-dumps/zones.json').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) mapBounds = d; updateZoneLabel(); }).catch(() => {});
  function mapImage(id) {
    let im = mapImgCache.get(id);
    if (!im) { im = new Image(); im._ok = false; im.onload = () => { im._ok = true; }; im.src = 'http://localhost:5001/images/Maps/' + id + '.webp'; mapImgCache.set(id, im); }
    return im;
  }
  function clearAll() { harvest.clear(); mobs.clear(); players.clear(); chests.clear(); dungeons.clear(); }
  function applyMapChange(id) { if (typeof id === 'string' && id && id !== currentMapId) { currentMapId = id; clearAll(); updateZoneLabel(); } }
  function drawMap(S, center) {
    ctx.fillStyle = '#1a1c23'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!cfg.showMap || currentMapId == null || lpX == null) return;
    const im = mapImage(currentMapId); if (!im || !im._ok) return;
    const sf = 4 * (S / 500) * cfg.zoom;
    const z = mapBounds[currentMapId], b = z && z.bounds;
    const extent = b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) : 825;
    const cx = b ? (b.min[0] + b.max[0]) / 2 : 0, cy = b ? (b.min[1] + b.max[1]) / 2 : 0;
    const ds = extent * sf, adjX = (lpX - cx) * sf, adjY = (-lpY + cy) * sf;
    ctx.save();
    ctx.scale(1, -1); ctx.translate(center, -center); ctx.rotate(-0.785398); ctx.translate(-adjX, adjY);
    ctx.globalAlpha = 0.9; ctx.drawImage(im, -ds / 2, -ds / 2, ds, ds); ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ---- projection ----
  function size() { return Math.min(canvas.width, canvas.height); }
  function project(px, py) {
    const S = size(), center = S / 2, BASE = 4 * (S / 500) * cfg.zoom;
    const hX = -px + lpX, hY = py - lpY, ang = -0.785398;
    return { x: ang * (hX - hY) * BASE + center, y: ang * (hX + hY) * BASE + center };
  }

  function draw() {
    const S = size(), center = S / 2, R = center - 4;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMap(S, center);
    // anillos guía (encima del mapa)
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    [R, R * 0.66, R * 0.33].forEach((r) => { ctx.beginPath(); ctx.arc(center, center, r, 0, 7); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(center - R, center); ctx.lineTo(center + R, center);
    ctx.moveTo(center, center - R); ctx.lineTo(center, center + R); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('N', center, center - R + 11);

    if (lpX == null) {
      ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.font = '11px sans-serif';
      ctx.fillText('esperando posición…', center, center + 4);
      return;
    }

    // formas por categoría + tier dentro + borde por encantamiento
    const sz = 3.8 * cfg.iconSize;
    const ENCH = ['rgba(255,255,255,.30)', '#2ecc71', '#3498db', '#e056fd', '#f1c40f']; // e0..e4
    const place = (px, py) => { const pt = project(px, py); return (pt.x >= -6 && pt.x <= S + 6 && pt.y >= -6 && pt.y <= S + 6) ? pt : null; };
    const tierText = (pt, tier) => { if (!tier) return; ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, Math.round(sz * 1.9))}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(tier), pt.x, pt.y); };
    const diamond = (pt, r) => { ctx.beginPath(); ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x + r, pt.y); ctx.lineTo(pt.x, pt.y + r); ctx.lineTo(pt.x - r, pt.y); ctx.closePath(); };
    const square = (pt, r) => { ctx.beginPath(); ctx.rect(pt.x - r, pt.y - r, r * 2, r * 2); };
    const triangle = (pt, r) => { ctx.beginPath(); ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x + r, pt.y + r); ctx.lineTo(pt.x - r, pt.y + r); ctx.closePath(); };

    // Recursos: icono real (.webp); fallback a círculo+tier si aún no cargó
    if (cfg.layers.resources) harvest.forEach((h) => {
      const mat = matOf(h.type);
      if (cfg.tiers[h.tier] === false || cfg.enchants[h.ench || 0] === false) return;
      if (mat && cfg.materials[mat] === false) return;
      const pt = place(h.posX, h.posY); if (!pt) return;
      const im = mat ? icon(`${mat}_${h.tier}_${h.ench || 0}`) : null;
      if (im && im._ok) {
        const s = (sz + 6) * 2;
        ctx.drawImage(im, pt.x - s / 2, pt.y - s / 2, s, s);
      } else {
        ctx.fillStyle = COL.resource; ctx.beginPath(); ctx.arc(pt.x, pt.y, sz + 2, 0, 7); ctx.fill();
        if (h.ench) { ctx.lineWidth = 2; ctx.strokeStyle = ENCH[h.ench] || ENCH[0]; ctx.stroke(); }
        tierText(pt, h.tier);
      }
    });
    // Mobs: rombo naranja, tier dentro
    if (cfg.layers.mobs) mobs.forEach((m) => {
      if (m.isMist) return; const pt = place(m.posX, m.posY); if (!pt) return;
      ctx.fillStyle = COL.mob; diamond(pt, sz + 2); ctx.fill();
      if (m.ench) { ctx.lineWidth = 2; ctx.strokeStyle = ENCH[m.ench] || ENCH[0]; ctx.stroke(); }
      tierText(pt, m.tier);
    });
    // Cofres: cuadrado dorado
    if (cfg.layers.chests) chests.forEach((c) => { const pt = place(c.posX, c.posY); if (!pt) return; ctx.fillStyle = COL.chest; square(pt, sz); ctx.fill(); });
    // Mists (rombo) + Dungeons (triángulo): morados
    if (cfg.layers.mists) {
      mobs.forEach((m) => { if (!m.isMist) return; const pt = place(m.posX, m.posY); if (!pt) return; ctx.fillStyle = COL.mist; diamond(pt, sz + 1); ctx.fill(); });
      dungeons.forEach((d) => { const pt = place(d.posX, d.posY); if (!pt) return; ctx.fillStyle = COL.dungeon; triangle(pt, sz + 1); ctx.fill(); });
    }
    // Jugadores enemigos: círculo rojo con anillo (resalta)
    if (cfg.layers.players) { const allies = getAllies(); players.forEach((p) => {
      if (p.posX == null || (p.name && allies.has(p.name))) return;   // ocultar a tu equipo/aliados del radar
      const pt = place(p.posX, p.posY); if (!pt) return;
      ctx.shadowColor = COL.player; ctx.shadowBlur = 8; ctx.fillStyle = COL.player;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, sz + 1, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(pt.x, pt.y, sz + 3.5, 0, 7); ctx.stroke();
    }); }

    // jugador local (centro)
    ctx.fillStyle = COL.me; ctx.beginPath(); ctx.arc(center, center, 4, 0, 7); ctx.fill();
    ctx.textBaseline = 'alphabetic';
  }

  // render loop
  function loop() { draw(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ---- WebSocket ----
  let ws = null, reconnectT = null;
  const safeParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  function decodePos(v) {
    if (Array.isArray(v) && v.length >= 2) return [v[0], v[1]];
    if (v && v.type === 'Buffer' && v.data) {
      const dv = new DataView(new Uint8Array(v.data).buffer);
      return [dv.getFloat32(0, true), dv.getFloat32(4, true)];
    }
    return null;
  }
  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (_) { return sched(); }
    ws.onclose = () => sched();
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type === 'batch' && Array.isArray(m.messages)) m.messages.forEach(handle); else handle(m); } catch (_) {} };
  }
  function sched() { clearTimeout(reconnectT); reconnectT = setTimeout(connect, 3000); }

  function handle(m) {
    const dict = typeof m.dictionary === 'string' ? safeParse(m.dictionary) : m.dictionary;
    const p = dict && dict.parameters; if (!p) return;
    const op = p['253'], code = p['252'], id = p['0'], now = Date.now();

    // local player position (operations)
    if (op === 2 || op === 3) { const pos = decodePos(p['9']); if (pos) { lpX = pos[0]; lpY = pos[1]; } if (typeof p['8'] === 'string') applyMapChange(p['8']); }
    if (op === 21 || op === 22) { const pos = decodePos(p['1']); if (pos) { lpX = pos[0]; lpY = pos[1]; } }
    if (op === 41 && typeof p['0'] === 'string') applyMapChange(p['0']);

    switch (code) {
      case 39: { // harvestable batch
        const A = (k) => (p[k] && p[k].data) ? p[k].data : p[k];
        const ids = A('0'), types = A('1'), tiers = A('2'), pos = p['3'], counts = A('4');
        if (Array.isArray(ids)) for (let i = 0; i < ids.length; i++) {
          harvest.set(ids[i], { posX: pos[i * 2], posY: pos[i * 2 + 1], type: types && types[i], tier: tiers && tiers[i], ench: 0, size: counts && counts[i], last: now });
        }
        break; }
      case 40: { const loc = decodePos(p['8']); if (loc) harvest.set(id, { posX: loc[0], posY: loc[1], type: p['5'], tier: p['7'], ench: p['11'] || 0, size: p['10'], last: now }); break; }
      case 46: { const h = harvest.get(id); if (h) { if (p['1'] == null) harvest.delete(id); else { h.size = p['1']; h.ench = p['2'] ?? h.ench; } } break; }
      case 123: { // mob o mist (si trae nombre)
        const loc = p['7'] || [0, 0]; const name = p['32'] || p['31'];
        const e = { posX: loc[0], posY: loc[1], tier: p['21'], ench: p['33'] || 0, enemyType: p['1'], isMist: !!name, name, last: now };
        mobs.set(id, e); break; }
      case 47: { const e = mobs.get(id); if (e) e.ench = p['1'] ?? e.ench; break; }
      case 3: { // move (entidades): actualizar pos por id en el map que lo tenga
        const px = p['4'], py = p['5'];
        const e = mobs.get(id) || players.get(id) || dungeons.get(id);
        if (e && px != null) { e.posX = px; e.posY = py; e.last = now; }
        break; }
      case 391: { const loc = decodePos(p['1']); if (loc) chests.set(id, { posX: loc[0], posY: loc[1], rarity: p['5'], last: now }); break; }
      case 323: { const loc = decodePos(p['1']); if (loc) dungeons.set(id, { posX: loc[0], posY: loc[1], type: p['3'] || p['15'], ench: p['8'] || 0, last: now }); break; }
      case 29: {
        const isNew = !players.has(id); const name = p['1'];
        players.set(id, { posX: null, posY: null, faction: p['53'] ?? 0, name, last: now });
        const z = zonePvp(); if (isNew && !isAlly(name) && z && z !== 'safe') alertEnemy();  // no alertar de aliados/party
        break;
      }
      case 1: { harvest.delete(id); mobs.delete(id); players.delete(id); chests.delete(id); dungeons.delete(id); break; }
      default: break;
    }
  }

  // cleanup + zone change (Join/ChangeCluster clear)
  setInterval(() => {
    const now = Date.now();
    [harvest, mobs, players, chests, dungeons].forEach((mp) => mp.forEach((e, id) => { if (now - e.last > 120000) mp.delete(id); }));
  }, 20000);

  // ---- config UI wiring (en el widget) ----
  function wireUI() {
    // capas (checkboxes con data-layer)
    document.querySelectorAll('#radar-layers input[data-layer]').forEach((cb) => {
      cb.checked = cfg.layers[cb.dataset.layer] !== false;
      cb.addEventListener('change', () => { cfg.layers[cb.dataset.layer] = cb.checked; saveCfg(); });
    });
    const zoom = document.getElementById('rad-zoom');
    if (zoom) { zoom.value = cfg.zoom; zoom.addEventListener('input', () => { cfg.zoom = +zoom.value; saveCfg(); }); }
    const isz = document.getElementById('rad-icon');
    if (isz) { isz.value = cfg.iconSize; isz.addEventListener('input', () => { cfg.iconSize = +isz.value; saveCfg(); }); }
    const sm = document.getElementById('rad-showmap');
    if (sm) { sm.checked = cfg.showMap !== false; sm.addEventListener('change', () => { cfg.showMap = sm.checked; saveCfg(); }); }
    const af = document.getElementById('rad-alert-flash');
    if (af) { af.checked = cfg.alertFlash !== false; af.addEventListener('change', () => { cfg.alertFlash = af.checked; saveCfg(); }); }
    const asnd = document.getElementById('rad-alert-sound');
    if (asnd) { asnd.checked = cfg.alertSound !== false; asnd.addEventListener('change', () => { cfg.alertSound = asnd.checked; saveCfg(); }); }
    const tb = document.getElementById('rad-alert-test');
    if (tb) tb.addEventListener('click', () => { if (cfg.alertFlash) flashAlert(); if (cfg.alertSound) beep(); });
    document.querySelectorAll('#rad-tiers button[data-tier]').forEach((b) => {
      const t = +b.dataset.tier; b.setAttribute('aria-pressed', String(cfg.tiers[t] !== false));
      b.addEventListener('click', () => { cfg.tiers[t] = !(cfg.tiers[t] !== false); b.setAttribute('aria-pressed', String(cfg.tiers[t])); saveCfg(); });
    });
    document.querySelectorAll('#rad-ench button[data-ench]').forEach((b) => {
      const e = +b.dataset.ench; b.setAttribute('aria-pressed', String(cfg.enchants[e] !== false));
      b.addEventListener('click', () => { cfg.enchants[e] = !(cfg.enchants[e] !== false); b.setAttribute('aria-pressed', String(cfg.enchants[e])); saveCfg(); });
    });
    document.querySelectorAll('#rad-mats button[data-mat]').forEach((b) => {
      const m = b.dataset.mat; b.setAttribute('aria-pressed', String(cfg.materials[m] !== false));
      b.addEventListener('click', () => { cfg.materials[m] = !(cfg.materials[m] !== false); b.setAttribute('aria-pressed', String(cfg.materials[m])); saveCfg(); });
    });
    // plegar/desplegar toda la config
    const toggle = document.getElementById('rad-cfg-toggle');
    const box = document.getElementById('radar-cfg');
    function applyOpen() {
      box.classList.toggle('collapsed', !cfg.cfgOpen);
      toggle.setAttribute('aria-expanded', String(cfg.cfgOpen));
      toggle.textContent = cfg.cfgOpen ? 'Configuración ▾' : 'Configuración ▸';
    }
    if (toggle && box) { applyOpen(); toggle.addEventListener('click', () => { cfg.cfgOpen = !cfg.cfgOpen; applyOpen(); saveCfg(); }); }
  }
  wireUI();
  connect();
})();
