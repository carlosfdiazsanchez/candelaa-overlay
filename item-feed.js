// Item feed (unificado): un buscador + encantamiento, dos pestañas:
//  - Mercado: precios por ciudad (resalta comprar/vender) + calculadora de flip.
//  - Crafteo: mejor ciudad por bono, receta y rentabilidad comparada E0-E4.
// Todas las peticiones HTTP van por el proceso main (sin CORS).

(function () {
  const search = document.getElementById('item-search');
  const results = document.getElementById('item-results');
  const tabMarket = document.getElementById('tab-market');
  const craftOut = document.getElementById('craft-out');
  if (!search) return;

  let items = [], nameById = {}, recipes = {}, focusData = {};
  let currentBase = null, currentName = '', currentEnch = 0, currentQuality = 0;
  let marketData = null, marketVolMap = {}, craftPriceMap = {}, craftVolMap = {}, marketRefreshT = null, marketQuality = null;

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
  const DEFAULT_STATION_RATE = 400;
  const stationRate = () => { const el = document.getElementById('station-rate'); return el ? (+el.value || 0) : DEFAULT_STATION_RATE; };
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
    const fr = document.getElementById('mkt-fresh'); if (fr && c.freshMaxH != null) fr.value = String(c.freshMaxH);
    const sc = document.getElementById('craft-station-city'); if (sc && c.stationCity != null) sc.value = c.stationCity;
    const fo = document.getElementById('craft-focus'); if (fo && typeof c.focus === 'boolean') fo.checked = c.focus;
    const fa = document.getElementById('craft-focus-avail'); if (fa && c.focusAvail != null) fa.value = String(c.focusAvail);
    const sm = document.getElementById('craft-session-mode'); if (sm && c.sessionMode) sm.value = c.sessionMode;
    const mg = document.getElementById('craft-margin'); if (mg && c.margin != null) mg.value = String(c.margin);
  })();
  function saveCfg() {
    const pt = document.getElementById('premium-toggle'); const sr = document.getElementById('station-rate');
    const fr = document.getElementById('mkt-fresh'); const sc = document.getElementById('craft-station-city');
    const fo = document.getElementById('craft-focus');
    const fa = document.getElementById('craft-focus-avail'); const sm = document.getElementById('craft-session-mode');
    const mg = document.getElementById('craft-margin');
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        premium: !!(pt && pt.checked), stationRate: sr ? +sr.value || 0 : 400, freshMaxH: fr ? +fr.value || 0 : 6,
        stationCity: sc ? sc.value : '', focus: !!(fo && fo.checked),
        focusAvail: fa ? +fa.value || 0 : 10000, sessionMode: sm ? sm.value : 'focus', margin: mg ? +mg.value || 0 : 20,
      }));
    } catch (_) {}
  }
  { const pt = document.getElementById('premium-toggle'); if (pt) pt.addEventListener('change', saveCfg); }
  { const sr = document.getElementById('station-rate'); if (sr) sr.addEventListener('input', saveCfg); }
  { const fr = document.getElementById('mkt-fresh'); if (fr) fr.addEventListener('change', () => { saveCfg(); if (currentBase) renderMarket(true); }); }

  const freshMaxH = () => { const el = document.getElementById('mkt-fresh'); return el ? +el.value || 0 : 0; };
  const isStale = (date) => { const h = freshMaxH(); return h > 0 && ageHours(date) > h; };

  const QAB = ['', '', 'B', 'Not', 'Sob', 'OM'];
  const qBadge = (qv) => (currentQuality === 0 && qv > 1 && QAB[qv])
    ? ` <span class="qbadge" title="Ojo: este precio NO es de calidad Normal, es ${QNAMES[qv]}">${QAB[qv]}</span>` : '';

  Promise.all([window.overlay.itemsIndex(), window.overlay.recipesIndex(), window.overlay.focusIndex()]).then(([it, rc, fx]) => {
    items = it || []; recipes = rc || {}; focusData = fx || {};
    nameById = Object.fromEntries(items.map((x) => [x.id, x.n]));
    initDailyBonus();
  });

  // ---------- bono diario de producción (dos familias al día, +10%) ----------
  const CAT_ES = {
    arcanestaff: 'bastón arcano', axe: 'hachas', bag: 'bolsas', bow: 'arcos', cape: 'capas',
    cloth_armor: 'pecho de tela', cloth_helmet: 'casco de tela', cloth_shoes: 'botas de tela',
    crossbow: 'ballestas', cursestaff: 'bastón maldito', dagger: 'dagas', fiber: 'tela (refino)',
    firestaff: 'bastón de fuego', food: 'comida', froststaff: 'bastón de escarcha',
    gatherergear: 'equipo de recolector', hammer: 'martillos', hide: 'cuero (refino)',
    holystaff: 'bastón sagrado', knuckles: 'puños', leather_armor: 'pecho de cuero',
    leather_helmet: 'casco de cuero', leather_shoes: 'botas de cuero', mace: 'mazas',
    meat_chicken: 'carne de pollo', meat_cow: 'carne de vaca', meat_goat: 'carne de cabra',
    meat_goose: 'carne de oca', meat_pig: 'carne de cerdo', meat_sheep: 'carne de oveja',
    naturestaff: 'bastón natural', offhand: 'secundarias', ore: 'lingotes (refino)',
    plate_armor: 'pecho de placas', plate_helmet: 'casco de placas', plate_shoes: 'botas de placas',
    potion: 'pociones', quarterstaff: 'varas', rock: 'piedra (refino)', spear: 'lanzas',
    sword: 'espadas', tools: 'herramientas', wood: 'tablas (refino)',
  };
  const DAILY_KEY = 'candelaa-daily-v1';
  const DAILY_PCT = 10;
  const todayStr = () => new Date().toISOString().slice(0, 10);
  let dailyCfg = { d: '', a: '', b: '' };
  function initDailyBonus() {
    const s1 = document.getElementById('craft-daily-1'), s2 = document.getElementById('craft-daily-2');
    if (!s1 || !s2) return;
    const cats = [...new Set(Object.values(focusData).map((v) => v.c).filter(Boolean))]
      .map((c) => ({ c, n: CAT_ES[c] || c })).sort((a, b) => a.n.localeCompare(b.n, 'es'));
    const opts = '<option value="">— ninguna</option>' + cats.map((x) => `<option value="${x.c}">${esc(x.n)}</option>`).join('');
    s1.innerHTML = opts; s2.innerHTML = opts;
    try { dailyCfg = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}') || {}; } catch (_) { dailyCfg = {}; }
    if (dailyCfg.d !== todayStr()) dailyCfg = { d: todayStr(), a: '', b: '' };
    s1.value = dailyCfg.a || ''; s2.value = dailyCfg.b || '';
    const onChange = () => {
      dailyCfg = { d: todayStr(), a: s1.value, b: s2.value };
      try { localStorage.setItem(DAILY_KEY, JSON.stringify(dailyCfg)); } catch (_) {}
      applyAutoReturn(); if (currentBase) renderCraft();
    };
    s1.addEventListener('change', onChange); s2.addEventListener('change', onChange);
  }
  const catOf = (baseId) => ((focusData[baseId] || {}).c || '');
  function dailyPct(baseId) {
    const c = catOf(baseId || currentBase);
    if (!c || dailyCfg.d !== todayStr()) return 0;
    return (c === dailyCfg.a || c === dailyCfg.b) ? DAILY_PCT : 0;
  }

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
    [/QUARTERSTAFF|IRONCLADSTAFF|DOUBLEBLADEDSTAFF|BLACKMONKSTONE|SOULSCYTHE|GRAILSEEKER/, 'Martlock', 'varas'],
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

  // Retorno de recursos: RRR = 1 - 1/(1+B), con B = base de estación + bono de ciudad + foco + bono diario.
  // Reproduce los valores publicados: 15,2 base · 24,8 crafteo con bono · 36,7 refino con bono ·
  // 43,5 con foco · 47,9 crafteo bono+foco · 53,9 refino bono+foco.
  const RET_BASE = 0.18, RET_FOCUS = 0.59, RET_REFINE = 0.40, RET_CRAFT = 0.15;
  const REFINED_ID = /^T\d+_(PLANKS|METALBAR|CLOTH|LEATHER|STONEBLOCK)(_LEVEL\d+@\d+)?$/;
  const REFINE_CITY = { PLANKS: ['FortSterling', 'tablas'], METALBAR: ['Thetford', 'lingotes'], CLOTH: ['Lymhurst', 'tela'], LEATHER: ['Martlock', 'cuero'], STONEBLOCK: ['Bridgewatch', 'bloques de piedra'] };
  // Brecilien es la ÚNICA ciudad con bono de bolsas, capas y pociones (+15%).
  const BRECILIEN_ONLY = [[/^T\d+_BAG/, 'bolsas'], [/^T\d+_CAPE/, 'capas'], [/_POTION/, 'pociones']];
  function productionBonus(baseId) {
    const id = baseId || '';
    const m = REFINED_ID.exec(id);
    if (m) { const c = REFINE_CITY[m[1]]; return { city: c[0], what: c[1], refine: true, pct: RET_REFINE }; }
    for (const [re, what] of BRECILIEN_ONLY) if (re.test(id)) return { city: 'Brecilien', what, refine: false, pct: RET_CRAFT };
    const cb = cityBonus(id);
    return cb ? { city: cb.city, what: cb.what, refine: false, pct: RET_CRAFT } : null;
  }
  function returnRate(baseId, opts) {
    const bon = productionBonus(baseId || currentBase);
    const st = (document.getElementById('craft-station-city') || {}).value || '';
    const focus = (opts && typeof opts.focus === 'boolean')
      ? opts.focus : !!(document.getElementById('craft-focus') || {}).checked;
    const daily = dailyPct(baseId || currentBase);
    const match = !!(bon && ((opts && opts.best) || (st && cityKey(st) === cityKey(bon.city))));
    const B = RET_BASE + (match ? bon.pct : 0) + (focus ? RET_FOCUS : 0) + daily / 100;
    const pct = (1 - 1 / (1 + B)) * 100;
    return { pct: Math.floor(pct * 10) / 10, match, bon, focus, daily, station: st };
  }
  function applyAutoReturn() {
    const inp = document.getElementById('craft-return');
    if (!inp || inp.dataset.auto === '0') return;
    inp.value = returnRate().pct.toFixed(1);
  }

  // ---------- favoritos (lista de seguimiento) ----------
  const FAV_KEY = 'candelaa-favs-v1';
  const FAV_MAX = 40;
  let favs = [];
  try { favs = JSON.parse(localStorage.getItem(FAV_KEY) || '[]') || []; } catch (_) { favs = []; }
  if (!Array.isArray(favs)) favs = [];
  const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, FAV_MAX))); } catch (_) {} };
  const isFav = (id) => favs.some((f) => f && f.id === id);
  function renderFavs() {
    const box = document.getElementById('item-favs'); if (!box) return;
    box.hidden = !favs.length;
    box.innerHTML = favs.map((f) => `<span class="fav-chip" data-fav="${esc(f.id)}" data-favn="${esc(f.n)}" title="Abrir ${esc(f.n)}"><b>${esc(f.n)}</b><span class="fav-x" data-favx="${esc(f.id)}" title="Quitar de favoritos">✕</span></span>`).join('');
  }
  function refreshFavStars() {
    document.querySelectorAll('[data-favstar]').forEach((el) => {
      const on = isFav(currentBase);
      el.classList.toggle('on', on); el.textContent = on ? '★' : '☆';
      el.title = on ? 'Quitar de favoritos' : 'Guardar en favoritos';
    });
  }
  function toggleFav() {
    if (!currentBase) return;
    if (isFav(currentBase)) { favs = favs.filter((f) => f.id !== currentBase); toast('☆ Quitado de favoritos'); }
    else { favs = [{ id: currentBase, n: currentName }, ...favs.filter((f) => f.id !== currentBase)].slice(0, FAV_MAX); toast('★ Guardado en favoritos'); }
    saveFavs(); renderFavs(); refreshFavStars();
  }
  renderFavs();

  document.getElementById('p-item').addEventListener('click', (e) => {
    const x = e.target.closest('[data-favx]');
    if (x) { e.stopPropagation(); favs = favs.filter((f) => f.id !== x.getAttribute('data-favx')); saveFavs(); renderFavs(); refreshFavStars(); return; }
    if (e.target.closest('[data-favstar]')) { e.stopPropagation(); toggleFav(); return; }
    const chip = e.target.closest('[data-fav]');
    if (chip) { e.stopPropagation(); selectItem(chip.getAttribute('data-fav'), chip.getAttribute('data-favn')); }
  });

  // ---------- buscador ----------
  function selectItem(id, fallbackName) {
    currentBase = id; currentName = nameById[id] || fallbackName || id;
    results.innerHTML = ''; search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : '');
    { const co = document.getElementById('cmp-offer'); if (co) co.value = ''; }
    loadMarket(); loadCraft();
    { const lv = document.getElementById('tab-level'); if (lv && !lv.hidden) loadLevel(); }
  }
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 180); });
  { const pb = document.getElementById('item-paste'); if (pb) pb.addEventListener('click', async () => {
      let txt = '';
      try { txt = await navigator.clipboard.readText(); } catch (_) { toast('No he podido leer el portapapeles'); return; }
      txt = String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!txt) { toast('Portapapeles vacío'); return; }
      search.value = txt; search.focus(); doSearch();
    }); }
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
    selectItem(r.dataset.id);
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
      { const tt = document.getElementById('tab-top'); if (tt && !tt.hidden) loadTop(true); }
    });
  });

  // ---------- pestañas ----------
  document.querySelectorAll('#item-tabs .tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#item-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      ['market', 'craft', 'scan', 'level', 'top', 'config'].forEach((t) => { const el = document.getElementById('tab-' + t); if (el) el.hidden = b.dataset.tab !== t; });
      if (b.dataset.tab === 'level') loadLevel();
      if (b.dataset.tab === 'top' && !topCache) loadTop(true);
      const enchSel = document.getElementById('item-ench');
      if (enchSel) enchSel.style.display = (b.dataset.tab === 'market') ? '' : 'none';
      const frSel = document.getElementById('item-fresh');
      if (frSel) frSel.style.display = (b.dataset.tab === 'market' || b.dataset.tab === 'top') ? '' : 'none';
      const qSel = document.getElementById('item-quality');
      if (qSel) qSel.style.display = (b.dataset.tab === 'config' || b.dataset.tab === 'level') ? 'none' : '';
    });
  });

  const QNAMES = ['Todas', 'Normal', 'Bueno', 'Notable', 'Sobresaliente', 'Obra maestra'];
  function itemHeadHtml(sub) {
    const qid = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    return `<div class="mkt-item-head"><img class="mkt-item-icon" src="https://render.albiononline.com/v1/item/${encodeURIComponent(qid)}.png?size=64" alt=""><div><div class="mkt-item-name"><span class="copyable" data-copy="${esc(currentName)}" title="Clic para copiar el nombre">${esc(currentName)}</span> <span class="enchtag">.${currentEnch}</span><span class="fav-star${isFav(currentBase) ? ' on' : ''}" data-favstar="1" title="${isFav(currentBase) ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${isFav(currentBase) ? '★' : '☆'}</span></div><div class="mkt-item-sub">${sub}</div></div></div>`;
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
            row.sell_price_min = lr.sell_price_min; row.sell_price_min_date = lr.sell_price_min_date;
            row.sell_price_min_quality = currentQuality || lr.quality || 0; (row._live = row._live || {}).sell = true;
          }
          if (lr.buy_price_max > 0 && (!row.buy_price_max_date || String(lr.buy_price_max_date || '') >= String(row.buy_price_max_date))) {
            row.buy_price_max = lr.buy_price_max; row.buy_price_max_date = lr.buy_price_max_date;
            row.buy_price_max_quality = currentQuality || lr.quality || 0; (row._live = row._live || {}).buy = true;
          }
        } else if (lr.sell_price_min > 0 || lr.buy_price_max > 0) {
          marketData.push({ city: lr.city, quality: lr.quality || 1,
            sell_price_min: lr.sell_price_min || 0, sell_price_min_date: lr.sell_price_min_date,
            sell_price_min_quality: currentQuality || lr.quality || 0,
            buy_price_max: lr.buy_price_max || 0, buy_price_max_date: lr.buy_price_max_date,
            buy_price_max_quality: currentQuality || lr.quality || 0,
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
  function sostChip(bm, avg, short) {
    if (!bm || !avg) return '';
    const r = bm / avg;
    const pico = r > 1.4, flojo = r < 0.7;
    const cls = pico ? 'chip-pico' : flojo ? 'chip-flojo' : 'chip-ok';
    const title = pico ? `Pico: pagan ${fmt(bm)} ahora pero lo normal es ~${fmt(avg)}; cuenta con el medio`
      : flojo ? `Pagan menos de lo normal ahora (~${fmt(avg)} de media); suele recuperarse`
      : `El precio de ahora va en línea con el medio histórico (~${fmt(avg)}): fiable`;
    const txt = short ? (pico ? '⚠' : flojo ? '↓' : '✅')
      : (pico ? `⚠ PICO ${r.toFixed(1)}×` : flojo ? '↓ flojo' : '✅ sostenido');
    return `<span class="chip ${cls}" title="${title}">${txt}</span>`;
  }
  // el Black Market solo compra EQUIPO (lo que dropean los mobs): ni comida, ni pociones,
  // ni monturas, ni recursos. La API devuelve filas suyas igualmente, así que hay que filtrar.
  const BM_CATS = new Set(['arcanestaff', 'axe', 'bag', 'bow', 'cape', 'cloth_armor', 'cloth_helmet', 'cloth_shoes',
    'crossbow', 'cursestaff', 'dagger', 'firestaff', 'froststaff', 'hammer', 'holystaff', 'knuckles',
    'leather_armor', 'leather_helmet', 'leather_shoes', 'mace', 'naturestaff', 'offhand',
    'plate_armor', 'plate_helmet', 'plate_shoes', 'quarterstaff', 'spear', 'sword']);
  const bmBuys = (baseId) => BM_CATS.has(catOf(baseId));
  function renderMarket(silent) {
    const rows = (marketData || []).filter((r) => r.sell_price_min > 0 || r.buy_price_max > 0);
    if (!rows.length) { if (!silent) tabMarket.innerHTML = '<div class="mempty">Sin datos de mercado.</div>'; return; }
    const cityRows = rows.filter((r) => r.city !== 'Black Market' && r.sell_price_min > 0);
    const citySells = cityRows.map((r) => r.sell_price_min);
    const isSellOutlier = (sp) => isHiOutlier(sp, citySells) || isLoOutlier(sp, citySells);
    const freshRows = cityRows.filter((r) => !isStale(r.sell_price_min_date));
    const staleDropped = cityRows.length - freshRows.length;
    // si la frescura elegida lo deja todo fuera, no vacíes la tabla: usa todo y avisa
    const scoreRows = freshRows.length ? freshRows : cityRows;
    const freshFilterActive = freshRows.length > 0 && staleDropped > 0;
    const scoreSells = scoreRows.map((r) => r.sell_price_min).filter((sp) => !isSellOutlier(sp));
    const usableSells = scoreSells.length ? scoreSells : scoreRows.map((r) => r.sell_price_min);
    const minSell = usableSells.length ? Math.min(...usableSells) : null;
    const maxSell = usableSells.length ? Math.max(...usableSells) : null;
    // Black Market al final (es venta inmediata al NPC, no sitio para comprar)
    rows.sort((a, b) => (a.city === 'Black Market' ? 1 : 0) - (b.city === 'Black Market' ? 1 : 0));
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    const itemHead = itemHeadHtml(`calidad: ${QNAMES[currentQuality] || 'Todas'} · precios por ciudad · se actualiza solo cada 60s`);
    const bmRowX = rows.find((r) => r.city === 'Black Market');
    const bmAvg = (marketVolMap['Black Market'] || {}).avg || 0;
    const bmStale = !!bmRowX && isStale(bmRowX.buy_price_max_date);
    const bmActual = (bmRowX && !bmStale) ? bmRowX.buy_price_max || 0 : 0;
    const bmEff = bmActual > 0 ? (bmAvg > 0 ? Math.min(bmActual, bmAvg) : bmActual) : 0;
    const minRow = scoreRows.find((r) => r.sell_price_min === minSell);
    const maxRow = scoreRows.find((r) => r.sell_price_min === maxSell);
    let bestHtml = '';
    if (minSell && minRow) {
      const taxN = salesTax();
      const opts = [];
      if (bmEff > 0) opts.push({ label: 'véndelo YA al 🏴 Black Market', gross: bmEff, net: bmEff * (1 - taxN), order: 0, q: bmRowX && bmRowX.buy_price_max_quality });
      if (maxSell && maxRow && maxRow.city !== minRow.city) opts.push({ label: 'pon orden de venta en ' + esc(maxRow.city), gross: maxSell, net: maxSell * (1 - taxN - 0.025), order: 1, q: maxRow.sell_price_min_quality });
      opts.sort((a, b) => b.net - a.net);
      if (opts.length) {
        const b = opts[0];
        const gain = b.net - minSell;
        const roi = minSell > 0 ? (gain / minSell) * 100 : 0;
        const dest = b.order ? cityShort(maxRow.city) : '🏴 BM';
        bestHtml = gain > 0
          ? `<div id="mkt-best" class="clickable" data-buy="${Math.round(minSell)}" data-sell="${Math.round(b.gross)}" data-order="${b.order}" title="Clic para volcar estos números a la calculadora">🛒 ${esc(cityShort(minRow.city))} <b>${fmt(minSell)}</b>${qBadge(minRow.sell_price_min_quality)} → ${dest} <b>${fmt(b.gross)}</b>${qBadge(b.q)} → neto ${fmt(b.net)} · <b>+${fmt(gain)}/ud</b> (${roiTxt(roi)})</div>`
          : `<div id="mkt-best" class="neg">🛒 ${fmt(minSell)} → neto ${fmt(b.net)} · <b>${fmt(gain)}/ud</b> (${roiTxt(roi)})</div>`;
      }
    }
    if (freshFilterActive || (freshMaxH() > 0 && !freshRows.length && cityRows.length)) {
      bestHtml += freshRows.length
        ? `<div class="fresh-note" title="Excluidos del cálculo por antigüedad; siguen visibles en gris">⏳ ${staleDropped} de +${freshMaxH()}h fuera${bmStale ? ' · BM rancio' : ''}</div>`
        : `<div class="fresh-note warn" title="Ningún precio baja del umbral de frescura: el cálculo usa datos viejos">⚠ todo +${freshMaxH()}h</div>`;
    }
    const QN2 = ['', 'Normal', 'Bueno', 'Notable', 'Sobresaliente', 'Obra maestra'];
    let qualHtml = '';
    if (Array.isArray(marketQuality) && marketQuality.some((x) => x.buy || x.bm)) {
      qualHtml = '<div class="mkt-quality"><div class="mkt-q-title" title="A cuánto la compras y a cuánto te la paga el Black Market, por calidad">💎 Por calidad</div>'
        + '<table><thead><tr><th style="text-align:left">Calidad</th><th>Comprar</th><th>BM paga</th><th>Vol/día</th><th>Visto</th></tr></thead><tbody>'
        + marketQuality.map((x) => { const age = agoStr(x.date); const stale = ageHours(x.date) > (freshMaxH() || 24); return `<tr><td class="name">${QN2[x.q]}</td><td class="silver">${x.buy ? fmt(x.buy) : '—'}</td><td class="${x.bm ? 'best-sell' : 'faint'}">${x.bm ? fmt(x.bm) : '—'} ${sostChip(x.bm, x.avg)}</td><td class="${x.vol ? '' : 'faint'}">${x.vol ? fmtInt(x.vol) : '—'}</td><td class="${stale ? 'down' : 'faint'}">${stale ? '⚠ ' : ''}${age || '—'}</td></tr>`; }).join('')
        + '</tbody></table></div>';
    }
    const tableHtml = '<table><thead><tr><th style="text-align:left">Ciudad</th><th title="La oferta de venta más barata: esto pagas si lo compras ya">Comprarlo cuesta</th><th title="La mejor orden de compra: esto te pagan si lo vendes al instante">Venderlo ya te da</th><th title="A cuánto se cierra de verdad (histórico)">Precio medio</th><th>Vol/día</th><th>Visto</th></tr></thead><tbody>'
      + rows.map((r) => {
        const isBM = r.city === 'Black Market';
        const sp = r.sell_price_min;
        const outlier = !isBM && sp > 0 && isSellOutlier(sp);
        const sellStale = !isBM && sp > 0 && freshFilterActive && isStale(r.sell_price_min_date);
        let cls = 'silver', mark = '', tip = '';
        if (outlier) { cls = 'faint'; mark = '⚠ '; tip = ' title="Precio atípico (posible orden troll o dato erróneo): excluido del cálculo"'; }
        else if (sellStale) { cls = 'faint'; mark = '⏳ '; tip = ` title="Precio de hace ${agoStr(r.sell_price_min_date) || '?'}, por encima del límite de frescura: excluido del cálculo"`; }
        else if (!isBM && sp > 0 && sp === minSell) { cls = 'best-buy'; mark = '🛒 '; }
        else if (!isBM && sp > 0 && sp === maxSell) { cls = 'best-sell'; mark = '💰 '; }
        const sellCell = (!isBM && sp > 0) ? `<td class="${cls}"${tip}>${mark}${fmt(sp)}${qBadge(r.sell_price_min_quality)}</td>` : '<td class="faint">—</td>';
        const bAge = agoStr(r.buy_price_max_date);
        const vc = marketVolMap[cityKey(r.city)] || {}; const vd = vc.daily || 0; const avg = vc.avg || 0;
        // el chip solo tiene sentido con una calidad concreta: en "Todas" el buy_max coge
        // la calidad más cara y el medio es la mezcla → daría un pico falso.
        const chip = (isBM && currentQuality) ? sostChip(r.buy_price_max, avg) : '';
        const fast = r.buy_price_max > 0 ? `<td class="${isBM && !bmStale ? 'best-sell' : 'faint'}" title="la mejor orden de compra: te pagan esto al instante · vista hace ${bAge || '—'}${isBM && bmStale ? ' · por encima del límite de frescura: excluido del cálculo' : ''}">${isBM ? (bmStale ? '⏳🏴 ' : '🏴 ') : ''}${fmt(r.buy_price_max)}${qBadge(r.buy_price_max_quality)}${chip}</td>` : '<td class="faint">—</td>';
        const volCell = vd > 0 ? `<td title="Unidades que se venden al día aquí (estimado, datos de la comunidad)">${fmtInt(vd)}</td>` : '<td class="faint">—</td>';
        const avgCell = avg > 0 ? `<td class="cr-vol-avg" title="Precio medio al que se cierra de verdad (histórico). Aunque la orden esté alta o baja, a esto se vende.">~${fmt(avg)}</td>` : '<td class="faint">—</td>';
        const sAge = agoStr(r.sell_price_min_date);
        const shownAge = isBM ? (bAge || sAge) : (sAge || bAge);
        const shownDate = isBM ? (r.buy_price_max_date || r.sell_price_min_date) : (r.sell_price_min_date || r.buy_price_max_date);
        const staleLimit = freshMaxH() || 24;
        const stale = !!shownAge && ageHours(shownDate) > staleLimit;
        const liveDot = r._live ? ' <span class="live-dot" title="Visto por TU cliente ahora mismo (captura en vivo)">🟢</span>' : '';
        return `<tr><td class="name">${isBM ? '🏴 Black Market' : esc(r.city)}${liveDot}</td>${sellCell}${fast}${avgCell}${volCell}<td class="${stale ? 'down' : 'faint'}" title="venta ${sAge || '—'} · compra ${bAge || '—'}${stale ? ` · dato de +${staleLimit} h, verifícalo en el juego` : ''}">${stale ? '⚠ ' : ''}${shownAge}</td></tr>`;
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
  // materias primas de refino: al craftear un recurso refinado encantado (p.ej. Tablas de
  // cedro excepcional = T5.3) la receta consume la materia prima TAMBIÉN encantada
  // (3× Troncos de cedro excepcional), no la normal. Sin esto se cobraba el precio Normal.
  const RAW_RES = /^T\d+_(WOOD|ORE|HIDE|FIBER|ROCK)(_LEVEL\d+@\d+)?$/;
  const enchantable = (id) => REFINABLE.test(id) || RAW_RES.test(id);
  // el retorno de recursos aplica a TODOS los materiales menos artefactos y
  // los aditivos de encantamiento (extracto de alquimia / salsa de pescado).
  const NO_RETURN =/ARTEFACT|QUESTITEM|_TOKEN|_FACTION_|ALCHEMY_EXTRACT|FISHSAUCE|(?:_RUNE|_SOUL|_RELIC|_SHARD_AVALONIAN|_SHARD_CRYSTAL)(?:@\d+)?$/;
  const returnable = (id) => !NO_RETURN.test(id);
  const ench = (id, e) => (e > 0 && enchantable(id) ? id + '_LEVEL' + e + '@' + e : id);
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
    { const q = document.getElementById('craft-qty'); if (q) q.dataset.auto = '1'; }
    if (!rec) { craftOut.innerHTML = '<div class="mempty">Este item no es crafteable.</div>'; return; }
    applyAutoReturn();
    craftOut.innerHTML = '<div class="mempty">Cargando precios…</div>';
    // materiales y productos por separado: los materiales son recursos (sin calidad),
    // el producto usa la calidad que crafteas (Normal por defecto), no el máx de todas.
    const matSet = new Set();
    for (let e = 0; e <= 4; e++) {
      recipeRows(currentBase, e).forEach((m) => {
        matSet.add(m.priceId); matSet.add(m.nameId);
        recipeRows(m.nameId, e).forEach((s) => { matSet.add(s.priceId); matSet.add(s.nameId); });
      });
    }
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
    renderCraft();
  }
  const matOrderOn = () => !!(document.getElementById('craft-mat-order') || {}).checked;
  // lo que te cuesta la unidad: comprando al instante es la venta más barata; dejando orden
  // de compra es superar en 1 la puja actual (la tasa del 2,5% se suma aparte)
  const cityUnitPrice = (cell) => {
    if (!cell) return 0;
    if (matOrderOn()) return cell.buy > 0 ? cell.buy + 1 : (cell.sell || 0);
    return cell.sell || 0;
  };
  const craftCityPrice = (id) => {
    const c = craftPriceMap[id]; if (!c) return 0;
    const all = CRAFT_CITIES.map((ct) => cityUnitPrice(c[ct])).filter((x) => x > 0);
    const valid = all.filter((v) => !isLoOutlier(v, all));   // ignora precios irrisorios (dato podrido) al coger el más barato
    const use = valid.length ? valid : all;
    return use.length ? Math.min(...use) : 0;
  };
  // coste de fabricar un material en vez de comprarlo (un nivel de profundidad).
  // usa el retorno propio del material (su bono de ciudad, no el del producto final) y su taller.
  function subCraftCost(nameId, e) {
    const rows = recipeRows(nameId, e);
    if (!rows.length) return null;
    const returnR = returnRate(nameId).pct / 100;
    let ret = 0, non = 0;
    for (const s of rows) {
      const u = craftCityPrice(s.priceId);
      if (!u) return null;
      const c = u * s.c;
      if (returnable(s.nameId)) ret += c; else non += c;
    }
    return ret * (1 - returnR) + non + stationFeeOf(nameId, stationRate());
  }
  const sellOrderOn = () => !!(document.getElementById('craft-sell-order') || {}).checked;
  // con orden de venta te pones en la cola al precio de la más barata (paga impuesto + 2,5%);
  // sin orden vendes ya a la mejor puja de ese mercado (solo impuesto). Vale igual para el BM.
  const sellUnitPrice = (cell) => (cell ? (sellOrderOn() ? (cell.sell || 0) : (cell.buy || 0)) : 0);
  const bestSellOf = (id, tax, sellFee) => {
    const c = craftPriceMap[id]; if (!c) return { gross: 0, net: 0, city: null, instant: false };
    const noBM = !bmBuys(String(id).split('@')[0]);
    const order = sellOrderOn();
    const refs = Object.entries(c).filter(([ct]) => ct !== 'Black Market').map(([, v]) => sellUnitPrice(v)).filter((x) => x > 0);
    let net = -1, gross = 0, city = null;
    Object.entries(c).forEach(([ct, v]) => {
      if (ct === 'Black Market' && noBM) return;
      const p = sellUnitPrice(v);
      if (p <= 0 || isHiOutlier(p, refs)) return;
      const n = p * (1 - tax - (order ? sellFee : 0));
      if (n > net) { net = n; gross = p; city = ct; }
    });
    return { gross, net: Math.max(0, net), city, instant: !order };
  };

  function renderCraft() {
    const rec = recipes[currentBase]; if (!rec) return;
    applyAutoFocusCost();
    const tax = salesTax();
    const sellFee = (document.getElementById('craft-sell-order') || {}).checked ? 0.025 : 0;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const fee = stationFeeOf(currentBase, stationRate());
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
    const defaultCity = '';
    const craftQty = +document.getElementById('craft-qty').value || 1;
    const matRows = recipeRows(currentBase, e).map((m) => {
      const id = m.priceId;
      const cm = craftPriceMap[id] || {};
      const perCity = CRAFT_CITIES.map((c) => ({ c, p: cityUnitPrice(cm[c]) }));
      const withPrice = perCity.filter((x) => x.p > 0);
      // ciudad por defecto: la global si tiene precio, si no la más barata disponible
      let chosen = perCity.find((x) => x.c === defaultCity && x.p > 0);
      if (!chosen) chosen = withPrice.slice().sort((a, b) => a.p - b.p)[0];
      const chosenCity = chosen ? chosen.c : defaultCity;
      const det = chosen ? chosen.p : 0;
      const opts = perCity.map((x) => `<option value="${x.p}"${x.c === chosenCity ? ' selected' : ''}>${esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}</option>`).join('');
      const enchTag = (e > 0 && enchantable(m.nameId)) ? '.' + e : '';
      const ret = returnable(m.nameId) ? 1 : 0;
      const mnm = nameById[m.nameId] || m.nameId;
      const subC = subCraftCost(m.nameId, e);
      let subChip = '';
      if (subC != null && subC > 0) {
        const better = det > 0 && subC < det;
        const diff = det > 0 ? Math.round((subC / det - 1) * 100) : null;
        const rr = returnRate(m.nameId);
        subChip = `<span class="cr-sub-chip ${better ? 'win' : 'lose'}" data-sub="${Math.round(subC)}"`
          + ` title="Fabricarlo tú cuesta ${fmt(subC)}/ud (retorno ${rr.pct.toFixed(1)}% en ${rr.match ? cityShort(rr.bon.city) : 'estación sin bono'} + taller). Comprarlo cuesta ${det ? fmt(det) : '—'}. Clic para usar este coste.">`
          + `🔨 ${fmt(subC)}${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff}%)` : ''}</span>`;
      }
      return `<div class="cr-row" data-c="${m.c}" data-ret="${ret}" data-id="${esc(id)}" data-name="${esc(mnm + enchTag)}">`
        + `<span class="cr-name copyable" data-copy="${esc(mnm)}" title="Clic para copiar el nombre">${m.c}× ${esc(mnm)}${enchTag}</span>`
        + subChip
        + `<span class="cr-buy" title="Unidades exactas a comprar de este material para la cantidad indicada">🛒 ${fmtInt(m.c * craftQty)}</span>`
        + `<select class="cr-city" title="Ciudad de compra de este material">${opts}</select>`
        + `<input class="cr-price" type="number" data-c="${m.c}" data-ret="${ret}" value="${Math.round(det)}">`
        + `<span class="cr-subtot silver" title="Subtotal (precio × cantidad)">${fmt(det * m.c)}</span>`
        + `</div>`;
    }).join('');
    const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
    const prodPriceMap = craftPriceMap[prodEnch(currentBase, e)] || {};
    const prodCityRows = ALL_CITIES.filter((c) => c !== 'Black Market' || bmBuys(currentBase)).map((c) => ({ c, p: sellUnitPrice(prodPriceMap[c]), instant: !sellOrderOn() }));
    const chosenSell = bs.city || (prodCityRows.find((x) => x.p > 0) || {}).c || '';
    const chosenRow = prodCityRows.find((x) => x.c === chosenSell) || {};
    const prodInstant = !!chosenRow.instant;
    const prodAvg = ((craftVolMap[prodEnch(currentBase, e)] || {})[cityKey(chosenSell || '')] || {}).avg || 0;
    const rawProd = chosenRow.p || Math.round(bs.gross) || 0;
    // si el precio de ahora es un pico, calcula con el MEDIO histórico (sostenible)
    const prodPrice = prodAvg > 0 ? Math.min(rawProd, prodAvg) : rawProd;
    const prodChip = prodAvg > 0 ? sostChip(rawProd, prodAvg) : '';
    const prodOpts = prodCityRows.map((x) => `<option value="${x.p}" data-instant="${x.instant ? 1 : 0}" data-city="${esc(x.c)}"${x.c === chosenSell ? ' selected' : ''}>${x.c === 'Black Market' ? '🏴 Black Market' : esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}${x.instant && x.p ? ' ⚡' : ''}</option>`).join('');
    const vmap = craftVolMap[prodEnch(currentBase, e)] || {};
    const vsorted = Object.entries(vmap).filter((x) => (x[1].daily || 0) > 0).sort((a, b) => (b[1].daily || 0) - (a[1].daily || 0));
    const sellCk = cityKey(bs.city || '');
    const volLine = vsorted.length
      ? `<div class="cr-vol" title="Unidades/día que absorbe cada mercado · ~ = precio medio realizado">Absorbe/día: ${vsorted.map((x) => `<span class="${x[0] === sellCk ? 'cr-vol-best' : ''}">${cityShort(x[0])} <b>${fmtInt(x[1].daily)}</b>${x[1].avg ? ` <span class="cr-vol-avg" title="precio medio realizado">~${fmt(x[1].avg)}</span>` : ''}</span>`).join(' · ')}</div>`
      : '<div class="cr-vol faint">Volumen/día: sin datos</div>';

    craftOut.innerHTML = itemHeadHtml('crafteo · elige materiales y dónde vender')
      + `<div class="cr-mini-row">${mini}</div>`
      + `<div class="cr-recipe" id="cr-mats"><div class="cr-sub">Receta E${e} <button class="mini-btn" id="cr-cheapest" title="Pone cada material al precio de la ciudad donde esté más barato (ojo: puede implicar varios viajes)">💸 más barato</button></div>${matRows}</div>`
      + `<div class="cr-row cr-prod"><span class="cr-name">Vender en ${prodChip}</span><select class="cr-city" id="cr-prod-city" title="Ciudad de venta del producto · precio por ciudad (🏴 Black Market = venta inmediata a su orden de compra)">${prodOpts}</select><input class="cr-price" id="cr-prod-price" type="number" data-instant="${prodInstant ? 1 : 0}" data-sellck="${cityKey(chosenSell || '')}" data-sellcity="${esc(chosenSell || '')}" value="${Math.round(prodPrice)}"></div>`
      + volLine
      + '<div id="craft-result" class="craft-total"></div>'
      + '<div id="craft-budget-out"></div>';
    calcResult();
  }

  function calcResult() {
    const rec = recipes[currentBase]; if (!rec) return;
    const result = document.getElementById('craft-result'); if (!result) return;
    const returnR = (+document.getElementById('craft-return').value || 0) / 100;
    const tax = salesTax();
    const fee = stationFeeOf(currentBase, stationRate());
    // la cantidad la propone la sesión de foco, pero si la escribes tú manda la tuya
    const fCost = +(document.getElementById('craft-focus-cost') || {}).value || 0;
    const fAvail = +(document.getElementById('craft-focus-avail') || {}).value || 0;
    const craftsF = ((document.getElementById('craft-focus') || {}).checked && fCost > 0) ? Math.floor(fAvail / fCost) : 0;
    const qtyEl = document.getElementById('craft-qty');
    if (qtyEl && qtyEl.dataset.auto !== '0' && craftsF > 0) qtyEl.value = craftsF;
    const qty = +((qtyEl || {}).value) || 1;
    const matOrder = !!(document.getElementById('craft-mat-order') || {}).checked;
    const sellFee = (document.getElementById('craft-sell-order') || {}).checked ? 0.025 : 0;
    let ret = 0, non = 0; const mats = [];
    document.querySelectorAll('#cr-mats .cr-row').forEach((row) => {
      const inp = row.querySelector('.cr-price'); if (!inp) return;
      const c = +inp.dataset.c || 0, price = +inp.value || 0, isRet = inp.dataset.ret === '1';
      const sub = price * c;
      if (isRet) ret += sub; else non += sub;
      const st = row.querySelector('.cr-subtot'); if (st) st.textContent = fmt(sub);
      const buy = row.querySelector('.cr-buy'); if (buy) buy.textContent = '🛒 ' + fmtInt(c * qty);
      mats.push({ id: row.dataset.id || '', name: row.dataset.name || '', c, price, ret: isRet, city: (row.querySelector('.cr-city') || {}).selectedOptions ? row.querySelector('.cr-city').selectedOptions[0].textContent.split(' ·')[0] : '' });
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
    const warnHtml = suspicious ? `<div class="cmp-verdict down" style="margin-top:8px" title="Rentabilidad imposible: casi seguro un precio de venta erróneo. Verifícalo en el juego">⚠ precio de venta atípico (${roiTxt(roi)})</div>` : '';
    // comparación contra una oferta manual (antigua pestaña Comparar, ahora integrada)
    const offer = +(document.getElementById('cmp-offer') || {}).value || 0;
    let offerHtml = '';
    if (offer > 0) {
      const offerNet = offer * (1 - tax);
      const oGain = offerNet - netCost;
      const oRoi = netCost > 0 ? (oGain / netCost) * 100 : 0;
      const opc = oGain >= 0 ? 'up' : 'down';
      offerHtml = `<div class="cmp-verdict ${opc}" style="margin-top:8px">${oGain >= 0 ? '✅' : '❌'} oferta <b>${fmt(offer)}</b> (neto ${fmt(offerNet)}) → <b>${oGain >= 0 ? '+' : ''}${fmt(oGain)}/ud</b> (${roiTxt(oRoi)})</div>`;
    }
    result.innerHTML = `1 ud → coste <span class="silver">${fmt(netCost)}</span> · venta neta <span class="silver">${fmt(ventaNeta)}</span> · <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit)}</b> (ROI ${roiTxt(roi)})`
      + `<div style="margin-top:5px">Para <b>${qty}</b> uds → inviertes <b class="silver">${fmt(netCost * qty)}</b> · recuperas <b class="silver">${fmt(ventaNeta * qty)}</b> · beneficio <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit * qty)}</b></div>`
      + warnHtml
      + offerHtml;
    renderPlan({ mats, returnR, tax, fee, qty, matOrder, sellFee, netCost, ventaNeta, sellPrice, profit, instant });
  }

  // ---------- foco: coste por unidad y eficiencia calibrada por línea de spec ----------
  const FOCUS_EFF_KEY = 'candelaa-focus-eff-v1';
  let focusEff = {};
  try { focusEff = JSON.parse(localStorage.getItem(FOCUS_EFF_KEY) || '{}') || {}; } catch (_) { focusEff = {}; }
  const specLine = (baseId) => String(baseId || '').replace(/^T\d+_/, '').replace(/@\d+$/, '');
  function focusBaseOf(baseId, e) {
    const d = focusData[baseId]; if (!d) return 0;
    return e > 0 ? +((d.e || {})[String(e)] || 0) : +d.f || 0;
  }
  const effOf = (baseId) => +focusEff[specLine(baseId)] || 0;
  // el árbol de destino abarata el foco de forma exponencial: coste = base / 2^(eficiencia/10000)
  const focusCostOf = (baseId, e) => { const b = focusBaseOf(baseId, e); return b ? b / Math.pow(2, effOf(baseId) / 10000) : 0; };
  function calibrateFocus(baseId, e, real) {
    const b = focusBaseOf(baseId, e);
    if (!b || !(real > 0)) return false;
    focusEff[specLine(baseId)] = Math.max(0, Math.round(10000 * Math.log2(b / real)));
    try { localStorage.setItem(FOCUS_EFF_KEY, JSON.stringify(focusEff)); } catch (_) {}
    return true;
  }
  function applyAutoFocusCost() {
    const inp = document.getElementById('craft-focus-cost'); if (!inp || !currentBase) return;
    const c = focusCostOf(currentBase, currentEnch);
    inp.value = c ? Math.round(c) : '';
    inp.placeholder = c ? '' : 'sin datos';
  }

  // ---------- plan de sesión, punto de equilibrio y compra de materiales ----------
  const bestBuyOf = (id) => {
    const c = craftPriceMap[id] || {};
    let best = 0;
    Object.entries(c).forEach(([ct, v]) => { if (ct !== 'Black Market' && (v.buy || 0) > best) best = v.buy; });
    return best;
  };
  const bestSellMinOf = (id) => {
    const c = craftPriceMap[id] || {};
    const all = Object.entries(c).filter(([ct]) => ct !== 'Black Market').map(([, v]) => v.sell).filter((x) => x > 0);
    const valid = all.filter((v) => !isLoOutlier(v, all));
    const use = valid.length ? valid : all;
    return use.length ? Math.min(...use) : 0;
  };

  // material más barato del mercado y en qué ciudad está (es el tope real de lo que tiene
  // sentido ofrecer por chat: por encima, te sale mejor comprarlo allí)
  const cheapestOf = (id) => {
    const c = craftPriceMap[id] || {};
    const rows = Object.entries(c).filter(([ct, v]) => ct !== 'Black Market' && (v.sell || 0) > 0);
    if (!rows.length) return { price: 0, city: '' };
    const all = rows.map(([, v]) => v.sell);
    const valid = rows.filter(([, v]) => !isLoOutlier(v.sell, all));
    const use = valid.length ? valid : rows;
    const best = use.reduce((a, b) => (b[1].sell < a[1].sell ? b : a));
    return { price: best[1].sell, city: best[0] };
  };

  function renderPlan(ctx) {
    const bEl = document.getElementById('craft-budget-out');
    const result = document.getElementById('craft-result');
    if (!bEl || !result) return;
    const useFocus = !!(document.getElementById('craft-focus') || {}).checked;
    const focusAvail = +(document.getElementById('craft-focus-avail') || {}).value || 0;
    const focusCost = +(document.getElementById('craft-focus-cost') || {}).value || 0;
    const mode = (document.getElementById('craft-session-mode') || {}).value || 'focus';
    const R = ctx.returnR, mo = ctx.matOrder ? 1.025 : 1;

    // punto de equilibrio, como una línea más del resultado
    const netSell = 1 - ctx.tax - (ctx.instant ? 0 : ctx.sellFee);
    const breakEven = netSell > 0 ? ctx.netCost / netSell : 0;
    const cushion = breakEven > 0 ? (ctx.sellPrice / breakEven - 1) * 100 : 0;
    const cc = cushion >= 0 ? 'up' : 'down';
    let extra = `<div style="margin-top:5px" title="Por debajo de ese precio pierdes silver: ya incluye impuesto de venta y, si la marcaste, la tasa de orden.">Pierdes por debajo de <b>${fmtInt(breakEven)}</b> · vendes a <b>${fmtInt(ctx.sellPrice)}</b> <span class="${cc}">(${cushion >= 0 ? '+' : ''}${cushion.toFixed(1)}% de colchón)</span></div>`;

    // sesión de foco, otra línea
    if (useFocus && focusCost > 0) {
      const perFocus = ctx.profit / focusCost;
      const craftsF = Math.floor(focusAvail / focusCost);
      const R0 = returnRate(currentBase, { focus: false }).pct / 100;
      let totalUnits = craftsF, matCrafts = craftsF * (1 - R);
      if (mode === 'mixed') { totalUnits = craftsF + (R < 1 ? (craftsF * R) / (1 - R0) : 0); matCrafts = craftsF; }
      const invest = ctx.mats.reduce((s, m) => s + m.price * m.c * (m.ret ? matCrafts : totalUnits), 0) * mo + ctx.fee * totalUnits;
      const gain = ctx.ventaNeta * totalUnits - invest;
      const gc = gain >= 0 ? 'up' : 'down';
      const warn = effOf(currentBase) > 0 ? '' : ' <span class="down" title="Sin calibrar: se usa el coste de foco sin especialización, así que sale peor de lo real. Escribe en Foco/ud lo que ves en la estación.">⚠ spec sin calibrar</span>';
      extra += `<div style="margin-top:5px" title="El foco es lo limitado, no el silver: la plata por punto es la que decide qué craftear.">${fmtInt(focusAvail)} de foco → <b>${fmtInt(totalUnits)}</b> uds · <b class="${ctx.profit >= 0 ? 'up' : 'down'}">${perFocus >= 0 ? '+' : ''}${perFocus.toFixed(1)}</b>/foco · sesión <b class="${gc}">${gain >= 0 ? '+' : ''}${fmt(gain)}</b>${warn}</div>`;
    }
    result.insertAdjacentHTML('beforeend', extra);

    // compra de materiales
    const buyUnits = ctx.qty;
    const matCraftsBudget = (useFocus && focusCost && mode === 'focus') ? Math.ceil(buyUnits * (1 - R)) : buyUnits;
    let totInstant = 0, totOrder = 0, totOffer = 0;
    const rows = ctx.mats.map((m) => {
      const need = Math.ceil(m.c * (m.ret ? matCraftsBudget : buyUnits));
      const bid = bestBuyOf(m.id);
      const cheap = cheapestOf(m.id);
      const ask = cheap.price || m.price;
      // hasta aquí puedes pagar sin dejar de ganar (con el resto de materiales igual)
      const weight = m.c * (m.ret ? (1 - R) : 1) * mo;
      const maxPay = weight > 0 ? m.price + ctx.profit / weight : 0;
      const sellerNet = bid * (1 - ctx.tax);
      const myCost = ctx.matOrder ? (bid ? (bid + 1) * 1.025 : ask * 1.025) : ask;
      let offer = 0;
      if (sellerNet > 0 && myCost > sellerNet) offer = sellerNet + (myCost - sellerNet) * 0.4;
      else if (ask > 0) offer = ask * 0.97;
      if (ask > 0 && offer > ask) offer = ask * 0.97;
      if (maxPay > 0 && offer > maxPay) offer = maxPay;
      const orderPrice = bid ? bid + 1 : Math.round(ask * 0.9);
      totInstant += ask * need;
      totOrder += orderPrice * 1.025 * need;
      totOffer += offer * need;
      const over = maxPay > 0 && orderPrice * 1.025 > maxPay;
      return { m, need, bid, ask, cheap, maxPay, offer, orderPrice, over };
    });
    const cityPlain = (c) => String(c || '').replace('FortSterling', 'Fort Sterling');
    const station = cityPlain((document.getElementById('craft-station-city') || {}).value);
    const wtb = rows.filter((r) => r.need > 0).map((r) => `${fmtInt(r.need)}x ${r.m.name} a ${fmtInt(r.offer)}`).join(' + ');
    const wtbMsg = `Compro ${wtb} · total ${fmtInt(totOffer)}${station ? ' · trato directo en ' + station : ''}`;
    bEl.className = 'cr-block';
    bEl.innerHTML = '<div class="cr-b-title">🛒 Comprar materiales'
      + ` <span class="faint">· para ${fmtInt(buyUnits)} uds${matCraftsBudget !== buyUnits ? ' (material de ' + fmtInt(matCraftsBudget) + ')' : ''}</span></div>`
      + '<table class="cr-tbl"><thead><tr><th>Material</th><th title="Unidades que necesitas comprar">Uds</th>'
      + '<th title="Mejor orden de COMPRA ahora mismo: lo que ya está pujando otro jugador. Para ser el mejor postor tienes que superarla.">Puja</th>'
      + '<th title="Precio más barato en TODAS las ciudades y dónde está. Es tu tope: por encima de eso te sale mejor ir a comprarlo allí.">Techo (más barato)</th>'
      + '<th title="Precio sugerido para trade directo por chat: por encima de lo que el vendedor sacaría vendiendo al mercado y por debajo de lo que te cuesta a ti.">Ofrecer</th></tr></thead><tbody>'
      + rows.map((r) => `<tr><td class="name copyable" data-copy="${esc(r.m.id)}" title="Clic para copiar el ID">${esc(r.m.name)}</td>`
        + `<td><b>${fmtInt(r.need)}</b></td>`
        + `<td class="${r.over ? 'down' : ''}" title="Pon tu orden a ${fmtInt(r.orderPrice)} para ser el mejor postor${r.over ? ' — ojo, eso ya pasa de lo que puedes pagar sin perder (' + fmtInt(r.maxPay) + ')' : ''}">${r.bid ? fmtInt(r.bid) : '—'}</td>`
        + `<td title="${r.maxPay > 0 ? 'Sin perder dinero podrías llegar hasta ' + fmtInt(r.maxPay) : ''}">${r.ask ? fmtInt(r.ask) : '—'}${r.cheap.city ? ` <span class="faint">${cityShort(r.cheap.city)}</span>` : ''}</td>`
        + `<td class="silver">${r.offer > 0 ? fmtInt(r.offer) : '—'}</td></tr>`).join('')
      + '</tbody></table>'
      + `<div class="cr-kv" style="margin-top:6px"><span>Comprando al instante</span><span><b class="silver">${fmt(totInstant)}</b></span></div>`
      + `<div class="cr-kv"><span title="Superando la puja actual en 1 silver, más el 2,5% de tasa por crear la orden. Es más barato pero tardas en que te la llenen.">Dejando órdenes de compra</span><span><b class="silver">${fmt(totOrder)}</b></span></div>`
      + `<div class="cr-kv"><span title="Trade directo por chat: ni tú pagas tasa de orden ni el vendedor paga impuesto de venta. El ahorro se reparte.">Por trade directo</span><span><b class="silver">${fmt(totOffer)}</b> <span class="up">−${fmt(totInstant - totOffer)}</span></span></div>`
      + `<textarea class="cr-wtb" id="cr-wtb" rows="2" readonly title="Clic para copiar">${esc(wtbMsg)}</textarea>`;
    const wtbEl = document.getElementById('cr-wtb');
    if (wtbEl) wtbEl.addEventListener('click', () => { wtbEl.select(); copyText(wtbEl.value); });
  }

  // (La antigua pestaña Comparar quedó fusionada en Crafteo: el input "Te ofrecen"
  //  se evalúa dentro de calcResult y muestra el veredicto de rentabilidad.)
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', () => { if (currentBase) calcResult(); }); }

  // ================= ESCÁNER (flip: comprar hecho → revender) =================
  const SELL_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien'];
  // dónde vendes y cómo: inmediato cobra la puja y solo paga impuesto; con orden te pones
  // en la cola al precio de la venta más barata y pagas impuesto + 2,5%
  const SELL_MODES = {
    bm: { locs: ['Black Market'], order: false, hdr: 'BM ⚡', txt: '🏴 BM inmediato' },
    bmorder: { locs: ['Black Market'], order: true, hdr: 'BM ord.', txt: '🏴 BM con orden' },
    market: { locs: SELL_CITIES, order: true, hdr: 'Venta', txt: 'orden en ciudad' },
    cityfast: { locs: SELL_CITIES, order: false, hdr: 'Puja', txt: 'inmediato en ciudad' },
  };
  const sellModeOf = (k) => SELL_MODES[k] || SELL_MODES.bm;
  const SCAN_ENCHANTS = [0, 1, 2, 3, 4]; // el escáner prueba todos y muestra el mejor por item
  const SCAN_CAPTURE = 1;   // volumen completo: el recorte mental lo pone el usuario, no el panel
  const SCAN_MAX_ROI = 500; // guarda anti-outlier: un ROI > 500% es casi siempre un precio troll de la API, no una oportunidad real
  const cityKey = (c) => (c === 'Black Market' ? 'Black Market' : String(c).replace(/\s+/g, ''));
  const cityShort = (c) => (c === 'Black Market' ? '🏴 BM' : (c === 'FortSterling' ? 'F.Sterling' : esc(c)));
  const scanStore = {};   // cache por configuración (cat|sell|tier|city) -> datos crudos
  let scanCache = null;    // configuración mostrada ahora mismo
  // el escáner calcula y recorta en el cliente sobre el dataset cacheado, así que
  // reordenar no necesita volver a la API: se ordena antes del recorte y se re-renderiza.
  const SCAN_SORTS = { eurDay: (r) => r.eurDay, gain: (r) => r.gain, vol: (r) => r.vol, cost: (r) => r.netCost, price: (r) => r.price, avg: (r) => r.avg, roi: (r) => r.roi, perFocus: (r) => r.perFocus || 0 };
  let scanSort = 'eurDay', scanDir = 'desc';
  const scanMode = () => (document.getElementById('scan-mode') || {}).value || 'flip';
  const scanKey = () => [
    scanMode(),
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
    const onlyBM = sellModeOf((document.getElementById('scan-sell') || {}).value || 'bm').locs[0] === 'Black Market';
    const targets = Object.keys(recipes).filter((id) => id.indexOf('@') < 0 && tierOk(id) && recipes[id] && recipes[id].r && (!onlyBM || bmBuys(id)));
    if (!targets.length) { out.innerHTML = '<div class="mempty">Sin items para ese tier.</div>'; return; }
    out.innerHTML = `<div class="scan-prog"><div class="lbl"><span>Escaneando ${targets.length} items…</span><b id="scan-prog-pct">0%</b></div><div class="scan-bar"><i id="scan-bar-fill"></i></div></div>`;
    const btn = document.getElementById('scan-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Escaneando…'; }
    const stopProg = startScanProgress();
    const prodSet = new Set();
    targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => prodSet.add(prodEnch(id, e))));
    const prodIds = [...prodSet];
    const sellLocs = sellModeOf(sellMode).locs;
    // rentabilidad: usa la calidad que DE VERDAD compras/flipeas. "Todas" (0) = Normal (1).
    const q = currentQuality || 1;
    const mode = scanMode();
    try {
      // Flip: comprar el ITEM ya hecho y revenderlo. Craft: comprar los MATERIALES y fabricarlo.
      const matSet = new Set();
      if (mode === 'craft') targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => recipeRows(id, e).forEach((m) => matSet.add(m.priceId))));
      const [prodRows, volRows, matRows] = await Promise.all([
        window.overlay.scanPrices(prodIds, [...new Set([city, ...sellLocs])], q),
        window.overlay.history(prodIds, sellLocs, 21, q),
        mode === 'craft' ? window.overlay.scanPrices([...matSet], [city], 1) : Promise.resolve([]),
      ]);
      const matP = {};
      (matRows || []).forEach((r) => { if (cityKey(r.city) === cityKey(city)) matP[r.item_id] = cityUnitPrice({ sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }); });
      const buyP = {}, buyDateM = {}, sellP = {}, dateM = {};
      (prodRows || []).forEach((r) => {
        const ck = cityKey(r.city);
        if (ck === cityKey(city)) { buyP[r.item_id] = r.sell_price_min || 0; buyDateM[r.item_id] = r.sell_price_min_date || null; }
        (sellP[r.item_id] = sellP[r.item_id] || {})[ck] = sellModeOf(sellMode).order ? (r.sell_price_min || 0) : (r.buy_price_max || 0);
        (dateM[r.item_id] = dateM[r.item_id] || {})[ck] = sellModeOf(sellMode).order ? (r.sell_price_min_date || null) : (r.buy_price_max_date || null);
      });
      const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
      scanStore[scanKey()] = { targets, buyP, buyDateM, sellP, dateM, volM, sellMode, sellLocs, city, mode, matP };
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
    const { targets, buyP, buyDateM, sellP, dateM, volM, sellMode, sellLocs, city, mode, matP } = scanCache;
    const bmNet = 1 - salesTax();
    const ordNet = 1 - salesTax() - 0.025;
    const isCraft = mode === 'craft';
    const useFocus = isCraft && !!(document.getElementById('craft-focus') || {}).checked;
    // en modo crafteo se asume que fabricas cada item en la ciudad que tiene su bono
    const craftCostOf = (id, e) => {
      const rows = recipeRows(id, e);
      if (!rows.length) return 0;
      let ret = 0, non = 0;
      for (const m of rows) {
        const u = (matP && matP[m.priceId]) || 0;
        if (!u) return 0;
        const c = u * m.c;
        if (returnable(m.nameId)) ret += c; else non += c;
      }
      const R = returnRate(id, { best: true }).pct / 100;
      return ret * (1 - R) + non + stationFeeOf(id, stationRate());
    };
    const res = targets.map((id) => {
      let best = null;
      SCAN_ENCHANTS.forEach((e) => {
        const pid = prodEnch(id, e);
        const netCost = isCraft ? craftCostOf(id, e) : ((buyP && buyP[pid]) || 0);
        if (netCost <= 0) return;                  // sin precio de compra / sin todos los materiales
        const prices = sellP[pid] || {}, vols = volM[pid] || {}, dts = (dateM && dateM[pid]) || {};
        sellLocs.forEach((ckRaw) => {
          const ck = cityKey(ckRaw); const price = prices[ck] || 0; if (!price) return;
          const vcell = vols[ck] || {}; const vol = vcell.daily || 0; const avg = vcell.avg || 0;
          const sellPrice = avg > 0 ? Math.min(price, avg) : price;   // valora con el MEDIO sostenible, no el pico de ahora
          const net = sellPrice * (sellModeOf(sellMode).order ? ordNet : bmNet);
          const gain = net - netCost;
          const roi = netCost > 0 ? (gain / netCost) * 100 : Infinity;
          if (roi > SCAN_MAX_ROI) return;   // precio outlier (troll/dato podrido), no una oportunidad real
          const eurDay = gain * vol * SCAN_CAPTURE;
          const fCost = useFocus ? focusCostOf(id, e) : 0;
          const perFocus = fCost > 0 ? gain / fCost : 0;
          const craftCity = isCraft ? (productionBonus(id) || {}).city || '' : '';
          if (!best || eurDay > best.eurDay) best = { id, e, netCost, price, avg, city: ck, gain, vol, eurDay, roi, perFocus, fCost, craftCity, sellDate: dts[ck] || null, buyDate: (buyDateM && buyDateM[id]) || null };
        });
      });
      return best;
    }).filter(Boolean);
    // picos: la orden de ahora muy por encima del medio histórico. Nadie te la compra a ese precio.
    const hideSpikes = !!(document.getElementById('scan-hide-spikes') || {}).checked;
    const isSpike = (r) => r.avg > 0 && r.price > r.avg * 3;
    const spikes = res.filter(isSpike).length;
    const skey = SCAN_SORTS[scanSort] ? scanSort : 'eurDay';
    const sdir = scanDir === 'asc' ? -1 : 1;
    const shown = (hideSpikes ? res.filter((r) => !isSpike(r)) : res)
      .sort((a, b) => (SCAN_SORTS[skey](b) - SCAN_SORTS[skey](a)) * sdir)
      .slice(0, 25);
    if (!shown.length) {
      out.innerHTML = `<div class="mempty">Sin oportunidades con datos completos.${spikes && hideSpikes ? ` Se han descartado ${spikes} pico${spikes === 1 ? '' : 's'} de precio; desmarca "Ocultar picos" para verlos.` : ' Prueba otro tier o canal de venta.'}</div>`;
      return;
    }
    const res2 = shown;
    const sellHdr = sellModeOf(sellMode).hdr;
    const buyCityShort = cityShort(cityKey(city));
    const sArrow = sdir === -1 ? ' ▲' : ' ▼';
    const sSort = (k, label, tip) => `<th class="top-sort${skey === k ? ' on' : ''}" data-ssort="${k}" title="${tip} · clic para ordenar${skey === k ? ' al revés' : ''}">${label}${skey === k ? sArrow : ''}</th>`;
    out.innerHTML = '<div class="scan-scroll"><table><thead><tr><th>Item · ench</th>'
      + sSort('cost', isCraft ? 'Craftear' : 'Compra', isCraft ? 'Coste de fabricarlo: materiales menos el retorno de la estación, más la tarifa del taller' : 'Lo que te cuesta comprarlo en la ciudad de origen')
      + sSort('price', sellHdr, 'Precio de venta que se usa (orden de ahora)')
      + sSort('avg', 'Medio', 'Precio medio realmente vendido (histórico)')
      + sSort('gain', 'Gana', 'Ganancia neta por unidad tras impuestos')
      + sSort('vol', 'Vol/día', 'Unidades que se mueven al día')
      + sSort('eurDay', 'Plata/día', 'Ganancia por unidad × TODO el volumen diario del mercado: el techo teórico si te llevaras el mercado entero')
      + (useFocus ? sSort('perFocus', 'Plata/foco', 'Ganancia por punto de foco gastado. Con el foco limitado, esta es la columna que decide qué craftear') : '')
      + '<th>Visto</th></tr></thead><tbody>'
      + res2.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        const where = sellModeOf(sellMode).locs.length === 1 ? '🏴 BM' : cityShort(r.city);
        const action = isCraft
          ? `craftear en ${r.craftCity ? cityShort(cityKey(r.craftCity)) : 'estación sin bono'} · mats de ${buyCityShort} → vender ${where}`
          : `comprar en ${buyCityShort} → vender ${where}`;
        const staleDate = ageHours(r.buyDate) > ageHours(r.sellDate) ? r.buyDate : r.sellDate;
        const ageTxt = agoStr(staleDate); const stale = ageHours(staleDate) > 24;
        const iconId = prodEnch(r.id, r.e);
        return `<tr><td class="name"><div class="scan-item"><img class="scan-ico" src="https://render.albiononline.com/v1/item/${encodeURIComponent(iconId)}.png?size=40" loading="lazy" alt=""><div class="scan-item-txt"><span class="copyable" data-copy="${esc(nm)}" title="Clic para copiar el nombre">${esc(nm)}</span> <span class="enchtag">.${r.e}</span><br><span class="faint" style="font-size:11px">${action} · ROI ${roiTxt(r.roi)}</span></div></div></td>`
          + `<td class="silver">${fmt(r.netCost)}</td><td class="silver scan-price">${fmt(r.price)}${sostChip(r.price, r.avg, true)}</td>`
          + `<td class="cr-vol-avg" title="precio medio realmente vendido (histórico): con esto se calcula la ganancia, no con el pico de ahora">${r.avg ? '~' + fmt(r.avg) : '—'}</td>`
          + `<td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td>`
          + `<td class="${r.vol > 0 ? '' : 'faint'}" title="Unidades que se mueven al día (calidad Normal). Plata/día usa este volumen completo.">${r.vol > 0 ? fmtInt(r.vol) : '—'}</td>`
          + `<td class="${pc}"><b>${r.eurDay >= 0 ? '+' : ''}${fmt(r.eurDay)}</b></td>`
          + (useFocus ? `<td class="${r.perFocus >= 0 ? 'up' : 'down'}" title="${r.fCost ? fmtInt(r.fCost) + ' de foco por unidad' : 'sin datos de foco para este item'}">${r.fCost ? (r.perFocus >= 0 ? '+' : '') + r.perFocus.toFixed(1) : '—'}</td>` : '')
          + `<td class="${stale ? 'down' : 'faint'}" title="Hace cuánto se vio este precio">${stale ? '⚠ ' : ''}${ageTxt || '—'}</td></tr>`;
      }).join('') + '</tbody></table></div>'
      + `<div class="best-hint">${fromCache ? '<b style="color:#9fd2e0">cacheado</b> · ' : ''}${spikes ? `<b style="color:#e0a336">${spikes} pico${spikes === 1 ? '' : 's'} ${hideSpikes ? 'oculto' + (spikes === 1 ? '' : 's') : 'visible' + (spikes === 1 ? '' : 's')}</b> · ` : ''}${res.length} con datos · ${isCraft ? 'crafteo' : 'reventa'} · ${sellModeOf(sellMode).txt}${useFocus ? ' · con foco' : ''}</div>`;
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
  ['scan-tier', 'scan-city', 'scan-sell', 'scan-mode'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', onScanFilterChange); });
  { const hs = document.getElementById('scan-hide-spikes'); if (hs) hs.addEventListener('change', () => { if (scanCache) renderScanResults(true); }); }
  { const sb = document.getElementById('scan-btn'); if (sb) sb.addEventListener('click', runScan); }
  { const sr = document.getElementById('scan-result'); if (sr) sr.addEventListener('click', (e) => {
      const th = e.target.closest('[data-ssort]'); if (!th || !scanCache) return;
      const k = th.dataset.ssort;
      if (scanSort === k) scanDir = scanDir === 'desc' ? 'asc' : 'desc';
      else { scanSort = k; scanDir = 'desc'; }
      renderScanResults(true);
    }); }

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
      const liveCalls = [];
      ids.forEach((id) => QS.forEach((q) => liveCalls.push([id, q])));
      const [results, liveRes] = await Promise.all([
        Promise.all(QS.map((q) => window.overlay.scanPrices(ids, locs, q).catch(() => []))),
        Promise.all(liveCalls.map(([id, q]) => window.overlay.marketLive(id, q).catch(() => null))),
      ]);
      const byCity = {};   // id -> q -> ck -> { price, city, date, live }
      QS.forEach((q, i) => {
        (results[i] || []).forEach((r) => {
          const s = r.sell_price_min || 0; if (s <= 0) return;
          const ck = cityKey(r.city);
          const mq = ((byCity[r.item_id] = byCity[r.item_id] || {})[q] = (byCity[r.item_id] || {})[q] || {});
          mq[ck] = { price: s, city: ck, date: r.sell_price_min_date || null, live: false };
        });
      });
      liveRes.forEach((live, k) => {
        const [id, q] = liveCalls[k];
        (live || []).forEach((lr) => {
          if (!lr || !lr.city || !(lr.sell_price_min > 0)) return;
          const ck = cityKey(lr.city);
          if (cityFilter && ck !== cityKey(cityFilter)) return;
          const mq = ((byCity[id] = byCity[id] || {})[q] = (byCity[id] || {})[q] || {});
          const prev = mq[ck];
          if (!prev || !prev.date || String(lr.sell_price_min_date || '') >= String(prev.date)) {
            mq[ck] = { price: lr.sell_price_min, city: ck, date: lr.sell_price_min_date || null, live: true };
          }
        });
      });
      const cheapest = {};   // id -> q -> { price, city, date, live }  (ciudad más barata, o la filtrada)
      Object.keys(byCity).forEach((id) => {
        const m = (cheapest[id] = {});
        Object.keys(byCity[id]).forEach((q) => {
          let best = null;
          Object.keys(byCity[id][q]).forEach((ck) => { const c = byCity[id][q][ck]; if (!best || c.price < best.price) best = c; });
          if (best) m[q] = best;
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
    // referencia = la versión de mayor tier (la "normal" del nivel, p.ej. T8.0): con qué comparas el ahorro
    const rowMin = (c) => { const m = cheapest[idOf(c)] || {}; const ps = QS.map((q) => (m[q] || {}).price).filter((p) => p > 0); return ps.length ? Math.min(...ps) : 0; };
    const refCombo = combos[0];
    const refMin = refCombo ? rowMin(refCombo) : 0;
    const rows = combos.map((c) => {
      const m = cheapest[idOf(c)] || {};
      const mine = rowMin(c);
      const diffPct = (refMin > 0 && mine > 0) ? Math.round((mine / refMin - 1) * 100) : null;
      const diffCell = c === refCombo
        ? `<td class="lvl-diff faint" title="Es la referencia: la versión de tier más alto para este nivel">base</td>`
        : `<td class="lvl-diff ${diffPct == null ? 'faint' : (diffPct < 0 ? 'up' : 'down')}" title="Comparado con ${refCombo.t}.${refCombo.e}, que cuesta ${refMin ? fmt(refMin) : '—'}">${diffPct == null ? '—' : (diffPct > 0 ? '+' : '') + diffPct + '%'}</td>`;
      const cells = QS.map((q, qi) => {
        const cell = m[q]; if (!cell) return '<td class="faint">—</td>';
        const cls = cell.price === globalMin ? 'lvl-best' : (cell.price === colMin[qi] ? 'lvl-colbest' : '');
        const stale = ageHours(cell.date) > (freshMaxH() || 24);
        const age = agoStr(cell.date) || 'sin fecha';
        const liveDot = cell.live ? ' <span class="live-dot" title="Visto por TU cliente ahora mismo (captura en vivo)">🟢</span>' : '';
        const sub = (cityFilter ? age : (age + ' · ' + cityShort(cell.city))) + liveDot;
        return `<td class="${cls}"><div class="lvl-price">${fmt(cell.price)}${cell.price === globalMin ? ' ✅' : ''}</div><div class="lvl-age${stale ? ' stale' : ''}">${stale ? '⚠ ' : ''}${sub}</div></td>`;
      }).join('');
      return `<tr><td class="lvl-combo">${c.t}.${c.e}</td>${cells}${diffCell}</tr>`;
    }).join('');
    out.innerHTML = itemHeadHtml('nivel ' + target + ' · ' + (cityFilter ? cityShort(cityFilter) : 'ciudad más barata'))
      + '<div class="scan-scroll"><table class="lvl-table"><thead><tr><th>T.Ench</th>' + LVL_QNAMES.map((n) => `<th>${n}</th>`).join('') + `<th title="Diferencia de precio frente a la versión de tier más alto de este nivel">vs ${refCombo ? refCombo.t + '.' + refCombo.e : 'base'}</th>` + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  ['level-target', 'level-city'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { if (currentBase) loadLevel(); }); });

  // ================= TOP (lo que más se mueve · base de la cartera) =================
  let topCache = null, topDir = 'desc', topSort = 'turnover';
  async function loadTop(force) {
    const out = document.getElementById('top-result'); if (!out) return;
    const city = (document.getElementById('top-city') || {}).value || 'Black Market';
    const days = +((document.getElementById('top-days') || {}).value) || 7;
    const tierSel = (document.getElementById('top-tier') || {}).value || '';
    const limit = 50;
    const sortBy = topSort;
    const dir = topDir;
    const onlyPriced = (document.getElementById('top-only-priced') || {}).checked !== false;
    const tiers = tierSel ? tierSel.split('') : [];
    const key = [city, days, tierSel, limit, sortBy, dir, onlyPriced ? 'p' : 'all', 'q' + currentQuality].join('|');
    if (!force && topCache && topCache.key === key) { renderTop(); return; }
    out.innerHTML = '<div class="mempty">Mirando qué se mueve…</div>';
    const btn = document.getElementById('top-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Calculando…'; }
    try {
      const rows = await window.overlay.topVolume({ city, days, quality: currentQuality, limit, tiers, sortBy, dir, onlyPriced });
      topCache = { key, city, days, sortBy, dir, rows: rows || [] };
      renderTop();
    } catch (_) {
      out.innerHTML = '<div class="mempty">No he podido cargar el top (¿sin conexión o token caducado?).</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '💰 Ver lo que más se mueve'; }
    }
  }
  function renderTop() {
    const out = document.getElementById('top-result'); if (!out || !topCache) return;
    const { rows, city, days } = topCache;
    const sortBy = topCache.sortBy || 'turnover';
    if (!rows.length) { out.innerHTML = '<div class="mempty">Sin datos de volumen para ese mercado/ventana. Prueba una ventana más larga, otro tier, o desmarca "Solo items con precio ahora".</div>'; return; }
    const isBM = city === 'Black Market';
    const priceHdr = isBM ? 'BM paga ahora' : 'Compran ya a';
    const dir = topCache.dir || 'desc';
    const arrow = dir === 'asc' ? ' ▲' : ' ▼';
    const sortable = (k, label, tip) => `<th class="top-sort${sortBy === k ? ' on' : ''}" data-sort="${k}" title="${tip} · clic para ordenar${sortBy === k ? ' al revés' : ' por esto'}">${label}${sortBy === k ? arrow : ''}</th>`;
    out.innerHTML = '<div class="scan-scroll"><table><thead><tr><th>Item</th>'
      + sortable('daily', 'Absorbe/día', 'Unidades que absorbe el mercado al día (media de la ventana, corregida por cobertura de datos)')
      + sortable('avg', 'Medio', 'Precio medio al que se cierra de verdad (último día con datos)')
      + sortable('now', priceHdr, 'La mejor orden de compra en este momento: esto te pagan al instante')
      + sortable('delta', 'Δ vs medio', 'Cuánto se desvía el precio de ahora del medio. Verde = pagan por encima de lo normal (vende); rojo = pagan por debajo (espera)')
      + sortable('turnover', 'Mueve/día', 'Plata/día que mueve este item aquí (absorbe/día × medio): mide lo gordo del mercado, no tu beneficio')
      + '<th>Visto</th><th></th></tr></thead><tbody>'
      + rows.map((r) => {
        const base = String(r.item_id).split('@')[0];
        const e = String(r.item_id).indexOf('@') > 0 ? String(r.item_id).split('@')[1] : '0';
        const nm = nameById[base] || base;
        const now = r.buy_price_max || 0, avg = r.avg_price || 0;
        const d = (now > 0 && avg > 0) ? Math.round((now / avg - 1) * 100) : null;
        const dCls = d == null ? 'faint' : (d >= 15 ? 'up' : (d <= -15 ? 'down' : 'faint'));
        const spike = d != null && d >= 200;
        const age = agoStr(r.buy_price_max_date);
        const stale = isStale(r.buy_price_max_date);
        const turnover = avg > 0 ? avg * (r.daily || 0) : 0;
        const fav = isFav(base);
        return `<tr class="top-row" data-topid="${esc(base)}" data-topn="${esc(nm)}">`
          + `<td class="name"><div class="scan-item"><img class="scan-ico" src="https://render.albiononline.com/v1/item/${encodeURIComponent(r.item_id)}.png?size=40" loading="lazy" alt=""><div class="scan-item-txt"><span class="copyable" data-copy="${esc(nm)}" title="Clic para copiar el nombre">${esc(nm)}</span> <span class="enchtag">.${e}</span></div></div></td>`
          + `<td><b>${fmtInt(r.daily)}</b></td>`
          + `<td class="cr-vol-avg">${avg ? '~' + fmt(avg) : '—'}</td>`
          + `<td class="${now ? (isBM ? 'best-sell' : 'silver') : 'faint'}">${now ? fmt(now) : '—'}${qBadge(r.buy_price_max_quality)}</td>`
          + `<td class="${dCls}" ${spike ? 'title="Pico: pagan muchísimo más que el medio. Casi seguro no aguanta; valida en el juego"' : ''}>${d == null ? '—' : (d > 0 ? '+' : '') + d + '%'}${spike ? ' ⚠' : ''}</td>`
          + `<td class="silver" title="${fmtInt(r.daily)} uds × ~${fmt(avg)}">${turnover ? fmt(turnover) : '—'}</td>`
          + `<td class="${stale ? 'down' : 'faint'}" title="Hace cuánto se vio la orden de compra">${stale ? '⚠ ' : ''}${age || '—'}</td>`
          + `<td><span class="fav-star${fav ? ' on' : ''}" data-topfav="${esc(base)}" data-topfavn="${esc(nm)}" title="${fav ? 'Quitar de la cartera' : 'Añadir a la cartera'}">${fav ? '★' : '☆'}</span></td>`
          + '</tr>';
      }).join('') + '</tbody></table></div>'
      + `<div class="best-hint" title="Clic en una cabecera ordena por ella (otra vez invierte) y recalcula en el servidor; clic en una fila abre el item en Precios; ★ lo guarda en la cartera">${days} días · ${isBM ? '🏴 BM' : cityShort(city)} · ${QNAMES[currentQuality] || 'Todas'} · ${rows.length} items</div>`;
  }
  { const tb = document.getElementById('top-btn'); if (tb) tb.addEventListener('click', () => loadTop(true)); }
  ['top-city', 'top-days', 'top-tier', 'top-only-priced'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => loadTop(false)); });
  { const tr = document.getElementById('top-result'); if (tr) tr.addEventListener('click', (e) => {
      const th = e.target.closest('.top-sort');
      if (th) {
        if (topSort === th.dataset.sort) topDir = topDir === 'desc' ? 'asc' : 'desc';
        else { topSort = th.dataset.sort; topDir = 'desc'; }
        loadTop(false);
        return;
      }
      const st = e.target.closest('[data-topfav]');
      if (st) {
        e.stopPropagation();
        const id = st.getAttribute('data-topfav'), n = st.getAttribute('data-topfavn');
        if (isFav(id)) { favs = favs.filter((f) => f.id !== id); toast('☆ Fuera de la cartera'); }
        else { favs = [{ id, n }, ...favs.filter((f) => f.id !== id)].slice(0, FAV_MAX); toast('★ En la cartera'); }
        saveFavs(); renderFavs(); renderTop();
        return;
      }
      if (e.target.closest('[data-copy]')) return;
      const row = e.target.closest('.top-row');
      if (row) selectItem(row.getAttribute('data-topid'), row.getAttribute('data-topn'));
    }); }

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
    const chip = ev.target.closest('.cr-sub-chip');
    if (chip) {
      const row = chip.closest('.cr-row'); const inp = row && row.querySelector('.cr-price');
      if (inp) { inp.value = chip.dataset.sub; calcResult(); toast('🔨 Usando el coste de fabricarlo'); }
      return;
    }
    if (ev.target.closest('#cr-cheapest')) {
      document.querySelectorAll('#cr-mats .cr-row').forEach((row) => {
        const sel = row.querySelector('.cr-city'), inp = row.querySelector('.cr-price');
        if (!sel || !inp) return;
        let best = null;
        Array.from(sel.options).forEach((o) => { const v = +o.value || 0; if (v > 0 && (!best || v < (+best.value || 0))) best = o; });
        if (best) { best.selected = true; inp.value = Math.round(+best.value || 0); }
      });
      calcResult();
      return;
    }
    const b = ev.target.closest('.cr-mini'); if (!b) return;
    currentEnch = +b.dataset.e;
    document.querySelectorAll('#item-ench button[data-e]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.e === currentEnch)));
    renderCraft();
  });
  { const el = document.getElementById('craft-qty'); if (el) el.addEventListener('input', () => { el.dataset.auto = '0'; if (currentBase) calcResult(); }); }
  { const cr = document.getElementById('craft-return'); if (cr) cr.addEventListener('change', () => { if (currentBase) calcResult(); }); }
  { const so = document.getElementById('craft-sell-order'); if (so) so.addEventListener('change', () => { if (currentBase && recipes[currentBase]) renderCraft(); }); }
  { const mo = document.getElementById('craft-mat-order'); if (mo) mo.addEventListener('change', () => { if (currentBase && recipes[currentBase]) renderCraft(); onScanFilterChange(); }); }
  ['craft-station-city', 'craft-focus'].forEach((id) => {
    const el = document.getElementById(id); if (!el) return;
    el.addEventListener('change', () => {
      const inp = document.getElementById('craft-return'); if (inp) inp.dataset.auto = '1';
      applyAutoReturn(); saveCfg();
      if (currentBase && recipes[currentBase]) renderCraft();
    });
  });
  ['craft-focus-avail', 'craft-margin'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => { saveCfg(); if (currentBase) calcResult(); }); });
  { const sm = document.getElementById('craft-session-mode'); if (sm) sm.addEventListener('change', () => { saveCfg(); if (currentBase) calcResult(); }); }
  { const fc = document.getElementById('craft-focus-cost'); if (fc) fc.addEventListener('change', () => {
      if (currentBase && calibrateFocus(currentBase, currentEnch, +fc.value || 0)) applyAutoFocusCost();
      if (currentBase) calcResult();
    }); }
  { const fa = document.getElementById('craft-focus-auto'); if (fa) fa.addEventListener('click', () => {
      if (!currentBase) return;
      delete focusEff[specLine(currentBase)];
      try { localStorage.setItem(FOCUS_EFF_KEY, JSON.stringify(focusEff)); } catch (_) {}
      applyAutoFocusCost(); calcResult();
    }); }
  { const cr = document.getElementById('craft-return'); if (cr) cr.addEventListener('input', () => { cr.dataset.auto = '0'; if (currentBase) calcResult(); }); }
  { const ra = document.getElementById('craft-return-auto'); if (ra) ra.addEventListener('click', () => {
      const inp = document.getElementById('craft-return'); if (inp) inp.dataset.auto = '1';
      applyAutoReturn();
      if (currentBase && recipes[currentBase]) renderCraft();
    }); }
  { const pt = document.getElementById('premium-toggle'); if (pt) pt.addEventListener('change', () => {
      if (currentBase && marketData) renderMarket();
      if (currentBase && recipes[currentBase]) renderCraft();
      onScanFilterChange();
    }); }

})();
