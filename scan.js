'use strict';
// Сканер монет: издержки, поправка на множественные проверки, сводка по символу.
const FEE = 0.1;      // комиссия, % за круг (тейкер 0.05% × 2)
const SYMS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX', 'DOT', 'LTC', 'NEAR', 'APT', 'ARB', 'OP', 'INJ', 'SUI', 'FIL', 'ATOM', 'WIF', 'PEPE', 'BONK', 'FET', 'RUNE', 'TIA', 'SEI', 'JUP'];

const erfcc = x => { const z = Math.abs(x), t = 1 / (1 + 0.5 * z); const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? r : 2 - r; };
function zCrit(p) {                                   // |z|, при котором двусторонняя p-величина = p
  let lo = 0, hi = 12; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (erfcc(mid / Math.SQRT2) > p) lo = mid; else hi = mid; } return (lo + hi) / 2;
}
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// t24 — ответ /ticker/24hr, samples — несколько ответов /ticker/bookTicker. Спред берём медианой по замерам.
function parseCosts(t24, samples, syms) {
  const vol = new Map(t24.map(x => [x.symbol, +x.quoteVolume])), maps = samples.map(a => {
    const m = new Map(); for (const b of a) { const bid = +b.bidPrice, ask = +b.askPrice; if (bid > 0 && ask > 0) m.set(b.symbol, (ask - bid) / ((ask + bid) / 2) * 100); } return m;
  }), out = {};
  for (const s of syms) {
    const sp = median(maps.map(m => m.get(s + 'USDT')).filter(v => v != null)), v = vol.get(s + 'USDT');
    if (sp != null && v != null) out[s] = { spread: sp, vol24: v };
  }
  return out;
}
const tierOf = v => v == null ? '—' : v >= 1e9 ? 'топ' : v >= 2e8 ? 'крупные' : v >= 5e7 ? 'средние' : 'малые';

function summarize(sym, d, mk, tcrit) {
  const spread = mk ? mk.spread : 0.05, cost = FEE + spread;
  let best = null, nSig = 0, nCand = 0, hits3 = 0;
  for (const f of d.feats) for (const H of d.horizons) {
    const c = f.cells[H]; if (c.r == null) continue;
    const gross = Math.abs(c.edge), net = gross - cost, netT = c.se ? net / c.se : 0, sig = Math.abs(c.t) > tcrit && c.stable;
    if (Math.abs(c.t) > 3 && c.stable) hits3++;
    if (sig) nSig++; if (sig && netT > 2 && net > 0) nCand++;
    const score = (sig ? 1e3 : 0) + net;                       // значимые выше, внутри — по чистому ходу
    if (c.stable && (!best || score > best.score)) best = { feature: f.l, key: f.k, H, r: c.r, t: c.t, n: c.n, gross, net, netT, sig, score };
  }
  return { sym, tier: tierOf(mk?.vol24), days: d.days, vol24: mk ? mk.vol24 : null, spread: mk ? mk.spread : null, spreadKnown: !!mk, cost, best, nSig, nCand, hits3 };
}
const rankRows = rows => rows.sort((a, b) => b.nCand - a.nCand || b.nSig - a.nSig || ((b.best ? b.best.net : -9) - (a.best ? a.best.net : -9)));
module.exports = { SYMS, FEE, zCrit, parseCosts, tierOf, summarize, rankRows };
