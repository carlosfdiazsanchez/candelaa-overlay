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

  let items = [], nameById = {}, nameEnById = {}, recipes = {}, focusData = {}, enchIndex = {};
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
    const done = () => toast('📋 Copied: ' + txt);
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
  // si el render oficial no devuelve el icono de algún item, se oculta el hueco en vez de
  // dejar la imagen rota (el evento error no burbujea: hay que escucharlo en captura)
  document.getElementById('p-item').addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG') t.style.visibility = 'hidden';
  }, true);

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
    const sf = document.getElementById('scan-fresh'); if (sf && c.scanFreshH != null) sf.value = String(c.scanFreshH);
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
        scanFreshH: (() => { const sf = document.getElementById('scan-fresh'); return sf ? +sf.value || 0 : 24; })(),
      }));
    } catch (_) {}
  }
  { const pt = document.getElementById('premium-toggle'); if (pt) pt.addEventListener('change', saveCfg); }
  { const sr = document.getElementById('station-rate'); if (sr) sr.addEventListener('input', saveCfg); }
  { const fr = document.getElementById('mkt-fresh'); if (fr) fr.addEventListener('change', () => { saveCfg(); if (currentBase) renderMarket(true); }); }

  const freshMaxH = () => { const el = document.getElementById('mkt-fresh'); return el ? +el.value || 0 : 0; };
  const isStale = (date) => { const h = freshMaxH(); return h > 0 && ageHours(date) > h; };

  // Nombre a copiar de un item encantado: en los recursos la rareza va en el propio nombre
  // ("Tela suntuosa rara" = .2) y ese es el que se busca en el juego; en el equipo el nombre
  // no cambia, así que se le añade la notación .N para no perder el dato.
  const copyNameOf = (baseId, e, baseName, dict) => {
    const map = dict || nameById;
    const nm = baseName || map[baseId] || baseId;
    if (!e) return nm;
    const enchId = enchantable(baseId) ? ench(baseId, e) : prodEnch(baseId, e);
    const own = map[enchId];
    return own && own !== nm ? own : nm + ' .' + e;
  };
  const enNameOf = (id) => {
    const base = String(id).replace(/_LEVEL\d+@\d+$/, '').replace(/@\d+$/, '');
    const m = /_LEVEL(\d)@/.exec(String(id)) || /@(\d)$/.exec(String(id));
    return copyNameOf(base, m ? +m[1] : 0, nameEnById[base], nameEnById);
  };

  const QAB = ['', '', 'B', 'Not', 'Sob', 'OM'];
  const qBadge = (qv) => (currentQuality === 0 && qv > 1 && QAB[qv])
    ? ` <span class="qbadge" title="Careful: this price is NOT Normal quality, it is ${QNAMES[qv]}">${QAB[qv]}</span>` : '';

  Promise.all([window.overlay.itemsIndex(window.__lang), window.overlay.recipesIndex(), window.overlay.focusIndex()]).then(([it, rc, fx]) => {
    items = it || []; recipes = rc || {}; focusData = fx || {};
    nameById = Object.fromEntries(items.map((x) => [x.id, x.n]));
    initDailyBonus();
  });
  if (window.overlay.enchantIndex) {
    window.overlay.enchantIndex().then((ix) => { enchIndex = ix || {}; }).catch(() => {});
  }
  // nombres en inglés: para el mensaje de compra del chat global (se carga aparte, sin bloquear)
  if (window.overlay.itemsIndexEn) {
    window.overlay.itemsIndexEn().then((en) => { nameEnById = Object.fromEntries((en || []).map((x) => [x.id, x.n])); }).catch(() => {});
  }

  // ---------- bono diario de producción (dos familias al día, +10%) ----------
  const CAT_ES = {
    arcanestaff: 'arcane staff', axe: 'axes', bag: 'bags', bow: 'bows', cape: 'capes',
    cloth_armor: 'cloth armor', cloth_helmet: 'cloth helmet', cloth_shoes: 'cloth shoes',
    crossbow: 'crossbows', cursestaff: 'cursed staff', dagger: 'daggers', fiber: 'cloth (refining)',
    firestaff: 'fire staff', food: 'food', froststaff: 'frost staff',
    gatherergear: 'gatherer gear', hammer: 'hammers', hide: 'leather (refining)',
    holystaff: 'holy staff', knuckles: 'knuckles', leather_armor: 'leather armor',
    leather_helmet: 'leather helmet', leather_shoes: 'leather shoes', mace: 'maces',
    meat_chicken: 'chicken meat', meat_cow: 'beef', meat_goat: 'goat meat',
    meat_goose: 'goose meat', meat_pig: 'pork', meat_sheep: 'mutton',
    naturestaff: 'nature staff', offhand: 'off-hands', ore: 'bars (refining)',
    plate_armor: 'plate armor', plate_helmet: 'plate helmet', plate_shoes: 'plate shoes',
    potion: 'potions', quarterstaff: 'quarterstaffs', rock: 'stone (refining)', spear: 'spears',
    sword: 'swords', tools: 'tools', wood: 'planks (refining)',
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
    const opts = '<option value="">— none</option>' + cats.map((x) => `<option value="${x.c}">${esc(x.n)}</option>`).join('');
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
    CLOTH_HEAD: ['Thetford', 'cloth helmet'], CLOTH_ARMOR: ['Fort Sterling', 'cloth armor'], CLOTH_SHOES: ['Bridgewatch', 'cloth shoes'],
    LEATHER_HEAD: ['Lymhurst', 'leather helmet'], LEATHER_ARMOR: ['Thetford', 'leather armor'], LEATHER_SHOES: ['Lymhurst', 'leather shoes'],
    PLATE_HEAD: ['Fort Sterling', 'plate helmet'], PLATE_ARMOR: ['Bridgewatch', 'plate armor'], PLATE_SHOES: ['Martlock', 'plate shoes'],
  };
  const WEAPON = [
    [/SWORD|CLAYMORE|DUALSWORD|CLEAVER|GALATINE|KINGMAKER|CARVINGSWORD/, 'Lymhurst', 'swords'],
    [/_BOW|WARBOW|LONGBOW|WHISPERINGBOW/, 'Lymhurst', 'bows'],
    [/ARCANESTAFF|ENIGMATICSTAFF|WITCHWORK|OCCULTSTAFF|MALEVOLENT/, 'Lymhurst', 'arcane staff'],
    [/_AXE|BATTLEAXE|HALBERD|CARRIONCALLERS|REALMBREAKER|BEARPAWS|INFERNALSCYTHE/, 'Martlock', 'axes'],
    [/QUARTERSTAFF|IRONCLADSTAFF|DOUBLEBLADEDSTAFF|BLACKMONKSTONE|SOULSCYTHE|GRAILSEEKER/, 'Martlock', 'quarterstaffs'],
    [/FROSTSTAFF|GLACIALSTAFF|HOARFROST|ICICLESTAFF|PERMAFROST/, 'Martlock', 'frost staff'],
    [/_OFF_/, 'Martlock', 'off-hand'],
    [/CROSSBOW|WEEPINGREPEATER|BOLTCASTERS|SIEGEBOW/, 'Bridgewatch', 'crossbows'],
    [/DAGGER|CLAWPAIR|BLOODLETTER|BLACKHANDS|DEATHGIVERS|BRIDLEDFURY/, 'Bridgewatch', 'daggers'],
    [/CURSEDSTAFF|DEMONICSTAFF|LIFECURSE|CURSEDSKULL|DAMNATION/, 'Bridgewatch', 'cursed staff'],
    [/HAMMER|POLEHAMMER|TOMBHAMMER|FORGEHAMMERS|GROVEKEEPER/, 'Fort Sterling', 'hammers'],
    [/_SPEAR|_PIKE|GLAIVE|HERESYSPEAR|TRINITYSPEAR|DAYBREAKER/, 'Fort Sterling', 'spears'],
    [/HOLYSTAFF|DIVINESTAFF|FALLENSTAFF|REDEMPTIONSTAFF|HALLOWFALL/, 'Fort Sterling', 'holy staff'],
    [/_MACE|HEAVYMACE|MACEPAIR|INCUBUSMACE|CAMLANN/, 'Thetford', 'maces'],
    [/FIRESTAFF|INFERNOSTAFF|WILDFIRESTAFF|BLAZINGSTAFF|DAWNSONG/, 'Thetford', 'fire staff'],
    [/NATURESTAFF|WILDSTAFF|DRUIDICSTAFF|BLIGHTSTAFF|RAMPANTSTAFF/, 'Thetford', 'nature staff'],
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
  const BRECILIEN_ONLY = [[/^T\d+_BAG/, 'bags'], [/^T\d+_CAPE/, 'capes'], [/_POTION/, 'potions']];
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
    box.innerHTML = favs.map((f) => `<span class="fav-chip" data-fav="${esc(f.id)}" data-favn="${esc(f.n)}" title="Open ${esc(f.n)}"><b>${esc(f.n)}</b><span class="fav-x" data-favx="${esc(f.id)}" title="Remove from favourites">✕</span></span>`).join('');
  }
  function refreshFavStars() {
    document.querySelectorAll('[data-favstar]').forEach((el) => {
      const on = isFav(currentBase);
      el.classList.toggle('on', on); el.textContent = on ? '★' : '☆';
      el.title = on ? 'Remove from favourites' : 'Save to favourites';
    });
  }
  function toggleFav() {
    if (!currentBase) return;
    if (isFav(currentBase)) { favs = favs.filter((f) => f.id !== currentBase); toast('☆ Removed from favourites'); }
    else { favs = [{ id: currentBase, n: currentName }, ...favs.filter((f) => f.id !== currentBase)].slice(0, FAV_MAX); toast('★ Saved to favourites'); }
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
    if (pendingEnch != null) {
      currentEnch = pendingEnch; pendingEnch = null;
      document.querySelectorAll('#item-ench button[data-e]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.e === currentEnch)));
    }
    results.innerHTML = ''; search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : '');
    { const co = document.getElementById('cmp-offer'); if (co) co.value = ''; }
    loadMarket(); loadCraft();
    { const lv = document.getElementById('tab-level'); if (lv && !lv.hidden) loadLevel(); }
    { const sv = document.getElementById('tab-sell'); if (sv && !sv.hidden) loadSell(); }
  }
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 180); });
  { const pb = document.getElementById('item-paste'); if (pb) pb.addEventListener('click', async () => {
      let txt = '';
      try { txt = await navigator.clipboard.readText(); } catch (_) { toast('Could not read the clipboard'); return; }
      txt = String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!txt) { toast('Clipboard empty'); return; }
      search.value = txt; search.focus(); doSearch();
    }); }
  // "Bolsa de visión del maestro .1" o "vara 6.2": el sufijo dice el encantamiento (y el tier)
  let pendingEnch = null;
  function parseQuery(raw) {
    const m = /(?:\b([4-8]))?\s*\.\s*([0-4])\s*$/.exec(raw);
    if (!m) return { text: raw, tier: null, ench: null };
    return { text: raw.slice(0, m.index).trim(), tier: m[1] ? +m[1] : null, ench: +m[2] };
  }
  function doSearch() {
    const parsed = parseQuery(search.value.trim());
    pendingEnch = parsed.ench;
    const q = norm(parsed.text);
    if (q.length < 2) { results.innerHTML = ''; return; }
    // solo items base (sin @ench): una fila por item; el encantamiento se elige con el filtro Ench.
    const matches = items.filter((it) => it.id.indexOf('@') < 0 && norm(it.n).includes(q)
      && (!parsed.tier || it.id.startsWith('T' + parsed.tier + '_'))).slice(0, 14);
    results.innerHTML = matches.length
      ? matches.map((m) => `<div class="mres" data-id="${esc(m.id)}"><img class="ires-icon" src="icon://item/${encodeURIComponent(m.id)}?size=40" loading="lazy" alt=""><span class="ires-name">${esc(m.n)}</span><span class="mid">${recipes[m.id] ? '🔨' : ''}</span></div>`).join('')
      : '<div class="mempty">No results</div>';
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
      if (currentBase) {
        search.value = currentName + (currentEnch > 0 ? ` .${currentEnch}` : '');
        loadMarket(); renderCraft();
        const sv = document.getElementById('tab-sell'); if (sv && !sv.hidden) loadSell();
      }
    });
  });

  // ---------- calidad (filtro global, como el de encantamiento) ----------
  document.querySelectorAll('#item-quality button[data-q]').forEach((b) => {
    b.addEventListener('click', () => {
      currentQuality = +b.dataset.q;
      document.querySelectorAll('#item-quality button[data-q]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (currentBase) {
        loadMarket(); loadCraft();
        const sv = document.getElementById('tab-sell'); if (sv && !sv.hidden) loadSell();
      }
      onScanFilterChange();
    });
  });

  // ---------- pestañas ----------
  document.querySelectorAll('#item-tabs .tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#item-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      ['market', 'sell', 'craft', 'scan', 'level', 'config'].forEach((t) => { const el = document.getElementById('tab-' + t); if (el) el.hidden = b.dataset.tab !== t; });
      if (b.dataset.tab === 'level') loadLevel();
      if (b.dataset.tab === 'sell') loadSell();
      const enchSel = document.getElementById('item-ench');
      // en Vender el encantamiento elegido es el que YA tiene el item: es el punto de partida
      if (enchSel) enchSel.style.display = (b.dataset.tab === 'market' || b.dataset.tab === 'sell') ? '' : 'none';
      const frSel = document.getElementById('item-fresh');
      if (frSel) frSel.style.display = (b.dataset.tab === 'market' || b.dataset.tab === 'top') ? '' : 'none';
      const qSel = document.getElementById('item-quality');
      if (qSel) qSel.style.display = (b.dataset.tab === 'config' || b.dataset.tab === 'level') ? 'none' : '';
    });
  });

  const QNAMES = ['All', 'Normal', 'Good', 'Outstanding', 'Excellent', 'Masterpiece'];
  function itemHeadHtml(sub) {
    const qid = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    return `<div class="mkt-item-head"><img class="mkt-item-icon" src="icon://item/${encodeURIComponent(qid)}?size=64" alt=""><div><div class="mkt-item-name"><span class="copyable" data-copy="${esc(copyNameOf(currentBase, currentEnch, currentName))}" title="Clic para copiar «${esc(copyNameOf(currentBase, currentEnch, currentName))}»">${esc(currentName)}</span> <span class="enchtag">.${currentEnch}</span><span class="fav-star${isFav(currentBase) ? ' on' : ''}" data-favstar="1" title="${isFav(currentBase) ? 'Remove from favourites' : 'Save to favourites'}">${isFav(currentBase) ? '★' : '☆'}</span></div><div class="mkt-item-sub">${sub}</div></div></div>`;
  }

  // ================= MERCADO =================
  async function loadMarket(silent) {
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    if (!silent) tabMarket.innerHTML = '<div class="mempty">Loading prices…</div>';
    const [prices, vol, live] = await Promise.all([
      window.overlay.marketPrices(queryId, currentQuality),
      window.overlay.history([queryId], scopeCities(), 21, currentQuality),
      window.overlay.marketLive(queryId, currentQuality).catch(() => null),
    ]);
    marketData = (prices || []).filter((r) => inScope(r.city));
    if (Array.isArray(live)) {
      live.forEach((lr) => {
        if (!lr || !lr.city || !inScope(lr.city)) return;
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
        const cs = pr.filter((r) => r.city !== 'Black Market' && inScope(r.city) && r.sell_price_min > 0).map((r) => r.sell_price_min);
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
    const title = pico ? `Spike: they pay ${fmt(bm)} right now but ~${fmt(avg)} is normal; plan with the average`
      : flojo ? `Paying below normal right now (~${fmt(avg)} average); it usually recovers`
      : `The current price is in line with the historical average (~${fmt(avg)}): reliable`;
    const txt = short ? (pico ? '⚠' : flojo ? '↓' : '✅')
      : (pico ? `⚠ SPIKE ${r.toFixed(1)}×` : flojo ? '↓ weak' : '✅ steady');
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
    if (!rows.length) { if (!silent) tabMarket.innerHTML = '<div class="mempty">No market data.</div>'; return; }
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
    // ciudades primero, luego Rests y contrabandistas; el Black Market al final
    // (es venta inmediata al NPC, no sitio para comprar)
    const MKT_ORDER = { royal: 0, rest: 1, smuggler: 2 };
    const mktRank = (c) => (c === 'Black Market' ? 3 : (MKT_ORDER[marketTypeOf(c)] || 0));
    rows.sort((a, b) => mktRank(a.city) - mktRank(b.city));
    const queryId = currentEnch > 0 ? currentBase + '@' + currentEnch : currentBase;
    const itemHead = itemHeadHtml(`quality: ${QNAMES[currentQuality] || 'All'} · prices by market · auto-refreshes every 60s`);
    const bmRowX = rows.find((r) => r.city === 'Black Market');
    const bmAvg = (marketVolMap['Black Market'] || {}).avg || 0;
    const bmStale = !!bmRowX && isStale(bmRowX.buy_price_max_date);
    let bestHtml = '';
    if (freshFilterActive || (freshMaxH() > 0 && !freshRows.length && cityRows.length)) {
      bestHtml += freshRows.length
        ? `<div class="fresh-note" title="Left out of the calculation for being old; still visible in grey">⏳ ${staleDropped} over +${freshMaxH()}h left out${bmStale ? ' · stale BM' : ''}</div>`
        : `<div class="fresh-note warn" title="No price is under the freshness limit: the calculation is using old data">⚠ everything +${freshMaxH()}h</div>`;
    }
    const QN2 = ['', 'Normal', 'Good', 'Outstanding', 'Excellent', 'Masterpiece'];
    let qualHtml = '';
    if (Array.isArray(marketQuality) && marketQuality.some((x) => x.buy || x.bm)) {
      qualHtml = '<div class="mkt-quality"><div class="mkt-q-title" title="What you pay for it and what the Black Market pays you, by quality">💎 By quality</div>'
        + '<table><thead><tr><th style="text-align:left">Quality</th><th>Buy</th><th>BM pays</th><th>Vol/day</th><th>Seen</th></tr></thead><tbody>'
        + marketQuality.map((x) => { const age = agoStr(x.date); const stale = ageHours(x.date) > (freshMaxH() || 24); return `<tr><td class="name">${QN2[x.q]}</td><td class="silver">${x.buy ? fmt(x.buy) : '—'}</td><td class="${x.bm ? 'best-sell' : 'faint'}">${x.bm ? fmt(x.bm) : '—'} ${sostChip(x.bm, x.avg)}</td><td class="${x.vol ? '' : 'faint'}">${x.vol ? fmtInt(x.vol) : '—'}</td><td class="${stale ? 'down' : 'faint'}">${stale ? '⚠ ' : ''}${age || '—'}</td></tr>`; }).join('')
        + '</tbody></table></div>';
    }
    // con Rests y contrabandistas la lista de mercados se va a ~46 filas: scroll propio para que
    // el panel no crezca sin fin (la mejor jugada y la tabla por calidad se quedan fuera del scroll)
    const tableHtml = '<div class="mkt-scroll"><table><thead><tr><th style="text-align:left">Market</th><th title="The cheapest sell offer: this is what you pay if you buy it now">Buying it costs</th><th title="The best buy order: this is what you get if you sell instantly">Selling now pays</th><th title="What it actually closes at (historical)">Average price</th><th>Vol/day</th><th>Seen</th></tr></thead><tbody>'
      + rows.map((r) => {
        const isBM = r.city === 'Black Market';
        const sp = r.sell_price_min;
        const outlier = !isBM && sp > 0 && isSellOutlier(sp);
        const sellStale = !isBM && sp > 0 && freshFilterActive && isStale(r.sell_price_min_date);
        let cls = 'silver', mark = '', tip = '';
        if (outlier) { cls = 'faint'; mark = '⚠ '; tip = ' title="Outlier price (possible troll order or bad data): left out of the calculation"'; }
        else if (sellStale) { cls = 'faint'; mark = '⏳ '; tip = ` title="Price from ${agoStr(r.sell_price_min_date) || '?'} ago, over the freshness limit: left out of the calculation"`; }
        else if (!isBM && sp > 0 && sp === minSell) { cls = 'best-buy'; mark = '🛒 '; }
        else if (!isBM && sp > 0 && sp === maxSell) { cls = 'best-sell'; mark = '💰 '; }
        const sellCell = (!isBM && sp > 0) ? `<td class="${cls}"${tip}>${mark}${fmt(sp)}${qBadge(r.sell_price_min_quality)}</td>` : '<td class="faint">—</td>';
        const bAge = agoStr(r.buy_price_max_date);
        const vc = marketVolMap[cityKey(r.city)] || {}; const vd = vc.daily || 0; const avg = vc.avg || 0;
        // el chip solo tiene sentido con una calidad concreta: en "Todas" el buy_max coge
        // la calidad más cara y el medio es la mezcla → daría un pico falso.
        const chip = (isBM && currentQuality) ? sostChip(r.buy_price_max, avg) : '';
        const fast = r.buy_price_max > 0 ? `<td class="${isBM && !bmStale ? 'best-sell' : 'faint'}" title="the best buy order: paid to you instantly · seen ${bAge || '—'} ago${isBM && bmStale ? ' · over the freshness limit: left out of the calculation' : ''}">${isBM ? (bmStale ? '⏳🏴 ' : '🏴 ') : ''}${fmt(r.buy_price_max)}${qBadge(r.buy_price_max_quality)}${chip}</td>` : '<td class="faint">—</td>';
        const volCell = vd > 0 ? `<td title="Units sold per day here (estimated, community data)">${fmtInt(vd)}</td>` : '<td class="faint">—</td>';
        const avgCell = avg > 0 ? `<td class="cr-vol-avg" title="Average price it really closes at (historical). However high or low the order sits, this is what it sells for.">~${fmt(avg)}</td>` : '<td class="faint">—</td>';
        const sAge = agoStr(r.sell_price_min_date);
        const shownAge = isBM ? (bAge || sAge) : (sAge || bAge);
        const shownDate = isBM ? (r.buy_price_max_date || r.sell_price_min_date) : (r.sell_price_min_date || r.buy_price_max_date);
        const staleLimit = freshMaxH() || 24;
        const stale = !!shownAge && ageHours(shownDate) > staleLimit;
        const liveDot = r._live ? ' <span class="live-dot" title="Seen by YOUR client right now (live capture)">🟢</span>' : '';
        return `<tr><td class="name">${cityLabel(r.city)}${liveDot}</td>${sellCell}${fast}${avgCell}${volCell}<td class="${stale ? 'down' : 'faint'}" title="sell ${sAge || '—'} · buy ${bAge || '—'}${stale ? ` · data older than ${staleLimit}h, check it in game` : ''}">${stale ? '⚠ ' : ''}${shownAge}</td></tr>`;
      }).join('')
      + '</tbody></table></div>'
      + bestHtml + qualHtml;
    const holder = document.getElementById('mkt-table');
    if (silent && holder) { holder.innerHTML = tableHtml; return; }
    tabMarket.innerHTML = itemHead + '<div id="mkt-table">' + tableHtml + '</div>' + flipHtml(minSell || 0, maxSell || 0);
    bindFlip();
  }
  function flipHtml(buy, sell) {
    return '<div class="flip"><div class="flip-title">Flip calculator</div>'
      + '<div class="cfg-row"><span class="cfg-lbl">Quantity</span><input type="number" id="flip-qty" value="100" min="1"></div>'
      + `<div class="cfg-row"><span class="cfg-lbl">Buy at</span><input type="number" id="flip-buy" value="${Math.round(buy)}" min="0"></div>`
      + `<div class="cfg-row"><span class="cfg-lbl">Sell at</span><input type="number" id="flip-sell" value="${Math.round(sell)}" min="0"></div>`
      + '<label class="cfg-check"><input type="checkbox" id="flip-buy-order"> Buy with order (+2.5%)</label>'
      + '<label class="cfg-check"><input type="checkbox" id="flip-sell-order" checked> Sell with order (+2.5%)</label>'
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
    const tax = bruto * salesTax();
    const sellSetup = sellOrder ? bruto * 0.025 : 0;          // tasa de orden de venta
    const neto = bruto - tax - sellSetup;
    const gan = neto - gasto;
    const roi = gasto > 0 ? (gan / gasto) * 100 : 0;
    const res = document.getElementById('flip-result'); if (!res) return;
    res.innerHTML = `You spend <b class="silver">${fmt(gasto)}</b> · you net <b class="silver">${fmt(neto)}</b>`
      + `<div class="flip-break">sales tax ${fmt(tax)}${(buySetup + sellSetup) ? ' · orders ' + fmt(buySetup + sellSetup) : ''}</div>`
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

  const BASE_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien', 'Black Market'];
  const CRAFT_CITIES = ['Caerleon', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien']; // mats: sin Black Market

  // Mercados secundarios: las 3 Rests de las Outlands y las zonas negras con contrabandista.
  // El backend los ingiere igual que las ciudades y su catálogo dice cuáles tienen órdenes
  // vivas, así que no se ofrecen mercados muertos. Crafteo se queda siempre en CRAFT_CITIES:
  // allí no hay estaciones ni bono de ciudad, y falsearía "la ciudad más barata".
  const extraMarkets = { rest: [], smuggler: [] };
  let marketTypes = {};
  const SCOPE_KEY = 'albion-overlay-markets-v1';
  const marketScope = () => {
    const el = document.getElementById('mkt-scope');
    return (el && el.value) || localStorage.getItem(SCOPE_KEY) || 'rest';
  };
  // sin catálogo (backend caído) se asume lo restrictivo: solo las de siempre son de ciudad
  const BASE_SET = new Set(BASE_CITIES.map((c) => String(c).replace(/\s+/g, '')));
  const marketTypeOf = (city) => marketTypes[cityKey(city)] || (BASE_SET.has(cityKey(city)) ? 'royal' : 'smuggler');
  function scopeCities() {
    const s = marketScope();
    if (s === 'city') return BASE_CITIES;
    if (s === 'all') return [...BASE_CITIES, ...extraMarkets.rest, ...extraMarkets.smuggler];
    return [...BASE_CITIES, ...extraMarkets.rest];
  }
  function inScope(city) {
    const t = marketTypeOf(city), s = marketScope();
    if (t === 'rest') return s !== 'city';
    if (t === 'smuggler') return s === 'all';
    return true;
  }
  const MARKET_ICON = { rest: '🌀', smuggler: '🕶' };
  const marketIcon = (city) => MARKET_ICON[marketTypeOf(city)] || '';
  const cityLabel = (c) => (c === 'Black Market' ? '🏴 Black Market' : ((marketIcon(c) ? marketIcon(c) + ' ' : '') + esc(c)));
  async function loadMarketCatalog() {
    if (!window.overlay.markets) return;
    let rows = [];
    try { rows = await window.overlay.markets(); } catch (_) { return; }
    if (!Array.isArray(rows) || !rows.length) return;
    marketTypes = {}; extraMarkets.rest = []; extraMarkets.smuggler = [];
    rows.forEach((m) => {
      if (!m || !m.city) return;
      marketTypes[cityKey(m.city)] = m.type;
      if (m.type === 'rest') extraMarkets.rest.push(m.city);
      else if (m.type === 'smuggler' && m.orders > 0) extraMarkets.smuggler.push(m.city);
    });
    extraMarkets.smuggler.sort();
    fillScanCityOptions();
  }
  // "Comprar en" del escáner y de Nivel: ciudades siempre; Rests y contrabandistas según el filtro
  function fillScanCityOptions() {
    const s = marketScope();
    ['scan-city', 'level-city'].forEach((selId) => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      const keep = sel.value;
      sel.querySelectorAll('optgroup[data-extra]').forEach((g) => g.remove());
      const add = (label, list) => {
        if (!list.length) return;
        const g = document.createElement('optgroup');
        g.label = label; g.setAttribute('data-extra', '1');
        list.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; g.appendChild(o); });
        sel.appendChild(g);
      };
      if (s !== 'city') add('🌀 Rests', extraMarkets.rest);
      if (s === 'all') add('🕶 Smugglers', extraMarkets.smuggler);
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
      else if (keep) {
        sel.value = '';
        if (selId === 'scan-city') onScanFilterChange();
      }
    });
  }
  {
    const sel = document.getElementById('mkt-scope');
    if (sel) {
      const saved = localStorage.getItem(SCOPE_KEY);
      if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
      sel.addEventListener('change', () => {
        localStorage.setItem(SCOPE_KEY, sel.value);
        fillScanCityOptions();
        if (currentBase) loadMarket();
        onScanFilterChange();
        { const lv = document.getElementById('tab-level'); if (lv && !lv.hidden) loadLevel(); }
      });
    }
    loadMarketCatalog();
  }
  async function loadCraft() {
    const rec = recipes[currentBase];
    { const q = document.getElementById('craft-qty'); if (q) q.dataset.auto = '1'; }
    if (!rec) { craftOut.innerHTML = '<div class="mempty">This item cannot be crafted.</div>'; return; }
    applyAutoReturn();
    craftOut.innerHTML = '<div class="mempty">Loading prices…</div>';
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
      window.overlay.craftPrices([...matSet], BASE_CITIES, 0),
      window.overlay.craftPrices(prodIds, BASE_CITIES, prodQ),
      window.overlay.history(prodIds, BASE_CITIES, 21, 0),
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
      // ciudad por defecto: la más barata según el MISMO criterio que usa el bloque de compra
      // (mismo modo de compra y mismo descarte de precios podridos), para que no discrepen
      let chosen = perCity.find((x) => x.c === defaultCity && x.p > 0);
      if (!chosen) { const ch = cheapestOf(id); chosen = perCity.find((x) => x.c === ch.city && x.p > 0); }
      if (!chosen) chosen = withPrice.slice().sort((a, b) => a.p - b.p)[0];
      const chosenCity = chosen ? chosen.c : defaultCity;
      const det = chosen ? chosen.p : 0;
      const opts = perCity.map((x) => `<option value="${x.p}"${x.c === chosenCity ? ' selected' : ''}>${esc(x.c)} ${x.p ? '· ' + fmt(x.p) : '· s/p'}</option>`).join('');
      const enchTag = (e > 0 && enchantable(m.nameId)) ? '.' + e : '';
      const ret = returnable(m.nameId) ? 1 : 0;
      const mnmBase = nameById[m.nameId] || m.nameId;
      const enchName = (m.priceId !== m.nameId && nameById[m.priceId]) || '';
      const ownName = enchName && enchName !== mnmBase ? enchName : '';
      const mnm = ownName || mnmBase;
      const copyName = ownName || (mnmBase + (enchTag ? ' ' + enchTag : ''));
      const subC = subCraftCost(m.nameId, e);
      let subChip = '';
      if (subC != null && subC > 0) {
        const better = det > 0 && subC < det;
        const diff = det > 0 ? Math.round((subC / det - 1) * 100) : null;
        const rr = returnRate(m.nameId);
        subChip = `<span class="cr-sub-chip ${better ? 'win' : 'lose'}" data-sub="${Math.round(subC)}"`
          + ` title="Making it yourself costs ${fmt(subC)}/unit (return ${rr.pct.toFixed(1)}% in ${rr.match ? cityShort(rr.bon.city) : 'a station with no bonus'} + station fee). Buying it costs ${det ? fmt(det) : '—'}. Click to use this cost.">`
          + `🔨 ${fmt(subC)}${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff}%)` : ''}</span>`;
      }
      return `<div class="cr-row" data-c="${m.c}" data-ret="${ret}" data-id="${esc(id)}" data-name="${esc(copyName)}">`
        + `<span class="cr-name copyable" data-copy="${esc(copyName)}" title="Click to copy «${esc(copyName)}» (the exact name to search in game)">${m.c}× ${esc(mnm)}${enchTag}</span>`
        + subChip
        + `<span class="cr-buy" title="Exact units of this material to buy for the given quantity">🛒 ${fmtInt(m.c * craftQty)}</span>`
        + `<select class="cr-city" title="Market where you buy this material">${opts}</select>`
        + `<input class="cr-price" type="number" data-c="${m.c}" data-ret="${ret}" value="${Math.round(det)}">`
        + `<span class="cr-subtot silver" title="Subtotal (price × quantity)">${fmt(det * m.c)}</span>`
        + `</div>`;
    }).join('');
    const bs = bestSellOf(prodEnch(currentBase, e), tax, sellFee);
    const prodPriceMap = craftPriceMap[prodEnch(currentBase, e)] || {};
    const prodCityRows = BASE_CITIES.filter((c) => c !== 'Black Market' || bmBuys(currentBase)).map((c) => ({ c, p: sellUnitPrice(prodPriceMap[c]), instant: !sellOrderOn() }));
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
      ? `<div class="cr-vol" title="Units/day each market absorbs · ~ = average realised price">Absorbs/day: ${vsorted.map((x) => `<span class="${x[0] === sellCk ? 'cr-vol-best' : ''}">${cityShort(x[0])} <b>${fmtInt(x[1].daily)}</b>${x[1].avg ? ` <span class="cr-vol-avg" title="average realised price">~${fmt(x[1].avg)}</span>` : ''}</span>`).join(' · ')}</div>`
      : '<div class="cr-vol faint">Volume/day: no data</div>';

    craftOut.innerHTML = itemHeadHtml('crafting · pick materials and where to sell')
      + `<div class="cr-mini-row">${mini}</div>`
      + `<div class="cr-recipe" id="cr-mats"><div class="cr-sub">Recipe E${e} <button class="mini-btn" id="cr-cheapest" title="Sets every material to the price of the market where it is cheapest (careful: may mean several trips)">💸 cheapest</button></div>${matRows}</div>`
      + `<div class="cr-row cr-prod"><span class="cr-name">Sell in ${prodChip}</span><select class="cr-city" id="cr-prod-city" title="Market where you sell the product · price per market (🏴 Black Market = instant sale to its buy order)">${prodOpts}</select><input class="cr-price" id="cr-prod-price" type="number" data-instant="${prodInstant ? 1 : 0}" data-sellck="${cityKey(chosenSell || '')}" data-sellcity="${esc(chosenSell || '')}" value="${Math.round(prodPrice)}"></div>`
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
    const warnHtml = suspicious ? `<div class="cmp-verdict down" style="margin-top:8px" title="Impossible profit: almost certainly a bad sell price. Check it in game">⚠ outlier sell price (${roiTxt(roi)})</div>` : '';
    // comparación contra una oferta manual (antigua pestaña Comparar, ahora integrada)
    const offer = +(document.getElementById('cmp-offer') || {}).value || 0;
    let offerHtml = '';
    if (offer > 0) {
      const offerNet = offer * (1 - tax);
      const oGain = offerNet - netCost;
      const oRoi = netCost > 0 ? (oGain / netCost) * 100 : 0;
      const opc = oGain >= 0 ? 'up' : 'down';
      offerHtml = `<div class="cmp-verdict ${opc}" style="margin-top:8px">${oGain >= 0 ? '✅' : '❌'} offer <b>${fmt(offer)}</b> (net ${fmt(offerNet)}) → <b>${oGain >= 0 ? '+' : ''}${fmt(oGain)}/unit</b> (${roiTxt(oRoi)})</div>`;
    }
    result.innerHTML = `1 unit → cost <span class="silver">${fmt(netCost)}</span> · net sale <span class="silver">${fmt(ventaNeta)}</span> · <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit)}</b> (ROI ${roiTxt(roi)})`
      + `<div style="margin-top:5px">For <b>${qty}</b> units → you invest <b class="silver">${fmt(netCost * qty)}</b> · you get back <b class="silver">${fmt(ventaNeta * qty)}</b> · profit <b class="${pc}">${profit >= 0 ? '+' : ''}${fmt(profit * qty)}</b></div>`
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
    inp.placeholder = c ? '' : 'no data';
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
    const rows = CRAFT_CITIES.map((ct) => ({ ct, p: cityUnitPrice(c[ct]) })).filter((x) => x.p > 0);
    if (!rows.length) return { price: 0, city: '' };
    const all = rows.map((x) => x.p);
    const valid = rows.filter((x) => !isLoOutlier(x.p, all));   // ignora precios irrisorios (dato podrido)
    const use = valid.length ? valid : rows;
    const best = use.reduce((a, b) => (b.p < a.p ? b : a));
    return { price: best.p, city: best.ct };
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
    let extra = `<div style="margin-top:5px" title="Below that price you lose silver: it already includes sales tax and, if you ticked it, the order fee.">You lose below <b>${fmtInt(breakEven)}</b> · you sell at <b>${fmtInt(ctx.sellPrice)}</b> <span class="${cc}">(${cushion >= 0 ? '+' : ''}${cushion.toFixed(1)}% cushion)</span></div>`;

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
      const warn = effOf(currentBase) > 0 ? '' : ' <span class="down" title="Not calibrated: it uses the unspecialised focus cost, so it looks worse than reality. Type what the station shows into Focus/unit.">⚠ spec not calibrated</span>';
      extra += `<div style="margin-top:5px" title="Focus is the scarce resource, not silver: profit per point is what decides what to craft.">${fmtInt(focusAvail)} focus → <b>${fmtInt(totalUnits)}</b> units · <b class="${ctx.profit >= 0 ? 'up' : 'down'}">${perFocus >= 0 ? '+' : ''}${perFocus.toFixed(1)}</b>/focus · session <b class="${gc}">${gain >= 0 ? '+' : ''}${fmt(gain)}</b>${warn}</div>`;
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
    const wanted = rows.filter((r) => r.need > 0);
    const wtbEs = wanted.map((r) => `${fmtInt(r.need)}x ${r.m.name} a ${fmtInt(r.offer)}`).join(' + ');
    const msgEs = `Compro ${wtbEs} · total ${fmtInt(totOffer)}`;
    const num = (n) => Math.round(n).toLocaleString('en-US');
    const wtbEn = wanted.map((r) => `${num(r.need)}x ${enNameOf(r.m.id)} @ ${num(r.offer)}`).join(' + ');
    const msgEn = `WTB ${wtbEn} — ${num(totOffer)} total`;
    bEl.className = 'cr-block';
    bEl.innerHTML = '<div class="cr-b-title">🛒 Buy materials'
      + ` <span class="faint">· for ${fmtInt(buyUnits)} units${matCraftsBudget !== buyUnits ? ' (materials for ' + fmtInt(matCraftsBudget) + ')' : ''}</span></div>`
      + '<table class="cr-tbl"><thead><tr><th>Material</th><th title="Units you need to buy">Units</th>'
      + '<th title="Best BUY order right now: what another player is already bidding. To be top bidder you have to beat it.">Bid</th>'
      + '<th title="Cheapest price across ALL markets and where it is. That is your ceiling: above it you are better off going there.">Ceiling (cheapest)</th>'
      + '<th title="Suggested price for a direct chat trade: above what the seller would net on the market and below what it costs you.">Offer</th></tr></thead><tbody>'
      + rows.map((r) => `<tr><td class="name copyable" data-copy="${esc(r.m.id)}" title="Click to copy the ID">${esc(r.m.name)}</td>`
        + `<td><b>${fmtInt(r.need)}</b></td>`
        + `<td class="${r.over ? 'down' : ''}" title="Set your order at ${fmtInt(r.orderPrice)} to be top bidder${r.over ? ' — careful, that is already past what you can pay without losing (' + fmtInt(r.maxPay) + ')' : ''}">${r.bid ? fmtInt(r.bid) : '—'}</td>`
        + `<td title="${r.maxPay > 0 ? 'Without losing money you could go up to ' + fmtInt(r.maxPay) : ''}">${r.ask ? fmtInt(r.ask) : '—'}${r.cheap.city ? ` <span class="faint">${cityShort(r.cheap.city)}</span>` : ''}</td>`
        + `<td class="silver">${r.offer > 0 ? fmtInt(r.offer) : '—'}</td></tr>`).join('')
      + '</tbody></table>'
      + `<div class="cr-kv" style="margin-top:6px"><span>Buying instantly</span><span><b class="silver">${fmt(totInstant)}</b></span></div>`
      + `<div class="cr-kv"><span title="Beating the current bid by 1 silver, plus the 2.5% order setup fee. Cheaper, but it takes time to fill.">Placing buy orders</span><span><b class="silver">${fmt(totOrder)}</b></span></div>`
      + `<div class="cr-kv"><span title="Direct chat trade: you skip the order fee and the seller skips the sales tax. You split the saving.">Direct trade</span><span><b class="silver">${fmt(totOffer)}</b> <span class="up">−${fmt(totInstant - totOffer)}</span></span></div>`
      + `<div class="cr-wtb-lbl">🇪🇸 for Spanish chat<span class="faint"> · click to copy</span></div>`
      + `<textarea class="cr-wtb" id="cr-wtb" rows="2" readonly title="Click to copy the Spanish message">${esc(msgEs)}</textarea>`
      + `<div class="cr-wtb-lbl">🇬🇧 for global chat<span class="faint"> · click to copy</span></div>`
      + `<textarea class="cr-wtb" id="cr-wtb-en" rows="2" readonly title="Click to copy the English message">${esc(msgEn)}</textarea>`;
    ['cr-wtb', 'cr-wtb-en'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { el.select(); copyText(el.value); });
    });
  }

  // (La antigua pestaña Comparar quedó fusionada en Crafteo: el input "Te ofrecen"
  //  se evalúa dentro de calcResult y muestra el veredicto de rentabilidad.)
  { const co = document.getElementById('cmp-offer'); if (co) co.addEventListener('input', () => { if (currentBase) calcResult(); }); }

  // ================= VENDER (rutas de salida del item que ya tienes) =================
  // La calidad NO se puede cambiar en el juego: se fija al craftear y encantar la respeta.
  // Por eso solo hay dos familias de ruta: venderlo tal cual, o subirle encantamiento y venderlo.
  // Las cantidades de runa/alma/reliquia salen de upgraderequirements (ao-bin-dumps), no de una
  // estimación: son las mismas para los tres niveles de cada item.
  const ENCH_MAT_NAME = ['', 'RUNE', 'SOUL', 'RELIC'];
  const ENCH_MAX = 3;   // el .4 avaloniano no tiene receta de mejora: solo se craftea
  function enchStep(baseId, lvl) {
    const e = enchIndex[baseId];
    if (!e || lvl < 1 || lvl > ENCH_MAX) return null;
    const kind = e[1];
    const id = kind === 1 ? 'T1_ALCHEMY_EXTRACT_LEVEL' + lvl
      : kind === 2 ? 'T1_FISHSAUCE_LEVEL' + lvl
      : 'T' + tierOf(baseId) + '_' + ENCH_MAT_NAME[lvl];
    return { id, count: e[0] };
  }
  const enchantableItem = (baseId) => !!enchIndex[baseId];
  const sellMatCity = () => (document.getElementById('sell-mat-city') || {}).value || '';
  const sellMatOrder = () => !!(document.getElementById('sell-mat-order') || {}).checked;
  const sellOwned = () => !!(document.getElementById('sell-owned') || {}).checked;
  const sellQty = () => Math.max(1, +((document.getElementById('sell-qty') || {}).value) || 1);
  let sellCache = null;

  async function loadSell(silent) {
    const out = document.getElementById('sell-out');
    if (!out) return;
    if (!currentBase) { out.innerHTML = '<div class="mempty">Search for an item above to see how best to sell it.</div>'; return; }
    const from = currentEnch;
    const top = (enchantableItem(currentBase) && from < ENCH_MAX) ? ENCH_MAX : from;
    const ids = []; for (let e = from; e <= top; e++) ids.push(prodEnch(currentBase, e));
    const matIds = []; for (let e = from + 1; e <= top; e++) { const s = enchStep(currentBase, e); if (s) matIds.push(s.id); }
    const locs = scopeCities();
    const matLocs = sellMatCity() ? [sellMatCity()] : CRAFT_CITIES;
    const q = currentQuality || 1;
    if (!silent) out.innerHTML = '<div class="mempty">Loading prices…</div>';
    let pr = [], vol = [], mat = [];
    try {
      [pr, vol, mat] = await Promise.all([
        window.overlay.craftPrices(ids, locs, q),
        window.overlay.history(ids, locs, 21, q),
        matIds.length ? window.overlay.craftPrices(matIds, matLocs, 0) : Promise.resolve([]),
      ]);
    } catch (_) { out.innerHTML = '<div class="mempty">Could not load prices (API limit or no connection?). Try again in a moment.</div>'; return; }
    const prod = {}, vols = {}, mats = {};
    (pr || []).forEach((r) => {
      if (!inScope(r.city)) return;
      (prod[r.item_id] = prod[r.item_id] || {})[cityKey(r.city)] = {
        sell: r.sell_price_min || 0, sellDate: r.sell_price_min_date || null,
        buy: r.buy_price_max || 0, buyDate: r.buy_price_max_date || null,
      };
    });
    (vol || []).forEach((r) => { (vols[r.item_id] = vols[r.item_id] || {})[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
    (mat || []).forEach((r) => { (mats[r.item_id] = mats[r.item_id] || {})[cityKey(r.city)] = { sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 }; });
    sellCache = { base: currentBase, name: currentName, from, top, prod, vols, mats, quality: q };
    renderSell();
  }

  const sellMatUnit = (cell) => {
    if (!cell) return 0;
    if (sellMatOrder()) return cell.buy > 0 ? cell.buy + 1 : (cell.sell || 0);
    return cell.sell || 0;
  };

  function renderSell() {
    const out = document.getElementById('sell-out');
    if (!out || !sellCache || sellCache.base !== currentBase || sellCache.from !== currentEnch) return;
    const { from, top, prod, vols, mats, quality } = sellCache;
    const tax = salesTax();
    const matFee = sellMatOrder() ? 1.025 : 1;
    const qty = sellQty();

    const matBest = (id) => {
      const c = mats[id] || {};
      let unit = 0, city = '';
      Object.keys(c).forEach((ck) => { const p = sellMatUnit(c[ck]); if (p > 0 && (!unit || p < unit)) { unit = p; city = ck; } });
      return { unit, city };
    };
    // lo que te deja cada mercado por unidad, por las dos vías: cobrar la puja al instante
    // (solo impuesto) o ponerte en la cola de venta (impuesto + 2,5%). Con orden se valora al
    // MENOR entre la orden de ahora y el medio histórico: el pico de un troll no lo cobras.
    const destsOf = (pid) => {
      const c = prod[pid] || {}, v = vols[pid] || {};
      const rows = [];
      Object.keys(c).forEach((ck) => {
        const cell = c[ck], vc = v[ck] || {}, avg = vc.avg || 0;
        if (cell.buy > 0) rows.push({ city: ck, way: 'instant', gross: cell.buy, net: cell.buy * (1 - tax), date: cell.buyDate, vol: vc.daily || 0, avg });
        if (cell.sell > 0) {
          const g = avg > 0 ? Math.min(cell.sell, avg) : cell.sell;
          rows.push({ city: ck, way: 'order', gross: g, net: g * (1 - tax - 0.025), date: cell.sellDate, vol: vc.daily || 0, avg });
        }
      });
      rows.forEach((r) => { r.stale = isStale(r.date); });
      const fresh = rows.filter((r) => !r.stale);
      const use = fresh.length ? fresh : rows;
      return use.sort((a, b) => b.net - a.net);
    };

    const routes = [];
    let acc = 0; const steps = []; let missing = null;
    for (let t = from; t <= top; t++) {
      if (t > from) {
        const st = enchStep(currentBase, t);
        const mb = st ? matBest(st.id) : null;
        if (!st || !mb.unit) { missing = st ? st.id : null; break; }
        acc += mb.unit * st.count * matFee;
        steps.push({ lvl: t, id: st.id, count: st.count, unit: mb.unit, city: mb.city });
      }
      const dests = destsOf(prodEnch(currentBase, t));
      routes.push({ t, extra: acc, steps: steps.slice(), dests, dest: dests[0] || null });
    }
    const priced = routes.filter((r) => r.dest);
    if (!priced.length) {
      out.innerHTML = itemHeadHtml('no market prices for this item right now')
        + '<div class="mempty">Nobody is buying or selling it in the markets you have selected. Widen the 🏪 filter or the freshness limit.</div>';
      return;
    }
    // el punto de partida es venderlo AHORA tal cual: todo lo demás se mide contra eso
    const baseRoute = routes[0].dest ? routes[0] : null;
    const baseNet = baseRoute ? baseRoute.dest.net : 0;
    const buyCell = prod[prodEnch(currentBase, from)] || {};
    let basePrice = 0, basePriceCity = '';
    Object.keys(buyCell).forEach((ck) => { const p = buyCell[ck].sell || 0; if (p > 0 && (!basePrice || p < basePrice)) { basePrice = p; basePriceCity = ck; } });
    const capital = sellOwned() ? 0 : basePrice;
    priced.forEach((r) => {
      r.cost = capital + r.extra;
      r.profit = r.dest.net - r.cost;
      r.roi = r.cost > 0 ? (r.profit / r.cost) * 100 : null;
      r.delta = (r.dest.net - r.extra) - baseNet;
    });
    const best = priced.reduce((a, b) => (b.delta > a.delta ? b : a), priced[0]);

    const wayTxt = (d) => (d.way === 'instant' ? 'instantly' : 'with an order');
    const wayTip = (d) => (d.way === 'instant'
      ? `You take that market's best bid right now: ${fmt(d.gross)} minus ${Math.round(tax * 100)}% tax`
      : `You queue at ${fmt(d.gross)} and wait: ${Math.round(tax * 100)}% tax plus the 2.5% order fee${d.avg > 0 ? ` · valued at the historical average (~${fmt(d.avg)}) when the current order is above it` : ''}`);
    const routeName = (t) => (t === from ? 'Sell it as it is' : `Enchant to .${t} and sell`);

    const rows = priced.map((r) => {
      const d = r.dest;
      const isBest = r === best;
      const dcls = r.delta > 0 ? 'up' : (r.delta < 0 ? 'down' : 'faint');
      const age = agoStr(d.date);
      return `<tr${isBest ? ' class="best-row"' : ''}><td class="name"><div class="scan-item"><img class="scan-ico" src="icon://item/${encodeURIComponent(prodEnch(currentBase, r.t))}?size=40" loading="lazy" alt=""><div class="scan-item-txt">${isBest ? '⭐ ' : ''}${esc(routeName(r.t))} <span class="enchtag">.${r.t}</span><br><span class="faint" style="font-size:11px">${cityShort(d.city)} · ${wayTxt(d)}${r.roi != null ? ` · ROI ${roiTxt(r.roi)}` : ''}</span></div></div></td>`
        + `<td class="silver" title="${r.t === from ? (capital ? 'What buying the item costs you' : 'You already own it: nothing to spend') : 'Enchanting materials' + (capital ? ' plus buying the item' : '')}">${r.cost > 0 ? fmt(r.cost) : '—'}</td>`
        + `<td class="silver" title="${esc(wayTip(d))}">${fmt(d.net)}</td>`
        + `<td class="${r.profit >= 0 ? 'up' : 'down'}"><b>${r.profit >= 0 ? '+' : ''}${fmt(r.profit)}</b></td>`
        + `<td class="${dcls}" title="Against selling it right now as it is (${fmt(baseNet)} net)">${r.t === from ? '—' : (r.delta >= 0 ? '+' : '') + fmt(r.delta)}</td>`
        + `<td class="${d.vol > 0 ? '' : 'faint'}" title="Units moved per day in that market. With no volume the price is there but nobody is buying.">${d.vol > 0 ? fmtInt(d.vol) : '—'}</td>`
        + `<td class="${d.stale ? 'down' : 'faint'}" title="How long ago that price was seen">${d.stale ? '⚠ ' : ''}${age || '—'}</td></tr>`;
    }).join('');

    const shopping = best.steps.length
      ? '<div class="sell-plan"><div class="sell-plan-h">What to buy for the starred route</div>'
        + best.steps.map((s) => {
          const nm = nameById[s.id] || s.id;
          const total = s.unit * s.count * matFee;
          return `<div class="sell-plan-row"><img class="scan-ico" src="icon://item/${encodeURIComponent(s.id)}?size=32" loading="lazy" alt=""><span class="copyable" data-copy="${esc(nameEnById[s.id] || nm)}" title="Click to copy «${esc(nameEnById[s.id] || nm)}»">${esc(nm)}</span> <b>× ${fmtInt(s.count * qty)}</b> <span class="faint">in ${cityShort(s.city)} at ${fmt(s.unit)} each</span> <span class="silver">${fmt(total * qty)}</span></div>`;
        }).join('')
        + `<div class="sell-plan-row faint">→ .${best.t} and sell in ${cityShort(best.dest.city)} ${wayTxt(best.dest)}</div></div>`
      : '';

    // un mercado, una fila: de las dos vías se enseña la que más deja
    const seenCity = new Set();
    const others = (best.dests || []).filter((d) => (seenCity.has(d.city) ? false : seenCity.add(d.city))).slice(0, 7);
    const destTable = others.length > 1
      ? '<div class="sell-sub">Where to sell it once it is .' + best.t + '</div><div class="mkt-scroll"><table><thead><tr><th style="text-align:left">Market</th><th>How</th><th>You get</th><th>Vol/day</th><th>Seen</th></tr></thead><tbody>'
        + others.map((d) => `<tr><td class="name">${cityShort(d.city)}</td><td class="faint">${wayTxt(d)}</td><td class="silver" title="${esc(wayTip(d))}">${fmt(d.net)}</td><td class="${d.vol > 0 ? '' : 'faint'}">${d.vol > 0 ? fmtInt(d.vol) : '—'}</td><td class="${d.stale ? 'down' : 'faint'}">${d.stale ? '⚠ ' : ''}${agoStr(d.date) || '—'}</td></tr>`).join('')
        + '</tbody></table></div>'
      : '';

    // un destino sin volumen paga mucho sobre el papel y luego no te lo compra nadie: se dice
    const thin = best.dest.vol > 0 ? '' : ' <b>Careful</b>: nothing has sold there lately, so that price may take a long time to happen.';
    const verdict = (best.t === from
      ? `Best move: <b>sell it as it is</b> in ${cityShort(best.dest.city)} ${wayTxt(best.dest)} — ${fmt(best.dest.net)} net.`
      : `Best move: <b>enchant it to .${best.t}</b> and sell in ${cityShort(best.dest.city)} ${wayTxt(best.dest)} — ${fmt(best.delta)} more than selling it now${qty > 1 ? ` (${fmt(best.delta * qty)} for ${qty})` : ''}.`) + thin;
    const notes = [];
    if (!enchantableItem(currentBase)) notes.push('This item has no enchant recipe: the only choice is where to sell it.');
    else if (from >= ENCH_MAX) notes.push('.3 is the last level you can enchant to: .4 can only be crafted.');
    if (missing) notes.push(`No price for ${esc(nameById[missing] || missing)}, so the higher levels are left out.`);
    if (!sellOwned() && basePrice) notes.push(`Buying it costs ${fmt(basePrice)} in ${cityShort(basePriceCity)} and is counted in every route.`);
    notes.push('Quality cannot be changed in game — it is set when the item is crafted and enchanting keeps it. Pick yours in the quality filter above.');

    out.innerHTML = itemHeadHtml(`quality: ${QNAMES[quality] || 'Normal'} · ${qty > 1 ? qty + ' units · ' : ''}what to do with the one you have`)
      + `<div class="sell-verdict">${verdict}</div>`
      + '<div class="mkt-scroll"><table><thead><tr><th style="text-align:left">Route</th>'
      + '<th title="What you have to spend: enchanting materials, plus the item itself if you do not own it yet">Costs you</th>'
      + '<th title="Net silver in your pocket after tax and fees">You get</th>'
      + '<th title="What you get minus what you spend">Profit</th>'
      + '<th title="How much better (or worse) than selling it right now as it is">vs selling now</th>'
      + '<th>Vol/day</th><th>Seen</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + shopping + destTable
      + `<div class="best-hint">${notes.join(' · ')}</div>`;
  }

  ['sell-qty', 'sell-mat-order', 'sell-owned'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(id === 'sell-qty' ? 'input' : 'change', () => { if (sellCache) renderSell(); });
  });
  { const mc = document.getElementById('sell-mat-city'); if (mc) mc.addEventListener('change', () => { if (currentBase) loadSell(true); }); }

  // ================= ESCÁNER (flip: comprar hecho → revender) =================
  // dónde vendes y cómo: inmediato cobra la puja y solo paga impuesto; con orden te pones
  // en la cola al precio de la venta más barata y pagas impuesto + 2,5%.
  // Los destinos de ciudad siguen al filtro de mercados: con Rests/contrabandistas activos
  // también se busca la mejor venta allí.
  const sellCities = () => scopeCities().filter((c) => c !== 'Black Market');
  const SELL_MODES = {
    bm: { locs: ['Black Market'], order: false, hdr: 'BM ⚡', txt: '🏴 BM instant' },
    bmorder: { locs: ['Black Market'], order: true, hdr: 'BM ord.', txt: '🏴 BM with order' },
    market: { get locs() { return sellCities(); }, order: true, hdr: 'Sell', txt: 'order in market' },
    cityfast: { get locs() { return sellCities(); }, order: false, hdr: 'Bid', txt: 'instant in market' },
  };
  const sellModeOf = (k) => SELL_MODES[k] || SELL_MODES.bm;
  const SCAN_ENCHANTS = [0, 1, 2, 3, 4]; // el escáner prueba todos y muestra el mejor por item
  const SCAN_CAPTURE = 1;   // volumen completo: el recorte mental lo pone el usuario, no el panel
  const SCAN_MAX_ROI = 500; // guarda anti-outlier: un ROI > 500% es casi siempre un precio troll de la API, no una oportunidad real
  const cityKey = (c) => (c === 'Black Market' ? 'Black Market' : String(c).replace(/\s+/g, ''));
  const cityShort = (c) => (c === 'Black Market' ? '🏴 BM'
    : (marketIcon(c) ? marketIcon(c) + ' ' : '') + (c === 'FortSterling' ? 'F.Sterling' : esc(c)));
  const scanStore = {};   // cache por configuración (cat|sell|tier|city) -> datos crudos
  let scanCache = null;    // configuración mostrada ahora mismo
  // el escáner calcula y recorta en el cliente sobre el dataset cacheado, así que
  // reordenar no necesita volver a la API: se ordena antes del recorte y se re-renderiza.
  const SCAN_SORTS = { eurDay: (r) => r.eurDay, gain: (r) => r.gain, vol: (r) => r.vol, cost: (r) => r.netCost, price: (r) => r.price, avg: (r) => r.avg, roi: (r) => r.roi, perFocus: (r) => r.perFocus || 0 };
  let scanSort = 'eurDay', scanDir = 'desc';
  const scanMode = () => (document.getElementById('scan-mode') || {}).value || 'flip';
  const scanDays = () => +((document.getElementById('scan-days') || {}).value) || 21;
  const scanKey = () => [
    scanMode(),
    'd' + scanDays(),
    'm' + marketScope(),
    (document.getElementById('scan-sell') || {}).value || 'bm',
    document.getElementById('scan-tier').value,
    document.getElementById('scan-city').value,
    'q' + currentQuality,
  ].join('|');
  // el escaneo va por lotes, así que la barra mide trabajo REAL: un lote entregado = un tick.
  const SCAN_BATCH = 300;
  const batches = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
  // lotes a la vez. La API resuelve cada consulta de forma síncrona, así que pedir más en
  // paralelo no la acelera: solo alarga la cola y arriesga que el lote de turno agote el timeout.
  const SCAN_LANES = 2;
  async function runBatches(jobs, onDone) {
    const out = new Array(jobs.length);
    let next = 0;
    const lane = async () => {
      while (next < jobs.length) {
        const i = next++;
        // un 502 suelto del proxy no puede tirar un escaneo entero: se reintenta el lote.
        try { out[i] = await jobs[i](); }
        catch (_) { out[i] = await jobs[i](); }
        onDone();
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_LANES, jobs.length) }, lane));
    return out;
  }
  function startScanProgress(total) {
    let done = 0;
    const apply = () => {
      const p = Math.min(99, Math.round((done / Math.max(1, total)) * 100));
      const f = document.getElementById('scan-bar-fill'); if (f) f.style.width = p + '%';
      const t = document.getElementById('scan-prog-pct'); if (t) t.textContent = p + '%';
    };
    apply();
    return {
      tick: () => { done += 1; apply(); },
      stop: () => {
        const f = document.getElementById('scan-bar-fill'); if (f) f.style.width = '100%';
        const t = document.getElementById('scan-prog-pct'); if (t) t.textContent = '100%';
      },
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
    // fuera las variantes _LEVEL (son el refinado YA encantado: el escáner encanta el base por
    // su cuenta, así que aquí solo duplican y salen con doble encantamiento) y todo lo que no
    // tenga nombre en el índice (tradepacks, tokens, quest items): saldrían con el id crudo.
    const scannable = (id) => !/_LEVEL\d/.test(id) && !!nameById[id];
    const mode = scanMode();
    const targets = Object.keys(recipes).filter((id) => id.indexOf('@') < 0 && tierOk(id) && scannable(id)
      && recipes[id] && recipes[id].r && (!onlyBM || bmBuys(id))
      && (mode !== 'enchant' || enchantableItem(id)));
    if (!targets.length) { out.innerHTML = '<div class="mempty">No items for that tier.</div>'; return; }
    out.innerHTML = `<div class="scan-prog"><div class="lbl"><span>Scanning ${targets.length} items…</span><b id="scan-prog-pct">0%</b></div><div class="scan-bar"><i id="scan-bar-fill"></i></div></div>`;
    const btn = document.getElementById('scan-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
    let prog = null;
    const prodSet = new Set();
    targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => prodSet.add(prodEnch(id, e))));
    const prodIds = [...prodSet];
    const sellLocs = sellModeOf(sellMode).locs;
    // rentabilidad: usa la calidad que DE VERDAD compras/flipeas. "Todas" (0) = Normal (1).
    const q = currentQuality || 1;
    try {
      // Flip: comprar el ITEM ya hecho y revenderlo. Craft: comprar los MATERIALES y fabricarlo.
      // Encantar: comprar el item plano y gastarle runas/almas/reliquias encima.
      const matSet = new Set();
      if (mode === 'craft') targets.forEach((id) => SCAN_ENCHANTS.forEach((e) => recipeRows(id, e).forEach((m) => matSet.add(m.priceId))));
      if (mode === 'enchant') targets.forEach((id) => { for (let l = 1; l <= ENCH_MAX; l++) { const s = enchStep(id, l); if (s) matSet.add(s.id); } });
      // "Comprar en" vacío = cualquier ciudad: se piden todas y se queda la más barata de cada cosa
      const buyLocs = city ? [city] : CRAFT_CITIES;
      const inBuyLocs = (ck) => buyLocs.some((c) => cityKey(c) === ck);
      const priceLocs = [...new Set([...buyLocs, ...sellLocs])];
      const prodJobs = batches(prodIds, SCAN_BATCH).map((b) => () => window.overlay.scanPrices(b, priceLocs, q));
      const volJobs = batches(prodIds, SCAN_BATCH).map((b) => () => window.overlay.history(b, sellLocs, scanDays(), q));
      const matJobs = matSet.size ? batches([...matSet], SCAN_BATCH).map((b) => () => window.overlay.scanPrices(b, buyLocs, 1)) : [];
      prog = startScanProgress(prodJobs.length + volJobs.length + matJobs.length);
      const done = await runBatches([...prodJobs, ...volJobs, ...matJobs], prog.tick);
      const joined = (from, n) => done.slice(from, from + n).reduce((a, r) => a.concat(r || []), []);
      const prodRows = joined(0, prodJobs.length);
      const volRows = joined(prodJobs.length, volJobs.length);
      const matRows = joined(prodJobs.length + volJobs.length, matJobs.length);
      const matP = {}, matCityM = {};
      (matRows || []).forEach((r) => {
        if (!inBuyLocs(cityKey(r.city))) return;
        const p = cityUnitPrice({ sell: r.sell_price_min || 0, buy: r.buy_price_max || 0 });
        if (p > 0 && (!matP[r.item_id] || p < matP[r.item_id])) { matP[r.item_id] = p; matCityM[r.item_id] = cityKey(r.city); }
      });
      const buyP = {}, buyDateM = {}, buyCityM = {}, sellP = {}, dateM = {};
      (prodRows || []).forEach((r) => {
        const ck = cityKey(r.city);
        if (inBuyLocs(ck)) {
          const p = r.sell_price_min || 0;
          if (p > 0 && (!buyP[r.item_id] || p < buyP[r.item_id])) {
            buyP[r.item_id] = p; buyDateM[r.item_id] = r.sell_price_min_date || null; buyCityM[r.item_id] = ck;
          }
        }
        (sellP[r.item_id] = sellP[r.item_id] || {})[ck] = sellModeOf(sellMode).order ? (r.sell_price_min || 0) : (r.buy_price_max || 0);
        (dateM[r.item_id] = dateM[r.item_id] || {})[ck] = sellModeOf(sellMode).order ? (r.sell_price_min_date || null) : (r.buy_price_max_date || null);
      });
      const volM = {}; (volRows || []).forEach((r) => { (volM[r.item_id] = volM[r.item_id] || {})[cityKey(r.city)] = { daily: r.daily || 0, avg: r.avg_price || 0 }; });
      scanStore[scanKey()] = { targets, buyP, buyDateM, buyCityM, sellP, dateM, volM, sellMode, sellLocs, city, mode, matP, matCityM };
      scanCache = scanStore[scanKey()];
      prog.stop();
      renderScanResults(false);
    } catch (err) {
      out.innerHTML = '<div class="mempty">Scan failed (API limit or no connection?). Try again in a moment.</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Find opportunities'; }
    }
  }
  function renderScanResults(fromCache) {
    const out = document.getElementById('scan-result'); if (!out || !scanCache) return;
    const { targets, buyP, buyDateM, buyCityM, sellP, dateM, volM, sellMode, sellLocs, city, mode, matP, matCityM } = scanCache;
    const bmNet = 1 - salesTax();
    const ordNet = 1 - salesTax() - 0.025;
    const isCraft = mode === 'craft';
    const isEnch = mode === 'enchant';
    // con "cualquiera" cada material puede venir de una ciudad distinta
    const matsCityLabel = (id, e) => {
      const cities = [...new Set(recipeRows(id, e).map((m) => (matCityM || {})[m.priceId]).filter(Boolean))];
      if (!cities.length) return 'the cheapest';
      return cities.length === 1 ? cityShort(cities[0]) : cities.length + ' markets';
    };
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
    // encantar: lo que cuesta subir el item de e0 a e con runas compradas en buyLocs
    const enchMatOrder = matOrderOn() ? 1.025 : 1;
    const enchCostOf = (id, e0, e) => {
      let c = 0;
      for (let l = e0 + 1; l <= e; l++) {
        const s = enchStep(id, l); if (!s) return 0;
        const u = (matP && matP[s.id]) || 0; if (!u) return 0;
        c += u * s.count;
      }
      return c * enchMatOrder;
    };
    // flip/craft valoran un solo encantamiento; encantar compara pares (compras .e0, vendes .e)
    const COMBOS = [];
    for (let a = 0; a < ENCH_MAX; a++) for (let b = a + 1; b <= ENCH_MAX; b++) COMBOS.push([a, b]);
    const combos = isEnch ? COMBOS : SCAN_ENCHANTS.map((e) => [e, e]);
    const res = targets.map((id) => {
      let best = null;
      combos.forEach(([e0, e]) => {
        const pid = prodEnch(id, e);
        const buyId = prodEnch(id, e0);
        const enchCost = isEnch ? enchCostOf(id, e0, e) : 0;
        if (isEnch && enchCost <= 0) return;       // sin precio de las runas de algún escalón
        const netCost = isCraft ? craftCostOf(id, e) : (((buyP && buyP[buyId]) || 0) + enchCost);
        if (netCost <= 0 || (!isCraft && !(buyP && buyP[buyId]))) return;   // sin precio de compra / sin todos los materiales
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
          if (!best || eurDay > best.eurDay) best = { id, e, e0, netCost, enchCost, price, avg, city: ck, gain, vol, eurDay, roi, perFocus, fCost, craftCity, sellDate: dts[ck] || null, buyDate: (buyDateM && buyDateM[buyId]) || null };
        });
      });
      return best;
    }).filter(Boolean);
    // picos: la orden de ahora muy por encima del medio histórico. Nadie te la compra a ese precio.
    const hideSpikes = !!(document.getElementById('scan-hide-spikes') || {}).checked;
    const isSpike = (r) => r.avg > 0 && r.price > r.avg * 3;
    const spikes = res.filter(isSpike).length;
    // Antigüedad: manda el MÁS VIEJO de los dos precios (compra y venta). El margen sale de
    // restar uno del otro, así que basta con que uno esté caducado para que la cifra sea humo.
    const staleMaxH = +((document.getElementById('scan-fresh') || {}).value) || 0;
    const worstAge = (r) => Math.max(ageHours(r.buyDate), ageHours(r.sellDate));
    const isOld = (r) => staleMaxH > 0 && worstAge(r) > staleMaxH;
    const olds = res.filter(isOld).length;
    const skey = SCAN_SORTS[scanSort] ? scanSort : 'eurDay';
    const sdir = scanDir === 'asc' ? -1 : 1;
    const shown = res
      .filter((r) => !(hideSpikes && isSpike(r)))
      .filter((r) => !isOld(r))
      .sort((a, b) => (SCAN_SORTS[skey](b) - SCAN_SORTS[skey](a)) * sdir)
      .slice(0, 50);
    if (!shown.length) {
      const motivos = [];
      if (olds) motivos.push(`${olds} with prices older than ${staleMaxH}h`);
      if (spikes && hideSpikes) motivos.push(`${spikes} price spike${spikes === 1 ? '' : 's'}`);
      out.innerHTML = `<div class="mempty">No opportunities with complete data.${motivos.length ? ` Left out: ${motivos.join(' and ')}. Raise "Seen within" or untick the filters to see them.` : ' Try another tier or sell channel.'}</div>`;
      return;
    }
    const res2 = shown;
    const sellHdr = sellModeOf(sellMode).hdr;
    const buyCityShort = city ? cityShort(cityKey(city)) : '';
    const sArrow = sdir === -1 ? ' ▲' : ' ▼';
    const sSort = (k, label, tip) => `<th class="top-sort${skey === k ? ' on' : ''}" data-ssort="${k}" title="${tip} · click to sort${skey === k ? ' the other way' : ''}">${label}${skey === k ? sArrow : ''}</th>`;
    // lo descartado se dice: si no, una lista corta parece "no hay oportunidades" cuando en
    // realidad las hay pero con precios viejos.
    const dropNote = olds
      ? `<div class="fresh-note" title="They are not shown because their buy or sell price has not been seen in that long. Raise &quot;Seen within&quot; to include them.">⏳ ${olds} left out for being older than ${staleMaxH}h</div>`
      : '';
    out.innerHTML = dropNote + '<div class="scan-scroll"><table><thead><tr><th>Item · ench</th>'
      + sSort('cost', isCraft ? 'Craft' : isEnch ? 'Buy+runes' : 'Buy', isCraft ? 'Cost to make it: materials minus the station return, plus the station fee' : isEnch ? 'What the plain item costs you plus the enchanting materials' : 'What it costs you to buy it in the source market')
      + sSort('price', sellHdr, 'Sell price used (current order)')
      + sSort('avg', 'Avg', 'Average price actually sold (historical)')
      + sSort('gain', 'Profit', 'Net profit per unit after tax')
      + sSort('vol', 'Vol/day', 'Units moved per day')
      + sSort('eurDay', 'Silver/day', 'Profit per unit × the WHOLE daily volume of the market: the theoretical ceiling if you took the entire market')
      + (useFocus ? sSort('perFocus', 'Silver/focus', 'Profit per focus point spent. With focus being the limit, this is the column that decides what to craft') : '')
      + '<th>Seen</th></tr></thead><tbody>'
      + res2.map((r) => {
        const pc = r.gain >= 0 ? 'up' : 'down';
        const nm = nameById[r.id.split('@')[0]] || r.id;
        const where = sellModeOf(sellMode).locs.length === 1 ? '🏴 BM' : cityShort(r.city);
        const matsFrom = isCraft && !city ? matsCityLabel(r.id, r.e) : buyCityShort;
        const buyFrom = buyCityShort || cityShort(buyCityM[prodEnch(r.id, r.e0)] || '') || 'the cheapest';
        // la antigüedad va pegada a CADA mercado: así se ve de un vistazo cuál de los dos
        // precios es el viejo, en vez de un único "visto" que no dice de dónde sale
        const buyAgeTxt = agoStr(r.buyDate) || '?';
        const sellAgeTxt = agoStr(r.sellDate) || '?';
        const action = isCraft
          ? `craft in ${r.craftCity ? cityShort(cityKey(r.craftCity)) : 'station with no bonus'} · mats from ${matsFrom} → sell ${where} (${sellAgeTxt})`
          : isEnch
            ? `buy .${r.e0} in ${buyFrom} (${buyAgeTxt}) → enchant to .${r.e} (${fmt(r.enchCost)} in runes) → sell ${where} (${sellAgeTxt})`
            : `buy in ${buyFrom} (${buyAgeTxt}) → sell ${where} (${sellAgeTxt})`;
        // la columna enseña la PEOR de las dos patas: de nada sirve una venta fresquísima si el
        // precio de compra que sostiene la operación es de hace horas
        const staleDate = ageHours(r.buyDate) > ageHours(r.sellDate) ? r.buyDate : r.sellDate;
        const ageTxt = agoStr(staleDate); const stale = ageHours(staleDate) > 24;
        const seenTip = `Buy price seen ${agoStr(r.buyDate) || '—'} ago · sell price seen ${agoStr(r.sellDate) || '—'} ago · the column shows the older of the two`;
        const iconId = prodEnch(r.id, r.e);
        return `<tr><td class="name"><div class="scan-item"><img class="scan-ico" src="icon://item/${encodeURIComponent(iconId)}?size=40" loading="lazy" alt=""><div class="scan-item-txt"><span class="copyable" data-copy="${esc(copyNameOf(r.id, r.e, nm))}" title="Click to copy «${esc(copyNameOf(r.id, r.e, nm))}»">${esc(nm)}</span> <span class="enchtag">.${r.e}</span><br><span class="faint" style="font-size:11px">${action} · ROI ${roiTxt(r.roi)}</span></div></div></td>`
          + `<td class="silver">${fmt(r.netCost)}</td><td class="silver scan-price">${fmt(r.price)}${sostChip(r.price, r.avg, true)}</td>`
          + `<td class="cr-vol-avg" title="average price actually sold (historical): profit is worked out with this, not with the current spike">${r.avg ? '~' + fmt(r.avg) : '—'}</td>`
          + `<td class="${pc}">${r.gain >= 0 ? '+' : ''}${fmt(r.gain)}</td>`
          + `<td class="${r.vol > 0 ? '' : 'faint'}" title="Units moved per day (Normal quality). Silver/day uses this full volume.">${r.vol > 0 ? fmtInt(r.vol) : '—'}</td>`
          + `<td class="${pc}"><b>${r.eurDay >= 0 ? '+' : ''}${fmt(r.eurDay)}</b></td>`
          + (useFocus ? `<td class="${r.perFocus >= 0 ? 'up' : 'down'}" title="${r.fCost ? fmtInt(r.fCost) + ' focus per unit' : 'no focus data for this item'}">${r.fCost ? (r.perFocus >= 0 ? '+' : '') + r.perFocus.toFixed(1) : '—'}</td>` : '')
          + `<td class="${stale ? 'down' : 'faint'}" title="${seenTip}">${stale ? '⚠ ' : ''}${ageTxt || '—'}</td></tr>`;
      }).join('') + '</tbody></table></div>'
      + `<div class="best-hint">${fromCache ? '<b style="color:#9fd2e0">cached</b> · ' : ''}${spikes ? `<b style="color:#e0a336">${spikes} spike${spikes === 1 ? '' : 's'} ${hideSpikes ? 'hidden' : 'visible'}</b> · ` : ''}${res.length} with data · ${isCraft ? 'crafting' : isEnch ? 'enchanting' : 'reselling'} · ${sellModeOf(sellMode).txt}${useFocus ? ' · with focus' : ''}</div>`;
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
      out.innerHTML = `<div class="mempty">T${tier} not cached yet — hit 🔍 Find to scan it.</div>`;
    }
  }
  ['scan-tier', 'scan-city', 'scan-sell', 'scan-mode', 'scan-days'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', onScanFilterChange); });
  { const hs = document.getElementById('scan-hide-spikes'); if (hs) hs.addEventListener('change', () => { if (scanCache) renderScanResults(true); }); }
  // la antigüedad se filtra sobre los datos ya descargados: cambiarla NO relanza el escaneo
  { const sf = document.getElementById('scan-fresh'); if (sf) sf.addEventListener('change', () => { saveCfg(); if (scanCache) renderScanResults(true); }); }
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
  const LVL_QNAMES = ['Normal', 'Good', 'Outstanding', 'Excellent', 'Master.'];
  function levelCombos(target) {
    const out = [];
    for (let t = 8; t >= 4; t--) { const e = target - t; if (e >= 0 && e <= 4) out.push({ t, e }); }
    return out;   // de mayor tier (menos ench) a menor tier (más ench)
  }
  let levelCache = null;
  async function loadLevel() {
    const out = document.getElementById('level-result'); if (!out) return;
    if (!currentBase) { out.innerHTML = '<div class="mempty">Search an item above to see its equivalent versions.</div>'; return; }
    const body = currentBase.replace(/^T\d+_/, '');
    const target = +((document.getElementById('level-target') || {}).value) || 8;
    const cityFilter = (document.getElementById('level-city') || {}).value || '';   // '' = todas (la más barata)
    const combos = levelCombos(target);
    const idOf = (c) => 'T' + c.t + '_' + body + (c.e > 0 ? '@' + c.e : '');
    const ids = combos.map(idOf);
    const locs = cityFilter ? [cityFilter] : scopeCities();
    out.innerHTML = '<div class="mempty">Looking up prices…</div>';
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
      out.innerHTML = '<div class="mempty">Price lookup failed. Try again.</div>';
    }
  }
  function renderLevel() {
    const out = document.getElementById('level-result'); if (!out || !levelCache) return;
    const { combos, idOf, cheapest, target, cityFilter } = levelCache;
    const QS = [1, 2, 3, 4, 5];
    let globalMin = Infinity; const colMin = [Infinity, Infinity, Infinity, Infinity, Infinity];
    combos.forEach((c) => { const m = cheapest[idOf(c)] || {}; QS.forEach((q, qi) => { const cell = m[q]; if (cell) { if (cell.price < colMin[qi]) colMin[qi] = cell.price; if (cell.price < globalMin) globalMin = cell.price; } }); });
    if (!Number.isFinite(globalMin)) { out.innerHTML = '<div class="mempty">No prices for level ' + target + (cityFilter ? ' en ' + cityShort(cityFilter) : '') + '. Try another level/market or check in game.</div>'; return; }
    // referencia = la versión de mayor tier (la "normal" del nivel, p.ej. T8.0): con qué comparas el ahorro
    const rowMin = (c) => { const m = cheapest[idOf(c)] || {}; const ps = QS.map((q) => (m[q] || {}).price).filter((p) => p > 0); return ps.length ? Math.min(...ps) : 0; };
    const refCombo = combos[0];
    const refMin = refCombo ? rowMin(refCombo) : 0;
    const rows = combos.map((c) => {
      const m = cheapest[idOf(c)] || {};
      const mine = rowMin(c);
      const diffPct = (refMin > 0 && mine > 0) ? Math.round((mine / refMin - 1) * 100) : null;
      const diffCell = c === refCombo
        ? `<td class="lvl-diff faint" title="This is the reference: the highest-tier version for this level">base</td>`
        : `<td class="lvl-diff ${diffPct == null ? 'faint' : (diffPct < 0 ? 'up' : 'down')}" title="Compared with ${refCombo.t}.${refCombo.e}, which costs ${refMin ? fmt(refMin) : '—'}">${diffPct == null ? '—' : (diffPct > 0 ? '+' : '') + diffPct + '%'}</td>`;
      const cells = QS.map((q, qi) => {
        const cell = m[q]; if (!cell) return '<td class="faint">—</td>';
        const cls = cell.price === globalMin ? 'lvl-best' : (cell.price === colMin[qi] ? 'lvl-colbest' : '');
        const stale = ageHours(cell.date) > (freshMaxH() || 24);
        const age = agoStr(cell.date) || 'no date';
        const liveDot = cell.live ? ' <span class="live-dot" title="Seen by YOUR client right now (live capture)">🟢</span>' : '';
        const sub = (cityFilter ? age : (age + ' · ' + cityShort(cell.city))) + liveDot;
        return `<td class="${cls}"><div class="lvl-price">${fmt(cell.price)}${cell.price === globalMin ? ' ✅' : ''}</div><div class="lvl-age${stale ? ' stale' : ''}">${stale ? '⚠ ' : ''}${sub}</div></td>`;
      }).join('');
      return `<tr><td class="lvl-combo">${c.t}.${c.e}</td>${cells}${diffCell}</tr>`;
    }).join('');
    out.innerHTML = itemHeadHtml('level ' + target + ' · ' + (cityFilter ? cityShort(cityFilter) : 'cheapest market'))
      + '<div class="scan-scroll"><table class="lvl-table"><thead><tr><th>T.Ench</th>' + LVL_QNAMES.map((n) => `<th>${n}</th>`).join('') + `<th title="Price difference against the highest-tier version of this level">vs ${refCombo ? refCombo.t + '.' + refCombo.e : 'base'}</th>` + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  ['level-target', 'level-city'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { if (currentBase) loadLevel(); }); });

  // ================= TOP (lo que más se mueve · base de la cartera) =================
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
      if (inp) { inp.value = chip.dataset.sub; calcResult(); toast('🔨 Using the cost to make it'); }
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
