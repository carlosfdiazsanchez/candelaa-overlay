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
  // El grupo NO se deduce ya de listas de nombres (PartyJoined y compañía): cualquier evento con
  // un array de textos colaba —las pestañas del chat entraban tal cual—, los nombres se sumaban
  // uno a uno sin que nada los quitara y encima quedaban guardados para siempre. Verificado en el
  // tráfico real: el evento 182 emite la posición de CADA compañero de grupo con su nombre
  // (param 0 = [x,y], param 2 = nombre) y de nadie más, así que la pertenencia se lee de ahí.
  // Con caducidad: al salir del grupo dejan de llegar y el nombre se cae solo.
  const PARTY_KEY = 'albion-overlay-party-v3';
  const PARTY_TTL = 900000;
  ['albion-overlay-party-v1', 'albion-overlay-party-v2'].forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_]{2,15}$/;
  const looksLikeName = (n) => typeof n === 'string' && NAME_RE.test(n);
  const partyNames = new Map((() => {
    try { const v = JSON.parse(localStorage.getItem(PARTY_KEY)); return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && Date.now() - e[1] < PARTY_TTL) : []; } catch (_) { return []; }
  })());
  const savePartyShared = () => { try { localStorage.setItem(PARTY_KEY, JSON.stringify([...partyNames])); } catch (_) {} };
  function dropStaleMates() {
    const cut = Date.now() - PARTY_TTL;
    let ch = false;
    partyNames.forEach((ts, n) => { if (ts < cut) { partyNames.delete(n); ch = true; } });
    if (ch) savePartyShared();
    return ch;
  }
  const HIDE_KEY = 'albion-overlay-hidden-v1';
  let hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY)) || []); } catch (_) { return new Set(); } })();
  const saveHidden = () => localStorage.setItem(HIDE_KEY, JSON.stringify([...hidden]));

  // ---- tu gremio y tu alianza ----
  // Ni tu gremio ni tu alianza viajan en ningún spawn (tu personaje nunca emite NewCharacter),
  // pero SÍ vienen en la respuesta de JoinMap (op 2): param 58 = gremio, param 79 = alianza.
  // Índices verificados contra JoinResponse.cs de AlbionOnline-StatisticsAnalysis.
  // Se guardan porque el JoinMap solo llega al cambiar de zona: si el overlay se abre a mitad
  // de sesión, sin persistir no habría gremio hasta que el usuario se moviera de mapa.
  const MYGUILD_KEY = 'albion-overlay-myguild-v1';
  let myGuild = '', myAlliance = '';
  try { const v = JSON.parse(localStorage.getItem(MYGUILD_KEY)) || {}; myGuild = v.g || ''; myAlliance = v.a || ''; } catch (_) {}
  const saveMine = () => { try { localStorage.setItem(MYGUILD_KEY, JSON.stringify({ g: myGuild, a: myAlliance })); } catch (_) {} };
  // Los de tu gremio o tu alianza no te pueden atacar, así que salían como hostiles y disparaban
  // la alerta por nada: cuentan como los tuyos igual que el grupo y los ocultados a mano.
  const isMine = (p) => !!p && !!((myGuild && p.guild === myGuild) || (myAlliance && p.alliance === myAlliance));

  // ---- por qué NO hay distancia ni dirección de los jugadores ----
  // El juego NO difunde la posición de los demás en claro: el evento Move (3) la manda en un
  // buffer ofuscado (param 1) del que solo se lee la velocidad, y los params 4 y 5 —que sí
  // valen para los mobs— traen basura para jugadores (capturado en vivo el 2026-08-21:
  // -9.3e+24, 1.4e+15...). Ni ZQRadar ni el propio motor de datos lo resuelven: OpenRadar crea
  // cada jugador con posición (0,0) y nunca la actualiza. No se intenta romper el cifrado, así
  // que el panel no promete metros que no puede saber. Guardar esos params "por si acaso" es lo
  // que hacía el código antes; no se hace, porque cualquiera que los lea creerá que son metros.
  // ---- zona / mapa (heredado del radar; jugadores y el capturador de mercado lo necesitan) ----
  const isAlly = (name) => !!(name && (partyNames.has(name) || hidden.has(name)));
  const isFriend = (p) => !!p && (isAlly(p.name) || isMine(p));
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
      // La limpieza va AQUÍ, no en el temporizador de refresco: los spawns de la zona nueva
      // llegan inmediatamente detrás del cambio, así que borrar hasta dos segundos después se
      // llevaba por delante a los que ya habían aparecido — y el juego no los vuelve a anunciar
      // (NewCharacter solo llega al ENTRAR en tu burbuja), así que el panel se quedaba vacío
      // hasta que pasara alguien nuevo. Justo al entrar en una zona es cuando más importa.
      players.clear(); selectedId = null;
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
  // Un mismo jugador entrando y saliendo del borde de tu burbuja disparaba el aviso cada vez:
  // su objectId cambia en cada entrada, así que "es nuevo" era siempre cierto. Con el guid
  // (que no cambia) se le da un descanso; de otro enemigo distinto sí vuelve a sonar al momento.
  const alerted = new Map();
  const ALERT_TTL = 45000;
  function alertEnemy(who) {
    if (!playersPanelOpen()) return;   // solo avisa si el widget de Jugadores está abierto y desplegado
    const now = Date.now();
    const key = who && (who.guid || who.name);
    if (key) {
      if (now - (alerted.get(key) || 0) < ALERT_TTL) return;
      alerted.set(key, now);
      if (alerted.size > 200) alerted.forEach((t, k) => { if (now - t > ALERT_TTL) alerted.delete(k); });
    }
    if (now - lastAlert < 2500) return; lastAlert = now; flashAlert(); beep();
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
    balEl.title = 'Your party, guild and hidden allies against everyone else in range';
    const ipOf = (p) => avgIP(p.equip) || 0;
    const mates = [...players.values()].filter(isFriend);
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
    const inRange = [...players.values()].filter((p) => !isFriend(p)); // sin grupo, gremio/alianza ni ocultados
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
    // El gremio se detecta solo: el chip está para poder comprobarlo de un vistazo (y borrarlo
    // si el personaje cambia de gremio antes del siguiente cambio de zona).
    const myTag = myGuild || myAlliance;
    const mineN = [...players.values()].filter(isMine).length;
    const guildChip = myTag
      ? `<span class="hchip hguild" title="Your guild/alliance, hidden as allies: ${esc([myGuild, myAlliance].filter(Boolean).join(' / '))}">🛡 ${esc(myTag)}${mineN ? ' ×' + mineN : ''}<button data-clearguild="1" title="Forget the detected guild">✕</button></span>`
      : '';
    const hideBar = (hidden.size || partyN || myTag)
      ? `<div class="hidden-bar">${guildChip}${partyN ? `<span class="hchip hparty" title="Party detected automatically: ${esc([...partyNames.keys()].join(', '))}">👥 party ×${partyN}<button data-clearparty="1" title="Forget the detected party">✕</button></span>` : ''}${chips}${hidden.size ? `<button id="unhideAll">show all</button>` : ''}</div>`
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
    // Tres recolectores no son lo mismo que dos DPS y un sanador: el número suelto no decía
    // a qué te enfrentas, y el rol ya está calculado para pintar cada tarjeta.
    const roleN = {};
    arr.forEach((p) => { const w = wOf.get(p); if (w) roleN[w.role] = (roleN[w.role] || 0) + 1; });
    const comp = ['tank', 'heal', 'dps', 'sup', 'gather'].filter((r) => roleN[r])
      .map((r) => `<span style="color:${ROLE[r][1]}">${roleN[r]} ${ROLE[r][0]}</span>`).join(' ');
    if (comp && hostiles > 1) bits.push(comp);
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
      return `<div class="pcard th-${th}${p.id === selectedId ? ' selected' : ''}${p.left ? ' leaving' : ''}" data-id="${p.id}">
        <div class="prow">${tierTag}${wTag}${risk}
          ${flag}<span class="mount${p.mounted ? ' on' : ''}" title="${p.mounted ? 'Mounted' : 'On foot'}">🐎</span>
          <button class="phide" data-hide="${esc(p.name || '')}" title="Hide (mark as ally)">✕</button></div>
        <div class="prow2"><span class="pguild">${p.guild ? esc(p.guild) + squad : ''}</span>
          <span class="pname">${esc(p.name || '???')}</span></div>
        ${hpHtml(p)}${actHtml(p)}
        <div class="pmeta"><span class="ip">${ip ? 'IP ~' + ip : ''}</span>${gv > 0 ? `<span class="gval" title="Estimated market value of the gear">≈${fmtK(gv)}</span>` : ''}<span>${age}s</span></div>
      </div>`;
    }).join('');
  }

  // La vida solo se pinta cuando SABEMOS el máximo (llega con la regeneración, evento 91):
  // al aparecer, un jugador trae 1/1 y dibujar eso sería inventarse que está a tope.
  function hpHtml(p) {
    if (!(p.hpMax > 1) || !(p.hp >= 0) || p.hp >= p.hpMax * 0.995) return '';
    const pct = Math.max(0, Math.min(100, Math.round((p.hp / p.hpMax) * 100)));
    const col = pct < 35 ? '#ff6b5c' : pct < 70 ? '#ffcf6b' : '#5fc88a';
    return `<div class="hp" title="Health ${pct}%"><i style="width:${pct}%;background:${col}"></i></div>`;
  }
  function actHtml(p) {
    const bits = [];
    if ((p.fightUntil || 0) > Date.now()) {
      const foe = p.hitBy || p.hitting;
      bits.push(`<span class="pact-chip fight" title="Taking or dealing damage right now">⚔ in combat${foe ? ' vs ' + esc(foe) : ''}</span>`);
    }
    // Bajarse de la montura al lado de alguien es el gesto que precede a un ataque: quien va
    // de paso sigue montado. Es la señal más temprana que hay, y llega gratis en el evento 211.
    if (Date.now() - (p.dismount || 0) < DISMOUNT_TTL) bits.push('<span class="pact-chip cast" title="Just got off the mount: usually the move right before attacking">⚠ dismounted</span>');
    if (p.left) bits.push('<span class="pact-chip">out of range</span>');
    return bits.length ? `<div class="pact">${bits.join('')}</div>` : '';
  }
  const DISMOUNT_TTL = 8000;

  // ---- señal de pelea (lo demás vive en el panel de Combate) ----
  // Aquí solo interesa lo que cambia una decisión de huir o entrar: si el que tienes delante
  // está peleando y contra quién. El desglose de daño, saqueos y habilidades es otro panel.
  const COMBAT_TTL = 7000;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const known = (id) => (isNum(id) ? players.get(id) : null);

  function touchCombat(q, foe, incoming) {
    if (!q) return;
    q.fightUntil = Date.now() + COMBAT_TTL;
    if (incoming) q.hitBy = foe || q.hitBy; else q.hitting = foe || q.hitting;
  }
  // El evento de vida ya se leía, pero solo el param 3 (vida resultante). El 2 es el cambio y
  // el 6 quién lo causa: con eso se sabe quién pega a quién sin adivinar ningún código nuevo.
  function applyDamage(p) {
    const delta = isNum(p['2']) ? p['2'] : 0;
    if (delta >= 0) return;                       // curación o regeneración: no es una pelea
    const victim = known(p['0']), attacker = known(p['6']);
    touchCombat(victim, attacker ? attacker.name : null, true);
    touchCombat(attacker, victim ? victim.name : null, false);
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
  function handleMessage(msg) {
    if (msg.type === 'batch' && Array.isArray(msg.messages)) msg.messages.forEach(handleOne);
    else handleOne(msg);
  }
  function handleOne(m) {
    const dict = typeof m.dictionary === 'string' ? safeParse(m.dictionary) : m.dictionary;
    const p = dict && dict.parameters; if (!p) return;
    const op = p['253'], code = p['252'], id = p['0'];
    // cambio de mapa/zona (por operación): lo necesitan la clasificación de zona y el capturador de mercado
    // tu gremio/alianza llegan SOLO aquí (ver MYGUILD_KEY): se lee antes del cambio de mapa
    if (m.code === 'response' && op === 2) {
      const g = typeof p['58'] === 'string' ? p['58'] : null;
      const a = typeof p['79'] === 'string' ? p['79'] : null;
      if ((g !== null && g !== myGuild) || (a !== null && a !== myAlliance)) {
        if (g !== null) myGuild = g;
        if (a !== null) myAlliance = a;
        saveMine();
        scheduleRender();
      }
    }
    if ((op === 2 || op === 3) && typeof p['8'] === 'string') applyMapChange(p['8']);
    else if (op === 41 && typeof p['0'] === 'string') applyMapChange(p['0']);
    let touched = true;
    switch (code) {
      case 29: {
        const isNew = !players.has(id);
        // el guid (param 7) es el id ESTABLE del personaje: el objectId cambia cada vez que
        // entra y sale de tu burbuja, el guid no. Sirve para no repetir el aviso del mismo tipo.
        players.set(id, { id, guid: p['7'] || null, name: p['1'], guild: p['8'] || '', alliance: p['51'] || '',
          faction: p['53'] ?? 0, hp: 1, hpMax: 1, equip: p['40'] || null, spells: p['43'] || null,
          mounted: false, last: Date.now() });
        schedulePriceFetch();
        // solo avisa de quien REALMENTE puede atacarte: en amarilla/roja un recolector sin
        // marcar disparaba el beep igual que alguien que venía a matarte
        if (isNew && !isFriend(players.get(id)) && threatOf(players.get(id)) === 'peligro') alertEnemy(players.get(id));
        break;
      }
      case 1: {
        const q = players.get(id); if (q) q.left = Date.now();   // salió de rango: se borra tras un delay
        break;
      }
      case 6: { const q = players.get(id); if (q) { q.hp = p['3'] ?? q.hp; if (q.hp > q.hpMax) q.hpMax = q.hp; q.last = Date.now(); } applyDamage(p); break; }
      // La regeneración trae su ritmo (param 4) SOLO cuando el jugador está fuera de combate:
      // en combate la vida no regenera, así que el propio evento dice si está peleando. Es la
      // misma regla que usa albion-online-stats y no depende de ningún código que cambie de parche.
      case 91: {
        const q = players.get(id);
        if (q) { q.hp = p['2'] ?? q.hp; q.hpMax = p['3'] ?? q.hpMax; q.last = Date.now();
          if (p['4'] != null) { q.fightUntil = 0; q.hitBy = q.hitting = null; } else q.fightUntil = Math.max(q.fightUntil || 0, Date.now() + COMBAT_TTL); }
        break;
      }
      case 90: { const q = players.get(id); if (q) { q.equip = p['2'] || q.equip; q.last = Date.now(); schedulePriceFetch(); } break; }
      case 211: {
        const q = players.get(id);
        if (q) {
          const was = q.mounted;
          q.mounted = p['11'] === true || p['10'] === -1;
          q.last = Date.now();
          // Marca visual y nada más: sin distancia no se puede distinguir a quien se baja
          // encima de ti de quien lo hace en el borde de la burbuja, y un beep por cada
          // recolector que desmonta para picar sería insufrible.
          if (was && !q.mounted) q.dismount = Date.now();
        }
        break;
      }
      // alguien se marca en PvP a tu lado: antes esto no avisaba de nada, solo repintaba
      case 363: { const q = players.get(id); if (q) { const was = q.faction; q.faction = p['1'] ?? q.faction; q.last = Date.now(); if (was !== 255 && q.faction === 255 && !isFriend(q) && threatOf(q) === 'peligro') alertEnemy(q); } break; }
      case 3: { const q = players.get(id); if (q) q.last = Date.now(); break; }   // solo dice que sigue ahí: la posición va ofuscada
      // ---- party (para ocultar a los tuyos): posición de un compañero, con su nombre ----
      case 182: {
        const nm = p['2'];
        if (!looksLikeName(nm)) { touched = false; break; }
        touched = !partyNames.has(nm);   // repintar solo cuando entra alguien nuevo, no en cada paso que dan
        partyNames.set(nm, Date.now());
        if (touched) savePartyShared();
        break;
      }
      default: touched = false;
    }
    if (touched) scheduleRender();
  }

  let rt = null;
  function scheduleRender() { if (rt) return; rt = setTimeout(() => { rt = null; render(); }, 100); }

  // quitar jugadores 12s tras salir de rango (delay para verlos), o 5 min sin updates
  setInterval(() => {
    const now = Date.now(); let ch = dropStaleMates();
    players.forEach((p, id) => { if ((p.left && now - p.left > 12000) || now - p.last > 300000) { players.delete(id); ch = true; } });
    if (ch) render();
  }, 4000);

  // refresco periódico: distancia (cambia al MOVERTE tú) y antigüedad no llegan por evento
  setInterval(render, 2000);

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
    if (e.target.closest('[data-clearparty]')) { e.stopPropagation(); partyNames.clear(); savePartyShared(); render(); return; }
    if (e.target.closest('[data-clearguild]')) { e.stopPropagation(); myGuild = myAlliance = ''; saveMine(); render(); return; }
    const uh = e.target.closest('[data-unhide]');
    if (uh) { e.stopPropagation(); hidden.delete(uh.dataset.unhide); saveHidden(); render(); return; }
    const hb = e.target.closest('.phide');
    if (hb) { e.stopPropagation(); if (hb.dataset.hide) { hidden.add(hb.dataset.hide); saveHidden(); render(); } return; }
    const card = e.target.closest('.pcard'); if (!card) return;
    const id = Number(card.dataset.id);
    selectedId = (selectedId === id) ? null : id;
    render();
  });

  window.__players = { players, isAlly, isMine, isFriend, partyNames, render,
    me: () => ({ guild: myGuild, alliance: myAlliance }),
    state: () => ({ map: currentMapId, zone: window.__ovZone }) };
  // El panel de Combate necesita los mismos nombres de item; se comparten en vez de cargar
  // otras 11k entradas en memoria para lo mismo.
  window.__items = {
    info: itemInfo,
    label: (id) => { const it = itemInfo(id); if (!it || !it.name) return null; return cleanTier(esMap[it.name] || esMap[it.name.replace(/@\d+$/, '')] || it.name); },
  };

  render();
  connect();
})();
