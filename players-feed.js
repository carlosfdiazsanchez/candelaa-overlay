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
  // Las brumas NO están en zones.json: su id es "@MISTS@..." (y "@MISTSDUNGEON@..." el santuario),
  // así que la zona salía sin clasificar y el aviso de enemigo se quedaba mudo justo donde más
  // falta. Dentro de las brumas el PvP es libre, así que cuentan como zona negra.
  function zonePvp() {
    const id = currentMapId;
    if (typeof id !== 'string' || !id) return null;
    if (id.startsWith('@MISTS@') || id.startsWith('@MISTSDUNGEON@')) return 'black';
    // los ids compuestos de instancia ("1234-5") comparten el tipo de su zona base
    const z = mapBounds[id] || mapBounds[id.split('-')[0]];
    return z ? z.pvpType : null;
  }
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
  // Dos notas de campana en quinta DESCENDENTE (Sol5 -> Re5). El aviso anterior era onda
  // cuadrada subiendo de tono y cortada en seco: exactamente el patrón de una alarma, y el
  // corte abrupto añadía un chasquido que sobresalta. Una sinusoide que sube en 30 ms y se
  // apaga en medio segundo se oye igual de bien sin darte un susto.
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      [[784, 0], [587.33, 0.15]].forEach(([hz, dt]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = hz;
        const s = t + dt;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.075, s + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.55);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(s); o.stop(s + 0.6);
      });
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

  const nameToCat = {};
  fetch(ITEMS_URL).then((r) => (r.ok ? r.json() : null)).then((d) => { itemsDB = d; if (Array.isArray(d)) d.forEach((e) => { if (e && e.n) { nameToP[e.n] = e.p; nameToCat[e.n] = e.cat; } }); schedulePriceFetch(); render(); }).catch(() => {});
  try { window.overlay.itemsByIndex().then((a) => { indexMap = a || null; schedulePriceFetch(); render(); }); } catch (_) {}

  function itemInfo(id) {
    if (!id || id <= 0 || !indexMap) return null;
    const u = indexMap[id]; if (!u) return null;
    const tm = u.match(/^T(\d)/), em = u.match(/@(\d)/);
    const base = u.replace(/@\d+$/, '');
    const ip = nameToP[u] || nameToP[base] || null;
    return { name: u, tier: tm ? +tm[1] : null, ench: em ? +em[1] : 0, ip, cat: nameToCat[u] || nameToCat[base] || '' };
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
  // Rangos SACADOS DEL DUMP, no de memoria: los que de verdad aparecen son principiante,
  // novato, obrero, iniciado, experto, maestro, gran maestro y anciano. Faltaba "obrero"
  // (journeyman), así que los T3 se mostraban como "Guantes de peleador del obrero"; y
  // sobraban aprendiz/oficial/adepto/veterano, que no existen en los datos.
  // "gran maestro" va antes que "maestro" o quedaría un "gran " suelto.
  const RANKS = window.__lang === 'es'
    ? /\s+de(l| la)\s+(principiante|novato|obrero|iniciado|experto|gran maestro|maestro|anciano)$/i
    : /^(beginner|novice|journeyman|adept|expert|master|grandmaster|elder)'s\s+/i;
  const cleanTier = (s) => (s || '').replace(RANKS, '');

  // Se clasifica por el TOKEN REAL del uniqueName, no por el nombre comercial del arma.
  // La tabla anterior buscaba cosas como BEARPAWS, DEATHGIVERS o KINGMAKER, que el juego
  // nunca manda: sus items son DUALAXE_KEEPER, DUALSICKLE_UNDEAD y CLAYMORE_AVALON. Por eso
  // 258 de las 800 armas del índice caían en "Weapon" con rol DPS inventado. Los nombres
  // comerciales se conservan por si alguna vez llegaran, pero lo que clasifica es el token.
  // Auditado contra items-byindex + items-es/en: 0 armas sin clasificar.
  const WEAP = [
    [/HOLYSTAFF|DIVINESTAFF|FALLENSTAFF|REDEMPTIONSTAFF|HALLOWFALL/, 'Holy staff', 'heal'],
    [/NATURESTAFF|WILDSTAFF|DRUIDIC|BLIGHTSTAFF|RAMPANTSTAFF|IRONROOT/, 'Nature staff', 'heal'],
    [/ARCANESTAFF|ENIGMATICSTAFF|ENIGMATICORB|ARCANE_RINGPAIR|WITCHWORK|OCCULTSTAFF|MALEVOLENT/, 'Arcane staff', 'sup'],
    [/FROSTSTAFF|GLACIALSTAFF|ICECRYSTAL|ICEGAUNTLETS|HOARFROST|ICICLESTAFF|PERMAFROST/, 'Frost staff', 'sup'],
    [/FIRESTAFF|INFERNOSTAFF|WILDFIRESTAFF|BLAZINGSTAFF|FIRE_RINGPAIR|DAWNSONG/, 'Fire staff', 'dps'],
    [/CURSEDSTAFF|DEMONICSTAFF|LIFECURSESTAFF|SKULLORB|CURSEDSKULL|DAMNATION/, 'Cursed staff', 'dps'],
    [/SHAPESHIFTER/, 'Shapeshifter staff', 'dps'],
    [/CROSSBOW|WEEPINGREPEATER|BOLTCASTERS|SIEGEBOW/, 'Crossbow', 'dps'],
    [/_BOW|WARBOW|LONGBOW|WHISPERINGBOW/, 'Bow', 'dps'],
    [/DAGGER|CLAWPAIR|DUALSICKLE|RAPIER|BLOODLETTER|BLACKHANDS|DEATHGIVERS|BRIDLEDFURY/, 'Dagger', 'dps'],
    [/_SPEAR|_PIKE|GLAIVE|HARPOON|TRIDENT|HERESYSPEAR|TRINITYSPEAR|DAYBREAKER/, 'Spear', 'dps'],
    // QUARTERSTAFF antes que AXE: TWINSCYTHE (Soulscythe) es bastón, _SCYTHE_ (Guadaña
    // infernal, Falce de cristal) es hacha, y "TWINSCYTHE_HELL" contiene "SCYTHE".
    [/QUARTERSTAFF|IRONCLADEDSTAFF|DOUBLEBLADEDSTAFF|COMBATSTAFF|ROCKSTAFF|TWINSCYTHE|BLACKMONKSTONE|SOULSCYTHE|GRAILSEEKER/, 'Heavy staff', 'tank'],
    [/BATTLEAXE|HALBERD|DUALAXE|_SCYTHE_|CARRIONCALLERS|REALMBREAKER|BEARPAWS|INFERNALSCYTHE|_AXE/, 'Axe', 'dps'],
    [/CLAYMORE|DUALSWORD|DUALSCIMITAR|SCIMITAR|CLEAVER|GALATINE|KINGMAKER|CARVINGSWORD|SWORD/, 'Sword', 'dps'],
    [/KNUCKLES|IRONGAUNTLETS/, 'War gloves', 'dps'],
    [/POLEHAMMER|TOMBHAMMER|FORGEHAMMERS|_RAM_|GROVEKEEPER|HAMMER/, 'Hammer', 'tank'],
    [/HEAVYMACE|MACEPAIR|DUALMACE|ROCKMACE|FLAIL|INCUBUSMACE|CAMLANN|_MACE/, 'Mace', 'tank'],
  ];
  const ROLE = { heal: ['Healer', '#2ecc71'], sup: ['Support', '#3498db'], tank: ['Tank', '#f1c40f'], dps: ['DPS', '#ed4245'], gather: ['Gathering', '#9aa0a6'] };
  // Color por TIER EFECTIVO (tier + encantamiento), que llega hasta 12 con un T8.4.
  // Verificado en el dump: cada encantamiento vale exactamente lo mismo que un tier
  // (T4=700 IP, T4.2=900 IP = T6=900 IP), así que sumarlos no es una aproximación.
  const TIER_COLOR = { 0: '#9aa0a6', 1: '#9aa0a6', 2: '#9aa0a6', 3: '#c9d1d9', 4: '#8fd4e8', 5: '#46d160',
    6: '#4aa3ff', 7: '#b96bff', 8: '#ffcc33', 9: '#ffa03c', 10: '#ffa03c', 11: '#ff6b5c', 12: '#ff6b5c' };
  function weaponOf(eq) {
    const it = eq && itemInfo(eq[0]); if (!it || !it.name) return null;
    let role = 'dps', cat = 'Weapon';
    // el pico, la hoz o el martillo de cantero salían como "Hacha · DPS" o "Martillo · Tanque":
    // el dump ya los marca como recolección, y quien recolecta no es la misma amenaza
    if (it.cat === 'gathering') { role = 'gather'; cat = 'Gathering tool'; }
    else for (const [re, c, r] of WEAP) if (re.test(it.name)) { cat = c; role = r; break; }
    const es = cleanTier(esMap[it.name] || esMap[it.name.replace(/@\d+$/, '')] || cat);
    return { es, role, tier: it.tier, ench: it.ench };
  }
  // ¿ESTE jugador me puede atacar? Antes solo se miraba la zona: fuera de una segura TODOS
  // salían hostiles, así que el aviso no distinguía a un recolector de alguien que va a por ti.
  // Regla del motor de datos (isPlayerThreat), que es la mecánica real del juego:
  //   segura -> nadie · negra -> todos · amarilla/roja -> solo los marcados en PvP (facción 255)
  // Los de facción (1-6) dependen de cuál sea la TUYA, y esa no viaja por la red: se elige a
  // mano igual que la IP. Los de tu propia facción no te pueden tocar; los de una rival sí,
  // así que cuentan como hostiles. Sin facción elegida se asume lo peor y salen todos.
  const MYFAC_KEY = 'albion-overlay-myfaction-v1';
  let myFac = +localStorage.getItem(MYFAC_KEY) || 0;
  const myFacSel = document.getElementById('myfac-input');
  if (myFacSel) {
    myFacSel.value = String(myFac);
    myFacSel.addEventListener('change', () => {
      myFac = +myFacSel.value || 0;
      localStorage.setItem(MYFAC_KEY, String(myFac));
      render();
    });
  }
  const THREAT = { peligro: ['Hostile', 'h'] };
  function threatOf(p) {
    const z = window.__ovZone;
    if (z === 'safe') return 'pasivo';
    // Zona que no sabemos clasificar (mazmorras, instancias sueltas): se asume lo PEOR. Antes
    // devolvía "desconocido", que no era ni hostil ni pasivo, y con eso la alerta no sonaba:
    // un beep de más no cuesta nada, uno de menos te cuesta el equipo.
    if (!z) return 'peligro';
    if (z === 'black') return 'peligro';
    if (p.faction === 255) return 'peligro';
    if (p.faction >= 1 && p.faction <= 6) return (myFac && p.faction === myFac) ? 'pasivo' : 'peligro';
    return 'pasivo';
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

  // ---- balance de fuerzas: los tuyos contra los que tienes al lado ----
  // Tu propio personaje NO viaja por la red (nadie emite tu NewCharacter), así que tu IP se
  // escribe a mano una vez y se guarda. Sin ella el recuento sale sesgado en tu contra: falta
  // justo el jugador que más te importa.
  const MYIP_KEY = 'albion-overlay-myip-v1';
  let myIp = +localStorage.getItem(MYIP_KEY) || 0;
  const balEl = document.getElementById('pl-bal');
  const balMain = document.getElementById('pl-bal-main');
  const balSub = document.getElementById('pl-bal-sub');
  const myIpInput = document.getElementById('myip-input');
  if (myIpInput) {
    if (myIp) myIpInput.value = String(myIp);
    myIpInput.addEventListener('input', () => {
      myIp = Math.max(0, Math.min(2000, +myIpInput.value || 0));
      localStorage.setItem(MYIP_KEY, String(myIp));
      render();
    });
  }
  const fmtIP = (n) => Math.round(n).toLocaleString();
  function drawBalance(foes) {
    if (!balEl) return;
    // sin el índice de items cargado toda IP sería 0 y el veredicto sería mentira
    if (!indexMap || !foes.length || window.__ovZone === 'safe') { balEl.style.display = 'none'; return; }
    balEl.style.display = '';
    balEl.title = 'Your party and hidden allies against everyone else in range';
    const ipOf = (p) => avgIP(p.equip) || 0;
    const mates = [...players.values()].filter((p) => isAlly(p.name));
    const mine = mates.reduce((s, p) => s + ipOf(p), 0) + myIp;
    const theirs = foes.reduce((s, p) => s + ipOf(p), 0);
    const diff = mine - theirs;
    const even = Math.abs(diff) < Math.max(150, theirs * 0.05);
    balMain.className = 'pl-bal-main ' + (even ? 'even' : diff > 0 ? 'win' : 'lose');
    balMain.textContent = even ? '⚖ Even fight'
      : (diff > 0 ? '▲ Ahead by ' : '▼ Behind by ') + fmtIP(Math.abs(diff)) + ' IP';
    const side = myIp ? mates.length + 1 : mates.length;
    // con iconos en vez de "los tuyos"/"cercanos": la línea se arma sobre la marcha y las
    // palabras sueltas se traducirían a trozos
    balSub.textContent = `👥 ${side} · ${fmtIP(mine)} IP   vs   ⚔ ${foes.length} · ${fmtIP(theirs)} IP`
      + (myIp ? '' : '   (not counting you)');
  }

  function render() {
    const inRange = [...players.values()].filter((p) => !partyNames.has(p.name) && !hidden.has(p.name)); // sin party ni ocultados
    const all = inRange.filter((p) => threatOf(p) === 'peligro');
    const passiveN = inRange.length - all.length;
    const guildCount = {};
    all.forEach((p) => { if (p.guild) guildCount[p.guild] = (guildCount[p.guild] || 0) + 1; });
    // El arma manda también en el orden: el tier más alto arriba, que es lo que decide si
    // peleas o te vas. Se calcula una vez por jugador, no dentro del comparador.
    const wOf = new Map();
    all.forEach((p) => wOf.set(p, weaponOf(p.equip)));
    // se ordena por el MISMO número que se ve en la tarjeta (tier + encantamiento), o la lista
    // contradiría al badge: un 8 (T4.4) tiene que ir por encima de un 7 (T7 pelado)
    const wt = (p) => { const w = wOf.get(p); return w && w.tier ? w.tier + (w.ench || 0) : 0; };
    const wb = (p) => { const w = wOf.get(p); return w && w.tier ? w.tier : 0; };
    const arr = all.sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      return (wt(b) - wt(a)) || (wb(b) - wb(a))
        || ((avgIP(b.equip) || 0) - (avgIP(a.equip) || 0)) || (gearValue(b) - gearValue(a));
    });
    countEl.textContent = String(arr.length);
    drawBalance(arr);
    const partyN = partyNames.size;
    const chips = [...hidden].map((n) => `<span class="hchip">${esc(n)}<button data-unhide="${esc(n)}" title="Stop hiding">✕</button></span>`).join('');
    const hideBar = (hidden.size || partyN)
      ? `<div class="hidden-bar">${partyN ? `<span class="hparty" title="Party members detected automatically">👥 party ×${partyN}</span>` : ''}${chips}${hidden.size ? `<button id="unhideAll">show all</button>` : ''}</div>`
      : '';
    if (!arr.length) {
      const empty = passiveN
        ? `Nobody can attack you here.<br>Non-hostile players hidden: ${passiveN}`
        : 'No players in range.<br>Move around the world to spot them.';
      plist.innerHTML = hideBar + `<div class="pl-empty">${empty}</div>`;
      return;
    }
    const inDanger = !!(window.__ovZone && window.__ovZone !== 'safe');
    const hostiles = arr.filter((p) => threatOf(p) === 'peligro').length;
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
      // Se muestra SUMADO (T4.2 -> 6) porque un encantamiento vale igual que un tier: un
      // número suelto se compara de un golpe, "4.2 contra 5.1" hay que pararse a pensarlo.
      // El desglose real queda en el tooltip.
      const eff = w && w.tier ? w.tier + (w.ench || 0) : 0;
      const tierTag = eff
        ? `<span class="wtierbig" style="color:${TIER_COLOR[eff] || TIER_COLOR[0]};border-color:${TIER_COLOR[eff] || TIER_COLOR[0]}" title="T${w.tier}${w.ench ? '.' + w.ench : ''}">${eff}</span>`
        : '<span class="wtierbig wt-unk" title="Weapon not identified">?</span>';
      const wTag = w
        ? `<span class="wtype">${esc(w.es)}</span><span class="wrole" style="color:${ROLE[w.role][1]}">${ROLE[w.role][0]}</span>`
        : '<span class="wtype wt-unk">weapon ?</span>';
      const flag = p.faction === 255 ? '<span class="pflag" title="PvP flagged (hostile faction)">⚔</span>' : '';
      const risk = THREAT[th] ? `<span class="chip ${THREAT[th][1]}">${THREAT[th][0]}</span>` : '';
      const squad = (p.guild && guildCount[p.guild] >= 2) ? ` <span class="psquad" title="${guildCount[p.guild]} from this guild in range">×${guildCount[p.guild]}</span>` : '';
      return `<div class="pcard th-${th}${p.id === selectedId ? ' selected' : ''}" data-id="${p.id}">
        <div class="prow">${tierTag}${wTag}${risk}
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
        // solo avisa de quien REALMENTE puede atacarte: en amarilla/roja un recolector sin
        // marcar disparaba el beep igual que alguien que venía a matarte
        if (isNew && !isAlly(p['1']) && threatOf(players.get(id)) === 'peligro') alertEnemy();
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
      // alguien se marca en PvP a tu lado: antes esto no avisaba de nada, solo repintaba
      case 363: { const q = players.get(id); if (q) { const was = q.faction; q.faction = p['1'] ?? q.faction; q.last = Date.now(); if (was !== 255 && q.faction === 255 && !isAlly(q.name) && threatOf(q) === 'peligro') alertEnemy(); } break; }
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
