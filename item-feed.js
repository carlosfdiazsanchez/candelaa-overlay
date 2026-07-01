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
  let marketData = null, marketVolMap = {}, craftPriceMap = {}, craftVolMap = {};

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
    const matches = items.filter((it) => norm(it.n).includes(q)).slice(0, 14);
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
    });
  });

  // ---------- pestañas ----------
  document.querySelectorAll('#item-tabs .tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#item-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      ['market', 'craft', 'scan', 'ledger'].forEach((t) => { const el = document.getElementById('tab-' + t); if (el) el.hidden = b.dataset.tab !== t; });
      const enchSel = document.getElementById('item-ench');
      if (enchSel) enchSel.style.display = (b.dataset.tab === 'craft' || b.dataset.tab === 'scan' || b.dataset.tab === 'ledger') ? 'none' : '';
      const qSel = document.getElementById('item-quality');
      if (qSel) qSel.style.display = (b.dataset.tab === 'ledger') ? 'none' : '';
      if (b.dataset.tab === 'ledger') renderLedger();
    });
  });

  // ================= MERCADO =================
  async function loadMarket() {
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    tabMarket.innerHTML = '<div class="mempty">Cargando precios…</div>';
    const [prices, vol] = await Promise.all([
      window.overlay.marketPrices(queryId, currentQuality),
      window.overlay.history([queryId], ALL_CITIES, 21),
    ]);
    marketData = prices;
    marketVolMap = {};
    (vol || []).forEach((r) => { marketVolMap[cityKey(r.city)] = r.daily || 0; });
    renderMarket();
  }
  function renderMarket() {
    const rows = (marketData || []).filter((r) => r.sell_price_min > 0 || r.buy_price_max > 0);
    if (!rows.length) { tabMarket.innerHTML = '<div class="mempty">Sin datos de mercado.</div>'; return; }
    const citySells = rows.filter((r) => r.city !== 'Black Market' && r.sell_price_min > 0).map((r) => r.sell_price_min);
    const minSell = citySells.length ? Math.min(...citySells) : null;
    const maxSell = citySells.length ? Math.max(...citySells) : null;
    const ago = (ds) => { if (!ds) return ''; const m = Math.round((Date.now() - new Date(ds + 'Z').getTime()) / 60000); return m < 0 ? '' : (m < 60 ? m + 'm' : (m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd')); };
    // Black Market al final (es venta inmediata al NPC, no sitio para comprar)
    rows.sort((a, b) => (a.city === 'Black Market' ? 1 : 0) - (b.city === 'Black Market' ? 1 : 0));
    tabMarket.innerHTML = '<table><thead><tr><th>Ciudad</th><th>Venta</th><th>Rápida</th><th>Vol/día</th><th>Act.</th></tr></thead><tbody>'
      + rows.map((r) => {
        const isBM = r.city === 'Black Market';
        const sp = r.sell_price_min;
        let cls = 'silver', mark = '';
        if (!isBM && sp > 0 && sp === minSell) { cls = 'best-buy'; mark = '🛒 '; }
        else if (!isBM && sp > 0 && sp === maxSell) { cls = 'best-sell'; mark = '💰 '; }
        const sellCell = (!isBM && sp > 0) ? `<td class="${cls}">${mark}${fmt(sp)}</td>` : '<td class="faint">—</td>';
        const fast = r.buy_price_max > 0 ? `<td class="${isBM ? 'best-sell' : 'faint'}">${isBM ? '🏴 ' : ''}${fmt(r.buy_price_max)}</td>` : '<td class="faint">—</td>';
        const vd = marketVolMap[cityKey(r.city)] || 0;
        const volCell = vd > 0 ? `<td title="Unidades/día que mueve este mercado (estimado, datos de la comunidad)">${fmtInt(vd)}</td>` : '<td class="faint">—</td>';
        return `<tr><td class="name">${isBM ? 'Black Mkt' : esc(r.city)}</td>${sellCell}${fast}${volCell}<td class="faint">${ago(r.sell_price_min_date || r.buy_price_max_date)}</td></tr>`;
      }).join('')
      + '</tbody></table><div class="best-hint">🛒 comprar · 💰 vender (orden) · 🏴 Black Market compra al instante · Vol/día = lo que absorbe cada mercado</div>'
      + flipHtml(minSell || 0, maxSell || 0);
    bindFlip();
  }
  function flipHtml(buy, sell) {
    return '<div class="flip"><div class="flip-title">Calculadora de flip</div>'
      + '<div class="cfg-row"><span class="cfg-lbl">Cantidad</span><input type="number" id="flip-qty" value="100" min="1"></div>'
      + `<div class="cfg-row"><span class="cfg-lbl">Comprar a</span><input type="number" id="flip-buy" value="${Math.round(buy)}" min="0"></div>`
      + `<div class="cfg-row"><span class="cfg-lbl">Vender a</span><input type="number" id="flip-sell" value="${Math.round(sell)}" min="0"></div>`
      + '<label class="cfg-check"><input type="checkbox" id="flip-buy-order"> Compra con orden (+2,5%)</label>'
      + '<label class="cfg-check"><input type="checkbox" id="flip-sell-order" checked> Venta con orden (+2,5%)</label>'
      + '<div class="flip-note">impuesto de venta 4% (premium)</div>'
      + '<div id="flip-result" class="flip-result"></div></div>';
  }
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
    const tax = bruto * 0.04;                                 // impuesto de venta (premium)
    const sellSetup = sellOrder ? bruto * 0.025 : 0;          // tasa de orden de venta
    const neto = bruto - tax - sellSetup;
    const gan = neto - gasto;
    const roi = gasto > 0 ? (gan / gasto) * 100 : 0;
    const res = document.getElementById('flip-result'); if (!res) return;
    res.innerHTML = `Gastas <b class="silver">${fmt(gasto)}</b> · recibes neto <b class="silver">${fmt(neto)}</b>`
      + `<div class="flip-break">impuesto venta ${fmt(tax)}${(buySetup + sellSetup) ? ' · órdenes ' + fmt(buySetup + sellSetup) : ''}</div>`
      + `<div class="flip-gain ${gan >= 0 ? 'up' : 'down'}">${gan >= 0 ? '+' : ''}${fmt(gan)} &nbsp;(ROI ${roiTxt(roi)})</div>`;
  }

  // ================= CRAFTEO =================
  const REFINABLE = /(PLANKS|METALBAR|LEATHER|CLOTH|STONEBLOCK)/;
  // el retorno de recursos aplica a TODOS los materiales menos artefactos y
  // los aditivos de encantamiento (extracto de alquimia / salsa de pescado).
  const NO_RETURN = /ARTEFACT|QUESTITEM|_TOKEN|_FACTION_|ALCHEMY_EXTRACT|FISHSAUCE/;
  const returnable = (id) => !NO_RETURN.test(id);
  const ench = (id, e) => (e > 0 && REFINABLE.test(id) ? id + '@' + e : id);
  const prodEnch = (id, e) => (e > 0 ? id + '@' + e : id);
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
    const ids = new Set();
    for (let e = 0; e <= 4; e++) { ids.add(prodEnch(currentBase, e)); recipeRows(currentBase, e).forEach((m) => { ids.add(m.priceId); ids.add(m.nameId); }); }
    const prodIds = []; for (let e = 0; e <= 4; e++) prodIds.push(prodEnch(currentBase, e));
    const [rows, vol] = await Promise.all([
      window.overlay.craftPrices([...ids], ALL_CITIES, currentQuality),
      window.overlay.history(prodIds, ALL_CITIES, 21),
    ]);
    craftPriceMap = {};
    (rows || []).forEach((r) => { (craftPriceMap[r.item_id] = craftPriceMap[r.item_id] || {})[r.city] = { sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }; });
    craftVolMap = {};
    (vol || []).forEach((r) => { (craftVolMap[r.item_id] = craftVolMap[r.item_id] || {})[cityKey(r.city)] = r.daily || 0; });
    renderCraft();
  }
  const craftCityPrice = (id) => {
    const c = craftPriceMap[id]; if (!c) return 0;
    const city = document.getElementById('craft-city').value;
    if (c[city] && c[city].sell) return c[city].sell;
    const all = Object.values(c).map((x) => x.sell).filter((x) => x > 0);
    return all.length ? Math.min(...all) : 0;
  };
  const bestSellOf = (id, tax, sellFee) => {
    const c = craftPriceMap[id]; if (!c) return { gross: 0, net: 0, city: null, instant: false };
    let net = -1, gross = 0, city = null, instant = false;
    Object.entries(c).forEach(([ct, v]) => {
      if (ct === 'Black Market') { const n = (v.buy || 0) * (1 - tax); if ((v.buy || 0) > 0 && n > net) { net = n; gross = v.buy; city = ct; instant = true; } }
      else { const n = (v.sell || 0) * (1 - tax - sellFee); if ((v.sell || 0) > 0 && n > net) { net = n; gross = v.sell; city = ct; instant = false; } }
    });
    return { gross, net: Math.max(0, net), city, instant };
  };

  function renderCraft() {
    const rec = recipes[currentBase]; if (!rec) return;
    const tax = (+document.getElementById('craft-tax').value || 0) / 100;
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
    const prodLabel = bs.city ? `${bs.city === 'Black Market' ? 'Black Market 🏴' : esc(bs.city)} ${bs.instant ? '(inmediato)' : '(orden)'}` : 'sin datos';
    const vmap = craftVolMap[prodEnch(currentBase, e)] || {};
    const vsorted = Object.entries(vmap).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const sellCk = cityKey(bs.city || '');
    const volLine = vsorted.length
      ? `<div class="cr-vol" title="Unidades/día que absorbe cada mercado (estimado, datos de la comunidad)">Absorbe/día: ${vsorted.map((x) => `<span class="${x[0] === sellCk ? 'cr-vol-best' : ''}">${cityShort(x[0])} <b>${fmtInt(x[1])}</b></span>`).join(' · ')}</div>`
      : '<div class="cr-vol faint">Volumen/día: sin datos</div>';

    craftOut.innerHTML = `<div class="cr-mini-row">${mini}</div>`
      + `<div class="cr-recipe" id="cr-mats"><div class="cr-sub">Receta E${e} · elige ciudad y precio por material</div>${matRows}</div>`
      + `<div class="cr-row cr-prod"><span class="cr-name">Vender en ${prodLabel}</span><input class="cr-price" id="cr-prod-price" type="number" data-instant="${bs.instant ? 1 : 0}" value="${Math.round(bs.gross)}"></div>`
      + volLine
      + '<div id="craft-result" class="craft-total"></div>'
      + '<button class="cr-reg" id="cr-register" title="Guarda esta receta y precios como un lote en el Registro para seguir su P&L real">➕ Registrar este lote en el Registro</button>';
    calcResult();
  }

  function calcResult() {
    const rec = recipes[currentBase]; if (!rec) return;
    const result = document.getElementById('craft-result'); if (!result) return;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const tax = (+document.getElementById('craft-tax').value || 0) / 100;
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
      + offerHtml;
  }

  // (La antigua pestaña Comparar quedó fusionada en Crafteo: el input "Te ofrecen"
  //  se evalúa dentro de calcResult y muestra el veredicto de rentabilidad.)
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', () => { if (currentBase) calcResult(); }); }

  // ================= ESCÁNER (craftear y vender) =================
  const GEAR = /_(HEAD|ARMOR|SHOES)_|_2H_|_MAIN_|_OFF_|_CAPE|_BAG/;
  const CONSUMABLE = /_(POTION|MEAL)_/;
  const SELL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien'];
  const SELL_NET = 0.935; // venta por orden: 4% impuesto premium + 2,5% setup de orden
  const SCAN_ENCHANTS = [0, 1, 2, 3, 4]; // el escáner prueba todos y muestra el mejor por item
  const SCAN_RETURN = 0.23; // retorno por defecto (sin foco + ciudad); se afina por item en Crafteo
  const cityKey = (c) => (c === 'Black Market' ? 'Black Market' : String(c).replace(/\s+/g, ''));
  const cityShort = (c) => (c === 'Black Market' ? '🏴 BM' : (c === 'FortSterling' ? 'F.Sterling' : esc(c)));
  const scanStore = {};   // cache por configuración (cat|sell|tier|city) -> datos crudos
  let scanCache = null;    // configuración mostrada ahora mismo
  const scanKey = () => [
    (document.getElementById('scan-cat') || {}).value || 'gear',
    (document.getElementById('scan-strat') || {}).value || 'craft',
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
    const strat = (document.getElementById('scan-strat') || {}).value || 'craft';
    const cat = (document.getElementById('scan-cat') || {}).value || 'gear';
    const catRe = cat === 'consum' ? CONSUMABLE : (cat === 'all' ? null : GEAR);
    const tiers = tier === 'all' ? ['4', '5', '6', '7', '8'] : [tier];
    const tierOk = (id) => tiers.some((t) => id.startsWith('T' + t + '_'));
    const targets = Object.keys(recipes).filter((id) => id.indexOf('@') < 0 && tierOk(id) && (!catRe || catRe.test(id)) && recipes[id] && recipes[id].r);
    if (!targets.length) { out.innerHTML = '<div class="mempty">Sin items para ese tier/categoría.</div>'; return; }
    out.innerHTML = `<div class="scan-prog"><div class="lbl"><span>Escaneando ${targets.length} items… (${strat === 'flip' ? 'flip' : 'craft'})</span><b id="scan-prog-pct">0%</b></div><div class="scan-bar"><i id="scan-bar-fill"></i></div></div>`;
    const btn = document.getElementById('scan-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Escaneando…'; }
    const stopProg = startScanProgress();
    const prodSet = new Set();
    targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => prodSet.add(prodEnch(id, e))));
    const prodIds = [...prodSet];
    const sellLocs = sellMode === 'bm' ? ['Black Market'] : SELL_CITIES;
    const q = currentQuality;
    try {
      if (strat === 'flip') {
        // Flip: comprar el ITEM ya hecho en la ciudad y revenderlo (BM/mercado)
        const [prodRows, volRows] = await Promise.all([
          window.overlay.scanPrices(prodIds, [...new Set([city, ...sellLocs])], q),
          window.overlay.history(prodIds, sellLocs, 21),
        ]);
        const buyP = {}, sellP = {};
        (prodRows || []).forEach((r) => {
          const ck = cityKey(r.city);
          if (ck === cityKey(city)) buyP[r.item_id] = r.sell_price_min || 0;
          (sellP[r.item_id] = sellP[r.item_id] || {})[ck] = sellMode === 'bm' ? (r.buy_price_max || 0) : (r.sell_price_min || 0);
        });
        const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = r.daily || 0; });
        scanStore[scanKey()] = { targets, buyP, sellP, volM, sellMode, sellLocs, strat, city };
      } else {
        // Craft: comprar materiales, craftear y vender el producto
        const matIds = new Set();
        targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => recipeRows(id, e).forEach((m) => matIds.add(m.priceId))));
        const [matRows, prodRows, volRows] = await Promise.all([
          window.overlay.scanPrices([...matIds], [city], 0),   // materiales: todas las calidades
          window.overlay.scanPrices(prodIds, sellLocs, q),
          window.overlay.history(prodIds, sellLocs, 21),
        ]);
        const matP = {}; (matRows || []).forEach((r) => { matP[r.item_id] = r.sell_price_min || 0; });
        const sellP = {}; (prodRows || []).forEach((r) => { (sellP[r.item_id] = sellP[r.item_id] || {})[cityKey(r.city)] = sellMode === 'bm' ? (r.buy_price_max || 0) : (r.sell_price_min || 0); });
        const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = r.daily || 0; });
        scanStore[scanKey()] = { targets, matP, sellP, volM, sellMode, sellLocs, strat, city };
      }
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
    const { targets, matP, buyP, sellP, volM, sellMode, sellLocs, strat, city } = scanCache;
    const res = targets.map((id) => {
      let best = null;
      SCAN_ENCHANTS.forEach((e) => {
        const pid = prodEnch(id, e);
        let netCost;
        if (strat === 'flip') {
          netCost = (buyP && buyP[pid]) || 0;
          if (netCost <= 0) return;                  // no se puede comprar el item en esa ciudad
        } else {
          let ret = 0, non = 0, ok = true;
          recipeRows(id, e).forEach((m) => { const u = matP[m.priceId] || 0; if (!u) ok = false; const c = u * m.c; if (returnable(m.nameId)) ret += c; else non += c; });
          if (!ok) return;
          netCost = ret * (1 - SCAN_RETURN) + non;
          if (netCost <= 0) return;
        }
        const prices = sellP[pid] || {}, vols = volM[pid] || {};
        sellLocs.forEach((ckRaw) => {
          const ck = cityKey(ckRaw); const price = prices[ck] || 0; if (!price) return;
          const net = sellMode === 'bm' ? price * 0.96 : price * SELL_NET;
          const gain = net - netCost; const vol = vols[ck] || 0; const eurDay = gain * vol;
          if (!best || eurDay > best.eurDay) best = { id, e, netCost, price, city: ck, gain, vol, eurDay, roi: (gain / netCost) * 100 };
        });
      });
      return best;
    }).filter(Boolean)
      .sort((a, b) => b.eurDay - a.eurDay)
      .slice(0, 25);
    if (!res.length) { out.innerHTML = '<div class="mempty">Sin oportunidades con datos completos. Prueba otro tier/estrategia/categoría.</div>'; return; }
    const sellHdr = sellMode === 'bm' ? 'BM' : 'Venta';
    const costHdr = strat === 'flip' ? 'Compra' : 'Craft';
    const buyCityShort = cityShort(cityKey(city));
    out.innerHTML = '<div class="scan-scroll"><table><thead><tr><th>Item · ench</th><th>' + costHdr + '</th><th>' + sellHdr + '</th><th>Gana</th><th>Vol/día</th><th>€/día</th></tr></thead><tbody>'
      + res.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        const where = sellMode === 'bm' ? '🏴 BM' : cityShort(r.city);
        const action = strat === 'flip'
          ? `comprar en ${buyCityShort} → vender ${where}`
          : `mats en ${buyCityShort} → craftear → vender ${where}`;
        return `<tr><td class="name"><span class="copyable" data-copy="${esc(nm)}" title="Clic para copiar el nombre">${esc(nm)}</span> <span class="enchtag">.${r.e}</span>`
          + `<br><span class="faint" style="font-size:11px">${action} · ROI ${roiTxt(r.roi)}</span></td>`
          + `<td class="silver">${fmt(r.netCost)}</td><td class="silver">${fmt(r.price)}</td>`
          + `<td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td>`
          + `<td class="${r.vol > 0 ? '' : 'faint'}">${r.vol > 0 ? fmtInt(r.vol) : '—'}</td>`
          + `<td class="${pc}"><b>${r.eurDay >= 0 ? '+' : ''}${fmt(r.eurDay)}</b></td></tr>`;
      }).join('') + '</tbody></table></div>'
      + `<div class="best-hint">${fromCache ? '<b style="color:#9fd2e0">resultado cacheado</b> · pulsa 🔍 Buscar para actualizar · ' : ''}<b>.N</b> = encantamiento · €/día = ganancia/ud × volumen · ${strat === 'flip' ? 'Flip: comprar el item hecho y revender' : 'Craft: comprar mats, craftear y vender'}${sellMode === 'bm' ? ' al Black Market (inmediato)' : ' por orden en la mejor ciudad'}. Valida en el juego.</div>`;
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
  ['scan-tier', 'scan-city', 'scan-cat', 'scan-sell', 'scan-strat'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', onScanFilterChange); });
  { const sb = document.getElementById('scan-btn'); if (sb) sb.addEventListener('click', runScan); }

  // editar precios / config recalcula el resultado sin regenerar la receta (no pierde foco)
  craftOut.addEventListener('input', (ev) => { if (ev.target.classList && ev.target.classList.contains('cr-price')) calcResult(); });
  // cambiar la ciudad de un material → coge su precio en esa ciudad y recalcula
  craftOut.addEventListener('change', (ev) => {
    if (!ev.target.classList || !ev.target.classList.contains('cr-city')) return;
    const row = ev.target.closest('.cr-row'); if (!row) return;
    const inp = row.querySelector('.cr-price'); if (inp) inp.value = Math.round(+ev.target.value || 0);
    calcResult();
  });
  craftOut.addEventListener('click', (ev) => {
    const b = ev.target.closest('.cr-mini'); if (!b) return;
    currentEnch = +b.dataset.e;
    document.querySelectorAll('#item-ench button[data-e]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.e === currentEnch)));
    renderCraft();
  });
  ['craft-tax', 'craft-fee', 'craft-qty'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => { if (currentBase) calcResult(); }); });
  ['craft-return', 'craft-mat-order', 'craft-sell-order'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { if (currentBase) calcResult(); }); });
  document.getElementById('craft-city').addEventListener('change', () => { if (currentBase) renderCraft(); });

  // ================= REGISTRO (ciclo de vida y P&L real) =================
  const LED_KEY = 'candelaa-ledger-v1';
  const LED_TAX = 0.04, LED_SETUP = 0.025, LED_BATCH = 0.2; // premium 4% + setup 2,5%; tandas ~20% del vol/día
  let ledger = [];
  try { const raw = localStorage.getItem(LED_KEY); if (raw) ledger = JSON.parse(raw) || []; } catch (e) { ledger = []; }
  const ledgerSave = () => { try { localStorage.setItem(LED_KEY, JSON.stringify(ledger)); } catch (e) { } };
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const lotRetention = (ch) => (ch === 'market' ? LED_TAX + LED_SETUP : LED_TAX);

  function computeLot(lot) {
    const mats = Array.isArray(lot.mats) ? lot.mats : [];
    const matCost = mats.reduce((s, m) => s + (+m.qty || 0) * (+m.price || 0), 0);
    const fee = +lot.fee || 0, byprod = +lot.byprod || 0;
    const produced = +lot.produced || 0, sell = +lot.sell || 0;
    let sold = +lot.sold || 0; sold = Math.min(Math.max(sold, 0), produced);
    const remaining = produced - sold;
    const costTotal = matCost + fee - byprod;
    const costPerUnit = produced > 0 ? costTotal / produced : null;
    const unitNet = sell * (1 - lotRetention(lot.channel));
    const unitProfit = costPerUnit == null ? null : unitNet - costPerUnit;
    const profitRealized = unitProfit == null ? 0 : unitProfit * sold;
    const profitPending = unitProfit == null ? 0 : unitProfit * remaining;
    const profitTotal = profitRealized + profitPending;
    const netRemaining = unitNet * remaining;
    const roi = costTotal > 0 ? (profitTotal / costTotal) * 100 : null;
    const pctSold = produced > 0 ? (sold / produced) * 100 : 0;
    const status = (produced > 0 && sold >= produced) ? 'sold' : (sold > 0 ? 'partial' : 'open');
    const loss = (unitProfit != null && unitProfit < 0);
    const volday = +lot.volday || 0;
    const perBatch = volday > 0 ? Math.max(1, Math.round(volday * LED_BATCH)) : 0;
    const batches = (volday > 0 && remaining > 0) ? Math.max(1, Math.ceil(remaining / perBatch)) : 0;
    return { matCost, costTotal, costPerUnit, unitProfit, profitRealized, profitPending, profitTotal, netRemaining, roi, pctSold, status, loss, remaining, produced, sold, perBatch, batches };
  }

  const pcCls = (v) => (v == null ? '' : (v >= 0 ? 'up' : 'down'));
  const signed = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt(v));
  function ledBadge(c) {
    if (c.loss) return '<span class="led-badge warn">⚠ pérdida</span>';
    const t = { open: 'abierto', partial: 'parcial ' + Math.round(c.pctSold) + '%', sold: 'vendido' };
    return `<span class="led-badge ${c.status}">${t[c.status]}</span>`;
  }
  const batchInner = (c) => (c.batches > 0
    ? `Soltar en <b>${c.batches} ${c.batches === 1 ? 'tanda' : 'tandas'}</b> · ≈${fmtInt(c.perBatch)}/tanda (te quedan ${fmtInt(c.remaining)})`
    : '');
  const ledResCells = (c) => `<div class="r"><div class="k">Coste/u</div><div class="v">${c.costPerUnit == null ? '—' : fmt(c.costPerUnit)}</div></div>`
    + `<div class="r"><div class="k">Bº/u</div><div class="v ${pcCls(c.unitProfit)}">${signed(c.unitProfit)}</div></div>`
    + `<div class="r"><div class="k">ROI</div><div class="v ${pcCls(c.roi)}">${roiTxt(c.roi)}</div></div>`;

  function ledInp(lbl, f, v, i) { return `<label class="led-f"><span class="lbl">${lbl}</span><input data-lf="${f}" data-i="${i}" type="number" min="0" step="any" value="${v == null || v === '' ? '' : v}"></label>`; }
  function ledTxt(lbl, f, v, i) { return `<label class="led-f"><span class="lbl">${lbl}</span><input data-lf="${f}" data-i="${i}" type="text" value="${esc(v || '')}"></label>`; }
  function ledSel(lbl, f, v, i) {
    const opts = [['bm', 'Mercado negro'], ['market', 'Mercado normal']].map(([val, t]) => `<option value="${val}"${(v || 'bm') === val ? ' selected' : ''}>${t}</option>`).join('');
    return `<label class="led-f"><span class="lbl">${lbl}</span><select data-lf="${f}" data-i="${i}">${opts}</select></label>`;
  }

  function ledLotHtml(lot, i) {
    const c = computeLot(lot);
    const cls = 'led-lot' + (c.status === 'sold' ? ' done' : '') + (c.loss ? ' loss' : '');
    const head = `<div class="led-head" data-act="toggle" data-i="${i}">`
      + `<span class="nm">${esc(lot.name || '(sin nombre)')}</span>`
      + `<span data-badge>${ledBadge(c)}</span>`
      + `<span class="pl ${c.profitTotal >= 0 ? 'up' : 'down'}">${signed(c.profitTotal)}</span>`
      + `</div>`;
    if (!lot.exp) return `<div class="${cls}" data-i="${i}">${head}</div>`;
    const mats = (Array.isArray(lot.mats) ? lot.mats : []).map((m, j) =>
      `<div class="led-mat" data-j="${j}">`
      + `<input class="mn" data-mf="name" data-i="${i}" data-j="${j}" value="${esc(m.name || '')}" placeholder="material">`
      + `<input data-mf="qty" data-i="${i}" data-j="${j}" type="number" min="0" step="any" value="${m.qty == null || m.qty === '' ? '' : m.qty}" title="cantidad total">`
      + `<input data-mf="price" data-i="${i}" data-j="${j}" type="number" min="0" step="any" value="${m.price == null || m.price === '' ? '' : m.price}" title="precio/u">`
      + `<span class="x" data-act="delmat" data-i="${i}" data-j="${j}" title="quitar material">✕</span>`
      + `</div>`).join('');
    const body = `<div class="led-body">`
      + ledTxt('Nombre / producto', 'name', lot.name, i)
      + `<div class="led-mats">${mats}<button class="led-mini" data-act="addmat" data-i="${i}">+ material</button></div>`
      + `<div class="led-grid">`
      + ledSel('Canal de venta', 'channel', lot.channel, i)
      + ledTxt('Fecha', 'date', lot.date, i)
      + ledInp('Tasa estación (total)', 'fee', lot.fee, i)
      + ledInp('Crédito devolución', 'byprod', lot.byprod, i)
      + ledInp('Unidades producidas', 'produced', lot.produced, i)
      + ledInp('Vendidas', 'sold', lot.sold, i)
      + ledInp('Precio venta/u', 'sell', lot.sell, i)
      + ledInp('Vol/día (BM)', 'volday', lot.volday, i)
      + `</div>`
      + `<div class="led-res">${ledResCells(c)}</div>`
      + `<div class="led-batch" data-batch>${batchInner(c)}</div>`
      + `<div class="led-row-btns">`
      + `<button class="led-mini" data-act="sold" data-i="${i}">✓ Vender todo</button>`
      + `<button class="led-mini del" data-act="del" data-i="${i}">🗑 Borrar lote</button>`
      + `</div>`
      + `</div>`;
    return `<div class="${cls}" data-i="${i}">${head}${body}</div>`;
  }

  function renderLedSummary() {
    const el = document.getElementById('led-summary'); if (!el) return;
    const rows = ledger.map(computeLot);
    const cap = rows.reduce((s, c) => s + (c.costTotal || 0), 0);
    const real = rows.reduce((s, c) => s + (c.profitRealized || 0), 0);
    const pend = rows.reduce((s, c) => s + (c.profitPending || 0), 0);
    const proj = real + pend;
    const roi = cap > 0 ? (proj / cap) * 100 : null;
    el.innerHTML = '<div class="led-sum">'
      + `<div class="led-kpi"><div class="k">Invertido</div><div class="v">${fmt(cap)}</div></div>`
      + `<div class="led-kpi"><div class="k">Bº cobrado</div><div class="v ${pcCls(real)}">${signed(real)}</div></div>`
      + `<div class="led-kpi"><div class="k">Bº pendiente</div><div class="v ${pcCls(pend)}">${signed(pend)}</div></div>`
      + `<div class="led-kpi"><div class="k">Bº proyectado</div><div class="v ${pcCls(proj)}">${signed(proj)}</div></div>`
      + `<div class="led-kpi"><div class="k">ROI proyect.</div><div class="v ${pcCls(roi)}">${roiTxt(roi)}</div></div>`
      + `<div class="led-kpi"><div class="k">Lotes</div><div class="v">${ledger.length}</div></div>`
      + '</div>';
  }
  function renderLedList() {
    const host = document.getElementById('led-list'); if (!host) return;
    host.innerHTML = ledger.length
      ? ledger.map((lot, i) => ledLotHtml(lot, i)).join('')
      : '<div class="mempty">Sin lotes todavía. Pulsa “+ Nuevo lote manual”, o “➕ Registrar este lote” desde la pestaña Crafteo.</div>';
  }
  function renderLedger() { renderLedSummary(); renderLedList(); }

  function refreshLotDisplay(i) {
    const lotEl = document.querySelector(`#led-list .led-lot[data-i="${i}"]`); if (!lotEl) return;
    const c = computeLot(ledger[i]);
    lotEl.classList.toggle('done', c.status === 'sold');
    lotEl.classList.toggle('loss', !!c.loss);
    const head = lotEl.querySelector('.led-head');
    if (head) {
      const nm = head.querySelector('.nm'); if (nm) nm.textContent = ledger[i].name || '(sin nombre)';
      const bd = head.querySelector('[data-badge]'); if (bd) bd.innerHTML = ledBadge(c);
      const pl = head.querySelector('.pl'); if (pl) { pl.className = 'pl ' + (c.profitTotal >= 0 ? 'up' : 'down'); pl.textContent = signed(c.profitTotal); }
    }
    const res = lotEl.querySelector('.led-res'); if (res) res.innerHTML = ledResCells(c);
    const bt = lotEl.querySelector('[data-batch]'); if (bt) bt.innerHTML = batchInner(c);
    renderLedSummary();
  }

  const ledList = document.getElementById('led-list');
  if (ledList) {
    const onEdit = (e) => {
      const t = e.target;
      if (t.matches && t.matches('[data-lf]')) { ledger[+t.dataset.i][t.dataset.lf] = t.value; refreshLotDisplay(+t.dataset.i); ledgerSave(); }
      else if (t.matches && t.matches('[data-mf]')) { ledger[+t.dataset.i].mats[+t.dataset.j][t.dataset.mf] = t.value; refreshLotDisplay(+t.dataset.i); ledgerSave(); }
    };
    ledList.addEventListener('input', onEdit);
    ledList.addEventListener('change', onEdit);
    ledList.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act, i = +a.dataset.i;
      if (act === 'toggle') { ledger[i].exp = !ledger[i].exp; ledgerSave(); renderLedList(); }
      else if (act === 'addmat') { if (!Array.isArray(ledger[i].mats)) ledger[i].mats = []; ledger[i].mats.push({ name: '', qty: '', price: '' }); ledgerSave(); renderLedList(); }
      else if (act === 'delmat') { ledger[i].mats.splice(+a.dataset.j, 1); ledgerSave(); renderLedList(); }
      else if (act === 'del') { ledger.splice(i, 1); ledgerSave(); renderLedger(); }
      else if (act === 'sold') { ledger[i].sold = +ledger[i].produced || 0; ledgerSave(); renderLedList(); renderLedSummary(); }
    });
  }
  { const b = document.getElementById('led-add'); if (b) b.addEventListener('click', () => { ledger.unshift({ name: '', channel: 'bm', date: todayStr(), mats: [{ name: '', qty: '', price: '' }], fee: '', byprod: '', produced: '', sold: 0, sell: '', volday: '', exp: true }); ledgerSave(); renderLedger(); }); }
  { const b = document.getElementById('led-clear-sold'); if (b) b.addEventListener('click', () => { const n = ledger.length; ledger = ledger.filter((l) => computeLot(l).status !== 'sold'); if (ledger.length !== n) { ledgerSave(); renderLedger(); } }); }
  { const b = document.getElementById('led-export'); if (b) b.addEventListener('click', () => { const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'candelaa-registro.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); }

  // registrar el lote actual desde la pestaña Crafteo (snapshot de receta + precios)
  function addLotFromCraft() {
    if (!currentBase || !recipes[currentBase]) return;
    const craftQty = +document.getElementById('craft-qty').value || 1;
    const feePer = +document.getElementById('craft-fee').value || 0;
    const mats = [];
    document.querySelectorAll('#cr-mats .cr-row').forEach((row) => {
      const nameEl = row.querySelector('.cr-name'); const priceEl = row.querySelector('.cr-price');
      const per = +(priceEl && priceEl.dataset.c) || +row.dataset.c || 0;
      mats.push({ name: nameEl ? (nameEl.dataset.copy || nameEl.textContent.replace(/^\d+×\s*/, '')) : '', qty: per * craftQty, price: priceEl ? (+priceEl.value || 0) : 0 });
    });
    const prod = document.getElementById('cr-prod-price');
    const sell = prod ? (+prod.value || 0) : 0;
    const channel = (prod && prod.dataset.instant === '1') ? 'bm' : 'market';
    let volday = 0; const vmap = craftVolMap[prodEnch(currentBase, currentEnch)] || {};
    const vvals = Object.values(vmap).filter((x) => x > 0); if (vvals.length) volday = Math.max(...vvals);
    const name = currentName + (currentEnch > 0 ? ` .${currentEnch}` : '');
    ledger.unshift({ name, channel, date: todayStr(), mats, fee: feePer * craftQty, byprod: '', produced: craftQty, sold: 0, sell, volday, exp: true });
    ledgerSave();
    const lt = document.querySelector('#item-tabs .tab-btn[data-tab="ledger"]'); if (lt) lt.click();
    toast('✓ Lote añadido al Registro');
  }
  craftOut.addEventListener('click', (ev) => { if (ev.target.closest('#cr-register')) addLotFromCraft(); });
})();
