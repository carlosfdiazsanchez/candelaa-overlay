// Item feed (unificado): un buscador + encantamiento, dos pestañas:
//  - Mercado: precios por ciudad (resalta comprar/vender) + calculadora de flip.
//  - Crafteo: mejor ciudad por bono, receta y rentabilidad comparada E0-E4.
// Todas las peticiones HTTP van por el proceso main (sin CORS).

(function () {
  const search = document.getElementById('item-search');
  const results = document.getElementById('item-results');
  const tabMarket = document.getElementById('tab-market');
  const craftOut = document.getElementById('craft-out');
  const craftBonus = document.getElementById('craft-bonus');
  if (!search) return;

  let items = [], nameById = {}, recipes = {};
  let currentBase = null, currentName = '', currentEnch = 0, currentQuality = 0;
  let marketData = null, marketVolMap = {}, craftPriceMap = {}, craftVolMap = {}, marketRefreshT = null, marketQuality = null, craftQualMap = {};

  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // formato abreviado y legible: 238K, 1,0M (cálculo exacto por detrás)
  const fmt = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'K';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + 'K';
    return String(Math.round(n));
  };
  const roiTxt = (n) => (n == null || isNaN(n) ? '—' : Math.round(n) + '%');
  // cantidad exacta de unidades (separador de miles, sin abreviar): 3.200
  const fmtInt = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('es-ES'));
  const salesTax = () => ((document.getElementById('premium-toggle') || {}).checked === false ? 0.08 : 0.04);
  const stationRate = () => (+(document.getElementById('station-rate') || {}).value || 0);
  const agoStr = (ds) => { if (!ds) return ''; const m = Math.round((Date.now() - new Date(ds + 'Z').getTime()) / 60000); return m < 0 ? '' : (m < 60 ? m + 'm' : (m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd')); };
  const ageHours = (ds) => (ds ? (Date.now() - new Date(ds + 'Z').getTime()) / 3600000 : Infinity);

  // ---------- saneamiento anti-outlier (precios troll / datos podridos de la API) ----------
  // Un precio muy por encima (o por debajo) de la mediana del MISMO item en otras ciudades
  // es casi siempre una orden basura. Se necesita un mínimo de fuentes para poder juzgar.
  const OUTLIER_MULT = 8;      // > 8x la mediana del resto = outlier alto; < mediana/8 = outlier bajo
  const OUTLIER_MIN_SRC = 3;   // hacen falta al menos 3 precios válidos para decidir
  const medianOf = (arr) => { const a = arr.filter((x) => x > 0).sort((x, y) => x - y); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const isHiOutlier = (price, others) => { const med = medianOf(others); return med > 0 && others.filter((x) => x > 0).length >= OUTLIER_MIN_SRC && price > med * OUTLIER_MULT; };
  const isLoOutlier = (price, others) => { const med = medianOf(others); return med > 0 && others.filter((x) => x > 0).length >= OUTLIER_MIN_SRC && price > 0 && price < med / OUTLIER_MULT; };

  // ---------- copiar nombre al portapapeles (click en cualquier nombre) ----------
  let toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'copy-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1400);
  }
  function copyText(txt) {
    if (!txt) return;
    const done = () => toast('📋 Copiado: ' + txt);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, fallback); }
      else fallback();
    } catch (e) { fallback(); }
    function fallback() {
      const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { }
      document.body.removeChild(ta);
    }
  }
  // delegado: cualquier elemento con [data-copy] dentro del panel Item copia su nombre al click
  document.getElementById('p-item').addEventListener('click', (e) => {
    const t = e.target.closest('[data-copy]'); if (!t) return;
    e.stopPropagation();
    copyText(t.getAttribute('data-copy'));
  });

  const CFG_KEY = 'candelaa-config-v1';
  (function restoreCfg() {
    let c = {}; try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) {}
    const pt = document.getElementById('premium-toggle'); if (pt && typeof c.premium === 'boolean') pt.checked = c.premium;
    const sr = document.getElementById('station-rate'); if (sr && c.stationRate != null) sr.value = c.stationRate;
  })();
  function saveCfg() {
    const pt = document.getElementById('premium-toggle'); const sr = document.getElementById('station-rate');
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ premium: !!(pt && pt.checked), stationRate: sr ? +sr.value || 0 : 400 })); } catch (_) {}
  }
  { const pt = document.getElementById('premium-toggle'); if (pt) pt.addEventListener('change', saveCfg); }
  { const sr = document.getElementById('station-rate'); if (sr) sr.addEventListener('input', saveCfg); }

  Promise.all([window.overlay.itemsIndex(), window.overlay.recipesIndex()]).then(([it, rc]) => {
    items = it || []; recipes = rc || {};
    nameById = Object.fromEntries(items.map((x) => [x.id, x.n]));
  });

  // ---------- bono de ciudad (crafteo, +15% return) ----------
  const ARMOR = {
    CLOTH_HEAD: ['Thetford', 'casco de tela'], CLOTH_ARMOR: ['Fort Sterling', 'pecho de tela'], CLOTH_SHOES: ['Bridgewatch', 'botas de tela'],
    LEATHER_HEAD: ['Lymhurst', 'casco de cuero'], LEATHER_ARMOR: ['Thetford', 'pecho de cuero'], LEATHER_SHOES: ['Lymhurst', 'botas de cuero'],
    PLATE_HEAD: ['Fort Sterling', 'casco de placas'], PLATE_ARMOR: ['Bridgewatch', 'pecho de placas'], PLATE_SHOES: ['Martlock', 'botas de placas'],
  };
  const WEAPON = [
    [/SWORD|CLAYMORE|DUALSWORD|CLEAVER|GALATINE|KINGMAKER|CARVINGSWORD/, 'Lymhurst', 'espadas'],
    [/_BOW|WARBOW|LONGBOW|WHISPERINGBOW/, 'Lymhurst', 'arcos'],
    [/ARCANESTAFF|ENIGMATICSTAFF|WITCHWORK|OCCULTSTAFF|MALEVOLENT/, 'Lymhurst', 'bastón arcano'],
    [/_AXE|BATTLEAXE|HALBERD|CARRIONCALLERS|REALMBREAKER|BEARPAWS|INFERNALSCYTHE/, 'Martlock', 'hachas'],
    [/QUARTERSTAFF|IRONCLADSTAFF|DOUBLEBLADEDSTAFF|BLACKMONKSTONE|SOULSCYTHE|GRAILSEEKER/, 'Martlock', 'bastón pesado'],
    [/FROSTSTAFF|GLACIALSTAFF|HOARFROST|ICICLESTAFF|PERMAFROST/, 'Martlock', 'bastón de escarcha'],
    [/_OFF_/, 'Martlock', 'off-hand'],
    [/CROSSBOW|WEEPINGREPEATER|BOLTCASTERS|SIEGEBOW/, 'Bridgewatch', 'ballestas'],
    [/DAGGER|CLAWPAIR|BLOODLETTER|BLACKHANDS|DEATHGIVERS|BRIDLEDFURY/, 'Bridgewatch', 'dagas'],
    [/CURSEDSTAFF|DEMONICSTAFF|LIFECURSE|CURSEDSKULL|DAMNATION/, 'Bridgewatch', 'bastón maldito'],
    [/HAMMER|POLEHAMMER|TOMBHAMMER|FORGEHAMMERS|GROVEKEEPER/, 'Fort Sterling', 'martillos'],
    [/_SPEAR|_PIKE|GLAIVE|HERESYSPEAR|TRINITYSPEAR|DAYBREAKER/, 'Fort Sterling', 'lanzas'],
    [/HOLYSTAFF|DIVINESTAFF|FALLENSTAFF|REDEMPTIONSTAFF|HALLOWFALL/, 'Fort Sterling', 'bastón sagrado'],
    [/_MACE|HEAVYMACE|MACEPAIR|INCUBUSMACE|CAMLANN/, 'Thetford', 'mazas'],
    [/FIRESTAFF|INFERNOSTAFF|WILDFIRESTAFF|BLAZINGSTAFF|DAWNSONG/, 'Thetford', 'bastón de fuego'],
    [/NATURESTAFF|WILDSTAFF|DRUIDICSTAFF|BLIGHTSTAFF|RAMPANTSTAFF/, 'Thetford', 'bastón natural'],
  ];
  function cityBonus(id) {
    const a = id.match(/(HEAD|ARMOR|SHOES)_(CLOTH|LEATHER|PLATE)/);
    if (a) { const k = a[2] + '_' + a[1]; if (ARMOR[k]) return { city: ARMOR[k][0], what: ARMOR[k][1] }; }
    for (const [re, city, what] of WEAPON) if (re.test(id)) return { city, what };
    return null;
  }

  // ---------- buscador ----------
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 180); });
  function doSearch() {
    const q = norm(search.value.trim());
    if (q.length < 2) { results.innerHTML = ''; return; }
    // solo items base (sin @ench): una fila por item; el encantamiento se elige con el filtro Ench.
    const matches = items.filter((it) => it.id.indexOf('@') < 0 && norm(it.n).includes(q)).slice(0, 14);
    results.innerHTML = matches.length
      ? matches.map((m) => `<div class="mres" data-id="${esc(m.id)}"><img class="ires-icon" src="https://render.albiononline.com/v1/item/${encodeURIComponent(m.id)}.png?size=40" loading="lazy" alt=""><span class="ires-name">${esc(m.n)}</span><span class="mid">${recipes[m.id] ? '🔨' : ''}</span></div>`).join('')
      : '<div class="mempty">Sin resultados</div>';
  }
  results.addEventListener('click', (e) => {
    const r = e.target.closest('.mres'); if (!r) return;
    currentBase = r.dataset.id; currentName = nameById[currentBase] || currentBase;
    results.innerHTML = ''; search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : '');
    { const co = document.getElementById('cmp-offer'); if (co) co.value = ''; }
    loadMarket(); loadCraft();
    { const lv = document.getElementById('tab-level'); if (lv && !lv.hidden) loadLevel(); }
  });

  // ---------- encantamiento ----------
  document.querySelectorAll('#item-ench button[data-e]').forEach((b) => {
    b.addEventListener('click', () => {
      currentEnch = +b.dataset.e;
      document.querySelectorAll('#item-ench button[data-e]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (currentBase) { search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : ''); loadMarket(); renderCraft(); }
    });
  });

  // ---------- calidad (filtro global, como el de encantamiento) ----------
  document.querySelectorAll('#item-quality button[data-q]').forEach((b) => {
    b.addEventListener('click', () => {
      currentQuality = +b.dataset.q;
      document.querySelectorAll('#item-quality button[data-q]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (currentBase) { loadMarket(); loadCraft(); }
      onScanFilterChange();
    });
  });

  // ---------- pestañas ----------
  document.querySelectorAll('#item-tabs .tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#item-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      ['market', 'craft', 'scan', 'level', 'config'].forEach((t) => { const el = document.getElementById('tab-' + t); if (el) el.hidden = b.dataset.tab !== t; });
      if (b.dataset.tab === 'level') loadLevel();
      const enchSel = document.getElementById('item-ench');
      if (enchSel) enchSel.style.display = (b.dataset.tab === 'market') ? '' : 'none';
      const qSel = document.getElementById('item-quality');
      if (qSel) qSel.style.display = (b.dataset.tab === 'config' || b.dataset.tab === 'level') ? 'none' : '';
    });
  });

  const QNAMES = ['Todas', 'Normal', 'Bueno', 'Notable', 'Sobresaliente', 'Obra maestra'];
  function itemHeadHtml(sub) {
    const qid = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    return `<div class="mkt-item-head"><img class="mkt-item-icon" src="https://render.albiononline.com/v1/item/${encodeURIComponent(qid)}.png?size=64" alt=""><div><div class="mkt-item-name"><span class="copyable" data-copy="${esc(currentName)}" title="Clic para copiar el nombre">${esc(currentName)}</span> <span class="enchtag">.${currentEnch}</span></div><div class="mkt-item-sub">${sub}</div></div></div>`;
  }

  // ================= MERCADO =================
  async function loadMarket(silent) {
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    if (!silent) tabMarket.innerHTML = '<div class="mempty">Cargando precios…</div>';
    const [prices, vol, live] = await Promise.all([
      window.overlay.marketPrices(queryId, currentQuality),
      window.overlay.history([queryId], ALL_CITIES, 21, currentQuality),
      window.overlay.marketLive(queryId, currentQuality).catch(() => null),
    ]);
    marketData = prices || [];
    if (Array.isArray(live)) {
      live.forEach((lr) => {
        if (!lr || !lr.city) return;
        const ck = cityKey(lr.city);
        const row = marketData.find((r) => cityKey(r.city) === ck);
        if (row) {
          if (lr.sell_price_min > 0 && (!row.sell_price_min_date || String(lr.sell_price_min_date || '') >= String(row.sell_price_min_date))) {
            row.sell_price_min = lr.sell_price_min; row.sell_price_min_date = lr.sell_price_min_date; (row._live = row._live || {}).sell = true;
          }
          if (lr.buy_price_max > 0 && (!row.buy_price_max_date || String(lr.buy_price_max_date || '') >= String(row.buy_price_max_date))) {
            row.buy_price_max = lr.buy_price_max; row.buy_price_max_date = lr.buy_price_max_date; (row._live = row._live || {}).buy = true;
          }
        } else if (lr.sell_price_min > 0 || lr.buy_price_max > 0) {
          marketData.push({ city: lr.city, quality: lr.quality || 1,
            sell_price_min: lr.sell_price_min || 0, sell_price_min_date: lr.sell_price_min_date,
            buy_price_max: lr.buy_price_max || 0, buy_price_max_date: lr.buy_price_max_date,
            _live: { sell: lr.sell_price_min > 0, buy: lr.buy_price_max > 0 } });
        }
      });
    }
    marketVolMap = {};
    (vol || []).forEach((r) => { marketVolMap[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
    if (!silent) {
      const QS = [1, 2, 3, 4, 5];
      const [qp, qh] = await Promise.all([
        Promise.all(QS.map((q) => window.overlay.marketPrices(queryId, q).catch(() => []))),
        Promise.all(QS.map((q) => window.overlay.history([queryId], ['Black Market'], 21, q).catch(() => []))),
      ]);
      marketQuality = QS.map((q, i) => {
        const pr = qp[i] || [];
        const cs = pr.filter((r) => r.city !== 'Black Market' && r.sell_price_min > 0).map((r) => r.sell_price_min);
        const bmr = pr.find((r) => r.city === 'Black Market');
        const hr = (qh[i] || [])[0] || {};
        let date = '';
        pr.forEach((r) => { [r.sell_price_min_date, r.buy_price_max_date].forEach((d) => { if (d && d > date) date = d; }); });
        return { q, buy: cs.length ? Math.min(...cs) : 0, bm: bmr ? bmr.buy_price_max || 0 : 0, avg: hr.avg_price || 0, vol: hr.daily || 0, date };
      });
    }
    renderMarket(silent);
  }
  function sostChip(bm, avg) {
    if (!bm || !avg) return '';
    const r = bm / avg;
    return r > 1.4 ? `<span class="chip chip-pico" title="Pico: el BM paga ${fmt(bm)} ahora pero lo normal es ~${fmt(avg)}; cuenta con el medio">⚠ PICO ${r.toFixed(1)}×</span>`
      : r < 0.7 ? '<span class="chip chip-flojo" title="El BM paga menos de lo normal ahora; suele recuperarse">↓ flojo</span>'
      : '<span class="chip chip-ok" title="El precio de ahora va en línea con el medio histórico: fiable">✅ sostenido</span>';
  }
  function renderMarket(silent) {
    const rows = (marketData || []).filter((r) => r.sell_price_min > 0 || r.buy_price_max > 0);
    if (!rows.length) { if (!silent) tabMarket.innerHTML = '<div class="mempty">Sin datos de mercado.</div>'; return; }
    const citySells = rows.filter((r) => r.city !== 'Black Market' && r.sell_price_min > 0).map((r) => r.sell_price_min);
    const isSellOutlier = (sp) => isHiOutlier(sp, citySells) || isLoOutlier(sp, citySells);
    const validSells = citySells.filter((sp) => !isSellOutlier(sp));
    const usableSells = validSells.length ? validSells : citySells;   // si todo parece outlier, no ocultes todo
    const minSell = usableSells.length ? Math.min(...usableSells) : null;
    const maxSell = usableSells.length ? Math.max(...usableSells) : null;
    // Black Market al final (es venta inmediata al NPC, no sitio para comprar)
    rows.sort((a, b) => (a.city === 'Black Market' ? 1 : 0) - (b.city === 'Black Market' ? 1 : 0));
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    const itemHead = itemHeadHtml(`calidad: ${QNAMES[currentQuality] || 'Todas'} · precios por ciudad · se actualiza solo cada 60s`);
    const bmRowX = rows.find((r) => r.city === 'Black Market');
    const bmAvg = (marketVolMap['Black Market'] || {}).avg || 0;
    const bmActual = bmRowX ? bmRowX.buy_price_max || 0 : 0;
    const bmEff = bmActual > 0 ? (bmAvg > 0 ? Math.min(bmActual, bmAvg) : bmActual) : 0;
    const minRow = rows.find((r) => r.city !== 'Black Market' && r.sell_price_min === minSell);
    const maxRow = rows.find((r) => r.city !== 'Black Market' && r.sell_price_min === maxSell);
    let bestHtml = '';
    if (minSell && minRow) {
      const taxN = salesTax();
      const opts = [];
      if (bmEff > 0) opts.push({ label: 'véndelo YA al 🏴 Black Market', gross: bmEff, net: bmEff * (1 - taxN), order: 0 });
      if (maxSell && maxRow && maxRow.city !== minRow.city) opts.push({ label: 'pon orden de venta en ' + esc(maxRow.city), gross: maxSell, net: maxSell * (1 - taxN - 0.025), order: 1 });
      opts.sort((a, b) => b.net - a.net);
      if (opts.length) {
        const b = opts[0];
        const gain = b.net - minSell;
        const roi = minSell > 0 ? (gain / minSell) * 100 : 0;
        bestHtml = gain > 0
          ? `<div id="mkt-best" class="clickable" data-buy="${Math.round(minSell)}" data-sell="${Math.round(b.gross)}" data-order="${b.order}" title="Clic para volcar estos números a la calculadora de abajo">💰 <b>Mejor jugada:</b> compra en ${esc(minRow.city)} a <b>${fmt(minSell)}</b> → ${b.label} a <b>${fmt(b.gross)}</b> → tras impuestos te quedan ${fmt(b.net)} = <b>+${fmt(gain)}/ud</b> (ROI ${roiTxt(roi)})</div>`
          : `<div id="mkt-best" class="neg">Sin flip rentable entre ciudades ahora: comprarlo cuesta ${fmt(minSell)} y la mejor venta deja ${fmt(b.net)} neto (${fmt(gain)}/ud)</div>`;
      }
    }
    const QN2 = ['', 'Normal', 'Bueno', 'Notable', 'Sobresaliente', 'Obra maestra'];
    let qualHtml = '';
    if (Array.isArray(marketQuality) && marketQuality.some((x) => x.buy || x.bm)) {
      qualHtml = '<div class="mkt-quality"><div class="mkt-q-title">💎 Por calidad — a cuánto la compras y a cuánto te la paga el 🏴 BM (cada calidad va a su precio)</div>'
        + '<table><thead><tr><th style="text-align:left">Calidad</th><th>Comprar</th><th>BM paga</th><th>Vol/día</th><th>Visto</th></tr></thead><tbody>'
        + marketQuality.map((x) => { const age = agoStr(x.date); const stale = ageHours(x.date) > 24; return `<tr><td class="name">${QN2[x.q]}</td><td class="silver">${x.buy ? fmt(x.buy) : '—'}</td><td class="${x.bm ? 'best-sell' : 'faint'}">${x.bm ? fmt(x.bm) : '—'} ${sostChip(x.bm, x.avg)}</td><td class="${x.vol ? '' : 'faint'}">${x.vol ? fmtInt(x.vol) : '—'}</td><td class="${stale ? 'down' : 'faint'}">${stale ? '⚠ ' : ''}${age || '—'}</td></tr>`; }).join('')
        + '</tbody></table></div>';
    }
    const tableHtml = '<table><thead><tr><th style="text-align:left">Ciudad</th><th title="La oferta de venta más barata: esto pagas si lo compras ya">Comprarlo cuesta</th><th title="La mejor orden de compra: esto te pagan si lo vendes al instante">Venderlo ya te da</th><th title="A cuánto se cierra de verdad (histórico)">Precio medio</th><th>Vol/día</th><th>Visto</th></tr></thead><tbody>'
      + rows.map((r) => {
        const isBM = r.city === 'Black Market';
        const sp = r.sell_price_min;
        const outlier = !isBM && sp > 0 && isSellOutlier(sp);
        let cls = 'silver', mark = '', tip = '';
        if (outlier) { cls = 'faint'; mark = '⚠ '; tip = ' title="Precio atípico (posible orden troll o dato erróneo): excluido del cálculo"'; }
        else if (!isBM && sp > 0 && sp === minSell) { cls = 'best-buy'; mark = '🛒 '; }
        else if (!isBM && sp > 0 && sp === maxSell) { cls = 'best-sell'; mark = '💰 '; }
        const sellCell = (!isBM && sp > 0) ? `<td class="${cls}"${tip}>${mark}${fmt(sp)}</td>` : '<td class="faint">—</td>';
        const bAge = agoStr(r.buy_price_max_date);
        const vc = marketVolMap[cityKey(r.city)] || {}; const vd = vc.daily || 0; const avg = vc.avg || 0;
        // el chip solo tiene sentido con una calidad concreta: en "Todas" el buy_max coge
        // la calidad más cara y el medio es la mezcla → daría un pico falso.
        const chip = (isBM && currentQuality) ? sostChip(r.buy_price_max, avg) : '';
        const fast = r.buy_price_max > 0 ? `<td class="${isBM ? 'best-sell' : 'faint'}" title="la mejor orden de compra: te pagan esto al instante · vista hace ${bAge || '—'}">${isBM ? '🏴 ' : ''}${fmt(r.buy_price_max)}${chip}</td>` : '<td class="faint">—</td>';
        const volCell = vd > 0 ? `<td title="Unidades que se venden al día aquí (estimado, datos de la comunidad)">${fmtInt(vd)}</td>` : '<td class="faint">—</td>';
        const avgCell = avg > 0 ? `<td class="cr-vol-avg" title="Precio medio al que se cierra de verdad (histórico). Aunque la orden esté alta o baja, a esto se vende.">~${fmt(avg)}</td>` : '<td class="faint">—</td>';
        const sAge = agoStr(r.sell_price_min_date);
        const shownAge = isBM ? (bAge || sAge) : (sAge || bAge);
        const shownDate = isBM ? (r.buy_price_max_date || r.sell_price_min_date) : (r.sell_price_min_date || r.buy_price_max_date);
        const stale = !!shownAge && ageHours(shownDate) > 24;
        const liveDot = r._live ? ' <span class="live-dot" title="Visto por TU cliente ahora mismo (captura en vivo)">🟢</span>' : '';
        return `<tr><td class="name">${isBM ? '🏴 Black Market' : esc(r.city)}${liveDot}</td>${sellCell}${fast}${avgCell}${volCell}<td class="${stale ? 'down' : 'faint'}" title="venta ${sAge || '—'} · compra ${bAge || '—'}${stale ? ' · dato de +24h, verifícalo en el juego' : ''}">${stale ? '⚠ ' : ''}${shownAge}</td></tr>`;
      }).join('')
      + '</tbody></table>'
      + bestHtml + qualHtml;
    const holder = document.getElementById('mkt-table');
    if (silent && holder) { holder.innerHTML = tableHtml; return; }
    tabMarket.innerHTML = itemHead + '<div id="mkt-table">' + tableHtml + '</div>' + flipHtml(minSell || 0, maxSell || 0);
    bindFlip();
  }
  function flipHtml(buy, sell) {
    return '<div class="flip"><div class="flip-title">Calculadora de flip</div>'
      + '<div class="cfg-row"><span class="cfg-lbl">Cantidad</span><input type="number" id="flip-qty" value="100" min="1"></div>'
      + `<div class="cfg-row"><span class="cfg-lbl">Comprar a</span><input type="number" id="flip-buy" value="${Math.round(buy)}" min="0"></div>`
      + `<div class="cfg-row"><span class="cfg-lbl">Vender a</span><input type="number" id="flip-sell" value="${Math.round(sell)}" min="0"></div>`
      + '<label class="cfg-check"><input type="checkbox" id="flip-buy-order"> Compra con orden (+2,5%)</label>'
      + '<label class="cfg-check"><input type="checkbox" id="flip-sell-order" checked> Venta con orden (+2,5%)</label>'
      + `<div class="flip-note">impuesto de venta ${Math.round(salesTax() * 100)}% ${salesTax() === 0.04 ? '(premium)' : '(sin premium)'}</div>`
      + '<div id="flip-result" class="flip-result"></div></div>';
  }
  tabMarket.addEventListener('click', (e) => {
    const b = e.target.closest('#mkt-best.clickable'); if (!b) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('flip-buy', b.dataset.buy); set('flip-sell', b.dataset.sell);
    const so = document.getElementById('flip-sell-order'); if (so) so.checked = b.dataset.order === '1';
    calcFlip();
  });
  function bindFlip() {
    ['flip-qty', 'flip-buy', 'flip-sell'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('input', calcFlip); });
    ['flip-buy-order', 'flip-sell-order'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', calcFlip); });
    calcFlip();
  }
  function calcFlip() {
    const v = (id) => { const el = document.getElementById(id); return el ? +el.value || 0 : 0; };
    const chk = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
    const qty = v('flip-qty'), buy = v('flip-buy'), sell = v('flip-sell');
    const buyOrder = chk('flip-buy-order'), sellOrder = chk('flip-sell-order');
    const buySetup = buyOrder ? qty * buy * 0.025 : 0;       // tasa de orden de compra
    const gasto = qty * buy + buySetup;
    const bruto = qty * sell;
    const tax = bruto * salesTax();
    const sellSetup = sellOrder ? bruto * 0.025 : 0;          // tasa de orden de venta
    const neto = bruto - tax - sellSetup;
    const gan = neto - gasto;
    const roi = gasto > 0 ? (gan / gasto) * 100 : 0;
    const res = document.getElementById('flip-result'); if (!res) return;
    res.innerHTML = `Gastas <b class="silver">${fmt(gasto)}</b> · recibes neto <b class="silver">${fmt(neto)}</b>`
      + `<div class="flip-break">impuesto venta ${fmt(tax)}${(buySetup + sellSetup) ? ' · órdenes ' + fmt(buySetup + sellSetup) : ''}</div>`
      + `<div class="flip-gain ${gan >= 0 ? 'up' : 'down'}">${gan >= 0 ? '+' : ''}${fmt(gan)} &nbsp;(ROI ${roiTxt(roi)})</div>`;
  }

  function stopMarketAutoRefresh() { if (marketRefreshT) { clearInterval(marketRefreshT); marketRefreshT = null; } }
  function startMarketAutoRefresh() {
    stopMarketAutoRefresh();
    marketRefreshT = setInterval(() => {
      if (!tabMarket || tabMarket.hidden || !currentBase) return;
      const ae = document.activeElement;
      if (ae && tabMarket.contains(ae)) return;
      loadMarket(true);
    }, 60000);
  }
  startMarketAutoRefresh();

  // ================= CRAFTEO =================
  const REFINABLE = /(PLANKS|METALBAR|LEATHER|CLOTH|STONEBLOCK)/;
  // el retorno de recursos aplica a TODOS los materiales menos artefactos y
  // los aditivos de encantamiento (extracto de alquimia / salsa de pescado).
  const NO_RETURN =/ARTEFACT|QUESTITEM|_TOKEN|_FACTION_|ALCHEMY_EXTRACT|FISHSAUCE|(?:_RUNE|_SOUL|_RELIC|_SHARD_AVALONIAN|_SHARD_CRYSTAL)(?:@\d+)?$/;
  const returnable = (id) => !NO_RETURN.test(id);
  const ench = (id, e) => (e > 0 && REFINABLE.test(id) ? id + '_LEVEL' + e + '@' + e : id);
  const prodEnch = (id, e) => (e > 0 ? id + '@' + e : id);
  const RES_VALUE ={ 2: 4, 3: 8, 4: 16, 5: 32, 6: 64, 7: 128, 8: 256 };
  const tierOf = (id) => { const m = /^T(\d)_/.exec(id); return m ? +m[1] : 0; };
  const itemValueOf = (baseId) => { const rec = recipes[baseId]; if (!rec || !rec.r) return 0; return rec.r.reduce((s, m) => s + (RES_VALUE[tierOf(m.id)] || 0) * m.c, 0); };
  const stationFeeOf = (baseId, ratePer100) => itemValueOf(baseId) * 0.1125 * ((ratePer100 || 0) / 100);
  // materiales de la receta para un encantamiento dado.
  // consumibles (pociones/comida) traen receta explícita por nivel (@1/@2/@3,
  // con extracto/salsa); el resto se deriva encantando los materiales refinables.
  const recipeRows = (baseId, e) => {
    const exact = e > 0 && recipes[baseId + '@' + e];
    if (exact && exact.r) return exact.r.map((m) => ({ nameId: m.id, priceId: m.id, c: m.c }));
    const rec = recipes[baseId];
    if (!rec) return [];
    return rec.r.map((m) => ({ nameId: m.id, priceId: ench(m.id, e), c: m.c }));
  };

  const ALL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien', 'Black Market'];
  const CRAFT_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien']; // mats: sin Black Market
  async function loadCraft() {
    const rec = recipes[currentBase];
    if (!rec) { craftBonus.innerHTML = ''; craftOut.innerHTML = '<div class="mempty">Este item no es crafteable.</div>'; return; }
    const b = cityBonus(currentBase);
    craftBonus.innerHTML = b ? `Craftear en: <b>${b.city}</b> (+15% retorno a ${esc(b.what)})` : 'Sin ciudad con bono específico (artefacto/genérico).';
    craftOut.innerHTML = '<div class="mempty">Cargando precios…</div>';
    // materiales y productos por separado: los materiales son recursos (sin calidad),
    // el producto usa la calidad que crafteas (Normal por defecto), no el máx de todas.
    const matSet = new Set();
    for (let e = 0; e <= 4; e++) { recipeRows(currentBase, e).forEach((m) => { matSet.add(m.priceId); matSet.add(m.nameId); }); }
    const prodIds = []; for (let e = 0; e <= 4; e++) prodIds.push(prodEnch(currentBase, e));
    const prodQ = currentQuality || 1;
    const [matRows, prodRows, vol] = await Promise.all([
      window.overlay.craftPrices([...matSet], ALL_CITIES, 0),
      window.overlay.craftPrices(prodIds, ALL_CITIES, prodQ),
      window.overlay.history(prodIds, ALL_CITIES, 21, 0),
    ]);
    craftPriceMap = {};
    [...(matRows || []), ...(prodRows || [])].forEach((r) => { (craftPriceMap[r.item_id] = craftPriceMap[r.item_id] || {})[cityKey(r.city)] = { sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }; });
    craftVolMap = {};
    (vol || []).forEach((r) => { (craftVolMap[r.item_id] = craftVolMap[r.item_id] || {})[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
    // precio del producto en el BM POR CALIDAD (para el chip anti-pico y la mini-tabla): bm=buy_max, avg=medio realizado
    craftQualMap = {};
    const QS = [1, 2, 3, 4, 5];
    const [qbm, qhist] = await Promise.all([
      Promise.all(QS.map((q) => window.overlay.craftPrices(prodIds, ['Black Market'], q).catch(() => []))),
      Promise.all(QS.map((q) => window.overlay.history(prodIds, ['Black Market'], 21, q).catch(() => []))),
    ]);
    QS.forEach((q, i) => {
      (qbm[i] || []).forEach((r) => { const d = (craftQualMap[r.item_id] = craftQualMap[r.item_id] || {}); const c = (d[q] = d[q] || {}); c.bm = r.buy_price_max || 0; c.date = r.buy_price_max_date || null; });
      (qhist[i] || []).forEach((r) => { const d = (craftQualMap[r.item_id] = craftQualMap[r.item_id] || {}); (d[q] = d[q] || {}).avg = r.avg_price || 0; });
    });
    const feeInp = document.getElementById('craft-fee');
    if (feeInp && feeInp.dataset.auto !== '0') { feeInp.value = Math.round(stationFeeOf(currentBase, stationRate())); feeInp.dataset.auto = '1'; }
    renderCraft();
  }
  const craftCityPrice = (id) => {
    const c = craftPriceMap[id]; if (!c) return 0;
    const city = document.getElementById('craft-city').value;
    if (c[city] && c[city].sell) return c[city].sell;
    const all = Object.values(c).map((x) => x.sell).filter((x) => x > 0);
    const valid = all.filter((v) => !isLoOutlier(v, all));   // ignora precios irrisorios (dato podrido) al coger el más barato
    const use = valid.length ? valid : all;
    return use.length ? Math.min(...use) : 0;
  };
  const bestSellOf = (id, tax, sellFee) => {
    const c = craftPriceMap[id]; if (!c) return { gross: 0, net: 0, city: null, instant: false };
    const citySells = Object.entries(c).filter(([ct, v]) => ct !== 'Black Market' && v.sell > 0).map(([ct, v]) => v.sell);
    let net = -1, gross = 0, city = null, instant = false;
    Object.entries(c).forEach(([ct, v]) => {
      if (ct === 'Black Market') { const b = v.buy || 0; if (b > 0 && !isHiOutlier(b, citySells)) { const n = b * (1 - tax); if (n > net) { net = n; gross = b; city = ct; instant = true; } } }
      else { const s = v.sell || 0; if (s > 0 && !isHiOutlier(s, citySells)) { const n = s * (1 - tax - sellFee); if (n > net) { net = n; gross = s; city = ct; instant = false; } } }
    });
    return { gross, net: Math.max(0, net), city, instant };
  };

  function renderCraft() {
    const rec = recipes[currentBase]; if (!rec) return;
    const tax = salesTax();
    const sellFee = (document.getElementById('craft-sell-order') || {}).checked ? 0.025 : 0;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const fee = +document.getElementById('craft-fee').value || 0;
    const matOrder = !!(document.getElementById('craft-mat-order') || {}).checked;

    // mini comparativa E0-E4 (precios auto, referencia rápida y clicable)
    let best = -Infinity, bestE = -1; const calc = [];
    for (let e = 0; e <= 4; e++) {
      let ret = 0, non = 0, ok = true;
      recipeRows(currentBase, e).forEach((m) => { const u = craftCityPrice(m.priceId); if (!u) ok = false; const c = u * m.c; if (returnable(m.nameId)) ret += c; else non += c; });
      let netMat = ret * (1 - returnR) + non;
      if (matOrder) netMat *= 1.025;
      const netCost = netMat + fee;
      const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
      const profit = (bs.gross && ok) ? bs.net - netCost : null;
      calc.push({ e, profit });
      if (profit != null && profit > best) { best = profit; bestE = e; }
    }
    const mini = calc.map((c) => {
      const cls = c.e === bestE ? 'best-row' : (c.e === currentEnch ? 'sel-row' : '');
      const pc = c.profit == null ? 'faint' : (c.profit >= 0 ? 'up' : 'down');
      return `<button class="cr-mini ${cls}" data-e="${c.e}">E${c.e}<span class="${pc}">${c.profit == null ? '—' : (c.profit >= 0 ? '+' : '') + fmt(c.profit)}</span></button>`;
    }).join('');

    // receta editable del encantamiento seleccionado: por cada material,
    // selector de ciudad (con su precio) + precio editable + subtotal
    const e = currentEnch;
    const defaultCity = document.getElementById('craft-city').value;
    const craftQty = +document.getElementById('craft-qty').value || 1;
    const matRows = recipeRows(currentBase, e).map((m) => {
      const id = m.priceId;
      const cm = craftPriceMap[id] || {};
      const perCity = CRAFT_CITIES.map((c) => ({ c, p: (cm[c] && cm[c].sell) || 0 }));
      const withPrice = perCity.filter((x) => x.p > 0);
      // ciudad por defecto: la global si tiene precio, si no la más barata disponible
      let chosen = perCity.find((x) => x.c === defaultCity && x.p > 0);
      if (!chosen) chosen = withPrice.slice().sort((a, b) => a.p - b.p)[0];
      const chosenCity = chosen ? chosen.c : defaultCity;
      const det = chosen ? chosen.p : 0;
      const opts = perCity.map((x) => `<option value="${x.p}"${x.c === chosenCity ? ' selected' : ''}>${esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}</option>`).join('');
      const enchTag = (e > 0 && REFINABLE.test(m.nameId)) ? '.' + e : '';
      const ret = returnable(m.nameId) ? 1 : 0;
      const mnm = nameById[m.nameId] || m.nameId;
      return `<div class="cr-row" data-c="${m.c}" data-ret="${ret}">`
        + `<span class="cr-name copyable" data-copy="${esc(mnm)}" title="Clic para copiar el nombre">${m.c}× ${esc(mnm)}${enchTag}</span>`
        + `<span class="cr-buy" title="Unidades exactas a comprar de este material para la cantidad indicada">🛒 ${fmtInt(m.c * craftQty)}</span>`
        + `<select class="cr-city" title="Ciudad de compra de este material">${opts}</select>`
        + `<input class="cr-price" type="number" data-c="${m.c}" data-ret="${ret}" value="${Math.round(det)}">`
        + `<span class="cr-subtot silver" title="Subtotal (precio × cantidad)">${fmt(det * m.c)}</span>`
        + `</div>`;
    }).join('');
    const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
    const prodPriceMap = craftPriceMap[prodEnch(currentBase, e)] || {};
    const prodCityRows = ALL_CITIES.map((c) => {
      const isBM = c === 'Black Market';
      const cell = prodPriceMap[c] || {};
      return { c, p: (isBM ? cell.buy : cell.sell) || 0, instant: isBM };
    });
    const chosenSell = bs.city || (prodCityRows.find((x) => x.p > 0) || {}).c || document.getElementById('craft-city').value || '';
    const chosenRow = prodCityRows.find((x) => x.c === chosenSell) || {};
    const prodInstant = !!chosenRow.instant;
    const prodQ = currentQuality || 1;
    const prodAvg = ((craftQualMap[prodEnch(currentBase, e)] || {})[prodQ] || {}).avg || 0;
    const rawProd = chosenRow.p || Math.round(bs.gross) || 0;
    // si vendes al BM y el precio de ahora es un pico, calcula con el MEDIO (sostenible)
    const prodPrice = (prodInstant && prodAvg > 0) ? Math.min(rawProd, prodAvg) : rawProd;
    const prodChip = (prodInstant && prodAvg > 0) ? sostChip(rawProd, prodAvg) : '';
    const prodOpts = prodCityRows.map((x) => `<option value="${x.p}" data-instant="${x.instant ? 1 : 0}" data-city="${esc(x.c)}"${x.c === chosenSell ? ' selected' : ''}>${x.c === 'Black Market' ? '🏴 Black Market' : esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}${x.instant && x.p ? ' ⚡' : ''}</option>`).join('');
    const vmap = craftVolMap[prodEnch(currentBase, e)] || {};
    const vsorted = Object.entries(vmap).filter((x) => (x[1].daily || 0) > 0).sort((a, b) => (b[1].daily || 0) - (a[1].daily || 0));
    const sellCk = cityKey(bs.city || '');
    const volLine = vsorted.length
      ? `<div class="cr-vol" title="Unidades/día que absorbe cada mercado (todas las calidades) · ~ = precio medio al que se vende de verdad (histórico), útil si el precio de orden está bajo/obsoleto">Absorbe/día: ${vsorted.map((x) => `<span class="${x[0] === sellCk ? 'cr-vol-best' : ''}">${cityShort(x[0])} <b>${fmtInt(x[1].daily)}</b>${x[1].avg ? ` <span class="cr-vol-avg" title="precio medio realizado">~${fmt(x[1].avg)}</span>` : ''}</span>`).join(' · ')}</div>`
      : '<div class="cr-vol faint">Volumen/día: sin datos</div>';

    const cq = craftQualMap[prodEnch(currentBase, e)] || {};
    const qualProdHtml = [1, 2, 3, 4, 5].some((q) => (cq[q] || {}).bm)
      ? '<div class="mkt-quality"><div class="mkt-q-title">💎 Vender el producto por calidad — lo que paga el 🏴 BM (al craftear te salen varias)</div><table><thead><tr><th style="text-align:left">Calidad</th><th>BM paga</th><th></th><th>Visto</th></tr></thead><tbody>'
        + [1, 2, 3, 4, 5].map((q) => { const d = cq[q] || {}; if (!d.bm) return ''; const age = agoStr(d.date); const stale = ageHours(d.date) > 24; return `<tr><td class="name">${QNAMES[q]}</td><td class="best-sell">${fmt(d.bm)}</td><td>${sostChip(d.bm, d.avg)}</td><td class="${stale ? 'down' : 'faint'}">${stale ? '⚠ ' : ''}${age || '—'}</td></tr>`; }).join('')
        + '</tbody></table></div>'
      : '';
    craftOut.innerHTML = itemHeadHtml('crafteo · elige materiales y dónde vender')
      + `<div class="cr-mini-row">${mini}</div>`
      + `<div class="cr-recipe" id="cr-mats"><div class="cr-sub">Receta E${e} · elige ciudad y precio por material</div>${matRows}</div>`
      + `<div class="cr-row cr-prod"><span class="cr-name">Vender en ${prodChip}</span><select class="cr-city" id="cr-prod-city" title="Ciudad de venta del producto · precio por ciudad (🏴 Black Market = venta inmediata a su orden de compra)">${prodOpts}</select><input class="cr-price" id="cr-prod-price" type="number" data-instant="${prodInstant ? 1 : 0}" data-sellck="${cityKey(chosenSell || '')}" data-sellcity="${esc(chosenSell || '')}" value="${Math.round(prodPrice)}"></div>`
      + volLine
      + qualProdHtml
      + '<div id="craft-result" class="craft-total"></div>';
    calcResult();
  }

  function calcResult() {
    const rec = recipes[currentBase]; if (!rec) return;
    const result = document.getElementById('craft-result'); if (!result) return;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const tax = salesTax();
    const fee = +document.getElementById('craft-fee').value || 0;
    const qty = +document.getElementById('craft-qty').value || 1;
    const matOrder = !!(document.getElementById('craft-mat-order') || {}).checked;
    const sellFee = (document.getElementById('craft-sell-order') || {}).checked ? 0.025 : 0;
    let ret = 0, non = 0;
    document.querySelectorAll('#cr-mats .cr-row').forEach((row) => {
      const inp = row.querySelector('.cr-price'); if (!inp) return;
      const sub = (+inp.value || 0) * (+inp.dataset.c || 0);
      if (inp.dataset.ret === '1') ret += sub; else non += sub;
      const st = row.querySelector('.cr-subtot'); if (st) st.textContent = fmt(sub);
      const buy = row.querySelector('.cr-buy'); if (buy) buy.textContent = '🛒 ' + fmtInt((+inp.dataset.c || 0) * qty);
    });
    let netMat = ret * (1 - returnR) + non;
    if (matOrder) netMat *= 1.025;
    const netCost = netMat + fee;
    const prod = document.getElementById('cr-prod-price');
    const sellPrice = prod ? +prod.value || 0 : 0;
    const instant = prod && prod.dataset.instant === '1';
    const ventaNeta = sellPrice * (1 - tax - (instant ? 0 : sellFee));
    const profit = ventaNeta - netCost;
    const roi = netCost > 0 ? (profit / netCost) * 100 : 0;
    const pc = profit >= 0 ? 'up' : 'down';
    const suspicious = netCost > 0 && roi > SCAN_MAX_ROI;   // rentabilidad imposible => precio de venta troll/podrido
    const warnHtml = suspicious ? `<div class="cmp-verdict down" style="margin-top:8px">⚠ Precio de venta atípico (ROI ${roiTxt(roi)}): casi seguro un dato erróneo de la API. Verifícalo en el juego antes de invertir.</div>` : '';
    // comparación contra una oferta manual (antigua pestaña Comparar, ahora integrada)
    const offer = +(document.getElementById('cmp-offer') || {}).value || 0;
    let offerHtml = '';
    if (offer > 0) {
      const offerNet = offer * (1 - tax);
      const oGain = offerNet - netCost;
      const oRoi = netCost > 0 ? (oGain / netCost) * 100 : 0;
      const opc = oGain >= 0 ? 'up' : 'down';
      offerHtml = `<div class="cmp-verdict ${opc}" style="margin-top:8px">${oGain >= 0 ? '✅ Renta craftear vs esa oferta' : '❌ No compensa craftear'} · te ofrecen <b>${fmt(offer)}</b> (neto ${fmt(offerNet)}) → <b>${oGain >= 0 ? '+' : ''}${fmt(oGain)}/ud</b> (ROI ${roiTxt(oRoi)})</div>`;
    }
    result.innerHTML = `1 ud → coste <span class="silver">${fmt(netCost)}</span> · venta neta <span class="silver">${fmt(ventaNeta)}</span> · <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit)}</b> (ROI ${roiTxt(roi)})`
      + `<div style="margin-top:5px">Para <b>${qty}</b> uds → inviertes <b class="silver">${fmt(netCost * qty)}</b> · recuperas <b class="silver">${fmt(ventaNeta * qty)}</b> · beneficio <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit * qty)}</b></div>`
      + warnHtml
      + offerHtml;
  }

  // (La antigua pestaña Comparar quedó fusionada en Crafteo: el input "Te ofrecen"
  //  se evalúa dentro de calcResult y muestra el veredicto de rentabilidad.)
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', () => { if (currentBase) calcResult(); }); }

  // ================= ESCÁNER (flip: comprar hecho → revender) =================
  const SELL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien'];
  const SCAN_ENCHANTS = [0, 1, 2, 3, 4]; // el escáner prueba todos y muestra el mejor por item
  const SCAN_CAPTURE = 0.2;
  const SCAN_MAX_ROI = 500; // guarda anti-outlier: un ROI > 500% es casi siempre un precio troll de la API, no una oportunidad real
  const cityKey = (c) => (c === 'Black Market' ? 'Black Market' : String(c).replace(/\s+/g, ''));
  const cityShort = (c) => (c === 'Black Market' ? '🏴 BM' : (c === 'FortSterling' ? 'F.Sterling' : esc(c)));
  const scanStore = {};   // cache por configuración (cat|sell|tier|city) -> datos crudos
  let scanCache = null;    // configuración mostrada ahora mismo
  const scanKey = () => [
    (document.getElementById('scan-sell') || {}).value || 'bm',
    document.getElementById('scan-tier').value,
    document.getElementById('scan-city').value,
    'q' + currentQuality,
  ].join('|');
  // barra de progreso: el backend escanea en un lote (no hay progreso por item),
  // así que es un indicador de actividad que avanza y se completa al llegar los datos.
  let scanProgT = null;
  function startScanProgress() {
    let p = 6;
    const apply = () => {
      const f = document.getElementById('scan-bar-fill'); if (f) f.style.width = p + '%';
      const t = document.getElementById('scan-prog-pct'); if (t) t.textContent = Math.round(p) + '%';
    };
    apply();
    clearInterval(scanProgT);
    scanProgT = setInterval(() => { p += Math.max(0.7, (93 - p) * 0.09); if (p > 93) p = 93; apply(); }, 170);
    return () => {
      clearInterval(scanProgT); scanProgT = null;
      const f = document.getElementById('scan-bar-fill'); if (f) f.style.width = '100%';
      const t = document.getElementById('scan-prog-pct'); if (t) t.textContent = '100%';
    };
  }
  async function runScan() {
    const out = document.getElementById('scan-result');
    const tier = document.getElementById('scan-tier').value;
    const city = document.getElementById('scan-city').value;
    const sellMode = (document.getElementById('scan-sell') || {}).value || 'bm';
    const tiers = tier === 'all' ? ['4', '5', '6', '7', '8'] : [tier];
    const tierOk = (id) => tiers.some((t) => id.startsWith('T' + t + '_'));
    const targets = Object.keys(recipes).filter((id) => id.indexOf('@') < 0 && tierOk(id) && recipes[id] && recipes[id].r);
    if (!targets.length) { out.innerHTML = '<div class="mempty">Sin items para ese tier.</div>'; return; }
    out.innerHTML = `<div class="scan-prog"><div class="lbl"><span>Escaneando ${targets.length} items…</span><b id="scan-prog-pct">0%</b></div><div class="scan-bar"><i id="scan-bar-fill"></i></div></div>`;
    const btn = document.getElementById('scan-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Escaneando…'; }
    const stopProg = startScanProgress();
    const prodSet = new Set();
    targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => prodSet.add(prodEnch(id, e))));
    const prodIds = [...prodSet];
    const sellLocs = sellMode === 'bm' ? ['Black Market'] : SELL_CITIES;
    // rentabilidad: usa la calidad que DE VERDAD compras/flipeas. "Todas" (0) = Normal (1).
    const q = currentQuality || 1;
    try {
      // Flip: comprar el ITEM ya hecho en la ciudad y revenderlo (BM/mercado)
      const [prodRows, volRows] = await Promise.all([
        window.overlay.scanPrices(prodIds, [...new Set([city, ...sellLocs])], q),
        window.overlay.history(prodIds, sellLocs, 21, q),
      ]);
      const buyP = {}, buyDateM = {}, sellP = {}, dateM = {};
      (prodRows || []).forEach((r) => {
        const ck = cityKey(r.city);
        if (ck === cityKey(city)) { buyP[r.item_id] = r.sell_price_min || 0; buyDateM[r.item_id] = r.sell_price_min_date || null; }
        (sellP[r.item_id] = sellP[r.item_id] || {})[ck] = sellMode === 'bm' ? (r.buy_price_max || 0) : (r.sell_price_min || 0);
        (dateM[r.item_id] = dateM[r.item_id] || {})[ck] = sellMode === 'bm' ? (r.buy_price_max_date || null) : (r.sell_price_min_date || null);
      });
      const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
      scanStore[scanKey()] = { targets, buyP, buyDateM, sellP, dateM, volM, sellMode, sellLocs, city };
      scanCache = scanStore[scanKey()];
      stopProg();
      renderScanResults(false);
    } catch (err) {
      stopProg();
      out.innerHTML = '<div class="mempty">Error al escanear (¿límite de la API o sin conexión?). Inténtalo de nuevo en un momento.</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Buscar oportunidades'; }
    }
  }
  function renderScanResults(fromCache) {
    const out = document.getElementById('scan-result'); if (!out || !scanCache) return;
    const { targets, buyP, buyDateM, sellP, dateM, volM, sellMode, sellLocs, city } = scanCache;
    const bmNet = 1 - salesTax();
    const ordNet = 1 - salesTax() - 0.025;
    const res = targets.map((id) => {
      let best = null;
      SCAN_ENCHANTS.forEach((e) => {
        const pid = prodEnch(id, e);
        const netCost = (buyP && buyP[pid]) || 0;
        if (netCost <= 0) return;                  // no se puede comprar el item en esa ciudad
        const prices = sellP[pid] || {}, vols = volM[pid] || {}, dts = (dateM && dateM[pid]) || {};
        sellLocs.forEach((ckRaw) => {
          const ck = cityKey(ckRaw); const price = prices[ck] || 0; if (!price) return;
          const vcell = vols[ck] || {}; const vol = vcell.daily || 0; const avg = vcell.avg || 0;
          const sellPrice = avg > 0 ? Math.min(price, avg) : price;   // valora con el MEDIO sostenible, no el pico de ahora
          const net = sellMode === 'bm' ? sellPrice * bmNet : sellPrice * ordNet;
          const gain = net - netCost;
          const roi = netCost > 0 ? (gain / netCost) * 100 : Infinity;
          if (roi > SCAN_MAX_ROI) return;   // precio outlier (troll/dato podrido), no una oportunidad real
          const eurDay = gain * vol * SCAN_CAPTURE;
          if (!best || eurDay > best.eurDay) best = { id, e, netCost, price, avg, city: ck, gain, vol, eurDay, roi, sellDate: dts[ck] || null, buyDate: (buyDateM && buyDateM[id]) || null };
        });
      });
      return best;
    }).filter(Boolean)
      .sort((a, b) => b.eurDay - a.eurDay)
      .slice(0, 25);
    if (!res.length) { out.innerHTML = '<div class="mempty">Sin oportunidades con datos completos. Prueba otro tier o canal de venta.</div>'; return; }
    const sellHdr = sellMode === 'bm' ? 'BM' : 'Venta';
    const buyCityShort = cityShort(cityKey(city));
    out.innerHTML = '<div class="scan-scroll"><table><thead><tr><th>Item · ench</th><th>Compra</th><th>' + sellHdr + '</th><th>Medio</th><th>Gana</th><th>Vol/día</th><th>€/día</th><th>Visto</th></tr></thead><tbody>'
      + res.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        const where = sellMode === 'bm' ? '🏴 BM' : cityShort(r.city);
        const action = `comprar en ${buyCityShort} → vender ${where}`;
        const staleDate = ageHours(r.buyDate) > ageHours(r.sellDate) ? r.buyDate : r.sellDate;
        const ageTxt = agoStr(staleDate); const stale = ageHours(staleDate) > 24;
        const iconId = prodEnch(r.id, r.e);
        return `<tr><td class="name"><div class="scan-item"><img class="scan-ico" src="https://render.albiononline.com/v1/item/${encodeURIComponent(iconId)}.png?size=40" loading="lazy" alt=""><div class="scan-item-txt"><span class="copyable" data-copy="${esc(nm)}" title="Clic para copiar el nombre">${esc(nm)}</span> <span class="enchtag">.${r.e}</span><br><span class="faint" style="font-size:11px">${action} · ROI ${roiTxt(r.roi)}</span></div></div></td>`
          + `<td class="silver">${fmt(r.netCost)}</td><td class="silver">${fmt(r.price)}${sostChip(r.price, r.avg)}</td>`
          + `<td class="cr-vol-avg" title="precio medio realmente vendido (histórico): con esto se calcula la ganancia, no con el pico de ahora">${r.avg ? '~' + fmt(r.avg) : '—'}</td>`
          + `<td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td>`
          + `<td class="${r.vol > 0 ? '' : 'faint'}" title="Volumen/día (calidad Normal). El €/día usa ~20% de este volumen.">${r.vol > 0 ? fmtInt(r.vol) : '—'}</td>`
          + `<td class="${pc}"><b>${r.eurDay >= 0 ? '+' : ''}${fmt(r.eurDay)}</b></td>`
          + `<td class="${stale ? 'down' : 'faint'}" title="Hace cuánto se vio este precio">${stale ? '⚠ ' : ''}${ageTxt || '—'}</td></tr>`;
      }).join('') + '</tbody></table></div>'
      + `<div class="best-hint">${fromCache ? '<b style="color:#9fd2e0">resultado cacheado</b> · pulsa 🔍 Buscar para actualizar · ' : ''}<b>.N</b> = encantamiento · <b>Gana</b> se calcula con el precio <b>MEDIO</b> (no el pico); el chip ⚠ avisa si la orden de ahora está inflada · €/día = ganancia/ud × <b>~20% del volumen</b>${sellMode === 'bm' ? ' · venta al Black Market (inmediato)' : ' · venta por orden en la mejor ciudad'} · ⚠ = precio >24h. Valida en el juego.</div>`;
  }
  // al cambiar de tier/ciudad/categoría/canal: si ya está cacheado, mostrar al instante (sin API);
  // si no, pedir pulsar Buscar. Solo el botón consulta la API.
  function onScanFilterChange() {
    const out = document.getElementById('scan-result'); if (!out) return;
    const cached = scanStore[scanKey()];
    if (cached) { scanCache = cached; renderScanResults(true); }
    else {
      scanCache = null;
      const tier = document.getElementById('scan-tier').value;
      out.innerHTML = `<div class="mempty">T${tier} sin cachear todavía — pulsa 🔍 Buscar para escanearlo.</div>`;
    }
  }
  ['scan-tier', 'scan-city', 'scan-sell'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', onScanFilterChange); });
  { const sb = document.getElementById('scan-btn'); if (sb) sb.addEventListener('click', runScan); }

  // ================= NIVEL (equipo equivalente más barato por precio × calidad) =================
  // En Albion, +1 encantamiento = +1 tier de item power. T8.0 = T7.1 = T6.2 = T5.3 = T4.4:
  // mismo poder, precios muy distintos. Buscamos la combinación más barata para un nivel dado.
  const LVL_QNAMES = ['Normal', 'Bueno', 'Notable', 'Sobresal.', 'Obra M.'];
  function levelCombos(target) {
    const out = [];
    for (let t = 8; t >= 4; t--) { const e = target - t; if (e >= 0 && e <= 4) out.push({ t, e }); }
    return out;   // de mayor tier (menos ench) a menor tier (más ench)
  }
  let levelCache = null;
  async function loadLevel() {
    const out = document.getElementById('level-result'); if (!out) return;
    if (!currentBase) { out.innerHTML = '<div class="mempty">Busca un item arriba para ver sus versiones equivalentes.</div>'; return; }
    const body = currentBase.replace(/^T\d+_/, '');
    const target = +((document.getElementById('level-target') || {}).value) || 8;
    const cityFilter = (document.getElementById('level-city') || {}).value || '';   // '' = todas (la más barata)
    const combos = levelCombos(target);
    const idOf = (c) => 'T' + c.t + '_' + body + (c.e > 0 ? '@' + c.e : '');
    const ids = combos.map(idOf);
    const locs = cityFilter ? [cityFilter] : ALL_CITIES;
    out.innerHTML = '<div class="mempty">Buscando precios…</div>';
    try {
      const QS = [1, 2, 3, 4, 5];
      const results = await Promise.all(QS.map((q) => window.overlay.scanPrices(ids, locs, q).catch(() => [])));
      const cheapest = {};   // id -> q -> { price, city, date }  (ciudad elegida, o la más barata si "todas")
      QS.forEach((q, i) => {
        (results[i] || []).forEach((r) => {
          const s = r.sell_price_min || 0; if (s <= 0) return;
          const m = (cheapest[r.item_id] = cheapest[r.item_id] || {});
          if (!m[q] || s < m[q].price) m[q] = { price: s, city: cityKey(r.city), date: r.sell_price_min_date || null };
        });
      });
      levelCache = { combos, idOf, cheapest, target, cityFilter };
      renderLevel();
    } catch (_) {
      out.innerHTML = '<div class="mempty">Error al buscar precios. Reinténtalo.</div>';
    }
  }
  function renderLevel() {
    const out = document.getElementById('level-result'); if (!out || !levelCache) return;
    const { combos, idOf, cheapest, target, cityFilter } = levelCache;
    const QS = [1, 2, 3, 4, 5];
    let globalMin = Infinity; const colMin = [Infinity, Infinity, Infinity, Infinity, Infinity];
    combos.forEach((c) => { const m = cheapest[idOf(c)] || {}; QS.forEach((q, qi) => { const cell = m[q]; if (cell) { if (cell.price < colMin[qi]) colMin[qi] = cell.price; if (cell.price < globalMin) globalMin = cell.price; } }); });
    if (!Number.isFinite(globalMin)) { out.innerHTML = '<div class="mempty">Sin precios para nivel ' + target + (cityFilter ? ' en ' + cityShort(cityFilter) : '') + '. Prueba otro nivel/ciudad o valida en el juego.</div>'; return; }
    const rows = combos.map((c) => {
      const m = cheapest[idOf(c)] || {};
      const cells = QS.map((q, qi) => {
        const cell = m[q]; if (!cell) return '<td class="faint">—</td>';
        const cls = cell.price === globalMin ? 'lvl-best' : (cell.price === colMin[qi] ? 'lvl-colbest' : '');
        const stale = ageHours(cell.date) > 24;
        const age = agoStr(cell.date) || 'sin fecha';
        const sub = cityFilter ? age : (age + ' · ' + cityShort(cell.city));
        return `<td class="${cls}"><div class="lvl-price">${fmt(cell.price)}${cell.price === globalMin ? ' ✅' : ''}</div><div class="lvl-age${stale ? ' stale' : ''}">${stale ? '⚠ ' : ''}${sub}</div></td>`;
      }).join('');
      return `<tr><td class="lvl-combo">${c.t}.${c.e}</td>${cells}</tr>`;
    }).join('');
    out.innerHTML = itemHeadHtml('nivel ' + target + ' · ' + (cityFilter ? cityShort(cityFilter) : 'ciudad más barata'))
      + '<div class="scan-scroll"><table class="lvl-table"><thead><tr><th>T.Ench</th>' + LVL_QNAMES.map((n) => `<th>${n}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="best-hint"><b>✅ = lo más barato de todas</b> (mismo poder) · en azul, lo más barato de cada calidad · bajo cada precio, <b>hace cuánto se vio</b>' + (cityFilter ? '' : ' y en qué ciudad') + ' (⚠ = +24h) · precio = comprarlo ya. <b>Valida en el juego.</b></div>';
  }
  ['level-target', 'level-city'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { if (currentBase) loadLevel(); }); });

  // editar precios / config recalcula el resultado sin regenerar la receta (no pierde foco)
  craftOut.addEventListener('input', (ev) => { if (ev.target.classList && ev.target.classList.contains('cr-price')) calcResult(); });
  // cambiar la ciudad de un material → coge su precio en esa ciudad y recalcula
  craftOut.addEventListener('change', (ev) => {
    if (!ev.target.classList || !ev.target.classList.contains('cr-city')) return;
    const row = ev.target.closest('.cr-row'); if (!row) return;
    const inp = row.querySelector('.cr-price'); if (inp) inp.value = Math.round(+ev.target.value || 0);
    if (ev.target.id === 'cr-prod-city' && inp) {
      const opt = ev.target.selectedOptions && ev.target.selectedOptions[0];
      if (opt) { inp.dataset.instant = opt.dataset.instant || '0'; inp.dataset.sellcity = opt.dataset.city || ''; inp.dataset.sellck = cityKey(opt.dataset.city || ''); }
    }
    calcResult();
  });
  craftOut.addEventListener('click', (ev) => {
    const b = ev.target.closest('.cr-mini'); if (!b) return;
    currentEnch = +b.dataset.e;
    document.querySelectorAll('#item-ench button[data-e]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.e === currentEnch)));
    renderCraft();
  });
  { const el = document.getElementById('craft-qty'); if (el) el.addEventListener('input', () => { if (currentBase) calcResult(); }); }
  { const fi = document.getElementById('craft-fee'); if (fi) fi.addEventListener('input', () => { fi.dataset.auto = '0'; if (currentBase) calcResult(); }); }
  { const sr = document.getElementById('station-rate'); if (sr) sr.addEventListener('input', () => {
      const fi = document.getElementById('craft-fee');
      if (fi && fi.dataset.auto !== '0' && currentBase) fi.value = Math.round(stationFeeOf(currentBase, stationRate()));
      if (currentBase) calcResult();
      onScanFilterChange();
    }); }
  ['craft-return', 'craft-mat-order', 'craft-sell-order'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { if (currentBase) calcResult(); }); });
  document.getElementById('craft-city').addEventListener('change', () => { if (currentBase) renderCraft(); });
  { const pt = document.getElementById('premium-toggle'); if (pt) pt.addEventListener('change', () => {
      if (currentBase && marketData) renderMarket();
      if (currentBase && recipes[currentBase]) renderCraft();
      onScanFilterChange();
    }); }

})();
