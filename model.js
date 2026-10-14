'use strict';
// Чистая логика модели: прогноз, сигнал, симуляция сделок, walk-forward. Без зависимостей от Electron.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const DEFAULT_P = { w: { ema: .3, drift: .3, rsi: .15, sent: .15, f: .1 }, thr: .2, stop: .8, rr: [1.5, 2] };
const FEE = 0.1, HOLD = 60, STEP = 5;   // комиссия % туда-обратно, макс. удержание (мин), шаг оценки (мин)

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; for (const v of a) e = v * k + e * (1 - k); return e; };
const rsi = (a, n = 14) => { const s = a.slice(-n - 1); let g = 0, l = 0; for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); };

// Прогноз для отображения (h — минутные закрытия)
function solForecast(m, h) {
  if (h.length < 35) return null;
  const n = 30, s = h.slice(-n), mn = mean(s), last = h.at(-1);
  let num = 0, den = 0; s.forEach((v, i) => { num += (i - (n - 1) / 2) * (v - mn); den += (i - (n - 1) / 2) ** 2; });
  const slope = num / den / mn;
  let e = s[0]; s.forEach(v => e = v * 0.2 + e * 0.8);
  const trend = (last - e) / e;
  const rets = s.slice(1).map((v, i) => Math.log(v / s[i])), rm = mean(rets);
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - rm) ** 2, 0) / rets.length);
  const pr = k => (slope * k * 0.3 + trend * 0.5) * 100 + m * 0.08 * Math.sqrt(k / 5);
  const agree = Math.sign(slope) === Math.sign(trend) && Math.sign(slope) === Math.sign(m || slope);
  return {
    p5: pr(5), p60: pr(60), conf: Math.round(agree ? 55 + Math.min(15, Math.abs(pr(60)) * 10) : 38),
    fc: Array.from({ length: 30 }, (_, i) => last * (1 + pr(i + 1) / 100)),
    band: Array.from({ length: 30 }, (_, i) => last * vol * Math.sqrt(i + 1) * 1.5)
  };
}

// Тяжёлая часть сигнала: не зависит от весов, считается один раз на свечу
function features(h) {
  if (h.length < 60) return null;
  const last = h.at(-1), e9 = ema(h, 9), e21 = ema(h, 21), r = rsi(h), s = h.slice(-30);
  const rets = s.slice(1).map((v, i) => Math.log(v / s[i])), rm = mean(rets);
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - rm) ** 2, 0) / rets.length) || 1e-6;
  const f0 = solForecast(0, h); if (!f0) return null;
  return { last, e9, e21, r, vol, s0: s[0], p60: f0.p60,
    emaS: clamp((e9 - e21) / e21 / (vol * 3), -1, 1),
    driftS: clamp((last - s[0]) / s[0] / (vol * Math.sqrt(30) * 1.5), -1, 1),
    rsiS: r > 70 ? -(r - 70) / 30 : r < 30 ? (30 - r) / 30 : 0 };
}

// Лёгкая часть: веса, порог, стоп, RR (параметры P настраиваются)
function signalFrom(ft, m, P = DEFAULT_P, withReasons = true) {
  const w = P.w, p60 = ft.p60 + m * 0.08 * Math.sqrt(12);
  const sentS = clamp(m * 2, -1, 1), fS = clamp(p60 / 0.5, -1, 1);
  const score = w.ema * ft.emaS + w.drift * ft.driftS + w.rsi * ft.rsiS + w.sent * sentS + w.f * fS;
  const dir = score > P.thr ? 'LONG' : score < -P.thr ? 'SHORT' : 'WAIT', sg = Math.sign(score);
  const agree = [ft.emaS, ft.driftS, sentS, fS].filter(x => x !== 0 && Math.sign(x) === sg).length;
  const conf = Math.round(clamp(35 + Math.abs(score) * 45 + agree * 3, 30, 80));
  const stopPct = Math.max(ft.vol * Math.sqrt(60) * 100 * P.stop, 0.5), tpPct = stopPct * P.rr[conf >= 60 ? 1 : 0];
  const k = dir === 'SHORT' ? -1 : 1, last = ft.last, r = ft.r;
  return { dir, score, conf, entry: last, stopPct, tpPct, sl: last * (1 - k * stopPct / 100), tp: last * (1 + k * tpPct / 100), rsi: r,
    reasons: !withReasons ? null : [
      ft.e9 > ft.e21 ? 'EMA9 выше EMA21 — краткосрочный тренд вверх' : 'EMA9 ниже EMA21 — краткосрочный тренд вниз',
      `Движение за 30 мин: ${((last / ft.s0 - 1) * 100).toFixed(2)}%`,
      r > 70 ? `RSI ${r.toFixed(0)} — перекупленность, риск отката` : r < 30 ? `RSI ${r.toFixed(0)} — перепроданность, возможен отскок` : `RSI ${r.toFixed(0)} — нейтрально`,
      m > 0.15 ? 'Соцсети и новости: жадность (позитив)' : m < -0.1 ? 'Соцсети и новости: страх (негатив)' : 'Соцсети и новости нейтральны',
      `Прогноз модели на 1 ч: ${p60.toFixed(2)}%`] };
}
const solSignal = (m, f, h, P) => { if (!f) return null; const ft = features(h); return ft && signalFrom(ft, m, P); };

// ---------- Симуляция ----------
function buildFeatures(cl) { const F = new Array(cl.length); for (let i = 120; i < cl.length; i += STEP) F[i] = features(cl.slice(i - 119, i + 1)); return F; }

function exitTrade(C, i, k, sl, tp) {      // если в свече задеты оба уровня — считаем стоп (худший случай)
  const last = Math.min(i + HOLD, C.length - 1);
  for (let j = i + 1; j <= last; j++) {
    const b = C[j];
    if (k > 0 ? b.l <= sl : b.h >= sl) return { exit: sl, why: 'SL', j };
    if (k > 0 ? b.h >= tp : b.l <= tp) return { exit: tp, why: 'TP', j };
  }
  return { exit: C[last].c, why: 'timeout', j: last };
}
const align = i => Math.ceil(i / STEP) * STEP;

function simulate(C, F, from, to, P, minConf) {
  const trades = []; let i = align(Math.max(from, 120));
  while (i < to - 2) {
    const ft = F[i], sg = ft && signalFrom(ft, 0, P, false);   // тональность на истории недоступна → 0
    if (!sg || sg.dir === 'WAIT' || sg.conf < minConf) { i += STEP; continue; }
    const k = sg.dir === 'LONG' ? 1 : -1, x = exitTrade(C, i, k, sg.sl, sg.tp);
    const ret = k * (x.exit / sg.entry - 1) * 100 - FEE;
    trades.push({ i, dir: sg.dir, conf: sg.conf, ret, R: ret / sg.stopPct, why: x.why, stopPct: sg.stopPct, tpPct: sg.tpPct });
    i = align(x.j + 1);
  }
  return trades;
}

function randomTrades(C, F, from, to, rand, p = 0.12) {   // базовая линия: случайное направление, те же стоп/тейк
  const trades = []; let i = align(Math.max(from, 120));
  while (i < to - 2) {
    const ft = F[i];
    if (!ft || rand() > p) { i += STEP; continue; }
    const k = rand() < 0.5 ? 1 : -1, stopPct = Math.max(ft.vol * Math.sqrt(60) * 100 * 0.8, 0.5), tpPct = stopPct * 1.5;
    const x = exitTrade(C, i, k, ft.last * (1 - k * stopPct / 100), ft.last * (1 + k * tpPct / 100));
    const ret = k * (x.exit / ft.last - 1) * 100 - FEE;
    trades.push({ i, dir: k > 0 ? 'LONG' : 'SHORT', conf: 50, ret, R: ret / stopPct, why: x.why, stopPct, tpPct });
    i = align(x.j + 1);
  }
  return trades;
}

function stats(trades, rk = 1) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avgRet: 0, sd: 0, t: 0, pf: null, equity: 0, maxDD: 0, curve: [1] };
  const rets = trades.map(t => t.ret), avg = mean(rets);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
  const gp = rets.filter(x => x > 0).reduce((a, b) => a + b, 0), gl = -rets.filter(x => x <= 0).reduce((a, b) => a + b, 0);
  let eq = 1, peak = 1, dd = 0; const curve = [1];
  for (const t of trades) { eq *= 1 + t.R * rk / 100 * clamp((t.conf - 40) / 30, 0.25, 1); curve.push(eq); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return { n, winRate: rets.filter(x => x > 0).length / n * 100, avgRet: avg, sd, t: sd ? avg / (sd / Math.sqrt(n)) : 0, pf: gl ? gp / gl : null, equity: (eq - 1) * 100, maxDD: dd * 100, curve };
}
const grp = x => ({ n: x.length, win: x.length ? x.filter(t => t.ret > 0).length / x.length * 100 : null, avg: x.length ? mean(x.map(t => t.ret)) : null });

// Быстрый бэктест с ручными весами (карточка «Бэктест сигнала»)
function quickBacktest(C, minConf, rk) {
  const cl = C.map(x => x.c), F = buildFeatures(cl), tr = simulate(C, F, 120, C.length, DEFAULT_P, minConf), st = stats(tr, rk);
  return { ...st, bh: (cl.at(-1) / cl[120] - 1) * 100,
    buckets: [['30–54%', 30, 55], ['55–64%', 55, 65], ['65–80%', 65, 81]].map(([r, a, b]) => ({ range: r, ...grp(tr.filter(t => t.conf >= a && t.conf < b)) })),
    sides: { LONG: grp(tr.filter(t => t.dir === 'LONG')), SHORT: grp(tr.filter(t => t.dir === 'SHORT')) },
    exits: { TP: tr.filter(t => t.why === 'TP').length, SL: tr.filter(t => t.why === 'SL').length, timeout: tr.filter(t => t.why === 'timeout').length },
    from: C[120].t, to: C.at(-1).t };
}

// ---------- Настройка параметров и walk-forward ----------
const WS = { 'ручные': DEFAULT_P.w, 'тренд': { ema: .4, drift: .4, rsi: .05, sent: .05, f: .1 }, 'контртренд': { ema: .1, drift: .1, rsi: .55, sent: .05, f: .2 }, 'смешанные': { ema: .25, drift: .2, rsi: .25, sent: .1, f: .2 } };
const GRID = [];
for (const [wn, w] of Object.entries(WS)) for (const thr of [.2, .3, .4]) for (const stop of [.8, 1.2, 1.8]) for (const rr of [[1.5, 2], [1, 1.5]]) for (const mc of [30, 55, 65])
  GRID.push({ P: { w, thr, stop, rr }, mc, label: `${wn} · порог ${thr} · стоп ${stop}× · RR ${rr.join('/')} · увер. ≥${mc}` });

// Выбор по t-статистике среднего результата на обучающем окне (штрафует малые выборки; нужно ≥30 сделок)
function tuneParams(C, F, from, to) {
  let best = null, bs = -Infinity;
  for (const g of GRID) {
    const tr = simulate(C, F, from, to, g.P, g.mc); if (tr.length < 30) continue;
    const s = stats(tr), sc = s.t;
    if (sc > bs) { bs = sc; best = { ...g, trainN: s.n, trainAvg: s.avgRet, trainPf: s.pf }; }
  }
  return best || { P: DEFAULT_P, mc: 55, label: 'по умолчанию (на обучении <30 сделок)', trainN: 0, trainAvg: 0, trainPf: null };
}

async function walkForward(C, o = {}, progress = () => {}) {
  const cl = C.map(x => x.c), N = C.length, days = (N - 120) / 1440;
  if (days < 14) throw new Error(`мало истории (${days.toFixed(1)} дн.): нужно минимум 14 — нажмите «Загрузить историю»`);
  const trainD = clamp(Math.round(days * .4), 7, 30), testD = clamp(Math.round(days * .1), 2, 7), tr = trainD * 1440, te = testD * 1440;
  const F = buildFeatures(cl), folds = [];
  for (let a = 120; a + tr + te <= N; a += te) folds.push({ a, b: a + tr, c: a + tr + te });
  const oos = [], def = [], out = []; let hold = 1;
  for (let q = 0; q < folds.length; q++) {
    const { a, b, c } = folds[q], best = tuneParams(C, F, a, b);
    const tt = simulate(C, F, b, c, best.P, best.mc), td = simulate(C, F, b, c, DEFAULT_P, 55), s = stats(tt);
    oos.push(...tt); def.push(...td); hold *= cl[c - 1] / cl[b];
    out.push({ from: C[b].t, to: C[c - 1].t, label: best.label, trainN: best.trainN, trainAvg: best.trainAvg, trainPf: best.trainPf, n: s.n, avg: s.avgRet, pf: s.pf, win: s.winRate });
    progress((q + 1) / (folds.length + 1)); await new Promise(r => setImmediate(r));
  }
  let seed = 42; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647, reps = [];
  for (let k = 0; k < 10; k++) { const t = []; for (const { b, c } of folds) t.push(...randomTrades(C, F, b, c, rand)); reps.push(stats(t)); }
  const rnd = { n: mean(reps.map(r => r.n)), winRate: mean(reps.map(r => r.winRate)), avgRet: mean(reps.map(r => r.avgRet)), equity: mean(reps.map(r => r.equity)) };
  const calib = [[30, 45], [45, 55], [55, 65], [65, 75], [75, 81]].map(([a, b]) => {
    const x = oos.filter(t => t.conf >= a && t.conf < b);
    return { range: `${a}–${b - 1}%`, n: x.length, win: x.length ? mean(x.map(t => +(t.ret > 0))) * 100 : null, avg: x.length ? mean(x.map(t => t.ret)) : null,
      be: x.length ? mean(x.map(t => (t.stopPct + FEE) / (t.tpPct + t.stopPct))) * 100 : null };   // безубыточный винрейт
  });
  const big = calib.filter(c => c.n >= 15), monotonic = big.length >= 2 && big.every((c, i) => !i || c.win >= big[i - 1].win - 3);
  let gaps = 0; for (let i = 1; i < N; i++) if (C[i].t - C[i - 1].t > 120000) gaps++;
  progress(1);
  return { days, trainD, testD, folds: out, oos: stats(oos), def: stats(def), rnd, hold: (hold - 1) * 100, calib, monotonic, gaps, from: C[120].t, to: C.at(-1).t,
    foldsPos: out.filter(f => f.n && f.avg > 0).length };
}

// ---------- Отчёт по логам токенов ----------
function tokenReport(rows) {       // rows: {ts, addr, price, liq, pred, risk}, отсортированы по addr, ts
  const by = new Map(); for (const r of rows) { if (!by.has(r.addr)) by.set(r.addr, []); by.get(r.addr).push(r); }
  const pairs = [], rug = { low: [0, 0], mid: [0, 0], high: [0, 0] };
  for (const a of by.values()) {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      while (j < a.length && a[j].ts < a[i].ts + 15 * 6e4) j++;
      if (j < a.length && a[j].ts <= a[i].ts + 25 * 6e4 && a[i].price > 0 && a[j].price > 0) pairs.push({ pred: a[i].pred, act: (a[j].price / a[i].price - 1) * 100 });
    }
    const f = a[0], later = a.filter(x => x.ts >= f.ts + 30 * 6e4 && x.ts <= f.ts + 90 * 6e4);
    if (f.liq > 0 && later.length) { const g = f.risk < 35 ? 'low' : f.risk < 65 ? 'mid' : 'high'; rug[g][0]++; if (Math.min(...later.map(x => x.liq)) < f.liq * 0.4) rug[g][1]++; }
  }
  const sel = pairs.filter(p => Math.abs(p.pred) >= 2 && Math.abs(p.act) >= 0.5), up = pairs.filter(p => p.pred >= 5), dn = pairs.filter(p => p.pred <= -5);
  const mp = mean(pairs.map(p => p.pred)), ma = mean(pairs.map(p => p.act));
  const cov = pairs.reduce((s, p) => s + (p.pred - mp) * (p.act - ma), 0), vp = pairs.reduce((s, p) => s + (p.pred - mp) ** 2, 0), va = pairs.reduce((s, p) => s + (p.act - ma) ** 2, 0);
  const ts = rows.map(r => r.ts);
  return { tokens: by.size, snaps: rows.length, hours: rows.length ? (Math.max(...ts) - Math.min(...ts)) / 36e5 : 0, pairs: pairs.length,
    hit: { n: sel.length, rate: sel.length ? sel.filter(p => Math.sign(p.pred) === Math.sign(p.act)).length / sel.length * 100 : null },
    up: { n: up.length, v: up.length ? mean(up.map(p => p.act)) : null }, dn: { n: dn.length, v: dn.length ? mean(dn.map(p => p.act)) : null },
    corr: vp && va ? cov / Math.sqrt(vp * va) : null, rug };
}

module.exports = { DEFAULT_P, solForecast, solSignal, features, signalFrom, simulate, stats, quickBacktest, walkForward, tokenReport };
