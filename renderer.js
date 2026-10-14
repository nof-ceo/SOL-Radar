const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = n => n >= 1e6 ? '$' + fmt(n / 1e6, 1) + 'M' : n >= 1e3 ? '$' + fmt(n / 1e3, 0) + 'K' : '$' + fmt(n, 0);
const pct = n => `<span class="${n >= 0 ? 'up' : 'dn'}">${n >= 0 ? '+' : ''}${fmt(n)}%</span>`;
const ageStr = m => m == null ? '—' : m < 60 ? Math.round(m) + ' мин' : m < 1440 ? Math.floor(m / 60) + ' ч' : Math.floor(m / 1440) + ' д';
let filter = 'all', last = null;

$('flt').innerHTML = [['all', 'Все'], ['low', 'Низкий риск'], ['hot', 'Волатильные']].map(([k, l]) => `<button data-k="${k}" class="${k === 'all' ? 'on' : ''}">${l}</button>`).join('');
$('flt').onclick = e => { const k = e.target.dataset.k; if (!k) return; filter = k; [...$('flt').children].forEach(b => b.classList.toggle('on', b === e.target)); if (last) render(last); };
document.addEventListener('click', e => { const el = e.target.closest('[data-u]'); if (el) window.api.open(el.dataset.u); });

function draw(sol) {
  const c = $('ch'), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr);
  const H = sol.hist; if (H.length < 2) return;
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const F = sol.f ? sol.f.fc.length : 0, lastP = H.at(-1);
  const all = [...H, ...(sol.f ? sol.f.fc.map((x, i) => x + sol.f.band[i]).concat(sol.f.fc.map((x, i) => x - sol.f.band[i])) : [])];
  const mn = Math.min(...all), mx = Math.max(...all), X = i => i / (H.length + F - 1) * w, Y = x => h - 8 - (x - mn) / (mx - mn || 1) * (h - 16);
  g.strokeStyle = v('--bd'); for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(0, h * i / 4); g.lineTo(w, h * i / 4); g.stroke(); }
  g.beginPath(); H.forEach((p, i) => i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p))); g.strokeStyle = lastP >= H[0] ? v('--up') : v('--dn'); g.lineWidth = 2; g.stroke();
  if (!sol.f) return;
  const { fc, band } = sol.f;
  g.globalAlpha = .15; g.fillStyle = v('--ac'); g.beginPath(); g.moveTo(X(H.length - 1), Y(lastP));
  fc.forEach((p, i) => g.lineTo(X(H.length + i), Y(p + band[i]))); for (let i = F - 1; i >= 0; i--) g.lineTo(X(H.length + i), Y(fc[i] - band[i])); g.fill(); g.globalAlpha = 1;
  g.setLineDash([5, 4]); g.strokeStyle = v('--ac'); g.beginPath(); g.moveTo(X(H.length - 1), Y(lastP)); fc.forEach((p, i) => g.lineTo(X(H.length + i), Y(p))); g.stroke(); g.setLineDash([]);
}

function render(s) {
  last = s;
  // SOL
  if (s.sol.price) { $('p').textContent = '$' + fmt(s.sol.price); $('chg').innerHTML = pct((s.sol.price / s.sol.first - 1) * 100); draw(s.sol); }
  if (s.sol.f) { $('f5').innerHTML = pct(s.sol.f.p5); $('f60').innerHTML = pct(s.sol.f.p60); $('conf').textContent = s.sol.f.conf + '%'; }
  renderSol2(s.sol);
  // Статус источников
  const names = ['Биржи', 'BTC/ETH', 'Фьючерсы', 'База', 'DexScreener', 'RugCheck', 'Reddit', 'Новости', 'X', 'Discord'];
  $('status').innerHTML = names.filter(n => s.status[n]).map(n => { const st = s.status[n]; return `<span class="chip ${st.ok ? 'ok' : 'err'}" title="${esc(st.err || 'OK')}">${st.ok ? '●' : '✕'} ${n}</span>`; }).join('');
  // Настроение
  const m = s.m; $('mood').innerHTML = m > .15 ? '<span class="up">Жадность</span>' : m < -.1 ? '<span class="dn">Страх</span>' : '<span class="mut">Нейтрально</span>';
  const bar = $('moodbar'); bar.style.width = (50 + m * 50) + '%'; bar.style.background = m >= 0 ? 'var(--up)' : 'var(--dn)';
  $('srcs').innerHTML = Object.entries(s.mood).map(([k, v]) => `<div style="display:flex;justify-content:space-between"><span class="mut">${esc(k)}</span>${pct(v * 100)}</div>`).join('') || '<span class="mut">Ждём данные…</span>';
  // Токены
  let rows = s.tokens.slice();
  if (filter === 'low') rows = rows.filter(t => t.risk < 40); if (filter === 'hot') rows = rows.filter(t => t.volat > 20);
  rows.sort((a, b) => b.volat - a.volat);
  $('tb').innerHTML = rows.map(t => {
    const cls = t.risk < 35 ? 'r-l' : t.risk < 65 ? 'r-m' : 'r-h', lbl = t.risk < 35 ? 'Низкий' : t.risk < 65 ? 'Средний' : 'Высокий';
    return `<tr class="k" ${t.url ? `data-u="${esc(t.url)}"` : ''}><td><b>${esc(t.sym)}</b> <span class="mut">${esc((t.name || '').slice(0, 16))}</span></td><td>$${t.price.toPrecision(3)}</td><td>${ageStr(t.age)}</td><td>${usd(t.liq)}</td><td>${usd(t.vol24)}</td><td>${pct(t.ch5)}</td><td>${pct(t.ch1)}</td><td>${fmt(t.volat, 1)}</td><td>${t.sent > .2 ? '🟢' : t.sent < -.1 ? '🔴' : '🟡'} ${t.ment}</td><td>${pct(t.pred)} <span class="mut">(${t.conf}%)</span></td><td><span class="pill ${cls}" title="${esc(t.flags.join('; ') || 'нет данных RugCheck')}">${lbl} ${t.risk}</span></td></tr>`;
  }).join('') || '<tr><td colspan="11" class="mut">Загрузка токенов…</td></tr>';
  // Лента
  $('feed').innerHTML = s.posts.map(p => `<div class="post" ${p.url && /^https:/.test(p.url) ? `data-u="${esc(p.url)}"` : ''}><span class="src">${esc(p.src)}</span> <span class="mut">${new Date(p.ts).toLocaleTimeString('ru-RU')}</span> <span class="${p.s > .1 ? 'up' : p.s < -.1 ? 'dn' : 'mut'}">${p.s > .1 ? '▲' : p.s < -.1 ? '▼' : '●'}</span><div>${esc(p.text)}</div></div>`).join('');
}
// ---- Свечной график, сигнал, размер позиции ----
let tf = '5m';
$('tfb').innerHTML = ['1m', '5m', '15m', '1h'].map(k => `<button data-tf="${k}" class="${k === tf ? 'on' : ''}">${k}</button>`).join(' ');
$('tfb').onclick = e => { const k = e.target.dataset.tf; if (!k) return; tf = k; [...$('tfb').children].forEach(b => b.classList.toggle('on', b === e.target)); window.api.setTf(k); };
['dep', 'rsk'].forEach(id => {
  try { const sv = localStorage.getItem(id); if (sv) $(id).value = sv; } catch {}
  $(id).oninput = () => { try { localStorage.setItem(id, $(id).value); } catch {} if (last) renderSol2(last.sol); };
});
const emaArr = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map(v => (e = v * k + e * (1 - k))); };

function drawCandles(sol) {
  const C = sol.candles || []; if (C.length < 5) return;
  const c = $('cc'), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const sg = sol.sig, lv = sg && sg.dir !== 'WAIT' ? [sg.entry, sg.sl, sg.tp] : [];
  const vh = h * 0.18, ph = h - vh - 14;
  let mn = Math.min(...C.map(x => x.l), ...lv), mx = Math.max(...C.map(x => x.h), ...lv);
  const pad = (mx - mn) * 0.05; mn -= pad; mx += pad;
  const bw = w / C.length, X = i => (i + 0.5) * bw, Y = p => 6 + (mx - p) / (mx - mn || 1) * ph;
  g.font = '10px sans-serif';
  for (let i = 0; i < 5; i++) { const p = mx - (mx - mn) * i / 4, y = Y(p); g.strokeStyle = v('--bd'); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillStyle = v('--mut'); g.fillText(p.toFixed(2), 4, y - 2); }
  const vm = Math.max(...C.map(x => x.v)) || 1;
  C.forEach((x, i) => {
    const col = x.c >= x.o ? v('--up') : v('--dn'), vhh = x.v / vm * vh;
    g.fillStyle = col; g.globalAlpha = .35; g.fillRect(X(i) - bw * .35, h - vhh, bw * .7, vhh); g.globalAlpha = 1;
    g.strokeStyle = col; g.beginPath(); g.moveTo(X(i), Y(x.h)); g.lineTo(X(i), Y(x.l)); g.stroke();
    const y1 = Y(x.o), y2 = Y(x.c); g.fillRect(X(i) - bw * .35, Math.min(y1, y2), bw * .7, Math.max(1, Math.abs(y1 - y2)));
  });
  const cl = C.map(x => x.c);
  [[9, v('--ac')], [21, v('--warn')]].forEach(([n, col]) => {
    const e = emaArr(cl, n); g.beginPath(); e.forEach((p, i) => i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)));
    g.strokeStyle = col; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
  });
  if (lv.length) [[sg.entry, v('--tx'), 'вход'], [sg.sl, v('--dn'), 'SL'], [sg.tp, v('--up'), 'TP']].forEach(([p, col, l]) => {
    g.setLineDash([4, 4]); g.strokeStyle = col; g.beginPath(); g.moveTo(0, Y(p)); g.lineTo(w, Y(p)); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.fillText(l + ' ' + p.toFixed(2), w - 90, Y(p) - 3);
  });
}

function renderSol2(sol) {
  drawCandles(sol); renderBanner();
  const sg = sol.sig, el = $('sig');
  if (!sg) { el.innerHTML = '<span class="mut">Накопление данных…</span>'; return; }
  el.innerHTML = sg.dir === 'LONG' ? '<span class="up">▲ ЛОНГ</span>' : sg.dir === 'SHORT' ? '<span class="dn">▼ ШОРТ</span>' : '<span class="mut">■ ЖДАТЬ</span>';
  $('sigsub').textContent = `Уверенность модели ${sg.conf}% · RSI ${fmt(sg.rsi, 0)} · горизонт ~1 ч`;
  $('why').innerHTML = sg.reasons.map(r => '• ' + esc(r)).join('<br>');
  const ver = wfState && wfState.ok;
  if (!ver && !$('force').checked) { $('plan').innerHTML = '<span class="mut">Уровни и размер позиции скрыты: сигнал не подтверждён тестом.</span>'; $('size').innerHTML = ''; return; }
  if (sg.dir === 'WAIT') { $('plan').innerHTML = '<span class="mut">Сигналы противоречат друг другу — лучше не входить.</span>'; $('size').innerHTML = ''; return; }
  const sgn = sg.dir === 'LONG' ? 1 : -1;
  $('plan').innerHTML = `<div>Вход: <b>$${fmt(sg.entry)}</b></div><div>Стоп: <b class="dn">$${fmt(sg.sl)}</b> (${sgn > 0 ? '−' : '+'}${fmt(sg.stopPct)}%)</div><div>Тейк: <b class="up">$${fmt(sg.tp)}</b> (${sgn > 0 ? '+' : '−'}${fmt(sg.tpPct)}%)</div><div>Прогноз модели на 1 ч: ${pct(sol.f ? sol.f.p60 : 0)}</div>`;
  const dep = Math.max(1, +$('dep').value || 0), rk = Math.min(5, Math.max(0.1, +$('rsk').value || 1));
  const scale = Math.min(1, Math.max(0.25, (sg.conf - 40) / 30));          // меньше уверенность — меньше риск
  let notional = dep * rk / 100 * scale / (sg.stopPct / 100), lev = notional / dep, capped = false;
  if (lev > 5) { lev = 5; notional = dep * 5; capped = true; }
  const L = Math.max(lev, 1), risk = notional * sg.stopPct / 100;
  $('size').innerHTML = `<div>Размер позиции: <b>$${fmt(notional, 0)}</b> (≈ ${fmt(notional / sg.entry, 2)} SOL)</div><div>Плечо: <b>~${fmt(L, 1)}×</b>${capped ? ' (ограничено 5×)' : ''} · маржа ≈ $${fmt(notional / L, 0)}</div><div>Риск до стопа: <b class="dn">$${fmt(risk, 0)}</b> (${fmt(risk / dep * 100, 2)}% депозита) · потенциал: <b class="up">$${fmt(risk * sg.tpPct / sg.stopPct, 0)}</b></div>`;
}

// ---- Бэктест ----
function drawEq(curve) {
  const c = $('bte'); if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr); const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const mn = Math.min(...curve, 1), mx = Math.max(...curve, 1), X = i => i / (curve.length - 1 || 1) * w, Y = p => h - 6 - (p - mn) / (mx - mn || 1) * (h - 12);
  g.strokeStyle = v('--bd'); g.beginPath(); g.moveTo(0, Y(1)); g.lineTo(w, Y(1)); g.stroke();
  g.beginPath(); curve.forEach((p, i) => i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)));
  g.strokeStyle = curve.at(-1) >= 1 ? v('--up') : v('--dn'); g.lineWidth = 2; g.stroke();
}
$('btr').onclick = async () => {
  $('btr').disabled = true; $('bts').textContent = 'Загружаю историю и считаю…';
  const r = await window.api.backtest({ days: +$('btd').value, minConf: +$('btc').value, risk: +$('rsk').value });
  $('btr').disabled = false; $('bts').textContent = '';
  if (!r.ok) { $('btout').innerHTML = `<span class="dn">Ошибка: ${esc(r.err)}</span>`; return; }
  if (!r.n) { $('btout').innerHTML = '<span class="mut">За период не было ни одного сигнала выше порога уверенности.</span>'; return; }
  const k = (l, x) => `<div class="kpi"><span class="mut">${l}</span><b>${x}</b></div>`, f1 = x => x == null ? '—' : fmt(x, 0) + '%';
  const good = r.equity > 0 && (r.pf == null || r.pf > 1.1) && r.equity > r.bh * 0.5;
  const verdict = r.equity <= 0 || (r.pf != null && r.pf < 1) ? '⚠️ На этом периоде сигнал не показал преимущества — после комиссий он в минусе.'
    : good ? 'На этом периоде сигнал в плюсе, но один период — не доказательство: проверьте другие даты и пороги.' : 'Результат неоднозначный: преимущество над случайным входом не очевидно.';
  $('btout').innerHTML = `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">`
    + k('Сделок', r.n) + k('Винрейт', fmt(r.winRate, 0) + '%') + k('Средний результат', pct(r.avgRet)) + k('Profit factor', r.pf == null ? '∞' : fmt(r.pf))
    + k('Итог на депозит', pct(r.equity)) + k('Макс. просадка', `<span class="dn">−${fmt(r.maxDD)}%</span>`) + k('Купи и держи', pct(r.bh)) + `</div>`
    + `<p>${verdict}</p><canvas id="bte" style="height:140px"></canvas>`
    + `<div class="note" style="margin-top:6px">${new Date(r.from).toLocaleDateString('ru-RU')} — ${new Date(r.to).toLocaleDateString('ru-RU')} · выходы: TP ${r.exits.TP}, SL ${r.exits.SL}, по времени ${r.exits.timeout}</div>`
    + `<div class="tbl"><table style="min-width:420px"><thead><tr><th>Группа</th><th>Сделок</th><th>Винрейт</th><th>Средний результат</th></tr></thead><tbody>`
    + [...r.buckets.map(b => [`Уверенность ${b.range}`, b]), ['Лонги', r.sides.LONG], ['Шорты', r.sides.SHORT]]
        .map(([l, b]) => `<tr><td>${l}</td><td>${b.n}</td><td>${f1(b.win)}</td><td>${b.avg == null ? '—' : pct(b.avg)}</td></tr>`).join('')
    + `</tbody></table></div><div class="note">Если винрейт не растёт с уверенностью, шкала «уверенности» ничего не значит.</div>`;
  drawEq(r.curve);
};

// ---- Исследование модели ----
const p0 = x => x == null ? '—' : fmt(x, 0) + '%';
async function refreshDb() {
  const d = await window.api.dbStats();
  if (!d.ok) { $('dbs').innerHTML = `<span class="dn">${esc(d.err)}</span>`; return; }
  $('dbs').innerHTML = `В базе: SOL <b>${fmt(d.candles.n, 0)}</b> мин. свечей (≈ ${fmt(d.candles.n / 1440, 1)} дн.${d.candles.nulls ? ', без объёма покупателей: ' + fmt(d.candles.nulls, 0) + ' — нажмите «Загрузить»' : ''}), BTC ${fmt(d.btc, 0)}, ETH ${fmt(d.eth, 0)}, funding ${fmt(d.funding, 0)}, OI ${fmt(d.oi.n, 0)} (≈ ${fmt(d.oi.n / 288, 1)} дн.), токенов-снимков ${fmt(d.snaps, 0)} (${fmt(d.tokens, 0)} токенов), файл ${fmt(d.mb, 1)} МБ. Всё пишется, пока приложение запущено.`;
}
refreshDb();
window.api.onProg(p => { if (/^scan/.test(p.k)) return; $('wfs').textContent = (p.k === 'sync' ? `Загрузка (${p.label || ''}): ` : 'Проверка: ') + Math.round(p.v * 100) + '%'; });
const busy = (on, t = '') => { ['sy', 'wfb', 'tkb', 'dgb'].forEach(i => $(i).disabled = on); $('wfs').textContent = t; };
$('sy').onclick = async () => {
  busy(true, 'Загрузка данных…'); const r = await window.api.sync(+$('syd').value); busy(false);
  $('wfs').innerHTML = r.ok ? r.stages.map(s => s.ok ? `<span class="up">✓ ${esc(s.name)}: ${fmt(s.n, 0)}</span>` : `<span class="dn">✕ ${esc(s.name)}: ${esc(s.err)}</span>`).join(' · ') : `<span class="dn">${esc(r.err)}</span>`; refreshDb();
};
$('wfb').onclick = async () => {
  busy(true, 'Проверка…'); const r = await window.api.wf(); busy(false);
  if (!r.ok) { $('wfo').innerHTML = `<span class="dn">${esc(r.err)}</span>`; return; }
  const o = r.oos, d = n => new Date(n).toLocaleDateString('ru-RU'), pf = s => s.pf === undefined ? '—' : s.pf == null ? '∞' : fmt(s.pf);
  let v;
  if (o.n < 100) v = `⚠️ Всего ${o.n} сделок вне выборки — для выводов мало. Загрузите больше истории.`;
  else if (o.avgRet > 0 && o.t > 2 && o.avgRet > r.rnd.avgRet) v = '✅ Есть статистические признаки преимущества вне выборки (t > 2, лучше случайного входа). Это не гарантия: проверьте на другом периоде и бумажной торговлей.';
  else if (o.t < -2) v = `❌ Результат вне выборки достоверно отрицательный (t = ${fmt(o.t)}): после комиссий сигнал проигрывает, а до комиссий не лучше случайного входа. Использовать его для сделок нельзя.`;
  else v = '⚠️ Преимущество не доказано: средний результат вне выборки статистически неотличим от нуля или не лучше случайного входа. Использовать как сигнал к сделке нельзя.';
  const k = (l, x) => `<div class="kpi"><span class="mut">${l}</span><b>${x}</b></div>`;
  wfState = { ok: o.n >= 100 && o.avgRet > 0 && o.t > 2 && o.avgRet > r.rnd.avgRet, t: o.t, n: o.n };
  try { localStorage.setItem('wfState', JSON.stringify(wfState)); } catch {} if (last) renderSol2(last.sol);
  const base = (l, s, eq) => `<tr><td>${l}</td><td>${s.n == null ? '—' : fmt(s.n, 0)}</td><td>${s.winRate == null ? '—' : p0(s.winRate)}</td><td>${s.avgRet == null ? '—' : pct(s.avgRet)}</td><td>${pf(s)}</td><td>${pct(eq)}</td></tr>`;
  $('wfo').innerHTML = `<p><b>${v}</b></p><div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">`
    + k('Сделок вне выборки', o.n) + k('Винрейт', p0(o.winRate)) + k('Средний результат', pct(o.avgRet)) + k('t-статистика', fmt(o.t)) + k('Profit factor', o.pf == null ? '∞' : fmt(o.pf)) + k('Итог на депозит', pct(o.equity)) + k('Макс. просадка', `−${fmt(o.maxDD)}%`) + k('Окон в плюсе', `${r.foldsPos}/${r.folds.length}`) + `</div>`
    + `<div class="note" style="margin:6px 0">История ${d(r.from)} — ${d(r.to)} (${fmt(r.days, 0)} дн.); обучение ${r.trainD} дн., тест ${r.testD} дн., окон: ${r.folds.length}; пропусков в данных: ${r.gaps}. t > 2 — примерная граница, ниже которой результат нельзя отличить от случайного.</div>`
    + `<h2 style="margin-top:12px">Сравнение с базовыми стратегиями (вне выборки)</h2><div class="tbl"><table style="min-width:520px"><thead><tr><th>Стратегия</th><th>Сделок</th><th>Винрейт</th><th>Средний результат</th><th>Profit factor</th><th>Итог на депозит</th></tr></thead><tbody>`
    + base('Модель с настройкой на окнах', o, o.equity) + base('Ручные веса, без настройки', r.def, r.def.equity) + base('Случайный вход (среднее 10 прогонов)', r.rnd, r.rnd.equity)
    + `<tr><td>Купи и держи (те же окна теста)</td><td>—</td><td>—</td><td>—</td><td>—</td><td>${pct(r.hold)}</td></tr></tbody></table></div>`
    + `<h2 style="margin-top:12px">Калибровка «уверенности»</h2><div class="tbl"><table style="min-width:520px"><thead><tr><th>Уверенность</th><th>Сделок</th><th>Факт. винрейт</th><th>Безубыточный</th><th>Средний результат</th></tr></thead><tbody>`
    + r.calib.map(c => `<tr><td>${c.range}</td><td>${c.n}</td><td>${p0(c.win)}</td><td>${p0(c.be)}</td><td>${c.avg == null ? '—' : pct(c.avg)}</td></tr>`).join('')
    + `</tbody></table></div><div class="note">${r.monotonic ? 'Винрейт растёт с уверенностью — шкала хоть как-то информативна.' : 'Винрейт не растёт с уверенностью (или данных мало): число «уверенность» сейчас ничего не обещает.'} Если факт. винрейт ниже безубыточного, группа убыточна.</div>`
    + `<h2 style="margin-top:12px">По окнам</h2><div class="tbl"><table style="min-width:700px"><thead><tr><th>Окно теста</th><th>Выбранные параметры</th><th>Обучение: сделок / ср. / PF</th><th>Тест: сделок / ср. / PF</th></tr></thead><tbody>`
    + r.folds.map(f => `<tr><td>${d(f.from)}–${d(f.to)}</td><td>${esc(f.label)}</td><td>${f.trainN} / ${pct(f.trainAvg)} / ${f.trainPf == null ? '—' : fmt(f.trainPf)}</td><td>${f.n} / ${pct(f.avg)} / ${f.pf == null ? '—' : fmt(f.pf)}</td></tr>`).join('')
    + `</tbody></table></div><div class="note">Если на обучении результат сильно лучше, чем на тесте, — это переобучение.</div>`;
};
$('tkb').onclick = async () => {
  busy(true, 'Считаю…'); const r = await window.api.tokRep(); busy(false);
  if (!r.ok) { $('tko').innerHTML = `<span class="dn">${esc(r.err)}</span>`; return; }
  const g = ([n, bad], l) => `<tr><td>${l}</td><td>${n}</td><td>${n ? p0(bad / n * 100) : '—'}</td></tr>`;
  $('tko').innerHTML = `<h2 style="margin-top:12px">Токены: накопленные данные</h2><p class="note">Снимков: ${fmt(r.snaps, 0)} по ${r.tokens} токенам за ${fmt(r.hours, 1)} ч, пар «прогноз → факт через ~15 мин»: ${r.pairs}.${r.pairs < 300 ? ' Для выводов нужно хотя бы несколько тысяч пар — оставьте приложение включённым на 1–2 недели.' : ''}</p>`
    + `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">` + `<div class="kpi"><span class="mut">Угадано направление (n=${r.hit.n})</span><b>${p0(r.hit.rate)}</b></div>`
    + `<div class="kpi"><span class="mut">Факт при прогнозе ≥ +5% (n=${r.up.n})</span><b>${r.up.v == null ? '—' : pct(r.up.v)}</b></div><div class="kpi"><span class="mut">Факт при прогнозе ≤ −5% (n=${r.dn.n})</span><b>${r.dn.v == null ? '—' : pct(r.dn.v)}</b></div>`
    + `<div class="kpi"><span class="mut">Корреляция прогноз/факт</span><b>${r.corr == null ? '—' : fmt(r.corr)}</b></div></div>`
    + `<div class="tbl"><table style="min-width:420px"><thead><tr><th>Группа риска (при первом снимке)</th><th>Токенов</th><th>Ликвидность упала &gt;60% за час</th></tr></thead><tbody>${g(r.rug.low, 'Низкий')}${g(r.rug.mid, 'Средний')}${g(r.rug.high, 'Высокий')}</tbody></table></div>`
    + `<div class="note">Если «высокий риск» не падает чаще «низкого», риск-скор не работает.</div>`;
};

// ---- Статус проверки сигнала и диагностика признаков ----
let wfState = null; try { wfState = JSON.parse(localStorage.getItem('wfState') || 'null'); } catch {}
function renderBanner() {
  const ver = wfState && wfState.ok; $('vbanner').style.display = ver ? 'none' : ''; $('fl').style.display = ver ? 'none' : '';
  $('vbanner').innerHTML = !wfState ? '⚠️ <b>Сигнал не проверен на истории.</b> Запустите «Проверку» в блоке «Исследование модели». Уровни и размер позиции скрыты.'
    : `⚠️ <b>Сигнал не подтверждён тестом</b> (вне выборки: ${wfState.n} сделок, t = ${fmt(wfState.t)}). Направление показано для справки; уровни и размер позиции скрыты.`;
}
$('force').onchange = () => { if (last) renderSol2(last.sol); };
renderBanner();
const hz = H => H >= 60 ? (H / 60) + ' ч' : H + ' мин';
$('dgb').onclick = async () => {
  busy(true, 'Диагностика…'); const r = await window.api.diag(); busy(false);
  if (!r.ok) { $('dgo').innerHTML = `<span class="dn">${esc(r.err)}</span>`; return; }
  const cell = c => {
    if (c.r == null) return '<span class="mut">—</span>';
    const good = Math.abs(c.t) > 3 && c.stable, cls = good ? (c.r > 0 ? 'up' : 'dn') : 'mut';
    return `<span class="${cls}" title="n=${c.n}; половины периода: ${c.rA == null ? '—' : fmt(c.rA, 3)} / ${c.rB == null ? '—' : fmt(c.rB, 3)}">${good ? '<b>' : ''}${c.r > 0 ? '+' : ''}${fmt(c.r, 3)}${good ? '</b> ✓' : ''}<br><span class="mut" style="font-size:11px">t ${fmt(c.t, 1)} · ${fmt(c.edge, 3)}%</span></span>`;
  };
  let v;
  if (!r.nHits) v = `❌ Ни одна связь не прошла порог (|t| > 3 и одинаковый знак в обеих половинах периода). Случайно такое срабатывание ожидалось бы примерно ${fmt(r.expected, 1)} раза из ${r.tests} проверок. Ни один из этих признаков не предсказывает ход SOL — менять веса бессмысленно.`;
  else v = `Найдено устойчивых связей: ${r.nHits} из ${r.tests} проверок (случайно ожидалось ≈ ${fmt(r.expected, 1)}). Сильнейшие: ` + r.hits.slice(0, 5).map(h => `${esc(h.l)} → ${hz(h.H)} (ρ ${h.r > 0 ? '+' : ''}${fmt(h.r, 3)}, ход ${fmt(h.edge, 3)}%)`).join('; ')
    + `. Чтобы связь была торгуемой, средний ход должен заметно превышать комиссию 0,1% за круг${r.hits.some(h => Math.abs(h.edge) > 0.1) ? ' — у некоторых превышает' : ' — ни у одной не превышает'}.`;
  const volRow = ['60', '240'].map(H => r.vol[H] ? `${hz(+H)}: ρ ${fmt(r.vol[H].r, 3)} (t ${fmt(r.vol[H].t, 1)})` : null).filter(Boolean).join(', ');
  $('dgo').innerHTML = `<h2 style="margin-top:12px">Диагностика признаков</h2><p><b>${v}</b></p>`
    + `<div class="note">Период ${new Date(r.from).toLocaleDateString('ru-RU')} — ${new Date(r.to).toLocaleDateString('ru-RU')}, ${r.rows} точек. В ячейке: ρ — ранговая корреляция признака с ходом цены вперёд; t — значимость; % — средний ход, если торговать по знаку признака (до комиссии). ✓ — |t| > 3 и знак совпадает в обеих половинах периода. Выборки непересекающиеся.</div>`
    + `<div class="tbl"><table style="min-width:640px"><thead><tr><th>Признак</th>${r.horizons.map(H => `<th>→ ${hz(H)}</th>`).join('')}<th>Данных (1 ч)</th></tr></thead><tbody>`
    + r.feats.map(f => `<tr><td>${esc(f.l)}</td>${r.horizons.map(H => `<td>${cell(f.cells[H])}</td>`).join('')}<td class="mut">${f.cover}</td></tr>`).join('')
    + `</tbody></table></div><div class="note">Волатильность предсказывает будущую волатильность (корреляция текущей волатильности с будущим |ходом|): ${volRow || '—'}. Если связь сильная, модель волатильности полезнее модели направления.</div>`;
};

// ---- Сканер монет ----
const fmtV = v => v == null ? '—' : v >= 1e9 ? '$' + fmt(v / 1e9, 1) + ' млрд' : '$' + fmt(v / 1e6, 0) + ' млн';
const p3 = n => `<span class="${n >= 0 ? 'up' : 'dn'}">${n >= 0 ? '+' : ''}${fmt(n, 3)}%</span>`;
const busyS = (on, t = '') => { ['scs', 'scb'].forEach(i => $(i).disabled = on); $('scp').innerHTML = t; };
window.api.onProg(p => { if (p.k === 'scan-sync') $('scp').textContent = `Загрузка ${p.label}: ${Math.round(p.v * 100)}%`; if (p.k === 'scan') $('scp').textContent = `Анализ ${p.label}: ${Math.round(p.v * 100)}%`; });
$('scs').onclick = async () => {
  busyS(true, 'Загрузка…'); const r = await window.api.scanSync(+$('scd').value);
  if (!r.ok) { busyS(false, `<span class="dn">${esc(r.err)}</span>`); return; }
  const bad = r.res.filter(x => !x.ok);
  busyS(false, `Готово: ${r.res.length - bad.length} из ${r.res.length} монет` + (bad.length ? `. Недоступны: ${bad.map(x => esc(x.sym)).join(', ')}` : '')); refreshDb();
};
$('scb').onclick = async () => {
  busyS(true, 'Анализ…'); const r = await window.api.scan(); busyS(false);
  if (!r.ok) { $('sco').innerHTML = `<span class="dn">${esc(r.err)}</span>`; return; }
  const T = r.rows.reduce((a, x) => ({ sig: a.sig + x.nSig, cand: a.cand + x.nCand, h3: a.h3 + x.hits3 }), { sig: 0, cand: 0, h3: 0 }), e3 = r.nTests * 0.0027;
  let v;
  if (!T.cand) v = `❌ Ни на одной из ${r.rows.length} монет нет связи, которая прошла бы строгий порог (|t| > ${fmt(r.tcrit, 1)} с поправкой на ${r.nTests} проверок, одинаковый знак в обеих половинах) и при этом покрывала издержки. Значимых связей всего: ${T.sig}.`;
  else v = `Кандидатов, где связь значима и покрывает издержки: ${T.cand} (монет: ${r.rows.filter(x => x.nCand).map(x => esc(x.sym)).join(', ')}). Это только повод для проверки на другом периоде и бумажной торговли, не сигнал к сделке.`;
  v += ` Для сравнения: при мягком пороге |t| > 3 «находок» ${T.h3}, а случайно их ожидалось бы около ${fmt(e3, 0)} — поэтому порог пришлось ужесточить.`;
  const tiers = {}; r.rows.forEach(x => { (tiers[x.tier] ||= []).push(x); });
  const med = a => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const tierRow = t => { const xs = tiers[t]; if (!xs) return ''; const gm = med(xs.filter(x => x.best && x.best.sig).map(x => x.best.gross)); return `<tr><td>${t}</td><td>${xs.length}</td><td>${fmt(med(xs.map(x => x.cost)), 3)}%</td><td>${gm == null ? '—' : fmt(gm, 3) + '%'}</td><td>${xs.filter(x => x.nSig).length}</td><td>${xs.filter(x => x.nCand).length}</td></tr>`; };
  $('sco').innerHTML = `<p><b>${v}</b></p>`
    + (r.costNote ? `<div class="note dn">${esc(r.costNote)}</div>` : '') + (r.missing.length ? `<div class="note">Нет данных: ${r.missing.map(esc).join(', ')}.</div>` : '')
    + `<h2 style="margin-top:12px">По классам ликвидности</h2><div class="tbl"><table style="min-width:520px"><thead><tr><th>Класс (объём 24ч)</th><th>Монет</th><th>Издержки (медиана)</th><th>Ход до комиссий у значимых связей (медиана)</th><th>Со значимой связью</th><th>Кандидатов</th></tr></thead><tbody>${['топ', 'крупные', 'средние', 'малые', '—'].map(tierRow).join('')}</tbody></table></div>`
    + `<h2 style="margin-top:12px">Монеты</h2><div class="tbl"><table style="min-width:900px"><thead><tr><th>Монета</th><th>Класс</th><th>Объём 24ч</th><th>Спред</th><th>Издержки</th><th>Лучшая устойчивая связь</th><th>ρ (t)</th><th>Ход до комиссий</th><th>Чистый ход</th><th>Вывод</th></tr></thead><tbody>`
    + r.rows.map(x => { const b = x.best, cand = b && b.sig && b.netT > 2 && b.net > 0;
      return `<tr><td><b>${esc(x.sym)}</b></td><td>${esc(x.tier)}</td><td>${fmtV(x.vol24)}</td><td>${x.spread == null ? '—' : fmt(x.spread, 3) + '%'}</td><td>${fmt(x.cost, 3)}%</td><td style="text-align:left">${b ? esc(b.feature) + ' → ' + hz(b.H) : '—'}</td><td>${b ? (b.r > 0 ? '+' : '') + fmt(b.r, 3) + ' (t ' + fmt(b.t, 1) + ')' : '—'}</td><td>${b ? (b.sig ? fmt(b.gross, 3) + '%' : `<span class="mut">${fmt(b.gross, 3)}% (шум)</span>`) : '—'}</td><td>${b ? (b.sig ? p3(b.net) : `<span class="mut">${fmt(b.net, 3)}% (не значимо)</span>`) : '—'}</td><td>${cand ? '✅ кандидат' : b && b.sig ? 'связь есть, издержки не покрыты' : 'нет значимой связи'}</td></tr>`; }).join('')
    + `</tbody></table></div><div class="note">Серые значения без значимости — это максимум из десятков случайных ячеек, а не эффект: на чистом шуме он тоже положительный. «Лучшая устойчивая связь» — ячейка с наибольшим чистым ходом среди устойчивых (одинаковый знак в обеих половинах периода); значимой она считается только при |t| выше строгого порога. «Чистый ход» = ход до комиссий минус комиссия и спред; отрицательный — торговать нельзя. Данные — только действующие сейчас монеты (ошибка выжившего), период короткий, мелкие монеты на практике хуже, чем в тесте (проскальзывание, мало ликвидности).</div>`;
};

window.api.onState(render);
addEventListener('resize', () => { if (last) { draw(last.sol); drawCandles(last.sol); } });
