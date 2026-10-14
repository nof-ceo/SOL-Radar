const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path'), fs = require('fs');
const { solForecast, solSignal, quickBacktest, walkForward, tokenReport } = require('./model');
const { diagnose } = require('./diag');
const { SYMS, zCrit, parseCosts, summarize, rankRows } = require('./scan');
let DB = null;

// Необязательный config.json: ключи X API и Discord-бота (см. config.example.json)
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}

const UA = 'Mozilla/5.0 (Macintosh) SOLRadar/1.0';
const get = async (u, h = {}) => {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...h }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const S = { sol: { hist: [], candles: [] }, tf: '5m', store: new Map(), rc: new Map(), src: {}, status: {} };
const TF = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
// Свечи SOL: Binance, запасной вариант — Coinbase Exchange ([time, low, high, open, close, volume], новые первыми)
async function candles(tf, limit) {
  try {
    const k = await (await get(`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=${tf}&limit=${limit}`)).json();
    return k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], tb: +x[9] }));
  } catch {
    const k = await (await get(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=${TF[tf]}`)).json();
    return k.slice(0, limit).reverse().map(x => ({ t: x[0] * 1000, o: x[3], h: x[2], l: x[1], c: x[4], v: x[5] }));
  }
}

// ---------- Тональность (простой словарь; позже заменить на NLP-модель) ----------
const POS = ['bull', 'pump', 'moon', 'surge', 'rally', 'record', 'adopt', 'approve', 'etf', 'breakout', 'gain', 'launch', 'partnership', 'ath', 'upgrade', 'рост', 'взлет', 'взлёт'];
const NEG = ['bear', 'dump', 'crash', 'rug', 'scam', 'hack', 'exploit', 'drain', 'ban', 'lawsuit', 'fraud', 'liquidat', 'outage', 'plunge', 'fall', 'падени', 'скам', 'взлом'];
const sentiment = t => {
  t = t.toLowerCase(); let p = 0, n = 0;
  POS.forEach(w => { if (t.includes(w)) p++; }); NEG.forEach(w => { if (t.includes(w)) n++; });
  return clamp((p - n) / (p + n + 1) * 1.3, -1, 1);
};

const job = (name, every, fn) => {
  const go = async () => {
    try { await fn(); S.status[name] = { ok: true, t: Date.now() }; }
    catch (e) { S.status[name] = { ok: false, err: String(e.message || e), t: Date.now() }; }
  };
  go(); setInterval(go, every);
};

// ---------- Источники ----------
function startJobs() {
  // Цена и свечи SOL (минутки — для модели, выбранный таймфрейм — для графика)
  job('Биржи', 5000, async () => {
    const m1 = await candles('1m', 120);
    S.sol.hist = m1.map(c => c.c);
    try { DB && DB.addCandles(m1); } catch {}
    S.sol.candles = S.tf === '1m' ? m1 : await candles(S.tf, 100);
  });

  // Новые токены Solana: DexScreener (профили + бусты → данные по парам)
  job('DexScreener', 30000, async () => {
    const [a, b] = await Promise.all(['token-profiles/latest/v1', 'token-boosts/latest/v1']
      .map(p => get('https://api.dexscreener.com/' + p).then(r => r.json()).catch(() => [])));
    const fresh = [...a, ...b].filter(x => x.chainId === 'solana').map(x => x.tokenAddress);
    const addrs = [...new Set([...fresh, ...S.store.keys()])].slice(0, 30);
    if (!addrs.length) throw new Error('нет новых токенов');
    const pairs = await (await get('https://api.dexscreener.com/tokens/v1/solana/' + addrs.join(','))).json();
    const best = new Map();
    for (const p of pairs) {
      const k = p.baseToken.address;
      if (!best.has(k) || (p.liquidity?.usd || 0) > (best.get(k).liquidity?.usd || 0)) best.set(k, p);
    }
    for (const [k, p] of best) {
      const o = S.store.get(k) || { hist: [] };
      o.hist = [...o.hist, +p.priceUsd].slice(-60);
      Object.assign(o, {
        addr: k, sym: p.baseToken.symbol, name: p.baseToken.name, price: +p.priceUsd,
        liq: p.liquidity?.usd || 0, vol24: p.volume?.h24 || 0,
        ch5: p.priceChange?.m5 || 0, ch1: p.priceChange?.h1 || 0, ch24: p.priceChange?.h24 || 0,
        buys: p.txns?.m5?.buys || 0, sells: p.txns?.m5?.sells || 0,
        age: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 6e4 : null, url: p.url
      });
      S.store.set(k, o);
    }
  });

  // Проверка контрактов: RugCheck (до 4 токенов за проход)
  job('RugCheck', 20000, async () => {
    const todo = [...S.store.keys()].filter(k => !S.rc.has(k)).slice(0, 4);
    for (const k of todo) {
      try {
        const j = await (await get(`https://api.rugcheck.xyz/v1/tokens/${k}/report/summary`)).json();
        // score_normalised: чем выше, тем рискованнее (проверьте по актуальной документации API)
        S.rc.set(k, { score: j.score_normalised ?? null, risks: (j.risks || []).map(r => r.name).slice(0, 3) });
      } catch { S.rc.set(k, { score: null, risks: [] }); }
    }
  });

  job('Reddit', 60000, async () => {
    const out = [];
    for (const sub of ['solana', 'memecoins']) {
      const j = await (await get(`https://www.reddit.com/r/${sub}/new.json?limit=20`)).json();
      for (const c of j.data.children) out.push({ src: 'Reddit', text: c.data.title, url: 'https://reddit.com' + c.data.permalink, ts: c.data.created_utc * 1000 });
    }
    S.src.Reddit = out;
  });

  const rss = async u => {
    const x = await (await get(u)).text();
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map(m => {
      const g = t => (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || '';
      return { src: 'Новости', text: g('title').trim(), url: g('link').trim(), ts: Date.parse(g('pubDate')) || Date.now() };
    });
  };
  job('Новости', 120000, async () => {
    const r = await Promise.allSettled(['https://cointelegraph.com/rss/tag/solana', 'https://www.coindesk.com/arc/outboundfeeds/rss/'].map(rss));
    const ok = r.filter(x => x.status === 'fulfilled').flatMap(x => x.value);
    if (!ok.length) throw new Error('RSS недоступен');
    S.src.Новости = ok;
  });

  if (cfg.xBearer) job('X', 90000, async () => {
    const q = encodeURIComponent('(solana OR $SOL OR pumpfun) -is:retweet lang:en');
    const j = await (await get(`https://api.twitter.com/2/tweets/search/recent?query=${q}&max_results=20&tweet.fields=created_at`, { Authorization: 'Bearer ' + cfg.xBearer })).json();
    S.src.X = (j.data || []).map(t => ({ src: 'X', text: t.text, url: 'https://x.com/i/web/status/' + t.id, ts: Date.parse(t.created_at) }));
  });

  if (cfg.discordToken && cfg.discordChannels?.length) job('Discord', 45000, async () => {
    const out = [];
    for (const ch of cfg.discordChannels) {
      const j = await (await get(`https://discord.com/api/v10/channels/${ch}/messages?limit=20`, { Authorization: 'Bot ' + cfg.discordToken })).json();
      for (const m of j) if (m.content) out.push({ src: 'Discord', text: m.content, url: null, ts: Date.parse(m.timestamp) });
    }
    S.src.Discord = out;
  });
}

// ---------- Бэктест ----------
async function history(n) {            // n минутных свечей, постранично назад по времени
  let out = [], end = Date.now();
  while (out.length < n) {
    const lim = Math.min(1000, n - out.length); let k = null;
    for (const host of ['api.binance.com', 'api.binance.us']) {
      try { k = await (await get(`https://${host}/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=${lim}&endTime=${end}`)).json(); if (k.length) break; } catch {}
    }
    if (!k || !k.length) break;
    out = k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).concat(out);
    end = k[0][0] - 1;
  }
  if (!out.length) throw new Error('не удалось загрузить историю (Binance и Binance.US недоступны)');
  return out;
}

function snapshot() {
  const posts = Object.values(S.src).flat().map(p => ({ ...p, s: sentiment(p.text) })).sort((a, b) => b.ts - a.ts).slice(0, 80);
  const by = {}; posts.forEach(p => (by[p.src] ??= []).push(p.s));
  const mood = {}; for (const k in by) mood[k] = by[k].reduce((a, b) => a + b) / by[k].length;
  const vals = Object.values(mood), m = vals.length ? vals.reduce((a, b) => a + b) / vals.length : 0;

  const tokens = [...S.store.values()].map(t => {
    let ment = 0, ss = 0;
    if ((t.sym || '').length >= 3) {
      const re = new RegExp('(^|[^a-z0-9])\\$?' + t.sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
      posts.forEach(p => { if (re.test(p.text)) { ment++; ss += p.s; } });
    }
    const sent = ment ? ss / ment : 0, tot = t.buys + t.sells, bp = (t.buys - t.sells) / (tot + 1);
    const pred = clamp(t.ch5 * 0.6 + t.ch1 * 0.08 + bp * 2 + sent * 1.5, -40, 40);
    const conf = Math.round(clamp(20 + Math.log10(t.liq + 1) * 5 + Math.log10(tot + 1) * 6, 15, 75));
    let risk = 0;
    if (t.liq < 20e3) risk += 35; else if (t.liq < 100e3) risk += 15;
    if (t.age != null && t.age < 30) risk += 15;
    if (tot < 5) risk += 10;
    const rc = S.rc.get(t.addr);
    if (rc && rc.score != null) risk = Math.round((risk + clamp(rc.score, 0, 100)) / 2);
    return { addr: t.addr, sym: t.sym, name: t.name, price: t.price, liq: t.liq, vol24: t.vol24, ch5: t.ch5, ch1: t.ch1, age: t.age, url: t.url,
      volat: Math.abs(t.ch1) + Math.abs(t.ch5) * 2, ment, sent, pred, conf, risk: clamp(risk, 0, 100), flags: rc?.risks || [] };
  });
  const h = S.sol.hist;
  const fc = solForecast(m, h);
  return { sol: { price: h.at(-1) || 0, first: h[0] || 0, hist: h.slice(-60), f: fc, candles: S.sol.candles, tf: S.tf, sig: solSignal(m, fc, h) }, mood, m, posts, tokens, status: S.status, ts: Date.now() };
}

// ---------- Окно ----------
let win;
function createWindow() {
  win = new BrowserWindow({ width: 1240, height: 880, titleBarStyle: 'hiddenInset', backgroundColor: '#0d0f16',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile('index.html');
}
ipcMain.on('open', (_, u) => { if (typeof u === 'string' && /^https:\/\//.test(u)) shell.openExternal(u); });
function openDb() {
  try { DB = require('./db').open(path.join(app.getPath('userData'), 'solradar.sqlite')); DB.prune(60); }
  catch (e) { S.dbErr = String(e.message || e); S.status['База'] = { ok: false, err: 'SQLite недоступен: ' + S.dbErr, t: Date.now() }; }
}
const send = (k, v, label) => { if (win && !win.isDestroyed()) win.webContents.send('prog', { k, v, label }); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAPI = 'https://fapi.binance.com';
const bar = x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], tb: +x[9] });   // x[9] — объём агрессивных покупок

// Минутные свечи SOL/BTC/ETH: докачивает только недостающее; если у SOL нет объёма покупателей — перекачивает целиком
async function syncBars(sym, days, prog) {
  const now = Date.now(), want = now - days * 864e5, r = DB.barRange(sym);
  let start = (r.n && r.a <= want + 864e5 && !r.nulls) ? r.b + 6e4 : want, got = 0;
  while (start < now - 6e4) {
    let k = null;
    for (const host of ['api.binance.com', 'api.binance.us']) {
      try { const j = await (await get(`https://${host}/api/v3/klines?symbol=${sym}USDT&interval=1m&limit=1000&startTime=${start}`)).json(); if (Array.isArray(j)) { k = j; break; } } catch {}
    }
    if (!k) throw new Error(`история ${sym} недоступна (Binance и Binance.US)`);
    if (!k.length) break;
    DB.addBars(sym, k.map(bar)); got += k.length; start = k.at(-1)[0] + 6e4; prog(Math.min(1, (start - want) / (now - want)));
    if (k.length < 1000) break;
    await sleep(120);
  }
  return got;
}
async function syncFunding(days) {                  // funding SOLUSDT (perp), раз в 8 часов
  const now = Date.now(), want = now - days * 864e5, r = DB.tsRange('funding');
  let start = (r.n && r.a <= want + 864e5) ? r.b + 1 : want, got = 0;
  while (start < now) {
    const j = await (await get(`${FAPI}/fapi/v1/fundingRate?symbol=SOLUSDT&startTime=${start}&limit=1000`)).json();
    if (!Array.isArray(j)) throw new Error('funding: неожиданный ответ');
    if (!j.length) break;
    DB.addFunding(j.map(x => ({ t: x.fundingTime, rate: +x.fundingRate }))); got += j.length; start = j.at(-1).fundingTime + 1;
    if (j.length < 1000) break;
    await sleep(150);
  }
  return got;
}
async function syncOI() {                           // Binance отдаёт историю OI только за ~30 дней (шаг 5 мин)
  const now = Date.now(), want = now - 29 * 864e5, r = DB.tsRange('oi');
  let start = (r.n && r.a <= want + 864e5) ? r.b + 1 : want, got = 0;
  while (start < now) {
    const end = Math.min(now, start + 499 * 3e5);
    const j = await (await get(`${FAPI}/futures/data/openInterestHist?symbol=SOLUSDT&period=5m&limit=500&startTime=${start}&endTime=${end}`)).json();
    if (!Array.isArray(j)) throw new Error('OI: неожиданный ответ');
    if (j.length) { DB.addOI(j.map(x => ({ t: +x.timestamp, oi: +x.sumOpenInterest, oiv: +x.sumOpenInterestValue }))); got += j.length; }
    start = end + 1; await sleep(150);
  }
  return got;
}
// Живой сбор: BTC/ETH раз в 30 с, funding и OI раз в 5 мин (пишутся в базу, пока приложение запущено)
function startDataJobs() {
  job('BTC/ETH', 30000, async () => {
    if (!DB) return;
    for (const sym of ['BTC', 'ETH']) {
      let k = null;
      for (const host of ['api.binance.com', 'api.binance.us']) { try { const j = await (await get(`https://${host}/api/v3/klines?symbol=${sym}USDT&interval=1m&limit=30`)).json(); if (Array.isArray(j)) { k = j; break; } } catch {} }
      if (!k) throw new Error('нет данных ' + sym);
      DB.addBars(sym, k.map(bar));
    }
  });
  job('Фьючерсы', 300000, async () => {
    if (!DB) return;
    const f = await (await get(`${FAPI}/fapi/v1/fundingRate?symbol=SOLUSDT&limit=3`)).json();
    if (Array.isArray(f)) DB.addFunding(f.map(x => ({ t: x.fundingTime, rate: +x.fundingRate })));
    const o = await (await get(`${FAPI}/futures/data/openInterestHist?symbol=SOLUSDT&period=5m&limit=6`)).json();
    if (Array.isArray(o)) DB.addOI(o.map(x => ({ t: +x.timestamp, oi: +x.sumOpenInterest, oiv: +x.sumOpenInterestValue })));
  });
}

// ---------- Сканер монет ----------
async function marketCosts() {                      // объём 24ч и спред из стакана (3 замера, медиана)
  const pull = async p => { for (const h of ['api.binance.com', 'api.binance.us']) { try { const j = await (await get(`https://${h}${p}`)).json(); if (Array.isArray(j)) return j; } catch {} } throw new Error('Binance недоступен'); };
  const t24 = await pull('/api/v3/ticker/24hr'), samples = [];
  for (let i = 0; i < 3; i++) { samples.push(await pull('/api/v3/ticker/bookTicker')); if (i < 2) await sleep(1500); }
  return parseCosts(t24, samples, SYMS);
}
ipcMain.handle('scan-sync', async (_, days) => {
  if (!DB) return { ok: false, err: 'SQLite недоступен' };
  days = clamp(+days || 60, 14, 180); const res = [];
  for (let q = 0; q < SYMS.length; q++) {
    const s = SYMS[q];
    try { res.push({ sym: s, ok: true, n: await syncBars(s, days, v => send('scan-sync', (q + v) / SYMS.length, s)) }); }
    catch (e) { res.push({ sym: s, ok: false, err: String(e.message || e) }); }
  }
  return { ok: true, res };
});
ipcMain.handle('scan', async () => {
  if (!DB) return { ok: false, err: 'SQLite недоступен' };
  try {
    let cm = {}, costNote = '';
    try { cm = await marketCosts(); } catch (e) { costNote = 'Не удалось получить спреды (' + String(e.message || e) + ') — взят спред 0,05% по умолчанию.'; }
    const avail = SYMS.filter(s => DB.barRange(s).n >= 20000);
    if (!avail.length) return { ok: false, err: 'нет данных по монетам — нажмите «Загрузить данные монет»' };
    const nTests = avail.length * 60, tcrit = zCrit(0.05 / nTests);                  // поправка Бонферрони на все проверки
    const btc = DB.bars('BTC'), eth = DB.bars('ETH'), rows = []; let q = 0;
    for (const sym of avail) {
      const d = diagnose({ sol: DB.bars(sym), btc: sym === 'BTC' ? [] : btc, eth: sym === 'ETH' ? [] : eth }, { tcrit });
      rows.push(summarize(sym, d, cm[sym], tcrit));
      send('scan', ++q / avail.length, sym); await new Promise(r => setImmediate(r));
    }
    return { ok: true, tcrit, nTests, costNote, missing: SYMS.filter(s => !avail.includes(s)), rows: rankRows(rows) };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
});
ipcMain.handle('dbstats', () => DB ? { ok: true, ...DB.stats() } : { ok: false, err: 'SQLite недоступен: ' + (S.dbErr || 'не открыта') });
ipcMain.handle('sync', async (_, days) => {
  if (!DB) return { ok: false, err: 'SQLite недоступен' };
  days = clamp(+days || 90, 7, 365);
  const stages = [['SOL', p => syncBars('SOL', days, p)], ['BTC', p => syncBars('BTC', days, p)], ['ETH', p => syncBars('ETH', days, p)], ['Funding', () => syncFunding(days)], ['Open interest (≤30 дн.)', () => syncOI()]], res = [];
  for (let q = 0; q < stages.length; q++) {
    const [name, fn] = stages[q];
    try { res.push({ name, ok: true, n: await fn(v => send('sync', (q + v) / stages.length, name)) }); }
    catch (e) { const m = String(e.message || e); res.push({ name, ok: false, err: m + (/HTTP (451|403)/.test(m) ? ' — Binance Futures недоступен из вашего региона' : '') }); }
  }
  return { ok: true, stages: res };
});
ipcMain.handle('wf', async () => {
  if (!DB) return { ok: false, err: 'SQLite недоступен' };
  try { return { ok: true, ...(await walkForward(DB.candles(0), {}, v => send('wf', v))) }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
});
ipcMain.handle('diag', () => {
  if (!DB) return { ok: false, err: 'SQLite недоступен' };
  try { return { ok: true, ...diagnose({ sol: DB.bars('SOL'), btc: DB.bars('BTC'), eth: DB.bars('ETH'), funding: DB.funding(), oi: DB.oi() }) }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
});
ipcMain.handle('tokrep', () => DB ? { ok: true, ...tokenReport(DB.tokenRows(Date.now() - 14 * 864e5, 400000)) } : { ok: false, err: 'SQLite недоступен' });
let histCache = null;
ipcMain.handle('backtest', async (_, o = {}) => {
  const days = clamp(Math.round(+o.days || 3), 1, 7), minConf = clamp(+o.minConf || 55, 30, 80), rk = clamp(+o.risk || 1, 0.1, 5);
  try {
    if (!histCache || histCache.days < days || Date.now() - histCache.at > 10 * 60e3) histCache = { days, at: Date.now(), C: await history(days * 1440 + 120) };
    return { ok: true, ...quickBacktest(histCache.C.slice(-(days * 1440 + 120)), minConf, rk) };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
});
ipcMain.on('tf', async (_, tf) => { if (TF[tf]) { S.tf = tf; try { S.sol.candles = await candles(tf, 100); } catch {} } });
app.whenReady().then(() => {
  openDb(); startJobs(); startDataJobs(); createWindow();
  // Лог снимков токенов и настроения раз в минуту — основа для будущего обучения
  setInterval(() => { if (!DB) return; try { const s = snapshot(); DB.logSnap(s.tokens, s.m, s.sol.price); } catch {} }, 60000);
  setInterval(() => { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }, 2000);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
