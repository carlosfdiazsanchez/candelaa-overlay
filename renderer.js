// Renderer: radar drawing, panel controls, drag-to-move, layout persistence,
// and click-through (mouse-position based, reliable).

(function () {
  const LS_KEY = 'albion-overlay-layout-v1';
  let topZ = 10;
  let passthrough = false;   // "clic al juego": los paneles se atraviesan
  let lastIgnore = null;     // último estado enviado a setIgnoreMouseEvents
  let dragging = false;      // arrastrando un panel/barra

  function applyIgnore(ignore) {
    if (ignore !== lastIgnore) { lastIgnore = ignore; window.overlay.setIgnore(ignore); }
  }

  // versión de la app en la barra (sirve para verificar el auto-update)
  const verEl = document.getElementById('app-ver');
  if (verEl && window.overlay.getVersion) {
    window.overlay.getVersion().then((v) => { verEl.textContent = 'v' + v; }).catch(() => {});
  }
  if (window.overlay.onUpdateReady) {
    window.overlay.onUpdateReady(() => {
      if (verEl) { verEl.textContent = '⬇ update listo · reinicia'; verEl.classList.add('upd'); }
    });
  }

  // (el radar lo dibuja radar-feed.js con datos reales)

  // ---- layout persistence ----
  const draggables = ['bar', 'p-radar', 'p-players', 'p-item'];
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { return {}; } }
  function saveState() {
    const st = { panels: {}, opacity: document.getElementById('op').value, monitor: document.getElementById('mon').value, passthrough };
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
  ['p-radar', 'p-players', 'p-item'].forEach((id) => {
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
  document.getElementById('op').addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--panel-alpha', (e.target.value / 100).toFixed(2));
  });
  document.getElementById('op').addEventListener('change', saveState);
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
    if (st.opacity) {
      document.getElementById('op').value = st.opacity;
      document.documentElement.style.setProperty('--panel-alpha', (st.opacity / 100).toFixed(2));
    }
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
    const interactive = target.closest('#bar') || (!passthrough && target.closest('.panel'));
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
})();
