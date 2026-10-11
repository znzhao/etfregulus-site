// Unit tests for app/core.js and app/i18n.js.   Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../app/core.js");

const SESSIONS = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-11-02", "2026-11-03", "2026-11-09", "2026-11-10"];

test("lock: first session on or after buy + 30 calendar days", () => {
  // 2026-10-01 + 30 = 2026-10-31 (Saturday) -> Monday 2026-11-02
  assert.equal(C.sellableFrom("2026-10-01", 30, SESSIONS), "2026-11-02");
  assert.equal(C.sellableFrom("2026-10-03", 30, SESSIONS), "2026-11-02");   // 11-02 exactly
  assert.equal(C.sellableFrom("2026-10-05", 30, SESSIONS), "2026-11-09");   // skips non-sessions in the list
  // beyond the calendar: next weekday
  assert.equal(C.sellableFrom("2026-12-05", 30, SESSIONS), "2027-01-04");   // 2027-01-04 is a Monday
});

test("next session after the data date", () => {
  assert.equal(C.nextSession("2026-10-09", SESSIONS), "2026-10-12");
  assert.equal(C.nextSession("2026-11-10", SESSIONS), "2026-11-11");
});

test("date validation", () => {
  assert.ok(C.isValidDate("2026-02-28"));
  assert.ok(!C.isValidDate("2026-02-30"));
  assert.ok(!C.isValidDate("2026/02/01"));
  assert.ok(!C.isValidDate(""));
  assert.ok(!C.isValidDate(undefined));
});

test("rolling drawdown matches a brute-force window max", () => {
  const eq = [1, 1.1, 1.05, 0.9, 1.2, 1.0, 0.95, 1.3, 1.1, 1.0];
  for (const w of [1, 2, 3, 5, 100]) {
    const dd = C.rollingDrawdown(eq, w);
    eq.forEach((v, i) => {
      const pk = Math.max(...eq.slice(Math.max(0, i - w + 1), i + 1));
      assert.ok(Math.abs(dd[i] - (1 - v / pk)) < 1e-12, `w=${w} i=${i}`);
    });
  }
  const all = C.rollingDrawdown(eq, 0);
  assert.ok(Math.abs(all[3] - (1 - 0.9 / 1.1)) < 1e-12);
  assert.ok(Math.abs(all[9] - (1 - 1.0 / 1.3)) < 1e-12);
});

test("metrics match the Python definition on a simple path", () => {
  const eq = [1, 1.1, 0.99, 1.089];
  const m = C.metrics(eq);
  assert.ok(Math.abs(m.mdd - 0.1) < 1e-12);
  assert.ok(Math.abs(m.total - 0.089) < 1e-12);
  assert.ok(Math.abs(m.up - 2 / 3) < 1e-12);
  assert.equal(C.metrics([1]), null);
});

test("rolling Sharpe has one value per session from the start index", () => {
  const eq = Array.from({ length: 300 }, (_, i) => 1 + 0.001 * i + 0.01 * Math.sin(i));
  const rs = C.rollingSharpe(eq, 252, 252);
  assert.equal(rs.length, 300 - 252);
  assert.ok(rs.every(Number.isFinite));
  assert.deepEqual(C.rollingSharpe(eq.slice(0, 100), 252, 0), []);
});

test("range start", () => {
  const dates = ["2025-12-30", "2025-12-31", "2026-01-02", "2026-01-05", "2026-09-30", "2026-10-09"];
  assert.equal(C.rangeStart(dates, "YTD"), 1);          // base is the last 2025 close
  assert.equal(C.rangeStart(dates, "ALL"), 0);
  assert.equal(C.rangeStart(dates, "1M"), 3);           // one session before 2026-09-08
  assert.equal(C.indexOnOrAfter(dates, "2026-01-03"), 3);
  assert.equal(C.indexOnOrAfter(dates, "2030-01-01"), 5);
});

test("shares are whole and never exceed the amount", () => {
  const r = C.sharesFor({ CASH: 0.1, SPY: 0.6, TLT: 0.3 }, 10000, { SPY: 655.2, TLT: 88.1 });
  assert.equal(r.shares.SPY, 9);
  assert.equal(r.shares.TLT, 34);
  assert.ok(r.cash >= 0);
  assert.ok(Math.abs(r.cash - (10000 - 9 * 655.2 - 34 * 88.1)) < 1e-9);
});

const PRICES = { SPY: 500, TLT: 100, GLD: 200, IEF: 95 };
const plan = (over) => C.realPlan(Object.assign({
  holdings: [], cash: 0, target: { CASH: 0.1, SPY: 0.6, TLT: 0.3 }, prices: PRICES,
  nextDay: "2026-10-12", lockDays: 30, sessions: SESSIONS }, over));

test("real plan from cash only buys the target", () => {
  const p = plan({ cash: 10000 });
  const by = Object.fromEntries(p.rows.map((r) => [r.t, r]));
  assert.equal(by.SPY.tsh, 12);
  assert.equal(by.TLT.tsh, 30);
  assert.equal(p.total, 10000);
  assert.ok(Math.abs(p.cashAfter - (10000 - 12 * 500 - 30 * 100)) < 1e-9);
});

test("real plan never sells a locked ETF and funds the rest with what is left", () => {
  // GLD bought 2026-09-25 -> sellable 2026-11-02, after the next session: locked.
  const p = plan({ cash: 2000, holdings: [{ t: "GLD", sh: 20, d: "2026-09-25" }, { t: "SPY", sh: 4, d: "2026-01-02" }] });
  const by = Object.fromEntries(p.rows.map((r) => [r.t, r]));
  assert.equal(by.GLD.locked, true);
  assert.equal(by.GLD.tsh, 20);             // kept, not sold to its 0% target
  assert.equal(by.GLD.trade, 0);
  assert.equal(by.SPY.locked, false);
  // total 2000 + 4000 + 2000 = 8000; free capital 4000 split 0.6/0.3/0.1 of the non-kept want
  assert.equal(p.total, 8000);
  assert.ok(p.cashAfter >= -1e-9);
  const invested = p.rows.reduce((a, r) => a + r.tsh * r.px, 0);
  assert.ok(invested <= p.total + 1e-9);
});

test("real plan sells an unlocked ETF that is off-target", () => {
  const p = plan({ holdings: [{ t: "GLD", sh: 10, d: "2026-01-02" }] });
  const g = p.rows.find((r) => r.t === "GLD");
  assert.equal(g.locked, false);
  assert.equal(g.tsh, 0);
  assert.equal(g.trade, -10);
});

test("real plan: a lock expiring exactly on the next session is free", () => {
  // bought 2026-09-12 -> +30 = 2026-10-12, the next session itself
  const p = plan({ holdings: [{ t: "GLD", sh: 10, d: "2026-09-12" }], nextDay: "2026-10-12" });
  assert.equal(p.rows.find((r) => r.t === "GLD").locked, false);
});

test("real plan merges duplicate rows and ignores junk", () => {
  const p = plan({ cash: "abc", holdings: [{ t: "SPY", sh: 2, d: "2026-10-01" }, { t: "SPY", sh: 3, d: "2026-09-01" }, { t: "ZZZ", sh: 5, d: "" }, { t: "TLT", sh: -4, d: "" }] });
  const spy = p.rows.find((r) => r.t === "SPY");
  assert.equal(spy.sh, 5);
  assert.equal(spy.lastBuy, "2026-10-01");     // the latest purchase sets the lock
  assert.equal(spy.locked, true);
  assert.ok(!p.rows.some((r) => r.t === "ZZZ"));
  assert.equal(p.total, 2500);
});

test("real plan with nothing is empty", () => {
  const p = plan({});
  assert.equal(p.total, 0);
  assert.ok(p.rows.every((r) => r.tsh === 0));
});

test("freshness", () => {
  const m = { status: "ok", next_run: "2026-10-12T22:30:00Z" };
  assert.equal(C.freshness(m, Date.parse("2026-10-12T23:00:00Z")), "ok");
  assert.equal(C.freshness(m, Date.parse("2026-10-13T07:00:00Z")), "overdue");
  assert.equal(C.freshness({ status: "failed", next_run: null }, 0), "failed");
  assert.equal(C.freshness({ status: "ok", next_run: null }, Date.now()), "ok");
});

test("settings are sanitized against the manifest", () => {
  const man = { strategies: [{ id: "momentum" }, { id: "cash" }], ceilings: [5, 10, 15] };
  const s = C.sanitizeSettings({ lang: "fr", plan: "gone", ceiling: "10", amount: -5, cash: "1e3",
    holdings: [{ t: "SPY", sh: "3", d: "2026-02-30" }, { t: "spy", sh: 1 }, null, "x"] }, man);
  assert.equal(s.lang, "zh");
  assert.equal(s.plan, "momentum");
  assert.equal(s.ceiling, 10);
  assert.equal(s.amount, C.DEFAULTS.amount);
  assert.equal(s.cash, 1000);
  assert.deepEqual(s.holdings, [{ t: "SPY", sh: 3, d: "" }]);
  assert.deepEqual(C.sanitizeSettings(null, man).plan, "momentum");
  assert.deepEqual(C.sanitizeSettings({ ceiling: 7 }, man).ceiling, 5);
});

test("every ETF has a short name in both languages", () => {
  global.window = global.window || {};
  require("../app/i18n.js");
  const { zh, en } = global.window.I18N;
  const tickers = ["SPY", "QQQ", "IWM", "XLK", "XLC", "XLY", "XLP", "XLE", "XLF", "XLI", "XLB", "XLV", "XLU", "XLRE",
                   "SHY", "IEF", "TLT", "TIP", "LQD", "HYG", "GLD", "DBC", "VEA", "VWO"];
  for (const tk of tickers) {
    assert.ok(zh.etf[tk] && zh.etf[tk].length <= 6, "zh " + tk);
    assert.ok(en.etf[tk] && en.etf[tk].length <= 14, "en " + tk);
  }
  assert.equal(Object.keys(zh.etf).length, tickers.length);
});

test("every i18n key exists in both languages with the same shape", () => {
  global.window = global.window || {};
  require("../app/i18n.js");
  const { zh, en } = global.window.I18N;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const k of Object.keys(zh)) {
    assert.equal(typeof zh[k], typeof en[k], k);
    if (Array.isArray(zh[k])) assert.equal(zh[k].length, en[k].length, k);
    if (zh[k] && typeof zh[k] === "object" && !Array.isArray(zh[k])) assert.deepEqual(Object.keys(zh[k]).sort(), Object.keys(en[k]).sort(), k);
  }
});

test("strategies sort by a metric, missing values last, ties in default order", () => {
  const v = { a: 0.1, b: null, c: 0.3, d: 0.1, e: -0.2 };
  const ids = ["a", "b", "c", "d", "e"];
  assert.deepEqual(C.sortIds(ids, (id) => v[id], "desc"), ["c", "a", "d", "e", "b"]);
  assert.deepEqual(C.sortIds(ids, (id) => v[id], "asc"), ["e", "a", "d", "c", "b"]);
  // drawdown is sorted as shown (negative): high-to-low = smallest drawdown first
  const dd = { x: -0.30, y: -0.05, z: 0 };
  assert.deepEqual(C.sortIds(["x", "y", "z"], (id) => dd[id], "desc"), ["z", "y", "x"]);
});

test("sort settings are sanitized", () => {
  const man = { strategies: [{ id: "momentum" }], ceilings: [5] };
  assert.equal(C.sanitizeSettings({ sortKey: "sharpe", sortDir: "asc" }, man).sortKey, "sharpe");
  assert.equal(C.sanitizeSettings({ sortKey: "sharpe", sortDir: "asc" }, man).sortDir, "asc");
  assert.equal(C.sanitizeSettings({ sortKey: "bogus", sortDir: "up" }, man).sortKey, "default");
  assert.equal(C.sanitizeSettings({ sortKey: "bogus", sortDir: "up" }, man).sortDir, "desc");
});
