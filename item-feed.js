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
  let currentBase = null, currentName = '', currentEnch = 0;
  let marketData = null, craftPriceMap = {};

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
      if (currentBase) { const co = document.getElementById('cmp-offer'); if (co) co.value = ''; search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : ''); loadMarket(); renderCraft(); renderCompare(); }
    });
  });

  // ---------- pestañas ----------
  document.querySelectorAll('#item-tabs .tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#item-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      ['market', 'craft', 'compare', 'scan'].forEach((t) => { const el = document.getElementById('tab-' + t); if (el) el.hidden = b.dataset.tab !== t; });
      if (b.dataset.tab === 'compare') renderCompare();
    });
  });

  // ================= MERCADO =================
  async function loadMarket() {
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    tabMarket.innerHTML = '<div class="mempty">Cargando precios…</div>';
    marketData = await window.overlay.marketPrices(queryId);
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
    tabMarket.innerHTML = '<table><thead><tr><th>Ciudad</th><th>Venta</th><th>Rápida</th><th>Act.</th></tr></thead><tbody>'
      + rows.map((r) => {
        const isBM = r.city === 'Black Market';
        const sp = r.sell_price_min;
        let cls = 'silver', mark = '';
        if (!isBM && sp > 0 && sp === minSell) { cls = 'best-buy'; mark = '🛒 '; }
        else if (!isBM && sp > 0 && sp === maxSell) { cls = 'best-sell'; mark = '💰 '; }
        const sellCell = (!isBM && sp > 0) ? `<td class="${cls}">${mark}${fmt(sp)}</td>` : '<td class="faint">—</td>';
        const fast = r.buy_price_max > 0 ? `<td class="${isBM ? 'best-sell' : 'faint'}">${isBM ? '🏴 ' : ''}${fmt(r.buy_price_max)}</td>` : '<td class="faint">—</td>';
        return `<tr><td class="name">${isBM ? 'Black Mkt' : esc(r.city)}</td>${sellCell}${fast}<td class="faint">${ago(r.sell_price_min_date || r.buy_price_max_date)}</td></tr>`;
      }).join('')
      + '</tbody></table><div class="best-hint">🛒 comprar · 💰 vender (orden) · 🏴 Black Market compra al instante</div>'
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
  const ench = (id, e) => (e > 0 && REFINABLE.test(id) ? id + '@' + e : id);
  const prodEnch = (id, e) => (e > 0 ? id + '@' + e : id);

  const ALL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien', 'Black Market'];
  const CRAFT_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien']; // mats: sin Black Market
  async function loadCraft() {
    const rec = recipes[currentBase];
    if (!rec) { craftBonus.innerHTML = ''; craftOut.innerHTML = '<div class="mempty">Este item no es crafteable.</div>'; return; }
    const b = cityBonus(currentBase);
    craftBonus.innerHTML = b ? `Craftear en: <b>${b.city}</b> (+15% retorno a ${esc(b.what)})` : 'Sin ciudad con bono específico (artefacto/genérico).';
    craftOut.innerHTML = '<div class="mempty">Cargando precios…</div>';
    const ids = new Set();
    for (let e = 0; e <= 4; e++) { ids.add(prodEnch(currentBase, e)); rec.r.forEach((m) => { ids.add(ench(m.id, e)); ids.add(m.id); }); }
    const rows = await window.overlay.craftPrices([...ids], ALL_CITIES);
    craftPriceMap = {};
    (rows || []).forEach((r) => { (craftPriceMap[r.item_id] = craftPriceMap[r.item_id] || {})[r.city] = { sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }; });
    renderCraft();
    renderCompare();
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
      rec.r.forEach((m) => { const u = craftCityPrice(ench(m.id, e)); if (!u) ok = false; const c = u * m.c; if (REFINABLE.test(m.id)) ret += c; else non += c; });
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
    const matRows = rec.r.map((m) => {
      const id = ench(m.id, e);
      const cm = craftPriceMap[id] || {};
      const perCity = CRAFT_CITIES.map((c) => ({ c, p: (cm[c] && cm[c].sell) || 0 }));
      const withPrice = perCity.filter((x) => x.p > 0);
      // ciudad por defecto: la global si tiene precio, si no la más barata disponible
      let chosen = perCity.find((x) => x.c === defaultCity && x.p > 0);
      if (!chosen) chosen = withPrice.slice().sort((a, b) => a.p - b.p)[0];
      const chosenCity = chosen ? chosen.c : defaultCity;
      const det = chosen ? chosen.p : 0;
      const opts = perCity.map((x) => `<option value="${x.p}"${x.c === chosenCity ? ' selected' : ''}>${esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}</option>`).join('');
      const enchTag = (e > 0 && REFINABLE.test(m.id)) ? '.' + e : '';
      const ret = REFINABLE.test(m.id) ? 1 : 0;
      return `<div class="cr-row" data-c="${m.c}" data-ret="${ret}">`
        + `<span class="cr-name">${m.c}× ${esc(nameById[m.id] || m.id)}${enchTag}</span>`
        + `<select class="cr-city" title="Ciudad de compra de este material">${opts}</select>`
        + `<input class="cr-price" type="number" data-c="${m.c}" data-ret="${ret}" value="${Math.round(det)}">`
        + `<span class="cr-subtot silver" title="Subtotal (precio × cantidad)">${fmt(det * m.c)}</span>`
        + `</div>`;
    }).join('');
    const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
    const prodLabel = bs.city ? `${bs.city === 'Black Market' ? 'Black Market 🏴' : esc(bs.city)} ${bs.instant ? '(inmediato)' : '(orden)'}` : 'sin datos';

    craftOut.innerHTML = `<div class="cr-mini-row">${mini}</div>`
      + `<div class="cr-recipe" id="cr-mats"><div class="cr-sub">Receta E${e} · elige ciudad y precio por material</div>${matRows}</div>`
      + `<div class="cr-row cr-prod"><span class="cr-name">Vender en ${prodLabel}</span><input class="cr-price" id="cr-prod-price" type="number" data-instant="${bs.instant ? 1 : 0}" value="${Math.round(bs.gross)}"></div>`
      + '<div id="craft-result" class="craft-total"></div>';
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
    result.innerHTML = `1 ud → coste <span class="silver">${fmt(netCost)}</span> · venta neta <span class="silver">${fmt(ventaNeta)}</span> · <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit)}</b> (ROI ${roiTxt(roi)})`
      + `<div style="margin-top:5px">Para <b>${qty}</b> uds: <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit * qty)}</b></div>`;
  }

  // ================= COMPARAR (oferta vs craftear) =================
  function renderCompare() {
    const out = document.getElementById('cmp-result'); if (!out) return;
    if (!currentBase) { out.innerHTML = '<div class="mempty">Busca un item primero.</div>'; return; }
    const rec = recipes[currentBase];
    if (!rec) { out.innerHTML = '<div class="mempty">Este item no es crafteable.</div>'; return; }
    const e = currentEnch;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const tax = (+document.getElementById('craft-tax').value || 0) / 100;
    const fee = +document.getElementById('craft-fee').value || 0;
    const qty = +document.getElementById('craft-qty').value || 1;
    const matOrder = !!(document.getElementById('craft-mat-order') || {}).checked;
    const craftCity = document.getElementById('craft-city').value;
    // precio del material + de qué ciudad sale (sin mezclar encantamientos)
    const priceInfo = (id) => {
      const c = craftPriceMap[id]; if (!c) return { price: 0, city: null };
      if (c[craftCity] && c[craftCity].sell) return { price: c[craftCity].sell, city: craftCity };
      let best = { price: 0, city: null };
      Object.entries(c).forEach(([ct, v]) => { if (ct !== 'Black Market' && v.sell > 0 && (best.price === 0 || v.sell < best.price)) best = { price: v.sell, city: ct }; });
      return best;
    };
    let ret = 0, non = 0, missing = false;
    const rowsHtml = rec.r.map((m) => {
      const id = ench(m.id, e);
      const info = priceInfo(id);
      if (!info.price) missing = true;
      const sub = info.price * m.c; if (REFINABLE.test(m.id)) ret += sub; else non += sub;
      const tag = (e > 0 && REFINABLE.test(m.id)) ? '.' + e : '';
      return `<tr><td class="name">${m.c}× ${esc(nameById[m.id] || m.id)}${tag}</td><td class="${info.price ? 'silver' : 'down'}">${info.price ? fmt(info.price) : '⚠️'}</td><td class="faint">${info.city ? esc(info.city) : '—'}</td><td class="silver">${fmt(sub)}</td></tr>`;
    }).join('');
    let netMat = ret * (1 - returnR) + non;
    if (matOrder) netMat *= 1.025;
    const costeCraft = netMat + fee;
    const offerInput = document.getElementById('cmp-offer');
    const bm = craftPriceMap[prodEnch(currentBase, e)] && craftPriceMap[prodEnch(currentBase, e)]['Black Market'];
    if (offerInput && !offerInput.value && bm && bm.buy) offerInput.value = Math.round(bm.buy);
    const offer = offerInput ? +offerInput.value || 0 : 0;
    const offerNet = offer * (1 - tax);
    const gain = offerNet - costeCraft;
    const roi = costeCraft > 0 ? (gain / costeCraft) * 100 : 0;
    const pc = gain >= 0 ? 'up' : 'down';
    out.innerHTML = `<div class="cr-sub">Receta E${e} · precio de venta por ciudad</div>`
      + `<table><thead><tr><th>Material</th><th>P.unit</th><th>Ciudad</th><th>Subtot.</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
      + (missing ? '<div class="cmp-line down">⚠️ Falta el precio de algún material en E' + e + ' → el coste real es MAYOR. No te fíes del resultado.</div>' : '')
      + `<div class="cmp-line">Materiales <b class="silver">${fmt(ret + non)}</b>${matOrder ? ' (orden +2,5%)' : ''} · retorno ${Math.round(returnR * 100)}% solo a refinados → coste neto <b class="silver">${fmt(costeCraft)}</b></div>`
      + `<div class="cmp-line">Te ofrecen <b>${fmt(offer)}</b> → neto <b class="silver">${fmt(offerNet)}</b></div>`
      + `<div class="cmp-verdict ${pc}">${gain >= 0 ? '✅ Rentable craftear' : '❌ No rentable'} · ${gain >= 0 ? '+' : ''}${fmt(gain)}/ud (ROI ${roiTxt(roi)})</div>`
      + `<div class="cmp-line">Para <b>${qty}</b> uds: <b class="${pc}">${gain >= 0 ? '+' : ''}${fmt(gain * qty)}</b></div>`;
  }
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', renderCompare); }

  // ================= ESCÁNER (craftear vs Black Market) =================
  const GEAR = /_(HEAD|ARMOR|SHOES)_|_2H_|_MAIN_|_OFF_|_CAPE|_BAG/;
  async function runScan() {
    const out = document.getElementById('scan-result');
    const tier = document.getElementById('scan-tier').value;
    const e = +document.getElementById('scan-ench').value;
    const returnR = (+document.getElementById('scan-return').value || 0) / 100;
    const city = document.getElementById('scan-city').value;
    const targets = Object.keys(recipes).filter((id) => id.startsWith('T' + tier + '_') && GEAR.test(id));
    if (!targets.length) { out.innerHTML = '<div class="mempty">Sin items para ese tier.</div>'; return; }
    out.innerHTML = `<div class="mempty">Escaneando ${targets.length} items… (unos segundos)</div>`;
    const matIds = new Set(); targets.forEach((id) => recipes[id].r.forEach((m) => matIds.add(ench(m.id, e))));
    const prodIds = targets.map((id) => prodEnch(id, e));
    const [matRows, prodRows] = await Promise.all([
      window.overlay.scanPrices([...matIds], [city]),
      window.overlay.scanPrices(prodIds, ['Black Market']),
    ]);
    const matP = {}; (matRows || []).forEach((r) => { matP[r.item_id] = r.sell_price_min || 0; });
    const bmP = {}; (prodRows || []).forEach((r) => { bmP[r.item_id] = r.buy_price_max || 0; });
    const res = targets.map((id) => {
      let ret = 0, non = 0, ok = true;
      recipes[id].r.forEach((m) => { const u = matP[ench(m.id, e)] || 0; if (!u) ok = false; const c = u * m.c; if (REFINABLE.test(m.id)) ret += c; else non += c; });
      const netCost = ret * (1 - returnR) + non;   // retorno solo a refinados
      const bm = bmP[prodEnch(id, e)] || 0;
      const gain = (bm && ok) ? bm * 0.96 - netCost : null;   // BM neto (4% impuesto) − coste
      const roi = (gain != null && netCost > 0) ? (gain / netCost) * 100 : null;
      return { id, netCost, bm, gain, roi };
    }).filter((r) => r.gain != null && r.bm > 0 && r.netCost > 0).sort((a, b) => b.gain - a.gain).slice(0, 20);
    if (!res.length) { out.innerHTML = '<div class="mempty">Sin oportunidades con datos completos. Prueba otro tier/ench.</div>'; return; }
    out.innerHTML = '<table><thead><tr><th>Item</th><th>Coste</th><th>BM</th><th>Gana</th><th>ROI</th></tr></thead><tbody>'
      + res.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        return `<tr><td class="name">${esc(nm)} <span class="enchtag">.${e}</span></td><td class="silver">${fmt(r.netCost)}</td><td class="silver">${fmt(r.bm)}</td><td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td><td class="${pc}">${roiTxt(r.roi)}</td></tr>`;
      }).join('') + '</tbody></table><div class="best-hint">BM = lo que paga el Black Market (inmediato). Sin fee de estación. Valida en el juego.</div>';
  }
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
})();
