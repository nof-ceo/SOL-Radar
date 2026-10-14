// Хранилище на встроенном node:sqlite (Electron 35+ / Node 22.13+), без нативных зависимостей.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
exports.open = function (file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS bars(sym TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, tb REAL, PRIMARY KEY(sym, t)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS funding(t INTEGER PRIMARY KEY, rate REAL);
    CREATE TABLE IF NOT EXISTS oi(t INTEGER PRIMARY KEY, oi REAL, oiv REAL);
    CREATE TABLE IF NOT EXISTS token_snaps(ts INTEGER, addr TEXT, sym TEXT, price REAL, liq REAL, vol24 REAL, ch5 REAL, ch1 REAL, age REAL, risk INTEGER, pred REAL, conf INTEGER, sent REAL, ment INTEGER);
    CREATE INDEX IF NOT EXISTS ix_snap ON token_snaps(addr, ts);
    CREATE TABLE IF NOT EXISTS mood(ts INTEGER PRIMARY KEY, m REAL, sol REAL);`);
  // миграция со старой таблицы candles (там не было объёма покупателей — SOL нужно перезагрузить)
  if (db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='candles'").get()) {
    if (!db.prepare("SELECT 1 x FROM bars WHERE sym='SOL' LIMIT 1").get()) db.exec("INSERT INTO bars SELECT 'SOL',t,o,h,l,c,v,NULL FROM candles");
    db.exec('DROP TABLE candles');
  }
  const insB = db.prepare('INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)');
  const insF = db.prepare('INSERT OR REPLACE INTO funding VALUES (?,?)');
  const insO = db.prepare('INSERT OR REPLACE INTO oi VALUES (?,?,?)');
  const insT = db.prepare('INSERT INTO token_snaps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insM = db.prepare('INSERT OR REPLACE INTO mood VALUES (?,?,?)');
  const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  const n = x => (x == null || !Number.isFinite(+x) ? null : +x);
  const api = {
    addBars(sym, arr) { const now = Date.now(); tx(() => { for (const x of arr) if (x.t + 6e4 <= now) insB.run(sym, x.t, x.o, x.h, x.l, x.c, x.v ?? 0, n(x.tb)); }); },  // только закрытые свечи
    addCandles(arr) { api.addBars('SOL', arr); },
    bars(sym, from = 0) { return db.prepare('SELECT t,o,h,l,c,v,tb FROM bars WHERE sym=? AND t>=? ORDER BY t').all(sym, from); },
    candles(from = 0) { return api.bars('SOL', from); },
    barRange(sym) { const r = db.prepare('SELECT MIN(t) a, MAX(t) b, COUNT(*) n, SUM(tb IS NULL) nulls FROM bars WHERE sym=?').get(sym); return { ...r, nulls: r.nulls || 0 }; },
    tsRange(table) { if (!['funding', 'oi'].includes(table)) throw new Error('bad table'); return db.prepare(`SELECT MIN(t) a, MAX(t) b, COUNT(*) n FROM ${table}`).get(); },
    addFunding(arr) { tx(() => { for (const x of arr) insF.run(x.t, n(x.rate)); }); },
    addOI(arr) { tx(() => { for (const x of arr) insO.run(x.t, n(x.oi), n(x.oiv)); }); },
    funding() { return db.prepare('SELECT t, rate FROM funding ORDER BY t').all(); },
    oi() { return db.prepare('SELECT t, oi FROM oi ORDER BY t').all(); },
    logSnap(tokens, m, sol) {
      const ts = Date.now();
      tx(() => { for (const t of tokens) insT.run(ts, t.addr, t.sym ?? '', n(t.price), n(t.liq), n(t.vol24), n(t.ch5), n(t.ch1), n(t.age), n(t.risk), n(t.pred), n(t.conf), n(t.sent), n(t.ment)); insM.run(ts, n(m), n(sol)); });
    },
    tokenRows(since, limit) { return db.prepare('SELECT ts,addr,price,liq,pred,risk FROM token_snaps WHERE ts>=? ORDER BY addr, ts LIMIT ?').all(since, limit); },
    prune(days) { db.prepare('DELETE FROM token_snaps WHERE ts<?').run(Date.now() - days * 864e5); },
    stats() {
      const c = api.barRange('SOL'), s = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT addr) k FROM token_snaps').get();
      return { candles: { n: c.n, a: c.a, b: c.b, nulls: c.nulls }, btc: api.barRange('BTC').n, eth: api.barRange('ETH').n,
        funding: api.tsRange('funding').n, oi: api.tsRange('oi'), snaps: s.n, tokens: s.k, mb: fs.statSync(file).size / 1048576 };
    }
  };
  return api;
};
