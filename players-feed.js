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
  let itemsDB = null;
  let selectedId = null;
  const partyNames = new Set((() => { try { return JSON.parse(localStorage.getItem('albion-overlay-party-v1')) || []; } catch (_) { return []; } })());
  const savePartyShared = () => localStorage.setItem('albion-overlay-party-v1', JSON.stringify([...partyNames]));
  const HIDE_KEY = 'albion-overlay-hidden-v1';
  let hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY)) || []); } catch (_) { return new Set(); } })();
  const saveHidden = () => localStorage.setItem(HIDE_KEY, JSON.stringify([...hidden]));

  // Best-effort item DB (for tier / item power). If it 404s we just skip tiers.
  fetch(ITEMS_URL).then((r) => (r.ok ? r.json() : null)).then((d) => { itemsDB = d; }).catch(() => {});

  function itemInfo(id) {
    if (!id || id <= 0 || !itemsDB) return null;
    const e = itemsDB[id - 1]; if (!e) return null;
    const u = e.n || e.uniquename || '';
    const tm = u.match(/^T(\d)/), em = u.match(/@(\d)/);
    return { name: u, tier: tm ? +tm[1] : null, ench: em ? +em[1] : 0, ip: e.p || e.itempower || null };
  }
  function avgIP(eq) {
    if (!eq || !itemsDB) return null;
    let s = 0, n = 0;
    [0, 2, 3, 4, 8].forEach((i) => { const it = itemInfo(eq[i]); if (it && it.ip) { s += it.ip; n++; } });
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
  const fClass = (f) => (f === 255 ? 'h' : (f >= 1 && f <= 6 ? 'f' : 'p'));
  const fLabel = (f) => (f === 255 ? 'Hostil' : (f >= 1 && f <= 6 ? 'Facción' : 'Pasivo'));
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  function render() {
    const arr = [...players.values()]
      .filter((p) => !partyNames.has(p.name) && !hidden.has(p.name))   // ocultar party (auto) + ocultados (manual)
      .sort((a, b) => {
        if (a.id === selectedId) return -1;        // seleccionado siempre primero
        if (b.id === selectedId) return 1;
        return (avgIP(b.equip) || 0) - (avgIP(a.equip) || 0); // más equipados (amenaza) arriba
      });
    countEl.textContent = String(arr.length);
    const hideBar = hidden.size ? `<div class="hidden-bar">${hidden.size} oculto(s) · <button id="unhideAll">mostrar todos</button></div>` : '';
    if (!arr.length) {
      plist.innerHTML = hideBar + '<div class="pl-empty">Sin enemigos en rango.<br>Muévete por el mundo para detectarlos.</div>';
      return;
    }
    plist.innerHTML = hideBar + arr.map((p) => {
      const pct = p.hpMax ? Math.max(0, Math.min(100, Math.round(100 * p.hp / p.hpMax))) : 100;
      const ip = avgIP(p.equip);
      const age = Math.round((Date.now() - p.last) / 1000);
      return `<div class="pcard${p.id === selectedId ? ' selected' : ''}" data-id="${p.id}">
        <div class="prow"><span class="pname">${esc(p.name || '???')}</span>
          <span class="pguild">${p.guild ? '· ' + esc(p.guild) : ''}</span>
          ${p.mounted ? '<span class="mount" title="Montado">🐎</span>' : ''}
          <button class="phide" data-hide="${esc(p.name || '')}" title="Ocultar (marcar aliado)">✕</button></div>
        <div class="hp"><i style="width:${pct}%"></i></div>
        ${gearHtml(p.equip)}
        <div class="pmeta"><span class="ip">${ip ? 'IP ~' + ip : ''}</span><span>${age}s</span></div>
      </div>`;
    }).join('');
  }

  // ---- WebSocket ----
  let ws = null, reconnectT = null;
  function setConn(s) {
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
    const code = p['252'], id = p['0'];
    let touched = true;
    switch (code) {
      case 29:
        players.set(id, { id, name: p['1'], guild: p['8'] || '', alliance: p['51'] || '',
          faction: p['53'] ?? 0, hp: 1, hpMax: 1, equip: p['40'] || null, spells: p['43'] || null,
          mounted: false, last: Date.now() });
        break;
      case 1: {
        if (typeof p['4'] === 'string' && Array.isArray(p['5']) && p['5'].every((x) => typeof x === 'string')) {
          partyNames.clear(); partyNames.add(p['4']); p['5'].forEach((n) => partyNames.add(n)); savePartyShared();   // lista de party recurrente
        } else { const q = players.get(id); if (q) q.left = Date.now(); }   // salió de rango: se borra tras un delay
        break;
      }
      case 6: { const q = players.get(id); if (q) { q.hp = p['3'] ?? q.hp; q.last = Date.now(); } break; }
      case 91: { const q = players.get(id); if (q) { q.hp = p['2'] ?? q.hp; q.hpMax = p['3'] ?? q.hpMax; q.last = Date.now(); } break; }
      case 90: { const q = players.get(id); if (q) { q.equip = p['2'] || q.equip; q.last = Date.now(); } break; }
      case 211: { const q = players.get(id); if (q) { q.mounted = p['11'] === true || p['10'] === -1; q.last = Date.now(); } break; }
      case 363: { const q = players.get(id); if (q) { q.faction = p['1'] ?? q.faction; q.last = Date.now(); } break; }
      case 3: { const q = players.get(id); if (q) q.last = Date.now(); break; }
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

  // añadir aliado por nombre (se oculta para siempre, sin esperar a verlo)
  const allyInput = document.getElementById('ally-input');
  const allyBtn = document.getElementById('ally-btn');
  function addAlly() { const n = (allyInput.value || '').trim(); if (n) { hidden.add(n); saveHidden(); allyInput.value = ''; render(); } }
  if (allyBtn) allyBtn.addEventListener('click', addAlly);
  if (allyInput) allyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlly(); });

  // clic en una tarjeta = seleccionar (sube arriba y se resalta); otro clic la quita
  plist.addEventListener('click', (e) => {
    if (e.target.closest('#unhideAll')) { hidden.clear(); saveHidden(); render(); return; }
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
