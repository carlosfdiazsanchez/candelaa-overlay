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
  let marketData = null, craftPriceMap = {}, craftVolMap = {};

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
      const enchSel = document.getElementById('item-ench');
      if (enchSel) enchSel.style.display = (b.dataset.tab === 'craft' || b.dataset.tab === 'scan') ? 'none' : '';
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
      window.overlay.craftPrices([...ids], ALL_CITIES),
      window.overlay.history(prodIds, ALL_CITIES, 21),
    ]);
    craftPriceMap = {};
    (rows || []).forEach((r) => { (craftPriceMap[r.item_id] = craftPriceMap[r.item_id] || {})[r.city] = { sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }; });
    craftVolMap = {};
    (vol || []).forEach((r) => { (craftVolMap[r.item_id] = craftVolMap[r.item_id] || {})[cityKey(r.city)] = r.daily || 0; });
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
      return `<div class="cr-row" data-c="${m.c}" data-ret="${ret}">`
        + `<span class="cr-name">${m.c}× ${esc(nameById[m.nameId] || m.nameId)}${enchTag}</span>`
        + `<span class="cr-buy" title="Unidades exactas a comprar de este material para la cantidad indicada">🛒 ${fmtInt(m.c * craftQty)}</span>`
        + `<select class="cr-city" title="Ciudad de compra de este material">${opts}</select>`
        + `<input class="cr-price" type="number" data-c="${m.c}" data-ret="${ret}" value="${Math.round(det)}">`
        + `<span class="cr-subtot silver" title="Subtotal (precio × cantidad)">${fmt(det * m.c)}</span>`
        + `</div>`;
    }).join('');
    const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
    const prodLabel = bs.city ? `${bs.city === 'Black Market' ? 'Black Market 🏴' : esc(bs.city)} ${bs.instant ? '(inmediato)' : '(orden)'}` : 'sin datos';
    const cityShort = (c) => (c === 'Black Market' ? '🏴 BM' : (c === 'FortSterling' ? 'F.Sterling' : esc(c)));
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
    result.innerHTML = `1 ud → coste <span class="silver">${fmt(netCost)}</span> · venta neta <span class="silver">${fmt(ventaNeta)}</span> · <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit)}</b> (ROI ${roiTxt(roi)})`
      + `<div style="margin-top:5px">Para <b>${qty}</b> uds → inviertes <b class="silver">${fmt(netCost * qty)}</b> · recuperas <b class="silver">${fmt(ventaNeta * qty)}</b> · beneficio <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit * qty)}</b></div>`;
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
    const rowsHtml = recipeRows(currentBase, e).map((m) => {
      const info = priceInfo(m.priceId);
      if (!info.price) missing = true;
      const sub = info.price * m.c; if (returnable(m.nameId)) ret += sub; else non += sub;
      const tag = (e > 0 && REFINABLE.test(m.nameId)) ? '.' + e : '';
      return `<tr><td class="name">${m.c}× ${esc(nameById[m.nameId] || m.nameId)}${tag}</td><td class="${info.price ? 'silver' : 'down'}">${info.price ? fmt(info.price) : '⚠️'}</td><td class="faint">${info.city ? esc(info.city) : '—'}</td><td class="silver">${fmt(sub)}</td></tr>`;
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
      + `<div class="cmp-line">Materiales <b class="silver">${fmt(ret + non)}</b>${matOrder ? ' (orden +2,5%)' : ''} · retorno ${Math.round(returnR * 100)}% (no a artefactos/extracto) → coste neto <b class="silver">${fmt(costeCraft)}</b></div>`
      + `<div class="cmp-line">Te ofrecen <b>${fmt(offer)}</b> → neto <b class="silver">${fmt(offerNet)}</b></div>`
      + `<div class="cmp-verdict ${pc}">${gain >= 0 ? '✅ Rentable craftear' : '❌ No rentable'} · ${gain >= 0 ? '+' : ''}${fmt(gain)}/ud (ROI ${roiTxt(roi)})</div>`
      + `<div class="cmp-line">Para <b>${qty}</b> uds → inviertes <b class="silver">${fmt(costeCraft * qty)}</b> · beneficio <b class="${pc}">${gain >= 0 ? '+' : ''}${fmt(gain * qty)}</b></div>`;
  }
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', renderCompare); }

  // ================= ESCÁNER (craftear y vender) =================
  const GEAR = /_(HEAD|ARMOR|SHOES)_|_2H_|_MAIN_|_OFF_|_CAPE|_BAG/;
  const CONSUMABLE = /_(POTION|MEAL)_/;
  const SELL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien'];
  const SELL_NET = 0.935; // venta por orden: 4% impuesto premium + 2,5% setup de orden
  const SCAN_ENCHANTS = [0, 1, 2, 3]; // el escáner prueba estos y muestra el mejor por item
  const SCAN_RETURN = 0.23; // retorno por defecto (sin foco + ciudad); se afina por item en Crafteo
  const cityKey = (c) => (c === 'Black Market' ? 'Black Market' : String(c).replace(/\s+/g, ''));
  let scanCache = null;
  async function runScan() {
    const out = document.getElementById('scan-result');
    const tier = document.getElementById('scan-tier').value;
    const city = document.getElementById('scan-city').value;
    const sellMode = (document.getElementById('scan-sell') || {}).value || 'bm';
    const cat = (document.getElementById('scan-cat') || {}).value || 'gear';
    const catRe = cat === 'consum' ? CONSUMABLE : (cat === 'all' ? null : GEAR);
    const targets = Object.keys(recipes).filter((id) => id.indexOf('@') < 0 && id.startsWith('T' + tier + '_') && (!catRe || catRe.test(id)) && recipes[id] && recipes[id].r);
    if (!targets.length) { out.innerHTML = '<div class="mempty">Sin items para ese tier/categoría.</div>'; return; }
    out.innerHTML = `<div class="mempty">Escaneando ${targets.length} items… (unos segundos)</div>`;
    const matIds = new Set(), prodSet = new Set();
    targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => { recipeRows(id, e).forEach((m) => matIds.add(m.priceId)); prodSet.add(prodEnch(id, e)); }));
    const prodIds = [...prodSet];
    const sellLocs = sellMode === 'bm' ? ['Black Market'] : SELL_CITIES;
    const [matRows, prodRows, volRows] = await Promise.all([
      window.overlay.scanPrices([...matIds], [city]),
      window.overlay.scanPrices(prodIds, sellLocs),
      window.overlay.history(prodIds, sellLocs, 21),
    ]);
    const matP = {}; (matRows || []).forEach((r) => { matP[r.item_id] = r.sell_price_min || 0; });
    const sellP = {}; (prodRows || []).forEach((r) => { (sellP[r.item_id] = sellP[r.item_id] || {})[cityKey(r.city)] = sellMode === 'bm' ? (r.buy_price_max || 0) : (r.sell_price_min || 0); });
    const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = r.daily || 0; });
    scanCache = { targets, matP, sellP, volM, sellMode, sellLocs };
    renderScanResults();
  }
  function renderScanResults() {
    const out = document.getElementById('scan-result'); if (!out || !scanCache) return;
    const { targets, matP, sellP, volM, sellMode, sellLocs } = scanCache;
    const res = targets.map((id) => {
      let best = null;
      SCAN_ENCHANTS.forEach((e) => {
        let ret = 0, non = 0, ok = true;
        recipeRows(id, e).forEach((m) => { const u = matP[m.priceId] || 0; if (!u) ok = false; const c = u * m.c; if (returnable(m.nameId)) ret += c; else non += c; });
        if (!ok) return;
        const netCost = ret * (1 - SCAN_RETURN) + non; if (netCost <= 0) return;
        const pid = prodEnch(id, e);
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
    if (!res.length) { out.innerHTML = '<div class="mempty">Sin oportunidades con datos completos. Prueba otro tier/ench/categoría.</div>'; return; }
    const sellHdr = sellMode === 'bm' ? 'BM' : 'Venta';
    out.innerHTML = '<table><thead><tr><th>Item</th><th>Coste</th><th>' + sellHdr + '</th><th>Gana</th><th>Vol/día</th><th>€/día</th></tr></thead><tbody>'
      + res.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        const where = sellMode === 'bm' ? '🏴 Black Market' : esc(r.city);
        return `<tr><td class="name">${esc(nm)}${r.e > 0 ? ' <span class="enchtag">.' + r.e + '</span>' : ''}<br><span class="faint" style="font-size:10px">${where} · ROI ${roiTxt(r.roi)} · inv/día ${fmt(r.netCost * r.vol)}</span></td>`
          + `<td class="silver">${fmt(r.netCost)}</td><td class="silver">${fmt(r.price)}</td>`
          + `<td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td>`
          + `<td class="${r.vol > 0 ? '' : 'faint'}">${r.vol > 0 ? fmtInt(r.vol) : '—'}</td>`
          + `<td class="${pc}"><b>${r.eurDay >= 0 ? '+' : ''}${fmt(r.eurDay)}</b></td></tr>`;
      }).join('') + '</tbody></table>'
      + `<div class="best-hint">€/día = ganancia/ud × volumen diario. Volumen estimado de datos de la comunidad → valida en juego. ${sellMode === 'bm' ? 'BM = pago inmediato del Black Market, sin fee de estación.' : 'Venta por orden en la mejor ciudad por €/día.'}</div>`;
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
