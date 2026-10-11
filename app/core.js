/* ETFRegulus web app: pure logic (no DOM). Loaded by the page as window.Core and by the
   Node tests with require(). Everything here is deterministic and unit-tested. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 864e5;
  const TRADING_DAYS = 252;

  /* ---------------------------------------------------------------- dates */
  const toMs = (s) => Date.parse(s + "T00:00:00Z");
  const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(s, n) { return isoOf(toMs(s) + n * DAY); }
  function isValidDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toMs(s)) && isoOf(toMs(s)) === s; }

  /** First session on or after `date`, from an ascending list of ISO sessions. Beyond the
   *  list, the next weekday is a fallback (holidays then unknown). */
  function firstSessionOnOrAfter(date, sessions) {
    for (const s of sessions) if (s >= date) return s;
    let ms = toMs(date);
    while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY;
    return isoOf(ms);
  }

  /** Lock rule (config/constraints.yaml): an ETF bought on `buyDate` may be sold from the
   *  first session on or after buyDate + lockDays calendar days. */
  function sellableFrom(buyDate, lockDays, sessions) {
    return firstSessionOnOrAfter(addDays(buyDate, lockDays), sessions);
  }

  /** The next session after the data date: when the plan executes. */
  function nextSession(dataDate, sessions) {
    for (const s of sessions) if (s > dataDate) return s;
    return firstSessionOnOrAfter(addDays(dataDate, 1), []);
  }

  /* ---------------------------------------------------------------- series */
  function dailyReturns(eq) {
    const r = new Array(eq.length).fill(0);
    for (let i = 1; i < eq.length; i++) r[i] = eq[i] / eq[i - 1] - 1;
    return r;
  }

  /** Drawdown from the highest value of the last `window` points (current included);
   *  window <= 0 means the all-time peak. O(n) with a monotone deque. */
  function rollingDrawdown(eq, window) {
    const out = new Array(eq.length);
    const dq = [];
    let head = 0, pk = -Infinity;
    for (let i = 0; i < eq.length; i++) {
      if (window > 0) {
        while (head < dq.length && dq[head] <= i - window) head++;
        while (dq.length > head && eq[dq[dq.length - 1]] <= eq[i]) dq.pop();
        dq.push(i);
        out[i] = 1 - eq[i] / eq[dq[head]];
      } else {
        pk = Math.max(pk, eq[i]);
        out[i] = 1 - eq[i] / pk;
      }
    }
    return out;
  }

  /** Metrics over eq[a..b], matching src/publish/build.py `metrics`. */
  function metrics(eq, a = 0, b = eq.length - 1) {
    const n = b - a;
    if (n < 1) return null;
    let s = 0, s2 = 0, pos = 0, best = -Infinity, worst = Infinity, pk = eq[a], mdd = 0;
    for (let i = a + 1; i <= b; i++) {
      const x = eq[i] / eq[i - 1] - 1;
      s += x; s2 += x * x; if (x > 0) pos++;
      if (x > best) best = x; if (x < worst) worst = x;
    }
    for (let i = a; i <= b; i++) { if (eq[i] > pk) pk = eq[i]; mdd = Math.max(mdd, 1 - eq[i] / pk); }
    const mean = s / n, sd = Math.sqrt(Math.max(s2 / n - mean * mean, 0));
    const years = n / TRADING_DAYS;
    const total = eq[b] / eq[a] - 1;
    const cagr = Math.pow(eq[b] / eq[a], 1 / years) - 1;
    return { total, cagr, vol: sd * Math.sqrt(TRADING_DAYS), sharpe: sd > 0 ? mean / sd * Math.sqrt(TRADING_DAYS) : 0,
             mdd, calmar: mdd > 0 ? cagr / mdd : 0, best, worst, up: pos / n };
  }

  /** Rolling Sharpe over `w` daily returns, from index `from` (>= w). */
  function rollingSharpe(eq, w, from) {
    const r = dailyReturns(eq), out = [];
    if (eq.length <= w) return out;
    const start = Math.max(from, w);
    let s1 = 0, s2 = 0;
    for (let i = start - w + 1; i <= start; i++) { s1 += r[i]; s2 += r[i] * r[i]; }
    for (let i = start; i < eq.length; i++) {
      if (i > start) { s1 += r[i] - r[i - w]; s2 += r[i] * r[i] - r[i - w] * r[i - w]; }
      const mu = s1 / w, sd = Math.sqrt(Math.max(s2 / w - mu * mu, 0));
      out.push(sd > 0 ? mu / sd * Math.sqrt(TRADING_DAYS) : 0);
    }
    return out;
  }

  /** Index of the first date >= d (dates ascending), clamped to the array. */
  function indexOnOrAfter(dates, d) {
    let lo = 0, hi = dates.length - 1;
    if (d <= dates[0]) return 0;
    if (d > dates[hi]) return hi;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Start index of a named range ending at the last date. */
  function rangeStart(dates, key) {
    const last = dates[dates.length - 1];
    const back = { "1M": 31, "3M": 92, "6M": 183, "1Y": 365, "3Y": 1096, "5Y": 1826, "10Y": 3653 }[key];
    if (key === "YTD") {
      const i = indexOnOrAfter(dates, last.slice(0, 4) + "-01-01");
      return Math.max(0, i - 1);             // the prior close is the base
    }
    if (back) return Math.max(0, indexOnOrAfter(dates, addDays(last, -back)) - 1);
    return 0;
  }

  /* ---------------------------------------------------------------- plans */
  /** Shares for a weight plan, rounded down, priced at the last close. */
  function sharesFor(weights, amount, prices) {
    const out = {};
    let invested = 0;
    for (const [t, w] of Object.entries(weights)) {
      if (t === "CASH" || !(prices[t] > 0)) continue;
      const sh = Math.floor(amount * w / prices[t] + 1e-9);
      out[t] = sh; invested += sh * prices[t];
    }
    return { shares: out, cash: amount - invested };
  }

  /**
   * Real-holdings rebalance: move the user's book toward the strategy's target weights,
   * never selling a locked ETF (WEBAPP_PLAN.md Step 6, lock part).
   *   holdings: [{t, sh, d}] (shares; d = date of the last purchase, ISO)
   *   cash: investable cash; target: {ticker: weight} incl. CASH; prices: {ticker: close}
   *   nextDay: the session the trades execute on; lockDays; sessions: ISO calendar.
   * A locked ETF holding more than its target keeps its shares; the remaining capital is
   * spread over the other targets in proportion. Shares are whole; leftover stays cash.
   */
  function realPlan({ holdings, cash, target, prices, nextDay, lockDays, sessions }) {
    const rows = {};
    for (const h of holdings) {
      if (!(prices[h.t] > 0)) continue;
      const r = rows[h.t] || (rows[h.t] = { t: h.t, sh: 0, lastBuy: null });
      r.sh += Math.max(0, Number(h.sh) || 0);
      if (isValidDate(h.d) && (!r.lastBuy || h.d > r.lastBuy)) r.lastBuy = h.d;
    }
    for (const t of Object.keys(target)) if (t !== "CASH" && prices[t] > 0 && !rows[t]) rows[t] = { t, sh: 0, lastBuy: null };
    const list = Object.values(rows);
    const total = Math.max(0, Number(cash) || 0) + list.reduce((a, r) => a + r.sh * prices[r.t], 0);
    for (const r of list) {
      r.px = prices[r.t]; r.val = r.sh * r.px; r.want = (target[r.t] || 0) * total;
      r.sellable = r.lastBuy ? sellableFrom(r.lastBuy, lockDays, sessions) : null;
      r.locked = r.sh > 0 && !!r.sellable && r.sellable > nextDay;
      r.kept = r.locked && r.val > r.want;
    }
    const keptVal = list.filter((r) => r.kept).reduce((a, r) => a + r.val, 0);
    const keptWant = list.filter((r) => r.kept).reduce((a, r) => a + r.want, 0);
    const freeWant = total - keptWant;
    const scale = freeWant > 1e-9 ? Math.max(0, (total - keptVal) / freeWant) : 0;
    let invested = 0;
    for (const r of list) {
      r.tsh = r.kept ? r.sh : Math.floor(r.want * scale / r.px + 1e-9);
      if (r.locked && r.tsh < r.sh) r.tsh = r.sh;            // never sell into a lock
      r.trade = r.tsh - r.sh;
      invested += r.tsh * r.px;
    }
    list.sort((a, b) => b.tsh * b.px - a.tsh * a.px || a.t.localeCompare(b.t));
    return { rows: list.filter((r) => r.sh > 0 || r.tsh > 0), total, cashAfter: total - invested };
  }

  /* ---------------------------------------------------------------- freshness */
  /** "ok" | "failed" | "overdue": overdue once the next scheduled run is `graceHours` late. */
  function freshness(manifest, nowMs, graceHours = 8) {
    if (manifest.status === "failed") return "failed";
    if (manifest.next_run) {
      const due = Date.parse(manifest.next_run);
      if (!isNaN(due) && nowMs > due + graceHours * 3600e3) return "overdue";
    }
    return "ok";
  }

  /* ---------------------------------------------------------------- settings */
  const DEFAULTS = {
    lang: "zh", theme: "system", updown: "red-up", plan: "spy_tlt_60_40", ceiling: 5, mode: "sim",
    amount: 10000, cash: 0, holdings: [], sortKey: "default", sortDir: "desc"
  };

  /** Strategy sort keys offered on the Strategies page. */
  const SORT_KEYS = ["default", "ytd", "d1", "m1", "y1", "sharpe", "cagr", "maxdd"];

  /**
   * Order strategy ids by a metric. `valueOf(id)` returns the number shown on screen (drawdown
   * as a negative number, so "high to low" puts the smallest drawdown first). Missing values
   * go last in either direction; ties keep the default order.
   */
  function sortIds(ids, valueOf, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return ids.map((id, i) => ({ id, i, v: valueOf(id) }))
      .sort((a, b) => {
        const av = a.v == null || !isFinite(a.v), bv = b.v == null || !isFinite(b.v);
        if (av || bv) return av === bv ? a.i - b.i : av ? 1 : -1;
        return a.v === b.v ? a.i - b.i : sign * (a.v - b.v);
      })
      .map((x) => x.id);
  }

  /** Clean any stored/imported settings against what the manifest offers. */
  function sanitizeSettings(raw, manifest) {
    const s = Object.assign({}, DEFAULTS);
    const x = raw && typeof raw === "object" ? raw : {};
    if (["zh", "en"].includes(x.lang)) s.lang = x.lang;
    if (["system", "light", "dark"].includes(x.theme)) s.theme = x.theme;
    if (["red-up", "green-up"].includes(x.updown)) s.updown = x.updown;
    if (["sim", "real"].includes(x.mode)) s.mode = x.mode;
    const ids = manifest ? manifest.strategies.map((t) => t.id) : null;
    if (typeof x.plan === "string" && (!ids || ids.includes(x.plan))) s.plan = x.plan;
    else if (ids && !ids.includes(s.plan)) s.plan = ids[0];
    const ceil = Number(x.ceiling);
    const ceilings = manifest ? manifest.ceilings : [5, 10, 15];
    s.ceiling = ceilings.includes(ceil) ? ceil : (ceilings.includes(s.ceiling) ? s.ceiling : ceilings[0]);
    const num = (v, d) => { const n = Number(v); return isFinite(n) && n >= 0 ? Math.min(n, 1e12) : d; };
    s.amount = num(x.amount, s.amount);
    s.cash = num(x.cash, s.cash);
    s.holdings = Array.isArray(x.holdings) ? x.holdings
      .filter((h) => h && typeof h.t === "string" && /^[A-Z]{1,5}$/.test(h.t))
      .map((h) => ({ t: h.t, sh: num(h.sh, 0), d: isValidDate(h.d) ? h.d : "" }))
      .slice(0, 50) : [];
    if (SORT_KEYS.includes(x.sortKey)) s.sortKey = x.sortKey;
    if (["asc", "desc"].includes(x.sortDir)) s.sortDir = x.sortDir;
    return s;
  }

  return { DAY, toMs, isoOf, addDays, isValidDate, firstSessionOnOrAfter, sellableFrom, nextSession,
           dailyReturns, rollingDrawdown, metrics, rollingSharpe, indexOnOrAfter, rangeStart,
           sharesFor, realPlan, freshness, DEFAULTS, SORT_KEYS, sortIds, sanitizeSettings };
});
