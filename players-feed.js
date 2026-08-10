// Players feed: connects to OpenRadar's WebSocket and renders real nearby
// players. Mirrors OpenRadar's frontend contract (event codes + parameter
// indices) so it stays compatible with their updates.
//
// Event codes:  29 NewCharacter · 1 Leave · 6 Health · 91 RegenHealth ·
//               90 EquipmentChanged · 211 Mounted · 363 FlaggingFinished · 3 Move
// Spawn (29) params: 0 id · 1 name · 8 guild · 51 alliance · 53 faction ·
//                    40 equipment[10] · 43 spells[14]
// Faction: 0 pasivo · 1-6 facción · 255 hostil

(function () {
  const WS_URL = 'ws://localhost:5001/ws';
  const ITEMS_URL = 'http://localhost:5001/ao-bin-dumps/items.min.json';

  const plist = document.getElementById('plist');
  const countEl = document.getElementById('pl-count');
  const connEl = document.getElementById('pl-conn');
  const players = new Map();
  let itemsDB = null, indexMap = null;
  const nameToP = {};
  let selectedId = null;
  const partyNames = new Set((() => { try { return JSON.parse(localStorage.getItem('albion-overlay-party-v1')) || []; } catch (_) { return []; } })());
  const savePartyShared = () => localStorage.setItem('albion-overlay-party-v1', JSON.stringify([...partyNames]));
  const HIDE_KEY = 'albion-overlay-hidden-v1';
  let hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY)) || []); } catch (_) { return new Set(); } })();
  const saveHidden = () => localStorage.setItem(HIDE_KEY, JSON.stringify([...hidden]));

  // ---- zona / mapa (heredado del radar; jugadores y el capturador de mercado lo necesitan) ----
  const isAlly = (name) => !!(name && (partyNames.has(name) || hidden.has(name)));
  let currentMapId = null, mapBounds = {};
  function zonePvp() { const z = mapBounds[currentMapId]; return z ? z.pvpType : null; }
  function applyMapChange(mapId) {
    if (typeof mapId === 'string' && mapId && mapId !== currentMapId) {
      currentMapId = mapId; window.__ovMapId = mapId; window.__ovZone = zonePvp();
      try { window.overlay.setMarketZone(mapId); } catch (_) {}
    }
  }
  (function loadZones() {
    const apply = (d) => { if (d && typeof d === 'object' && Object.keys(d).length) { mapBounds = d; window.__ovZone = zonePvp(); return true; } return false; };
    const httpFallback = () => fetch('http://localhost:5001/ao-bin-dumps/zones.json').then((r) => (r.ok ? r.json() : null)).then((d) => { apply(d); }).catch(() => {});
    if (window.overlay && window.overlay.zones) { window.overlay.zones().then((d) => { if (!apply(d)) httpFallback(); }).catch(httpFallback); }
    else { httpFallback(); }
  })();

  // ---- alerta de enemigo (parpadeo rojo + beep), heredada del radar ----
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
  function playersPanelOpen() {
    const el = document.getElementById('p-players');
    if (!el || el.classList.contains('collapsed')) return false;   // panel cerrado o minimizado
    return getComputedStyle(el).display !== 'none';                // oculto con el toggle de la barra
  }
  function alertEnemy() {
    if (!playersPanelOpen()) return;   // solo avisa si el widget de Jugadores está abierto y desplegado
    const now = Date.now(); if (now - lastAlert < 2500) return; lastAlert = now; flashAlert(); beep();
  }
  const unlockAudio = () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {} };
  ['pointerdown', 'keydown', 'change'].forEach((e) => window.addEventListener(e, unlockAudio, { passive: true }));

  const PLH_KEY = 'albion-overlay-plist-h';
  (() => { const h = +localStorage.getItem(PLH_KEY); if (h > 0) plist.style.height = h + 'px'; })();
  try { new ResizeObserver(() => { if (plist.clientHeight) localStorage.setItem(PLH_KEY, plist.clientHeight); }).observe(plist); } catch (_) {}

  fetch(ITEMS_URL).then((r) => (r.ok ? r.json() : null)).then((d) => { itemsDB = d; if (Array.isArray(d)) d.forEach((e) => { if (e && e.n) nameToP[e.n] = e.p; }); schedulePriceFetch(); render(); }).catch(() => {});
  try { window.overlay.itemsByIndex().then((a) => { indexMap = a || null; schedulePriceFetch(); render(); }); } catch (_) {}

  function itemInfo(id) {
    if (!id || id <= 0 || !indexMap) return null;
    const u = indexMap[id]; if (!u) return null;
    const tm = u.match(/^T(\d)/), em = u.match(/@(\d)/);
    const ip = nameToP[u] || nameToP[u.replace(/@\d+$/, '')] || null;
    return { name: u, tier: tm ? +tm[1] : null, ench: em ? +em[1] : 0, ip };
  }
  // Slots que aportan IP al personaje: arma, mano izq., casco, armadura, botas y CAPA.
  // La montura (6), la bolsa (7) y la comida (8) también traen `p` en el dump, pero no cuentan
  // para el poder en combate: colar la montura hundía el IP de cualquiera que fuese en un
  // caballo barato con equipo T8 — justo al que más te interesa no subestimar.
  const IP_SLOTS = [0, 1, 2, 3, 4, 5];
  function avgIP(eq) {
    if (!eq) return null;
    let s = 0, n = 0;
    IP_SLOTS.forEach((i) => { const it = itemInfo(eq[i]); if (it && it.ip) { s += it.ip; n++; } });
    return n ? Math.round(s / n) : null;
  }
  const SLOT_ICON = ['🗡️', '🛡️', '🪖', '🧥', '👢', '🧣', '🐎', '🎒', '🍖'];
  function gearHtml(eq) {
    if (!eq) return '';
    let h = '<div class="gear">';
    [0, 2, 3, 4, 5, 8].forEach((i) => {
      const it = itemInfo(eq[i]);
      const tag = it && it.tier ? `<span class="t">${it.tier}${it.ench ? '.' + it.ench : ''}</span>` : '';
      const dim = (!eq[i] || eq[i] <= 0) ? ' style="opacity:.35"' : '';
      h += `<div class="slot"${dim}>${SLOT_ICON[i] || '·'}${tag}</div>`;
    });
    return h + '</div>';
  }
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  let esMap = {};
  try { window.overlay.itemsIndex(window.__lang).then((arr) => { (arr || []).forEach((x) => { esMap[x.id] = x.n; }); }); } catch (_) {}
  const RANKS = window.__lang === 'es'
    ? /\s+de(l| la)\s+(principiante|novato|aprendiz|iniciado|oficial|adepto|experto|gran maestro|maestro|anciano|veterano)$/i
    : /^(beginner|novice|journeyman|adept|expert|master|grandmaster|elder)'s\s+/i;
  const cleanTier = (s) => (s || '').replace(RANKS, '');

  const WEAP = [
    [/HOLYSTAFF|DIVINESTAFF|FALLENSTAFF|REDEMPTIONSTAFF|HALLOWFALL/, 'Holy staff', 'heal', '✚'],
    [/NATURESTAFF|WILDSTAFF|DRUIDIC|BLIGHTSTAFF|RAMPANTSTAFF/, 'Nature staff', 'heal', '🌿'],
    [/ARCANESTAFF|ENIGMATICSTAFF|WITCHWORK|OCCULTSTAFF|MALEVOLENT/, 'Arcane staff', 'sup', '✨'],
    [/FROSTSTAFF|GLACIALSTAFF|HOARFROST|ICICLESTAFF|PERMAFROST/, 'Frost staff', 'sup', '❄'],
    [/FIRESTAFF|INFERNOSTAFF|WILDFIRESTAFF|BLAZINGSTAFF|DAWNSONG/, 'Fire staff', 'dps', '🔥'],
    [/CURSEDSTAFF|DEMONICSTAFF|LIFECURSESTAFF|CURSEDSKULL|DAMNATION/, 'Cursed staff', 'dps', '💀'],
    [/CROSSBOW|WEEPINGREPEATER|BOLTCASTERS|SIEGEBOW/, 'Crossbow', 'dps', '🎯'],
    [/_BOW|WARBOW|LONGBOW|WHISPERINGBOW/, 'Bow', 'dps', '🏹'],
    [/DAGGER|CLAWPAIR|BLOODLETTER|BLACKHANDS|DEATHGIVERS|BRIDLEDFURY/, 'Dagger', 'dps', '🔪'],
    [/_SPEAR|_PIKE|GLAIVE|HERESYSPEAR|TRINITYSPEAR|DAYBREAKER/, 'Spear', 'dps', '🔱'],
    [/BATTLEAXE|HALBERD|CARRIONCALLERS|REALMBREAKER|BEARPAWS|INFERNALSCYTHE|_AXE/, 'Axe', 'dps', '🪓'],
    [/CLAYMORE|DUALSWORD|CLEAVER|GALATINE|KINGMAKER|CARVINGSWORD|SWORD/, 'Sword', 'dps', '⚔'],
    [/QUARTERSTAFF|IRONCLADSTAFF|DOUBLEBLADEDSTAFF|BLACKMONKSTONE|SOULSCYTHE|GRAILSEEKER/, 'Heavy staff', 'tank', '🥍'],
    [/POLEHAMMER|TOMBHAMMER|FORGEHAMMERS|GROVEKEEPER|HAMMER/, 'Hammer', 'tank', '🛠'],
    [/HEAVYMACE|MACEPAIR|INCUBUSMACE|CAMLANN|_MACE/, 'Mace', 'tank', '🔨'],
  ];
  const ROLE = { heal: ['Healer', '#2ecc71'], sup: ['Support', '#3498db'], tank: ['Tank', '#f1c40f'], dps: ['DPS', '#ed4245'] };
  // misma escala de color que los encantamientos del Buscador, para leer el tier sin pensar
  const TIER_COLOR = { 0: '#9aa0a6', 1: '#9aa0a6', 2: '#9aa0a6', 3: '#c9d1d9', 4: '#8fd4e8', 5: '#46d160', 6: '#4aa3ff', 7: '#b96bff', 8: '#ffcc33' };
  function weaponOf(eq) {
    const it = eq && itemInfo(eq[0]); if (!it || !it.name) return null;
    let role = 'dps', emoji = '⚔', cat = 'Weapon';
    for (const [re, c, r, em] of WEAP) if (re.test(it.name)) { cat = c; role = r; emoji = em; break; }
    const es = cleanTier(esMap[it.name] || esMap[it.name.replace(/@\d+$/, '')] || cat);
    return { es, role, emoji, tier: it.tier, ench: it.ench };
  }
  // distancia a mi personaje (posición que publica el radar) en unidades de mundo (~metros)
  function threatOf(p) {
    const z = window.__ovZone;
    if (!z) return 'desc';
    return z === 'safe' ? 'pasivo' : 'hostil';
  }

  const trimD = (v) => v.toFixed(1).replace('.', ',').replace(',0', '');
  const fmtK = (n) => { const a = Math.abs(n || 0); if (a >= 1e9) return trimD(n / 1e9) + 'B'; if (a >= 1e6) return trimD(n / 1e6) + 'M'; if (a >= 1e3) return Math.round(n / 1e3) + 'K'; return String(Math.round(n || 0)); };
  const PRICE_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling'];
  const VALUE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
  const priceMap = {};
  let priceT = null;
  function neededNames() {
    const s = new Set();
    players.forEach((p) => { if (p.equip) VALUE_SLOTS.forEach((i) => { const it = itemInfo(p.equip[i]); if (it && it.name && !(it.name in priceMap)) s.add(it.name); }); });
    return [...s];
  }
  async function fetchPrices() {
    priceT = null;
    const names = neededNames(); if (!names.length) return;
    names.forEach((n) => { priceMap[n] = 0; });
    try {
      const rows = await window.overlay.scanPrices(names, PRICE_CITIES, 0);
      (rows || []).forEach((r) => { const s = r.sell_price_min || 0; if (s > 0 && (!priceMap[r.item_id] || s < priceMap[r.item_id])) priceMap[r.item_id] = s; });
      render();
    } catch (_) {}
  }
  function schedulePriceFetch() { if (!priceT) priceT = setTimeout(fetchPrices, 1500); }
  function gearValue(p) {
    if (!p.equip) return 0;
    let sum = 0;
    VALUE_SLOTS.forEach((i) => { const it = itemInfo(p.equip[i]); if (it && it.name && priceMap[it.name] > 0) sum += priceMap[it.name]; });
    return sum;
  }

  function render() {
    const all = [...players.values()].filter((p) => !partyNames.has(p.name) && !hidden.has(p.name)); // sin party ni ocultados
    const guildCount = {};
    all.forEach((p) => { if (p.guild) guildCount[p.guild] = (guildCount[p.guild] || 0) + 1; });
    // El arma manda también en el orden: el tier más alto arriba, que es lo que decide si
    // peleas o te vas. Se calcula una vez por jugador, no dentro del comparador.
    const wOf = new Map();
    all.forEach((p) => wOf.set(p, weaponOf(p.equip)));
    const wt = (p) => { const w = wOf.get(p); return w && w.tier ? w.tier : 0; };
    const we = (p) => { const w = wOf.get(p); return w ? (w.ench || 0) : 0; };
    const arr = all.sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      return (wt(b) - wt(a)) || (we(b) - we(a))
        || ((avgIP(b.equip) || 0) - (avgIP(a.equip) || 0)) || (gearValue(b) - gearValue(a));
    });
    countEl.textContent = String(arr.length);
    const partyN = partyNames.size;
    const chips = [...hidden].map((n) => `<span class="hchip">${esc(n)}<button data-unhide="${esc(n)}" title="Stop hiding">✕</button></span>`).join('');
    const hideBar = (hidden.size || partyN)
      ? `<div class="hidden-bar">${partyN ? `<span class="hparty" title="Party members detected automatically">👥 party ×${partyN}</span>` : ''}${chips}${hidden.size ? `<button id="unhideAll">show all</button>` : ''}</div>`
      : '';
    if (!arr.length) {
      plist.innerHTML = hideBar + '<div class="pl-empty">No players in range.<br>Move around the world to spot them.</div>';
      return;
    }
    const inDanger = !!(window.__ovZone && window.__ovZone !== 'safe');
    const hostiles = arr.filter((p) => threatOf(p) === 'hostil').length;
    const squads = Object.entries(guildCount).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    const bits = [];
    if (hostiles) bits.push(`<b class="s-host">${hostiles} hostile${hostiles > 1 ? 's' : ''}</b>`);
    if (squads.length) bits.push(`${inDanger ? '⚠ ' : ''}squad <b>${esc(squads[0][0])}</b> ×${squads[0][1]}`);
    const danger = inDanger && (squads.length > 0 || hostiles >= 3);
    const summary = bits.length ? `<div class="pl-summary${danger ? ' danger' : ''}">${bits.join(' · ')}</div>` : '';
    plist.innerHTML = hideBar + summary + arr.map((p) => {
      const ip = avgIP(p.equip);
      const age = Math.round((Date.now() - p.last) / 1000);
      const th = threatOf(p);
      const gv = gearValue(p);
      const w = wOf.get(p);
      // El tier del arma manda: es lo que dice de un vistazo con qué te vas a encontrar.
      const tierTag = w && w.tier
        ? `<span class="wtierbig" style="color:${TIER_COLOR[w.tier] || TIER_COLOR[0]};border-color:${TIER_COLOR[w.tier] || TIER_COLOR[0]}" title="Weapon tier and enchantment">${w.tier}<i>.${w.ench || 0}</i></span>`
        : '<span class="wtierbig wt-unk" title="Weapon not identified">?</span>';
      const wTag = w
        ? `<span class="wtype">${esc(w.es)}</span><span class="wrole" style="color:${ROLE[w.role][1]}">${ROLE[w.role][0]}</span>`
        : '<span class="wtype wt-unk">weapon ?</span>';
      const flag = p.faction === 255 ? '<span class="pflag" title="PvP flagged (hostile faction)">⚔</span>' : '';
      const squad = (p.guild && guildCount[p.guild] >= 2) ? ` <span class="psquad" title="${guildCount[p.guild]} from this guild in range">×${guildCount[p.guild]}</span>` : '';
      return `<div class="pcard th-${th}${p.id === selectedId ? ' selected' : ''}" data-id="${p.id}">
        <div class="prow">${tierTag}${wTag}
          ${flag}<span class="mount${p.mounted ? ' on' : ''}" title="${p.mounted ? 'Mounted' : 'On foot'}">🐎</span>
          <button class="phide" data-hide="${esc(p.name || '')}" title="Hide (mark as ally)">✕</button></div>
        <div class="prow2"><span class="pguild">${p.guild ? esc(p.guild) + squad : ''}</span>
          <span class="pname">${esc(p.name || '???')}</span></div>
        <div class="pmeta"><span class="ip">${ip ? 'IP ~' + ip : ''}</span>${gv > 0 ? `<span class="gval" title="Estimated market value of the gear">≈${fmtK(gv)}</span>` : ''}<span>${age}s</span></div>
      </div>`;
    }).join('');
  }

  // ---- WebSocket ----
  let ws = null, reconnectT = null;
  function setConn(s) {
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
  // PartyJoined trae la lista de nombres como array de strings: lo localizamos
  // sin depender del índice exacto (robusto ante cambios de versión).
  function findStringList(params) {
    for (const k in params) { const v = params[k]; if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v; }
    return null;
  }
  function firstString(params, skip) {
    for (const k in params) { if (skip && skip.includes(k)) continue; if (typeof params[k] === 'string' && params[k]) return params[k]; }
    return null;
  }
  function handleMessage(msg) {
    if (msg.type === 'batch' && Array.isArray(msg.messages)) msg.messages.forEach(handleOne);
    else handleOne(msg);
  }
  function handleOne(m) {
    const dict = typeof m.dictionary === 'string' ? safeParse(m.dictionary) : m.dictionary;
    const p = dict && dict.parameters; if (!p) return;
    const op = p['253'], code = p['252'], id = p['0'];
    // cambio de mapa/zona (por operación): lo necesitan la clasificación de zona y el capturador de mercado
    if ((op === 2 || op === 3) && typeof p['8'] === 'string') applyMapChange(p['8']);
    else if (op === 41 && typeof p['0'] === 'string') applyMapChange(p['0']);
    let touched = true;
    switch (code) {
      case 29: {
        const isNew = !players.has(id);
        players.set(id, { id, name: p['1'], guild: p['8'] || '', alliance: p['51'] || '',
          faction: p['53'] ?? 0, hp: 1, hpMax: 1, equip: p['40'] || null, spells: p['43'] || null,
          mounted: false, posX: null, posY: null, last: Date.now() });
        schedulePriceFetch();
        if (isNew && !isAlly(p['1']) && window.__ovZone !== 'safe') alertEnemy();  // avisa de enemigos fuera de zona segura
        break;
      }
      case 1: {
        if (typeof p['4'] === 'string' && Array.isArray(p['5']) && p['5'].every((x) => typeof x === 'string')) {
          partyNames.clear(); partyNames.add(p['4']); p['5'].forEach((n) => partyNames.add(n)); savePartyShared();   // lista de party recurrente
        } else { const q = players.get(id); if (q) q.left = Date.now(); }   // salió de rango: se borra tras un delay
        break;
      }
      case 6: { const q = players.get(id); if (q) { q.hp = p['3'] ?? q.hp; q.last = Date.now(); } break; }
      case 91: { const q = players.get(id); if (q) { q.hp = p['2'] ?? q.hp; q.hpMax = p['3'] ?? q.hpMax; q.last = Date.now(); } break; }
      case 90: { const q = players.get(id); if (q) { q.equip = p['2'] || q.equip; q.last = Date.now(); schedulePriceFetch(); } break; }
      case 211: { const q = players.get(id); if (q) { q.mounted = p['11'] === true || p['10'] === -1; q.last = Date.now(); } break; }
      case 363: { const q = players.get(id); if (q) { q.faction = p['1'] ?? q.faction; q.last = Date.now(); } break; }
      case 3: { const q = players.get(id); if (q) { if (p['4'] != null) { q.posX = p['4']; q.posY = p['5']; } q.last = Date.now(); } break; }
      // ---- party (para ocultar a los tuyos) ----
      case 231: { const names = findStringList(p); if (names) { partyNames.clear(); names.forEach((n) => partyNames.add(n)); savePartyShared(); } break; } // PartyJoined (lista completa)
      case 233: { const nm = (typeof p['2'] === 'string' ? p['2'] : firstString(p, ['252'])); if (nm) { partyNames.add(nm); savePartyShared(); } break; } // PartyPlayerJoined
      case 232: { partyNames.clear(); savePartyShared(); break; } // PartyDisbanded
      default: touched = false;
    }
    if (touched) scheduleRender();
  }

  let rt = null;
  function scheduleRender() { if (rt) return; rt = setTimeout(() => { rt = null; render(); }, 100); }

  // quitar jugadores 12s tras salir de rango (delay para verlos), o 5 min sin updates
  setInterval(() => {
    const now = Date.now(); let ch = false;
    players.forEach((p, id) => { if ((p.left && now - p.left > 12000) || now - p.last > 300000) { players.delete(id); ch = true; } });
    if (ch) render();
  }, 4000);

  // refresco periódico: distancia (cambia al MOVERTE tú) y antigüedad no llegan por evento.
  // Al cambiar de zona, limpiar (si no, quedan jugadores viejos con distancias enormes).
  let lastMapId;
  setInterval(() => {
    if (window.__ovMapId !== lastMapId) { lastMapId = window.__ovMapId; players.clear(); selectedId = null; }
    render();
  }, 2000);

  setInterval(() => { for (const k in priceMap) delete priceMap[k]; schedulePriceFetch(); }, 300000);

  // añadir aliado por nombre (se oculta para siempre, sin esperar a verlo)
  const allyInput = document.getElementById('ally-input');
  const allyBtn = document.getElementById('ally-btn');
  function addAlly() { const n = (allyInput.value || '').trim(); if (n) { hidden.add(n); saveHidden(); allyInput.value = ''; render(); } }
  if (allyBtn) allyBtn.addEventListener('click', addAlly);
  if (allyInput) allyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlly(); });

  // clic en una tarjeta = seleccionar (sube arriba y se resalta); otro clic la quita
  plist.addEventListener('click', (e) => {
    if (e.target.closest('#unhideAll')) { hidden.clear(); saveHidden(); render(); return; }
    const uh = e.target.closest('[data-unhide]');
    if (uh) { e.stopPropagation(); hidden.delete(uh.dataset.unhide); saveHidden(); render(); return; }
    const hb = e.target.closest('.phide');
    if (hb) { e.stopPropagation(); if (hb.dataset.hide) { hidden.add(hb.dataset.hide); saveHidden(); render(); } return; }
    const card = e.target.closest('.pcard'); if (!card) return;
    const id = Number(card.dataset.id);
    selectedId = (selectedId === id) ? null : id;
    render();
  });

  render();
  connect();
})();
