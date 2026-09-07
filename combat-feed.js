// Panel de Combate: medidor de daño/curación, registro de sucesos (muertes, saqueos,
// recolección) y uso de habilidades. Tercera conexión al WS del motor de datos, igual que hace
// el Buscador: cada panel lee lo suyo y no se enredan entre ellos.
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
  const AUTO_KEY = 'albion-overlay-combat-auto-v1';
  const LEARN_KEY = 'albion-overlay-evcodes-v1';
  const AUTO_GAP = 60000;      // sin daño durante un minuto = la pelea anterior se ha acabado
  const LOG_MAX = 60;
  let tab = localStorage.getItem(TAB_KEY) || 'dmg';
  let auto = localStorage.getItem(AUTO_KEY) !== '0';

  const chars = new Map();     // objectId -> { name, guild, spells }
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
  const log = [];
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
  const itemLabel = (id) => { try { return window.__items && window.__items.label(id); } catch (_) { return null; } };
  const RAW_RES = /^T\d_(ORE|WOOD|FIBER|HIDE|ROCK|FISH|SEAWEED)/;
  function isRawResource(id) {
    try { const it = window.__items && window.__items.info(id); return !!(it && it.name && RAW_RES.test(it.name)); }
    catch (_) { return false; }
  }
  // El evento de daño manda el hechizo como ÍNDICE del dump de spells (verificado en vivo:
  // 3222 = FREEZINGWIND mientras el rival tiraba bastón de hielo). El diccionario lo genera
  // tools/build-spells.py y lo sirve el proceso principal.
  let spellsDB = null;
  try { window.overlay.spellsIndex(window.__lang).then((a) => { if (Array.isArray(a)) { spellsDB = a; scheduleRender(); } }); } catch (_) {}
  // El diccionario marca con ~ lo que el juego NO traduce: son efectos internos (banderas de
  // PvP, comida, monturas, pulsos de mob) que también viajan como casteos. Visto en PvP real,
  // sin distinguirlos la pestaña listaba "Flag blue x47" en media zona.
  const spellName = (idx) => {
    if (idx === -1) return { n: 'auto attack', real: true };
    const raw = spellsDB && spellsDB[idx];
    if (!raw) return { n: '#' + idx, real: false };
    return raw.charAt(0) === '~' ? { n: raw.slice(1), real: false } : { n: raw, real: true };
  };
  const nameOf = (id) => { const c = chars.get(id); return c ? c.name : (id === me.id ? me.name : null); };

  // El nombre se copia en la métrica en cuanto se conoce: los objectId se reciclan al cambiar
  // de zona y el registro de ids se vacía, pero la pelea que acabas de dar debe seguir legible.
  function statOf(id) {
    const key = mapSeq + ':' + id;
    let s = stats.get(key);
    if (!s) { s = { id, name: null, dmg: 0, heal: 0, taken: 0, hits: 0, spells: new Map(), first: Date.now(), last: 0 }; stats.set(key, s); }
    if (!s.name) s.name = nameOf(id);
    return s;
  }
  const kdOf = (name) => { let k = nameKD.get(name); if (!k) { k = { kills: 0, deaths: 0 }; nameKD.set(name, k); } return k; };
  function resetSession() { stats.clear(); nameKD.clear(); log.length = 0; sessionStart = 0; lastDamage = 0; scheduleRender(); }

  // ---- daño / curación ----
  function applyHealth(p) {
    const victim = p['0'], delta = isNum(p['2']) ? p['2'] : 0, causer = p['6'], spell = p['7'];
    if (!isNum(victim) || !delta) return false;
    const now = Date.now();
    // el corte de sesión se decide ANTES de anotar, si no el primer golpe de la pelea nueva
    // se contaría en la vieja y acto seguido se borraría con ella
    if (auto && lastDamage && now - lastDamage > AUTO_GAP) resetSession();
    if (!sessionStart) sessionStart = now;
    lastDamage = now;
    if (delta < 0) {
      const v = Math.round(-delta);
      if (isNum(causer)) {
        const s = statOf(causer); s.dmg += v; s.hits++; s.last = now;
        if (isNum(spell)) { const e = spellEntry(s, spell); e.hits++; e.dmg += v; }
      }
      const vs = statOf(victim); vs.taken += v; vs.last = now;
    } else if (isNum(causer)) {
      statOf(causer).heal += Math.round(delta);
    }
    return true;
  }

  function pushLog(kind, html) {
    log.unshift({ kind, html, t: Date.now() });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
    scheduleRender();
  }
  function spellEntry(s, idx) {
    let e = s.spells.get(idx);
    if (!e) { e = { casts: 0, hits: 0, dmg: 0 }; s.spells.set(idx, e); }
    return e;
  }
  function learnName(id, name, guild) {
    if (!isNum(id) || !looksLikeName(name)) return;
    const c = chars.get(id);
    if (c) { c.name = c.name || name; return; }
    chars.set(id, { name, guild: typeof guild === 'string' ? guild : '', spells: null });
    stats.forEach((s) => { if (s.id === id && !s.name) s.name = name; });
  }

  const SHAPES = [
    {
      key: 'died', codes: range(160, 175),
      test: (p) => looksLikeName(p['2']) && looksLikeName(p['10']),
      run: (p) => {
        const g = (s) => (typeof s === 'string' && s ? ` <i>[${esc(s)}]</i>` : '');
        pushLog('died', `💀 <b>${esc(p['2'])}</b>${g(p['3'])} killed by <b>${esc(p['10'])}</b>${g(p['11'])}`);
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
      run: (p) => {
        const nm = itemLabel(p['4']);
        pushLog('loot', `🎒 <b>${esc(p['2'])}</b> looted ${p['5']}× ${esc(nm || '#' + p['4'])} ← <b>${esc(p['1'])}</b>`);
        return true;
      },
    },
    {
      key: 'harvest', codes: range(58, 64),
      // El item TIENE que ser un recurso en bruto. Sin esa condición el código 64 (usar un
      // portal o un edificio) colaba en tráfico real: sus params encajaban de forma y el panel
      // se inventaba "Fulano recogió 7× <lo que hubiera en ese índice de item>".
      test: (p) => isNum(p['0']) && isNum(p['3']) && isNum(p['4']) && isNum(p['5']) && nameOf(p['0']) && isRawResource(p['4']),
      run: (p) => {
        const nm = itemLabel(p['4']); if (!nm) return false;
        const qty = (p['5'] || 0) + (p['6'] || 0) + (p['7'] || 0);
        const who = nameOf(p['0']);
        const prev = log[0];
        // recolectar dispara un evento por golpe: se agrupa con la línea anterior en vez de
        // llenar el registro con veinte líneas iguales
        if (prev && prev.kind === 'harvest' && prev.who === who && prev.item === nm && Date.now() - prev.t < 60000) {
          prev.qty += qty; prev.t = Date.now();
          prev.html = `🌾 <b>${esc(who)}</b> gathered ${prev.qty}× ${esc(nm)}`;
          scheduleRender();
          return true;
        }
        log.unshift({ kind: 'harvest', who, item: nm, qty, t: Date.now(), html: `🌾 <b>${esc(who)}</b> gathered ${qty}× ${esc(nm)}` });
        if (log.length > LOG_MAX) log.length = LOG_MAX;
        scheduleRender();
        return true;
      },
    },
  ];
  const SHAPE_CODES = new Set(SHAPES.flatMap((s) => s.codes));
  function tryShapes(code, p) {
    if (!SHAPE_CODES.has(code)) return false;
    const only = learned[code];
    for (const s of SHAPES) {
      if (only && s.key !== only) continue;              // este código ya está identificado
      if (!s.codes.includes(code) || !s.test(p)) continue;
      if (!s.run(p)) return false;
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
    spells: new Map(), ids: [], first: 0, last: 0 });
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
      s.spells.forEach((e, idx) => {
        const t = g.spells.get(idx) || { casts: 0, hits: 0, dmg: 0 };
        t.casts += e.casts; t.hits += e.hits; t.dmg += e.dmg;
        g.spells.set(idx, t);
      });
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

  function renderLog() {
    if (!log.length) return '<div class="cb-empty">Nothing has happened around you yet.<br>Deaths, loot and gathering show up here.</div>';
    return '<div class="cb-log">' + log.map((e) => {
      const s = Math.round((Date.now() - e.t) / 1000);
      return `<div class="cb-log-row ${e.kind}">${e.html}<span class="cb-age">${s < 60 ? s + 's' : Math.round(s / 60) + 'm'}</span></div>`;
    }).join('') + '</div>';
  }

  // Se cuentan los LANZAMIENTOS (CastStart) y aparte los golpes con daño, así también salen
  // las habilidades que no hacen daño: curaciones, escapes, purgas. Los que trae equipados
  // (array del spawn) sirven para ver lo que NO ha llegado a usar.
  function renderSpells() {
    const rs = rows().filter((r) => !r.agg && (r.s.spells.size || r.s.ids.some((id) => (chars.get(id) || {}).spells)));
    if (!rs.length) return '<div class="cb-empty">No abilities seen yet.</div>';
    return rs.map((r) => {
      // Un efecto interno solo entra si de verdad ha hecho daño (el "Ice sculpture explode"
      // del bastón de hielo pega 2.4k y sí importa); si no, fuera: es ruido de sistema.
      const used = [...r.s.spells.entries()]
        .map(([idx, e]) => ({ idx, e, sp: spellName(idx) }))
        .filter((u) => u.sp.real || u.e.dmg > 0)
        .sort((a, b) => b.e.dmg - a.e.dmg || b.e.casts - a.e.casts);
      const eq = r.s.ids.map((id) => (chars.get(id) || {}).spells).find(Array.isArray) || null;
      const unused = Array.isArray(eq) ? eq.filter((x) => x > 0 && !r.s.spells.has(x) && spellName(x).real) : [];
      return `<div class="cb-sp">
        <div class="cb-name">${esc(r.name)}${r.mine ? ' <i>(you)</i>' : ''}</div>
        <div class="cb-sp-list">${used.length ? used.map(({ idx, e, sp }) => {
          const times = e.casts || e.hits;
          return `<span class="cb-sp-chip${sp.real ? '' : ' int'}" title="#${idx} — ${e.casts} casts, ${e.hits} hits, ${fmtK(e.dmg)} damage">${esc(sp.n)}${times ? ` <b>×${times}</b>` : ''}${e.dmg ? ' ' + fmtK(e.dmg) : ''}</span>`;
        }).join('') : '<span class="cb-sp-none">no ability seen</span>'}</div>
        ${unused.length ? `<div class="cb-sp-list dim" title="Equipped but never used while in range">${unused.map((x) => `<span class="cb-sp-chip off">${esc(spellName(x).n)}</span>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Con el panel cerrado o minimizado se sigue CONTANDO, pero no se pinta: en una ZvZ el
  // evento de vida llega a cientos por segundo y repintar lo que nadie ve sale caro.
  const panelEl = document.getElementById('p-combat');
  const visible = () => panelEl && panelEl.style.display !== 'none' && !panelEl.classList.contains('collapsed');
  function render() {
    if (!visible()) return;
    body.innerHTML = tab === 'log' ? renderLog() : tab === 'spells' ? renderSpells() : renderDamage();
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
        if (isNum(p['0']) && looksLikeName(p['1'])) chars.set(p['0'], { name: p['1'], guild: p['8'] || '', spells: Array.isArray(p['43']) ? p['43'] : null });
        break;
      // Al cambiar de equipo llegan también los hechizos que lleva puestos (param 7, con -1 de
      // relleno). Visto en vivo: es la vía más frecuente para saber qué NO ha llegado a usar.
      case 90: {
        const c = chars.get(p['0']);
        if (c && Array.isArray(p['7'])) c.spells = p['7'];
        break;
      }
      case 6: if (applyHealth(p)) scheduleRender(); break;
      // CastStart: 0 quien lanza · 5 el hechizo · 7 su objetivo. Verificado en tráfico real
      // (5 = 3222 = FREEZINGWIND mientras el jugador tiraba bastón de hielo). Cuenta TODOS los
      // lanzamientos, también los que no hacen daño — curaciones, escapes, buffs —, que es la
      // mitad de lo que quieres saber de un rival.
      case 14:
        if (isNum(p['0']) && isNum(p['5'])) { spellEntry(statOf(p['0']), p['5']).casts++; scheduleRender(); }
        break;
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
    stats, chars, log, learned, nameKD, rows, handleMessage, me: () => me,
    codes: () => Object.entries(seenCodes).map(([c, n]) => [+c, n]).sort((a, b) => b[1] - a[1]),
    unknown: () => Object.entries(seenCodes).filter(([c]) => !learned[c]).map(([c, n]) => [+c, n]).sort((a, b) => b[1] - a[1]),
    forget: () => { Object.keys(learned).forEach((k) => delete learned[k]); saveLearned(); },
  };

  render();
  connect();
})();
