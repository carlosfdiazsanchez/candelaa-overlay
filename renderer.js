// Renderer: radar drawing, panel controls, drag-to-move, layout persistence,
// and click-through (mouse-position based, reliable).

(function () {
  const LS_KEY = 'albion-overlay-layout-v1';
  let topZ = 10;
  let passthrough = false;   // "clic al juego": los paneles se atraviesan
  let lastIgnore = null;     // último estado enviado a setIgnoreMouseEvents
  let dragging = false;      // arrastrando un panel/barra
  let gateActive = false;    // pantalla de token visible (captura todo el input)
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function applyIgnore(ignore) {
    if (ignore !== lastIgnore) { lastIgnore = ignore; window.overlay.setIgnore(ignore); }
  }

  // versión de la app en la barra (sirve para verificar el auto-update)
  const verEl = document.getElementById('app-ver');
  if (verEl && window.overlay.getVersion) {
    window.overlay.getVersion().then((v) => { verEl.textContent = 'v' + v; }).catch(() => {});
  }
  // indicador de auto-update: descarga con % y botón para reiniciar e instalar
  const updEl = document.getElementById('app-upd');
  if (updEl && window.overlay.onUpdateStatus) {
    updEl.addEventListener('click', () => { if (updEl.classList.contains('ready')) window.overlay.installUpdate(); });
    window.overlay.onUpdateStatus((s) => {
      if (!s) return;
      if (s.state === 'downloading') {
        updEl.hidden = false; updEl.className = 'upd-box dl';
        updEl.textContent = `⬇ Updating ${s.percent || 0}%`;
      } else if (s.state === 'ready') {
        updEl.hidden = false; updEl.className = 'upd-box ready';
        updEl.textContent = `✓ Restart to update${s.version ? ' to v' + s.version : ''}`;
      } else if (s.state === 'error') {
        updEl.hidden = true;
      }
    });
  }

  // ---- layout persistence ----
  const draggables = ['bar', 'p-players', 'p-radar', 'p-item', 'p-notes'];
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { return {}; } }
  function saveState() {
    const st = { panels: {}, monitor: document.getElementById('mon').value, passthrough };
    draggables.forEach((id) => {
      const el = document.getElementById(id); if (!el) return;
      st.panels[id] = {
        left: el.style.left || null, top: el.style.top || null,
        collapsed: el.classList.contains('collapsed'),
        hidden: el.style.display === 'none',
      };
    });
    localStorage.setItem(LS_KEY, JSON.stringify(st));
  }
  function applyPos(el, p) {
    if (p.left && p.top) { el.style.left = p.left; el.style.top = p.top; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none'; }
  }

  // ---- drag to move ----
  function makeDraggable(el, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.icon-btn, button, select, input')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
      el.style.zIndex = ++topZ;
      el.classList.add('dragging');
      dragging = true; applyIgnore(false);
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mm = (ev) => {
        let nx = ev.clientX - ox, ny = ev.clientY - oy;
        nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, nx));
        ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ny));
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
      };
      const mu = () => {
        window.removeEventListener('mousemove', mm);
        window.removeEventListener('mouseup', mu);
        el.classList.remove('dragging');
        dragging = false; lastIgnore = null; // forzar recálculo en el próximo move
        saveState();
      };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
  }
  makeDraggable(document.getElementById('bar'), document.querySelector('#bar .brand'));
  ['p-players', 'p-radar', 'p-item', 'p-notes'].forEach((id) => {
    const el = document.getElementById(id);
    makeDraggable(el, el.querySelector('.panel__head'));
  });

  // ---- collapse / toggles / opacity ----
  document.querySelectorAll('.collapse').forEach((b) => {
    b.addEventListener('click', (e) => {
      const p = e.target.closest('.panel'); p.classList.toggle('collapsed');
      b.textContent = p.classList.contains('collapsed') ? '▢' : '▁';
      saveState();
    });
  });
  document.getElementById('toggles').addEventListener('click', (e) => {
    const t = e.target.closest('.tg'); if (!t) return;
    const on = t.getAttribute('aria-pressed') === 'true';
    t.setAttribute('aria-pressed', String(!on));
    const el = document.getElementById('p-' + t.dataset.p); if (el) el.style.display = on ? 'none' : '';
    saveState();
  });
  // ---- notas: texto libre, se guarda solo ----
  (function notes() {
    const NOTES_KEY = 'candelaa-notes-v1';
    const ta = document.getElementById('notes-text');
    const state = document.getElementById('notes-state');
    if (!ta) return;
    try { ta.value = localStorage.getItem(NOTES_KEY) || ''; } catch (_) {}
    // el tamaño al que la dejes estirada se recuerda
    const SIZE_KEY = 'candelaa-notes-size-v1';
    try {
      const sz = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
      if (sz && sz.w) ta.style.width = sz.w;
      if (sz && sz.h) ta.style.height = sz.h;
    } catch (_) {}
    // el panel nace anclado a la derecha, así que al ensanchar crecería hacia la izquierda y
    // el tirador se queda quieto bajo el cursor. Fijándolo por left/top crece hacia el lado
    // que arrastras, como cualquier ventana.
    const anchorTopLeft = () => {
      const p = document.getElementById('p-notes');
      if (!p || p.style.left) return;
      const r = p.getBoundingClientRect();
      if (!r.width) return;   // layout todavía sin calcular: no lo movemos a 0,0
      p.style.left = Math.round(r.left) + 'px';
      p.style.top = Math.round(r.top) + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    };
    setTimeout(anchorTopLeft, 0);
    ta.addEventListener('pointerdown', anchorTopLeft);
    if (window.ResizeObserver) {
      let rt = null;
      new ResizeObserver(() => {
        clearTimeout(rt);
        rt = setTimeout(() => {
          try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: ta.style.width, h: ta.style.height })); } catch (_) {}
        }, 500);
      }).observe(ta);
    }
    let t = null, clearT = null;
    const mark = (txt) => { if (!state) return; state.textContent = txt; clearTimeout(clearT); clearT = setTimeout(() => { state.textContent = ''; }, 1500); };
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { try { localStorage.setItem(NOTES_KEY, ta.value); mark('saved'); } catch (_) { mark('could not save'); } }, 400);
    });
    const btn = document.getElementById('notes-clear');
    if (btn) btn.addEventListener('click', () => {
      if (!ta.value.trim()) return;
      if (!window.confirm('Delete every note?')) return;
      ta.value = '';
      try { localStorage.setItem(NOTES_KEY, ''); } catch (_) {}
      mark('vaciado');
    });
  })();

  document.getElementById('quit').addEventListener('click', () => window.overlay.quit());

  // ---- monitor selector ----
  const mon = document.getElementById('mon');
  window.overlay.getDisplays().then((list) => {
    mon.innerHTML = '';
    list.forEach((d) => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; mon.appendChild(o); });
    const st = loadState();
    if (st.monitor && [...mon.options].some((o) => o.value === String(st.monitor))) {
      mon.value = st.monitor; window.overlay.setDisplay(Number(st.monitor));
    }
  });
  mon.addEventListener('change', () => { window.overlay.setDisplay(Number(mon.value)); saveState(); });

  // ---- restore saved layout ----
  (function restore() {
    const st = loadState();
    if (st.panels) {
      Object.entries(st.panels).forEach(([id, p]) => {
        const el = document.getElementById(id); if (!el) return;
        applyPos(el, p);
        if (p.collapsed && el.classList.contains('panel')) {
          el.classList.add('collapsed');
          const b = el.querySelector('.collapse'); if (b) b.textContent = '▢';
        }
        if (p.hidden) {
          el.style.display = 'none';
          const tg = document.querySelector(`.tg[data-p="${id.replace('p-', '')}"]`);
          if (tg) tg.setAttribute('aria-pressed', 'false');
        }
      });
    }
  })();

  // ---- click-through (por posición del ratón) ----
  // Sobre barra -> siempre captura. Sobre panel -> captura salvo passthrough.
  // En vacío -> deja pasar los clics al juego.
  function evalAt(target) {
    if (dragging) return;
    const interactive = target.closest('#bar') || target.closest('#npcap-notice') || target.closest('.gate-card') || (!passthrough && target.closest('.panel'));
    applyIgnore(!interactive);
  }
  document.addEventListener('mousemove', (e) => evalAt(e.target), true);
  document.addEventListener('mouseover', (e) => evalAt(e.target), true);

  const ptBtn = document.getElementById('passthrough');
  function applyPassthrough() { ptBtn.setAttribute('aria-pressed', String(passthrough)); lastIgnore = null; }
  function togglePassthrough() { passthrough = !passthrough; applyPassthrough(); saveState(); }
  ptBtn.addEventListener('click', togglePassthrough);
  window.overlay.onTogglePassthrough(togglePassthrough);

  { const st = loadState(); if (st.passthrough) { passthrough = true; applyPassthrough(); } }

  // ================= ACCESO POR TOKEN =================
  const gate = document.getElementById('auth-gate');
  const gateInput = document.getElementById('gate-input');
  const gateBtn = document.getElementById('gate-btn');
  const gateErr = document.getElementById('gate-err');
  const gateMsg = document.getElementById('gate-msg');
  const authUserEl = document.getElementById('auth-user');
  const btnAdmin = document.getElementById('btn-admin');
  const pAdmin = document.getElementById('p-admin');
  let isAdmin = false;
  let gateDismissed = false;
  makeDraggable(gate.querySelector('.gate-card'), gate.querySelector('.gate-card'));
  document.getElementById('gate-close').addEventListener('click', () => { gateDismissed = true; hideGate(); });

  function showGate(msg) {
    gateActive = true; gateDismissed = false; gate.hidden = false;
    if (msg) gateMsg.textContent = msg;
    gateErr.textContent = ''; lastIgnore = null;
    setTimeout(() => { try { gateInput.focus(); } catch (_) {} }, 60);
  }
  function hideGate() { gateActive = false; gate.hidden = true; lastIgnore = null; }
  function setAuthUI(name) {
    authUserEl.textContent = name ? ('👤 ' + name) : '';
    btnAdmin.hidden = !isAdmin;
    if (!isAdmin) { pAdmin.style.display = 'none'; pAdmin.dataset.open = '0'; }
  }
  const reasonText = (r) => ({
    token_invalid: 'Invalid token.', token_revoked: 'Your token has been revoked.',
    token_blocked: 'Your token is blocked.', no_token: 'Enter your token.',
    network: 'Could not reach the server.',
  }[r] || ('Error: ' + r));
  async function verify(token) { try { return await window.overlay.authVerify(token); } catch (_) { return { valid: false, reason: 'network' }; } }

  async function gateSubmit() {
    const t = (gateInput.value || '').trim();
    if (!t) { gateErr.textContent = 'Enter your token.'; return; }
    gateBtn.disabled = true; gateErr.textContent = 'Checking…';
    const r = await verify(t);
    gateBtn.disabled = false;
    if (r.valid) { isAdmin = !!r.is_admin; setAuthUI(r.name === 'app' ? '' : r.name); hideGate(); gateInput.value = ''; }
    else { gateErr.textContent = reasonText(r.reason); }
  }
  gateBtn.addEventListener('click', gateSubmit);
  gateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') gateSubmit(); });

  // arranque: la app trae su propia clave, así que no se pide nada. El gate solo aparece
  // si el servidor rechaza esa clave (revocada o build sin clave), nunca por un corte de red.
  (async function bootAuth() {
    const stored = await window.overlay.getToken();
    if (!stored) { showGate('Enter your access token'); return; }
    const r = await verify(stored);
    if (r.valid) { isAdmin = !!r.is_admin; setAuthUI(r.name === 'app' ? '' : r.name); hideGate(); }
    else if (r.reason !== 'network') { showGate(reasonText(r.reason) + ' Enter a valid token.'); }
  })();

  // re-verificación periódica: si revocas el token, se bloquea en ~10 min
  setInterval(async () => {
    if (gateActive) return;
    const r = await verify(await window.overlay.getToken());
    if (r.valid) { isAdmin = !!r.is_admin; setAuthUI(r.name === 'app' ? '' : r.name); }
    else if (r.reason !== 'network') { isAdmin = false; setAuthUI(''); if (!gateDismissed) showGate('Signed out: ' + reasonText(r.reason)); }
  }, 10 * 60 * 1000);

  // ================= PANEL ADMIN (solo is_admin) =================
  makeDraggable(pAdmin, pAdmin.querySelector('.panel__head'));
  const alist = document.getElementById('alist');
  const adminCount = document.getElementById('admin-count');
  const ACT_LABEL = { revoke: 'Revoke', block: 'Block', activate: 'Reactivate', delete: 'Delete' };

  const agoR = (ds) => { if (!ds) return 'never'; const m = Math.round((Date.now() - new Date(ds).getTime()) / 60000); if (m < 1) return 'now'; return m < 60 ? m + 'm' : (m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'); };
  const isOnline = (ds) => !!(ds && (Date.now() - new Date(ds).getTime()) < 40000);
  async function renderAdmin() {
    const res = await window.overlay.adminList();
    const tokens = (res && res.tokens) || [];
    const online = tokens.filter((t) => isOnline(t.last_seen_at)).length;
    adminCount.textContent = online ? `${tokens.length} · ${online} en línea` : String(tokens.length);
    if (!tokens.length) { alist.innerHTML = '<div class="pl-empty">No tokens issued.</div>'; return; }
    tokens.sort((a, b) => (isOnline(b.last_seen_at) - isOnline(a.last_seen_at)) || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')));
    alist.innerHTML = tokens.map((t) => {
      const acts = [];
      if (!t.is_admin) {
        if (t.status === 'active') { acts.push('revoke', 'block'); } else { acts.push('activate'); }
        acts.push('delete');
      }
      const btns = acts.map((a) => `<button data-tok="${esc(t.token)}" data-act="${a}">${ACT_LABEL[a]}</button>`).join('');
      const on = isOnline(t.last_seen_at);
      const pres = `<span class="apres" title="${t.last_seen_at ? 'Última vez: ' + new Date(t.last_seen_at).toLocaleString('es-ES') : 'Nunca conectado'}"><span class="adot ${on ? 'on' : ''}"></span>${on ? 'en línea' : 'visto ' + agoR(t.last_seen_at)}</span>`;
      return `<div class="arow"><div class="atop"><span class="aname">${esc(t.name)}${t.is_admin ? ' 🛡️' : ''}</span>${pres}<span class="abadge ${t.status}">${t.status}</span></div><div class="atok copyable" data-copy="${esc(t.token)}" title="Click to copy the token">${esc(t.token)}</div><div class="aacts">${btns}</div></div>`;
    }).join('');
  }
  let adminTimer = null;
  btnAdmin.addEventListener('click', () => {
    pAdmin.hidden = false;
    const open = pAdmin.dataset.open === '1';
    if (open) { pAdmin.style.display = 'none'; pAdmin.dataset.open = '0'; if (adminTimer) { clearInterval(adminTimer); adminTimer = null; } }
    else { pAdmin.style.display = ''; pAdmin.dataset.open = '1'; renderAdmin(); if (adminTimer) clearInterval(adminTimer); adminTimer = setInterval(renderAdmin, 12000); }
  });
  document.getElementById('admin-add').addEventListener('click', async () => {
    const inp = document.getElementById('admin-name');
    const name = (inp.value || '').trim(); if (!name) return;
    const r = await window.overlay.adminIssue(name); inp.value = '';
    if (r && r.token) document.getElementById('admin-new').innerHTML = `<div class="newtok">Token for <b>${esc(r.name)}</b>:<br><span class="copyable" data-copy="${esc(r.token)}" title="Click to copy">${esc(r.token)}</span><br><small>Click the token to copy it and pass it on.</small></div>`;
    renderAdmin();
  });
  alist.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const { tok, act } = b.dataset;
    if (act === 'delete' && !window.confirm('Delete this token? This cannot be undone.')) return;
    await window.overlay.adminAction(tok, act);
    renderAdmin();
  });

  // copiar token al portapapeles al hacer click (igual que los nombres de item)
  let _copyToastEl = null, _copyToastT = null;
  function copyToast(msg) {
    if (!_copyToastEl) { _copyToastEl = document.createElement('div'); _copyToastEl.id = 'copy-toast'; document.body.appendChild(_copyToastEl); }
    _copyToastEl.textContent = msg; _copyToastEl.classList.add('show');
    clearTimeout(_copyToastT); _copyToastT = setTimeout(() => _copyToastEl.classList.remove('show'), 1400);
  }
  function copyTok(txt) {
    if (!txt) return;
    const done = () => copyToast('📋 Copied: ' + txt);
    const fb = () => { const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (_) {} document.body.removeChild(ta); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb); else fb(); } catch (_) { fb(); }
  }
  pAdmin.addEventListener('click', (e) => {
    const el = e.target.closest('[data-copy]'); if (!el) return;
    copyTok(el.getAttribute('data-copy'));
  });

  // ================= NPCAP (auto-descarga, vía gratis) =================
  (async function npcapCheck() {
    const notice = document.getElementById('npcap-notice');
    const btn = document.getElementById('npcap-btn');
    const state = document.getElementById('npcap-state');
    try {
      if (await window.overlay.npcapStatus()) { notice.hidden = true; return; }
      notice.hidden = false;
      btn.addEventListener('click', async () => {
        btn.disabled = true; state.textContent = ' downloading…';
        const r = await window.overlay.npcapInstall();
        if (r && r.launched) state.textContent = ' installer opened: accept the UAC prompt and hit Next';
        else { state.textContent = ' failed; install manually from npcap.com'; btn.disabled = false; }
      });
    } catch (_) {}
  })();
})();
