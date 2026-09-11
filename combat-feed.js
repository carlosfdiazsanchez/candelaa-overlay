// Panel de Combate: medidor de daño/curación y botín por persona. Tercera conexión al WS del
// motor de datos, igual que hace el Buscador: cada panel lee lo suyo y no se enredan entre ellos.
// Las pestañas de Sucesos y Habilidades se quitaron (v0.2.88) porque el usuario no las usaba, y
// con ellas todo lo que solo las alimentaba: el registro, la recolección y el rastreo de
// hechizos (CastStart, el array de habilidades del spawn y el diccionario de spells). El
// generador tools/build-spells.py y el IPC spells-index siguen ahí, ya sin consumidor.
//
// Códigos: los BAJOS (<150) llevan años sin moverse y se usan directamente —
//   6 HealthUpdate (0 víctima · 2 cambio de vida · 6 causante · 7 habilidad)
//   29 NewCharacter · 91 RegenerationHealthChanged · op 2 Join (tú)
// Los ALTOS cambian con cada parche (este overlay usa 211 para Mounted mientras las listas
// públicas dicen 209), así que muertes, saqueos y recolección NO se buscan por número: se
// prueban los candidatos y solo se acepta el que además encaja con la forma del payload.
(function () {
  const WS_URL = 'ws://localhost:5001/ws';
  const body = document.getElementById('cb-body');
  const countEl = document.getElementById('cb-count');
  const connEl = document.getElementById('cb-conn');
  const timeEl = document.getElementById('cb-time');
  const totalEl = document.getElementById('cb-total');
  if (!body) return;

  const TAB_KEY = 'albion-overlay-combat-tab-v1';
  const AUTO_KEY = 'albion-overlay-combat-auto-v2';
  const LEARN_KEY = 'albion-overlay-evcodes-v1';
  const AUTO_GAP = 60000;      // sin daño durante un minuto = la pelea anterior se ha acabado
  // las pestañas de Sucesos y Habilidades ya no existen: una preferencia guardada de entonces
  // dejaría el panel en blanco
  let tab = localStorage.getItem(TAB_KEY) === 'loot' ? 'loot' : 'dmg';
  let auto = localStorage.getItem(AUTO_KEY) === '1';

  const chars = new Map();     // objectId -> { name, guild }
  // Las métricas NO se pueden clavar en el objectId a secas: el servidor los REUTILIZA en cada
  // zona, así que al cruzar un portal el daño de un desconocido se sumaba al de quien tenía ese
  // id en la zona anterior — y encima heredaba su nombre. La clave lleva delante el número de
  // zona; luego el render agrupa por nombre, que es lo único estable.
  const stats = new Map();     // "zona:objectId" -> métricas
  let mapSeq = 0;
  // Muertes y bajas llegan por NOMBRE (el evento las trae así), y quien murió puede no haber
  // pegado a nadie: antes se buscaba su objectId en la lista de la zona y, si no estaba, la
  // muerte se perdía. Se guardan por nombre y se cruzan al pintar.
  const nameKD = new Map();    // nombre -> { kills, deaths }
  let me = { id: null, name: null };
  let sessionStart = 0, lastDamage = 0;
  const seenCodes = {};
  const learned = (() => { try { return JSON.parse(localStorage.getItem(LEARN_KEY)) || {}; } catch (_) { return {}; } })();
  const saveLearned = () => { try { localStorage.setItem(LEARN_KEY, JSON.stringify(learned)); } catch (_) {} };

  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_]{2,15}$/;
  const looksLikeName = (n) => typeof n === 'string' && NAME_RE.test(n);
  const trimD = (v) => v.toFixed(1).replace('.', ',').replace(',0', '');
  const fmtK = (n) => { const a = Math.abs(n || 0); if (a >= 1e6) return trimD(n / 1e6) + 'M'; if (a >= 1e3) return trimD(n / 1e3) + 'K'; return String(Math.round(n || 0)); };
  const nameOf = (id) => { const c = chars.get(id); return c ? c.name : (id === me.id ? me.name : null); };

  // El nombre se copia en la métrica en cuanto se conoce: los objectId se reciclan al cambiar
  // de zona y el registro de ids se vacía, pero la pelea que acabas de dar debe seguir legible.
  function statOf(id) {
    const key = mapSeq + ':' + id;
    let s = stats.get(key);
    if (!s) { s = { id, name: null, dmg: 0, heal: 0, taken: 0, hits: 0, first: Date.now(), last: 0 }; stats.set(key, s); }
    if (!s.name) s.name = nameOf(id);
    return s;
  }
  const kdOf = (name) => { let k = nameKD.get(name); if (!k) { k = { kills: 0, deaths: 0 }; nameKD.set(name, k); } return k; };
  function resetSession() { stats.clear(); nameKD.clear(); sessionStart = 0; lastDamage = 0; scheduleRender(); }

  // ---- daño / curación ----
  function applyHealth(p) {
    const victim = p['0'], delta = isNum(p['2']) ? p['2'] : 0, causer = p['6'];
    if (!isNum(victim) || !delta) return false;
    const now = Date.now();
    // el corte de sesión se decide ANTES de anotar, si no el primer golpe de la pelea nueva
    // se contaría en la vieja y acto seguido se borraría con ella
    if (auto && lastDamage && now - lastDamage > AUTO_GAP) resetSession();
    if (!sessionStart) sessionStart = now;
    lastDamage = now;
    if (delta < 0) {
      const v = Math.round(-delta);
      if (isNum(causer)) { const s = statOf(causer); s.dmg += v; s.hits++; s.last = now; }
      const vs = statOf(victim); vs.taken += v; vs.last = now;
    } else if (isNum(causer)) {
      statOf(causer).heal += Math.round(delta);
    }
    return true;
  }

  function learnName(id, name, guild) {
    if (!isNum(id) || !looksLikeName(name)) return;
    const c = chars.get(id);
    if (c) { c.name = c.name || name; return; }
    chars.set(id, { name, guild: typeof guild === 'string' ? guild : '' });
    stats.forEach((s) => { if (s.id === id && !s.name) s.name = name; });
  }

  // ---- botín y fama: NO se borran solos ----
  // El medidor de daño corta la sesión cuando pasa un minuto sin golpes; el botín no puede
  // funcionar así. Lo que se quiere saber al volver de gankear es quién levantó qué en toda la
  // salida, para cotejarlo con lo que aparece en el cofre, así que esto sobrevive a las peleas,
  // a los cambios de zona y a cerrar el overlay: solo lo borra el botón de esta pestaña.
  const LOOT_KEY = 'albion-overlay-loot-v2';
  const FAME_KEY = 'albion-overlay-fame-v1';
  const LPRICE_KEY = 'albion-overlay-lootprices-v1';
  const PRICE_TTL = 86400000;
  const loot = new Map();      // saqueador -> { items: {uniquename|#id: unidades}, first, last, kills:{víctima:n} }
  let fame = { total: 0, active: 0, last: 0, n: 0, code: null };
  const prices = (() => { try { return JSON.parse(localStorage.getItem(LPRICE_KEY)) || {}; } catch (_) { return {}; } })();

  const loadLoot = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(LOOT_KEY)) || [];
      raw.forEach((e) => { if (e && e.name) loot.set(e.name, { items: e.items || {}, first: e.first || 0, last: e.last || 0, kills: e.kills || {} }); });
    } catch (_) {}
  };
  const saveLoot = () => {
    try { localStorage.setItem(LOOT_KEY, JSON.stringify([...loot].map(([name, v]) => ({ name, ...v })))); } catch (_) {}
  };
  const saveFame = () => { try { localStorage.setItem(FAME_KEY, JSON.stringify(fame)); } catch (_) {} };
  try { const f = JSON.parse(localStorage.getItem(FAME_KEY)); if (f && typeof f.total === 'number') fame = Object.assign(fame, f); } catch (_) {}
  loadLoot();

  const lootOf = (name) => { let l = loot.get(name); if (!l) { l = { items: {}, first: Date.now(), last: 0, kills: {} }; loot.set(name, l); } return l; };
  function addLoot(who, itemId, qty, victim) {
    const it = (() => { try { return window.__items && window.__items.info(itemId); } catch (_) { return null; } })();
    const key = (it && it.name) ? it.name : '#' + itemId;
    const l = lootOf(who);
    l.items[key] = (l.items[key] || 0) + (qty || 1);
    l.last = Date.now();
    if (victim) l.kills[victim] = (l.kills[victim] || 0) + (qty || 1);
    saveLoot();
    schedulePriceFetch();
  }
  // La fama viaja en diezmilésimas, igual que la plata del saqueo (documentado en CLAUDE.md tras
  // verlo en tráfico real: 630000000 en el paquete son 63K de plata).
  // El ritmo se mide sobre el tiempo ACTIVO, no sobre el reloj: si se persiste entre sesiones,
  // dividir por las horas transcurridas desde el primer punto daría una tasa de risa. Un hueco
  // de más de cinco minutos no cuenta como tiempo jugado.
  const FAME_GAP = 300000;
  function addFame(v, code) {
    const now = Date.now();
    if (fame.last && now - fame.last < FAME_GAP) fame.active += now - fame.last;
    fame.last = now; fame.total += v; fame.n++; fame.code = code;
    saveFame();
    scheduleRender();
  }
  const famePerHour = () => {
    const h = Math.max(fame.active, 60000) / 3600000;
    return fame.total > 0 ? fame.total / h : 0;
  };
  function resetLoot() { loot.clear(); fame = { total: 0, active: 0, last: 0, n: 0, code: fame.code }; saveLoot(); saveFame(); render(); }

  // ---- precios del botín ----
  // Mismo camino que usa Jugadores para tasar el equipo: el mínimo de venta en las ciudades.
  // Sin calidad (el evento de saqueo no la trae), así que es una estimación y se dice.
  const PRICE_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling'];
  let priceT = null;
  function neededPrices() {
    const now = Date.now(), s = new Set();
    loot.forEach((l) => Object.keys(l.items).forEach((k) => {
      if (k.charAt(0) === '#') return;
      const e = prices[k];
      if (!e || now - e.t > PRICE_TTL) s.add(k);
    }));
    return [...s];
  }
  async function fetchPrices() {
    priceT = null;
    const names = neededPrices(); if (!names.length) return;
    const now = Date.now();
    names.forEach((n) => { prices[n] = { p: (prices[n] || {}).p || 0, t: now }; });
    try {
      const rows = await window.overlay.scanPrices(names, PRICE_CITIES, 0);
      (rows || []).forEach((r) => {
        const v = r.sell_price_min || 0;
        if (v > 0 && (!prices[r.item_id] || !prices[r.item_id].p || v < prices[r.item_id].p)) prices[r.item_id] = { p: v, t: now };
      });
      try { localStorage.setItem(LPRICE_KEY, JSON.stringify(prices)); } catch (_) {}
      scheduleRender();
    } catch (_) {}
  }
  function schedulePriceFetch() { if (!priceT) priceT = setTimeout(fetchPrices, 2000); }
  const priceOf = (key) => ((prices[key] || {}).p || 0);
  const lootValue = (l) => Object.entries(l.items).reduce((a, [k, q]) => a + priceOf(k) * q, 0);
  const lootUnits = (l) => Object.values(l.items).reduce((a, q) => a + q, 0);
  // De los tuyos: el grupo detectado, los aliados que hayas ocultado a mano y tú.
  // Jugadores guarda tu nombre entre sesiones (solo viaja al cambiar de zona), así que se
  // pregunta ahí cuando esta pestaña todavía no lo ha visto: si no, tras reiniciar el overlay
  // tu propia fila se iba a "los demás" y el total del grupo salía corto.
  const myName = () => me.name || (() => { try { return (window.__players.me() || {}).name || null; } catch (_) { return null; } })();
  const isMate = (name) => {
    const mine = myName();
    if (mine && name === mine) return true;
    try { return !!(window.__players && window.__players.isAlly(name)); } catch (_) { return false; }
  };

  const SHAPES = [
    {
      key: 'died', codes: range(160, 175),
      test: (p) => looksLikeName(p['2']) && looksLikeName(p['10']),
      run: (p) => {
        // Verificado en tráfico real: además de los nombres trae los objectId (1 el muerto,
        // 9 el matador). Se aprovechan para ponerle nombre a quien ya estaba en la zona antes
        // de abrir el overlay — de ese nunca llega NewCharacter y su daño salía sin dueño.
        learnName(p['1'], p['2'], p['3']); learnName(p['9'], p['10'], p['11']);
        kdOf(p['2']).deaths++; kdOf(p['10']).kills++;
        return true;
      },
    },
    {
      key: 'loot', codes: range(268, 288),
      // SOLO la variante de objeto: 1 el cuerpo saqueado, 2 el saqueador, 4 el itemId, 5 cuántos.
      // La de "plata" (2 nombre · 3 true · 5 cantidad) está QUITADA a propósito: en tráfico real,
      // estando en una ciudad —donde no hay cadáveres que saquear— saltaba cuatro veces seguidas
      // con el mismo jugador y el mismo importe clavado, así que es otra cosa y llamarlo "saqueó
      // 10K" sería mentir. Vuelve cuando se vea en una zona con muertes de verdad.
      test: (p) => looksLikeName(p['1']) && looksLikeName(p['2']) && isNum(p['4']) && isNum(p['5']),
      run: (p) => { addLoot(p['2'], p['4'], p['5'], p['1']); return true; },
    },
  ];
  // La fama la manda el servidor SOLO de tu personaje (nadie te cuenta la de los demás), y esa
  // es justo la guarda que hace fiable identificar el evento sin saber su número: el param 0
  // tiene que ser TU objectId. El código antiguo era el 73 (messages.json de albion-online-addons,
  // generado de tráfico real) y en esta versión del juego los de su entorno están desplazados
  // (NewCharacter 25 -> 29, Regen 81 -> 91), así que se busca en la franja y se aprende.
  // Las tres condiciones juntas —tu id, entero, múltiplo de 100 y al menos un punto de fama—
  // dejan fuera el ruido; si aun así aprendiera un código equivocado, la cifra se vería absurda
  // y el botón de reiniciar más __combat.forget() lo deshacen.
  SHAPES.push({
    key: 'fame', codes: range(65, 89),
    test: (p) => isNum(p['0']) && me.id != null && p['0'] === me.id
      && isNum(p['2']) && Number.isInteger(p['2']) && p['2'] >= 10000 && p['2'] < 5e9 && p['2'] % 100 === 0,
    run: (p, code) => { addFame(p['2'] / 10000, code); return true; },
  });
  const SHAPE_CODES = new Set(SHAPES.flatMap((s) => s.codes));
  function tryShapes(code, p) {
    if (!SHAPE_CODES.has(code)) return false;
    const only = learned[code];
    for (const s of SHAPES) {
      if (only && s.key !== only) continue;              // este código ya está identificado
      if (!s.codes.includes(code) || !s.test(p)) continue;
      if (!s.run(p, code)) return false;
      if (!only) { learned[code] = s.key; saveLearned(); }
      return true;
    }
    return false;
    // NO se guarda "este suceso ya vive en el código N" para descartar los demás: si el primer
    // acierto fuese equivocado, el bueno quedaría bloqueado PARA SIEMPRE (pasó en pruebas: se
    // aprendió 166 y luego el 165 real ya no entraba). Que varios códigos encajen es inofensivo
    // — todos tienen que pasar igualmente el filtro de forma —; perder el evento no lo es.
  }

  // ---- render ----
  let rt = null;
  function scheduleRender() { if (rt) return; rt = setTimeout(() => { rt = null; render(); }, 250); }
  const secs = () => (sessionStart ? Math.max(1, Math.round((Date.now() - sessionStart) / 1000)) : 0);

  // Se agrupa por NOMBRE, no por objectId: el mismo jugador vuelve con otro id al cambiar de
  // zona y salía dos veces en la tabla, con su daño partido entre las dos filas.
  const blank = (name) => ({ name, dmg: 0, heal: 0, taken: 0, hits: 0, kills: 0, deaths: 0,
    ids: [], first: 0, last: 0 });
  const groupOf = (map, name) => { let g = map.get(name); if (!g) { g = blank(name); map.set(name, g); } return g; };
  function rows() {
    const byName = new Map();
    // Todo lo que pega sin nombre —bichos, guardias, torres— se junta en UNA fila. Antes se
    // descartaba, y en una pelea contra mobs el panel se veía vacío aunque lo contara todo:
    // ni ellos tienen nombre ni lo tienes tú hasta que cambias de zona.
    const rest = blank('👹 creatures');
    let anyRest = false;
    stats.forEach((s) => {
      // En una zona concurrida hay decenas de jugadores lanzando cosas sin tocarse: sin esto
      // la tabla se llenaba de filas a cero que tapaban a los que están peleando de verdad.
      if (!s.dmg && !s.heal && !s.taken) return;
      const name = s.name || nameOf(s.id);
      let g;
      if (name) g = groupOf(byName, name);
      else { g = rest; anyRest = true; }
      g.dmg += s.dmg; g.heal += s.heal; g.taken += s.taken; g.hits += s.hits;
      g.first = g.first ? Math.min(g.first, s.first) : s.first;
      g.last = Math.max(g.last, s.last || 0);
      g.ids.push(s.id);
    });
    // una muerte cuenta aunque el muerto no llegara a pegarle a nadie
    nameKD.forEach((kd, name) => {
      if (!kd.kills && !kd.deaths) return;
      const g = groupOf(byName, name);
      g.kills = kd.kills; g.deaths = kd.deaths;
    });
    const out = [...byName.values()].map((g) => ({ s: g, name: g.name, mine: !!me.name && g.name === me.name }));
    if (anyRest && (rest.dmg || rest.taken)) out.push({ s: rest, name: rest.name, agg: true });
    return out.sort((a, b) => b.s.dmg - a.s.dmg || b.s.heal - a.s.heal);
  }

  function renderDamage() {
    const rs = rows();
    if (!rs.length) return '<div class="cb-empty">No combat recorded yet.<br>Hit something (or take a hit) and it shows up here.</div>';
    const t = secs();
    const top = Math.max(...rs.map((r) => Math.max(r.s.dmg, r.s.heal)), 1);
    const totalDmg = rs.reduce((a, r) => a + r.s.dmg, 0) || 1;
    return rs.map((r) => {
      const s = r.s;
      // DPS sobre el tiempo que ESE jugador ha estado activo, no sobre la sesión entera: con el
      // reloj común, quien entra al final de la pelea sale con un DPS ridículo aunque haya
      // metido todo su daño en diez segundos. Suelo de 4 s: por debajo la media es fantasía.
      const win = Math.max(4, ((s.last || s.first) - s.first) / 1000);
      const dps = s.dmg && t >= 4 ? Math.round(s.dmg / win) + '/s' : '·';
      const share = Math.round((s.dmg / totalDmg) * 100);
      const w = Math.max(2, Math.round((s.dmg / top) * 100));
      const hw = s.heal ? Math.max(2, Math.round((s.heal / top) * 100)) : 0;
      return `<div class="cb-row${r.mine ? ' mine' : ''}">
        <div class="cb-r1"><span class="cb-name">${esc(r.name)}${r.mine ? ' <i>(you)</i>' : ''}</span>
          <span class="cb-dmg">${fmtK(s.dmg)}</span><span class="cb-dps">${dps}</span><span class="cb-share">${share}%</span></div>
        <div class="cb-bar-track"><i style="width:${w}%"></i>${hw ? `<u style="width:${hw}%"></u>` : ''}</div>
        <div class="cb-r2">${s.heal ? `<span class="cb-heal" title="Healing done">✚ ${fmtK(s.heal)}</span>` : ''}
          ${s.taken ? `<span class="cb-taken" title="Damage taken">🛡 ${fmtK(s.taken)}</span>` : ''}
          ${s.hits ? `<span title="Hits landed">${s.hits} hit${s.hits > 1 ? 's' : ''}</span>` : ''}
          ${s.kills ? `<span class="cb-kill" title="Kills">⚔ ${s.kills}</span>` : ''}
          ${s.deaths ? `<span class="cb-death" title="Deaths">💀 ${s.deaths}</span>` : ''}</div>
      </div>`;
    }).join('');
  }

  // Pestaña Botín: quién ha levantado qué de los muertos, cuánto vale y cuánto sale entre todos
  // los tuyos. El total del grupo es la cifra contra la que se compara lo que aparezca luego en
  // el cofre; las filas dicen de quién salió cada parte.
  function renderLoot() {
    const rows = [...loot.entries()].map(([name, l]) => ({ name, l, mate: isMate(name), val: lootValue(l), units: lootUnits(l) }))
      .sort((a, b) => b.val - a.val || b.units - a.units);
    const mates = rows.filter((r) => r.mate);
    const others = rows.filter((r) => !r.mate);
    const teamVal = mates.reduce((a, r) => a + r.val, 0);
    const teamUnits = mates.reduce((a, r) => a + r.units, 0);
    const fph = famePerHour();
    const head = `<div class="cb-loot-head">
      <div class="cb-lh-cell"><i>Fame/h</i><b title="Your own fame only: the server does not send anyone else's [ev ${fame.code || '?'} n=${fame.n}]">${fph ? fmtK(fph) : '—'}</b></div>
      <div class="cb-lh-cell"><i>Team loot</i><b class="v" title="Estimated with the cheapest city sell price, quality ignored">${teamVal ? fmtK(teamVal) : '—'}</b></div>
      <div class="cb-lh-cell"><i>Pieces</i><b>${teamUnits || 0}</b></div>
      <button id="cb-loot-reset" title="Clear looting and fame. Nothing else clears them.">⟲ Clear loot</button>
    </div>`;
    if (!rows.length) {
      return head + '<div class="cb-empty">Nothing looted yet.<br>Whatever anyone takes off a body shows up here, and it stays until you clear it.</div>';
    }
    const block = (list, label) => (list.length ? `<div class="cb-loot-sec">${label}</div>` + list.map((r) => {
      const items = Object.entries(r.l.items).sort((a, b) => priceOf(b[0]) * b[1] - priceOf(a[0]) * a[1]);
      const chips = items.map(([k, q]) => {
        const nm = prettyItem(k);
        const v = priceOf(k) * q;
        return `<span class="cb-loot-item" title="${esc(k)}${v ? ' · ' + fmtK(v) : ' · no price yet'}">${q}× ${esc(nm)}${v ? ` <u>${fmtK(v)}</u>` : ''}</span>`;
      }).join('');
      const from = Object.keys(r.l.kills || {});
      return `<div class="cb-row${r.mate ? ' mine' : ''}">
        <div class="cb-r1"><span class="cb-name">${esc(r.name)}${r.mate ? ' <i>(yours)</i>' : ''}</span>
          <span class="cb-loot-val">${r.val ? fmtK(r.val) : '—'}</span><span class="cb-dps">📦 ${r.units}</span></div>
        <div class="cb-loot-items">${chips}</div>
        ${from.length ? `<div class="cb-r2"><span title="Bodies looted">← ${esc(from.slice(0, 4).join(', '))}${from.length > 4 ? '…' : ''}</span></div>` : ''}
      </div>`;
    }).join('') : '');
    return head + block(mates, 'Your group') + block(others, 'Everyone else');
  }
  // El botín se guarda por uniquename (resuelto al llegar), no por el índice numérico: ese
  // índice cambia con cada parche y lo saqueado ayer apuntaría a otro item. Para pintarlo se
  // pide el nombre a Jugadores, que ya tiene el diccionario cargado, y el tier se escribe.
  const prettyItem = (u) => {
    if (u.charAt(0) === '#') return u;
    const t = u.match(/^T(\d)/), e = u.match(/@(\d)/);
    let nm = u;
    try { nm = (window.__items && window.__items.byName && window.__items.byName(u)) || u; } catch (_) {}
    return nm + (t ? ' T' + t[1] + (e ? '.' + e[1] : '') : '');
  };

  // Con el panel cerrado o minimizado se sigue CONTANDO, pero no se pinta: en una ZvZ el
  // evento de vida llega a cientos por segundo y repintar lo que nadie ve sale caro.
  const panelEl = document.getElementById('p-combat');
  const visible = () => panelEl && panelEl.style.display !== 'none' && !panelEl.classList.contains('collapsed');
  function render() {
    if (!visible()) return;
    body.innerHTML = tab === 'loot' ? renderLoot() : renderDamage();
    const t = secs();
    if (timeEl) timeEl.textContent = t ? (t < 60 ? t + 's' : Math.floor(t / 60) + 'm' + String(t % 60).padStart(2, '0')) : '—';
    const rs = rows();
    if (countEl) countEl.textContent = String(rs.length);
    if (totalEl) {
      const tot = rs.reduce((a, r) => a + r.s.dmg, 0);
      totalEl.textContent = tot ? '⚔ ' + fmtK(tot) : '';
    }
  }
  setInterval(render, 1000);   // el reloj de la sesión y las antigüedades del registro corren solos

  // ---- controles ----
  const tabsEl = document.getElementById('cb-tabs');
  function paintTabs() { if (tabsEl) tabsEl.querySelectorAll('[data-t]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === tab))); }
  if (tabsEl) {
    paintTabs();
    tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      tab = b.dataset.t; localStorage.setItem(TAB_KEY, tab); paintTabs(); render();
    });
  }
  body.addEventListener('click', (e) => {
    if (e.target.closest('#cb-loot-reset')) resetLoot();
  });
  const resetBtn = document.getElementById('cb-reset');
  if (resetBtn) resetBtn.addEventListener('click', resetSession);
  const autoEl = document.getElementById('cb-auto');
  if (autoEl) {
    autoEl.checked = auto;
    autoEl.addEventListener('change', () => { auto = autoEl.checked; localStorage.setItem(AUTO_KEY, auto ? '1' : '0'); });
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
    const op = p['253'], code = p['252'];
    // El cambio de zona se atiende EN EL MOMENTO, no en un temporizador: los spawns de la zona
    // nueva llegan justo detrás, y limpiando dos segundos tarde se borraban los que ya habían
    // entrado (era exactamente lo que pasaba: la tabla se quedaba con un solo nombre).
    if ((op === 2 || op === 3) && typeof p['8'] === 'string') applyMap(p['8']);
    else if (op === 41 && typeof p['0'] === 'string') applyMap(p['0']);
    // TU personaje no emite NewCharacter, así que sin esto tu propia barra no existiría. Sí
    // llega en la respuesta de JoinMap: param 0 tu objectId, param 2 tu nombre.
    if (op === 2 && isNum(p['0']) && looksLikeName(p['2'])) { me = { id: p['0'], name: p['2'] }; scheduleRender(); }
    if (code == null) return;
    seenCodes[code] = (seenCodes[code] || 0) + 1;
    switch (code) {
      case 29:
        if (isNum(p['0']) && looksLikeName(p['1'])) chars.set(p['0'], { name: p['1'], guild: p['8'] || '' });
        break;
      case 6: if (applyHealth(p)) scheduleRender(); break;
      // NewLoot: la bolsa de un muerto trae su id (2) y su nombre (3) — otra vía para ponerle
      // nombre a quien nunca emitió NewCharacter.
      case 98:
        if (isNum(p['2']) && looksLikeName(p['3'])) learnName(p['2'], p['3']);
        break;
      default: tryShapes(code, p);
    }
  }

  // Al cambiar de zona se olvidan los ids (el mismo jugador vuelve con otro objectId), pero NO
  // las métricas: cruzar un portal en mitad de una pelea no debería borrar el recuento.
  let curMap = null;
  function applyMap(id) { if (id && id !== curMap) { curMap = id; chars.clear(); mapSeq++; } }

  // Diagnóstico para cuando un parche mueva los códigos: qué ha pasado por aquí y qué se ha
  // identificado ya. __combat.forget() lo hace aprender otra vez desde cero.
  window.__combat = {
    stats, chars, learned, nameKD, rows, handleMessage, me: () => me,
    codes: () => Object.entries(seenCodes).map(([c, n]) => [+c, n]).sort((a, b) => b[1] - a[1]),
    unknown: () => Object.entries(seenCodes).filter(([c]) => !learned[c]).map(([c, n]) => [+c, n]).sort((a, b) => b[1] - a[1]),
    forget: () => { Object.keys(learned).forEach((k) => delete learned[k]); saveLearned(); },
    loot, fame: () => fame, prices, resetLoot,
  };

  render();
  connect();
})();
