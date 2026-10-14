'use strict';
// Диагностика признаков: есть ли у каждого признака статистическая связь с будущим ходом SOL (до комиссий, стопов и тейков).
const M = require('./model');
const HZ = [5, 15, 60, 240];                    // горизонты, минут
const FEATS = [
  ['sol_ret15', 'SOL: ход за 15 мин'], ['sol_ret60', 'SOL: ход за 60 мин'], ['sol_ema', 'SOL: EMA9 vs EMA21 (тренд)'], ['sol_drift', 'SOL: дрейф 30 мин / шум'], ['sol_rsi', 'SOL: RSI − 50'],
  ['btc_ret15', 'BTC: ход за 15 мин'], ['btc_ret60', 'BTC: ход за 60 мин'], ['eth_ret15', 'ETH: ход за 15 мин'], ['eth_ret60', 'ETH: ход за 60 мин'], ['rel_btc60', 'SOL минус BTC, 60 мин'],
  ['taker15', 'Агрессивные покупки − продажи, 15 мин'], ['taker60', 'Агрессивные покупки − продажи, 60 мин'],
  ['funding', 'Funding rate (бп)'], ['oi_chg60', 'Open interest: изм. за 60 мин'], ['oi_chg240', 'Open interest: изм. за 4 ч']];

function rank(a) {
  const idx = a.map((_, i) => i).sort((p, q) => a[p] - a[q]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; }
  return r;
}
function pear(x, y) {
  const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; c += a * b; vx += a * a; vy += b * b; }
  return vx && vy ? c / Math.sqrt(vx * vy) : 0;
}
const spear = (x, y) => pear(rank(x), rank(y));         // ранговая корреляция устойчива к выбросам
const tstat = (r, n) => Math.abs(r) >= 1 ? 0 : r * Math.sqrt((n - 2) / (1 - r * r));
const median = a => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

function cell(x, y, ts, mid) {
  const n = x.length; if (n < 30) return { n, r: null };
  const r = spear(x, y), med = median(x);
  const sv = x.map((v, i) => (v > med ? 1 : -1) * y[i]), edge = sv.reduce((a, b) => a + b, 0) / n;      // средний ход при торговле по знаку признака (до комиссий), %
  const se = Math.sqrt(sv.reduce((a, b) => a + (b - edge) ** 2, 0) / Math.max(1, n - 1) / n);            // стандартная ошибка среднего
  const half = f => { const xs = [], ys = []; ts.forEach((t, i) => { if (f(t)) { xs.push(x[i]); ys.push(y[i]); } }); return xs.length >= 30 ? spear(xs, ys) : null; };
  const rA = half(t => t < mid), rB = half(t => t >= mid);
  return { n, r, t: tstat(r, n), edge, se, rA, rB, stable: rA != null && rB != null && Math.sign(rA) === Math.sign(r) && Math.sign(rB) === Math.sign(r) };
}

function diagnose(D, opts = {}) {
  const tc = opts.tcrit ?? 3;
  const C = D.sol, N = C.length;
  if (N < 20000) throw new Error(`мало данных SOL (${N} свечей): нажмите «Загрузить историю»`);
  const cl = C.map(b => b.c), mapOf = a => new Map((a || []).map(b => [b.t, b.c]));
  const bm = mapOf(D.btc), em = mapOf(D.eth), btc = C.map(b => bm.get(b.t) ?? null), eth = C.map(b => em.get(b.t) ?? null);
  const fund = (D.funding || []).slice().sort((a, b) => a.t - b.t), oiM = new Map((D.oi || []).map(x => [x.t, x.oi]));
  const ok = (i, k) => i - k >= 0 && C[i].t - C[i - k].t === k * 6e4;                      // нет пропусков в данных
  const ret = (a, i, k) => ok(i, k) && a[i] != null && a[i - k] != null ? (a[i] / a[i - k] - 1) * 100 : null;
  const flow = (i, k) => { if (!ok(i, k - 1)) return null; let tb = 0, v = 0; for (let j = i - k + 1; j <= i; j++) { if (C[j].tb == null || !(C[j].v > 0)) return null; tb += C[j].tb; v += C[j].v; } return 2 * tb / v - 1; };
  let fi = -1;                                                                                // funding «как известно на момент t»
  const fundAt = t => { while (fi + 1 < fund.length && fund[fi + 1].t <= t) fi++; return fi >= 0 && t - fund[fi].t < 9 * 36e5 ? fund[fi].rate * 1e4 : null; };
  const oiAt = t => oiM.get(Math.floor(t / 3e5) * 3e5 - 3e5) ?? null;                         // предыдущая 5-минутка — без заглядывания вперёд
  const oiChg = (t, k) => { const a = oiAt(t), b = oiAt(t - k * 6e4); return a != null && b > 0 ? (a / b - 1) * 100 : null; };
  const fwd = (i, H) => i + H < N && ok(i + H, H) ? (cl[i + H] / cl[i] - 1) * 100 : null;

  const rows = [];
  for (let i = 240; i < N; i += 5) {
    if (!ok(i, 119)) continue;
    const ft = M.features(cl.slice(i - 119, i + 1)); if (!ft) continue;
    const s60 = ret(cl, i, 60), b60 = ret(btc, i, 60), t = C[i].t;
    rows.push({ i, t, vol: ft.vol * 100, f: {
      sol_ret15: ret(cl, i, 15), sol_ret60: s60, sol_ema: ft.emaS, sol_drift: ft.driftS, sol_rsi: ft.r - 50,
      btc_ret15: ret(btc, i, 15), btc_ret60: b60, eth_ret15: ret(eth, i, 15), eth_ret60: ret(eth, i, 60), rel_btc60: s60 != null && b60 != null ? s60 - b60 : null,
      taker15: flow(i, 15), taker60: flow(i, 60), funding: fundAt(t), oi_chg60: oiChg(t, 60), oi_chg240: oiChg(t, 240) } });
  }
  const mid = (C[0].t + C.at(-1).t) / 2, hits = []; let tests = 0;
  const sample = (get, H, absY) => {                            // непересекающиеся выборки: шаг не меньше горизонта
    const x = [], y = [], ts = []; let last = -1e18;
    for (const r of rows) { const v = get(r); if (v == null || r.t - last < H * 6e4) continue; const yy = fwd(r.i, H); if (yy == null) continue; x.push(v); y.push(absY ? Math.abs(yy) : yy); ts.push(r.t); last = r.t; }
    return [x, y, ts];
  };
  const feats = FEATS.map(([k, l]) => {
    const cells = {};
    for (const H of HZ) {
      const c = cells[H] = cell(...sample(r => r.f[k], H, false), mid); tests++;
      if (c.r != null && Math.abs(c.t) > tc && c.stable) hits.push({ k, l, H, r: c.r, t: c.t, edge: c.edge });
    }
    return { k, l, cells, cover: cells[60].n };
  });
  const vol = {}; for (const H of [60, 240]) { const [x, y] = sample(r => r.vol, H, true); vol[H] = x.length >= 30 ? { n: x.length, r: spear(x, y), t: tstat(spear(x, y), x.length) } : null; }
  hits.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  return { days: N / 1440, from: C[0].t, to: C.at(-1).t, rows: rows.length, horizons: HZ, feats, vol, tests, expected: tests * 0.0027, hits: hits.slice(0, 8), nHits: hits.length };
}
module.exports = { diagnose };
