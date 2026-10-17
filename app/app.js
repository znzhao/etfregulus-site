/* ETFRegulus web app: pages, charts and settings. Pure logic lives in core.js. */
(function () {
  "use strict";
  const C = window.Core, TXT = window.I18N;
  const STORE_KEY = "etfregulus.settings.v1";
  const app = document.getElementById("app");

  /* ------------------------------------------------------------------ state */
  let S = C.sanitizeSettings(readStore(), null);
  const D = { manifest: null, universe: null, today: null, live: null, bt: {}, assets: {}, sessions: [] };
  const view = { tab: "equity", range: "ALL", bench: "", calYear: null, cmp: null, cmpRange: "5Y", rebShow: 12, liveShow: 20, cmpSort: { key: null, dir: "desc" } };
  let charts = [], renderToken = 0;

  function readStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* private mode: settings last for this visit */ } }

  /* ------------------------------------------------------------------ text and numbers */
  function t(k, vars) {
    let s = (TXT[S.lang] || TXT.zh)[k];
    if (s === undefined) s = TXT.zh[k] !== undefined ? TXT.zh[k] : k;
    if (vars && typeof s === "string") for (const [a, b] of Object.entries(vars)) s = s.split("{" + a + "}").join(b);
    return s;
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const locale = () => (S.lang === "zh" ? "zh-CN" : "en-US");
  function pct(x, d = 1, sign = false) {
    if (x == null || !isFinite(x)) return "—";
    const v = (100 * x).toFixed(d);
    return (sign && x > 0 ? "+" : "") + (v === "-0.0" || v === "-0.00" ? v.slice(1) : v) + "%";
  }
  const pp = (x) => (x == null ? "—" : (100 * x).toFixed(1) + "%");
  function money(x) {
    if (!isFinite(x)) return "—";
    return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(x);
  }
  const fmtNum = (x, d = 2) => (isFinite(x) ? Number(x).toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  // Timestamps are shown in US Eastern time (the market's clock), e.g. "2026-10-15 18:30 EDT".
  const fmtET = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "—";
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  };
  const intFmt = (x) => Number(x).toLocaleString(locale());
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const md = (d) => (d ? d.slice(5) : "");
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  /* ------------------------------------------------------------------ data */
  async function getJSON(path) {
    const r = await fetch("data/" + path, { cache: "no-cache" });
    if (!r.ok) throw new Error(path + " (" + r.status + ")");
    return r.json();
  }
  async function loadCore() {
    const m = await getJSON("manifest.json");
    if (m.schema_version !== 1) throw new Error("unsupported data version " + m.schema_version);
    const [u, td] = await Promise.all([getJSON(m.files.universe), getJSON(m.files.today)]);
    D.live = await getJSON(m.files.live).catch(() => null);
    D.manifest = m; D.universe = u; D.today = td; D.bt = {};
    D.assets = {};
    for (const a of u.assets) D.assets[a.ticker] = a;
    D.sessions = u.calendar.sessions;
    S = C.sanitizeSettings(S, m);
    if (!view.cmp) view.cmp = m.strategies.map((s) => s.id).filter((id) => id !== "cash").slice(0, 3);
  }
  function backtest(pid) {
    if (!D.bt[pid]) {
      const file = D.manifest.files.backtest[pid];
      D.bt[pid] = (file ? getJSON(file) : Promise.reject(new Error("no backtest " + pid))).then((b) => {
        b.ret = C.dailyReturns(b.equity);
        b.dd12 = C.rollingDrawdown(b.equity, 252);
        return b;
      });
      D.bt[pid].catch(() => { delete D.bt[pid]; });
    }
    return D.bt[pid];
  }
  const strat = (id) => D.manifest.strategies.find((s) => s.id === id);
  const sname = (id) => { const s = strat(id); return s ? s.name[S.lang] : id; };
  const pidOf = (id, c = S.ceiling, k = S.maxEtf) => id + "_D" + c + (k ? "_K" + k : "");
  const entry = (id, c) => D.today.portfolios[pidOf(id, c)];
  const price = (tk) => (D.assets[tk] ? D.assets[tk].close : NaN);
  /* Every ETF is shown with a short name next to its ticker (falls back to the data's name). */
  const aname = (tk) => { const m = t("etf"); return (m && m[tk]) || (D.assets[tk] ? D.assets[tk].name[S.lang] : tk); };
  const labelText = (tk) => (tk === "CASH" ? t("cash") : tk + " " + aname(tk));
  const label = (tk) => (tk === "CASH" ? esc(t("cash")) : `${esc(tk)} <span class="sn">${esc(aname(tk))}</span>`);
  const nextDay = () => C.nextSession(D.manifest.data_date, D.sessions);
  /* Line icons drawn as SVG: arrow/star characters are shown as colour emoji on some phones. */
  const ICON_PATH = {
    up: '<path d="M2 7.5 5 4.5 8 7.5"/>',
    down: '<path d="M2 4.5 5 7.5 8 4.5"/>',
    both: '<path d="M2.5 4.8 5 2.3 7.5 4.8"/><path d="M2.5 7.2 5 9.7 7.5 7.2"/>',
  };
  const icon = (k) => k === "star"
    ? '<svg class="ic" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1.2l1.45 2.95 3.25.47-2.35 2.3.55 3.24L6 8.63 3.1 10.16l.55-3.24L1.3 4.62l3.25-.47z" fill="currentColor"/></svg>'
    : `<svg class="ic" viewBox="0 0 10 12" width="10" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATH[k]}</svg>`;

  /* Colours. Strategies: seven well-separated, muted hues that avoid the gain/loss red and green;
     a lighter set for dark mode. ETFs: one family per asset class (US equity blues, sectors in
     teal/sage/sand/plum, Treasuries in warm ambers, credit in greys, gold/commodities in ochre,
     international in rose), fixed per ticker so a colour means the same ETF everywhere. */
  const STRAT_COL = {
    light: { rl: "#3d3a8c", spy_tlt_60_40: "#3f6cb5", momentum: "#e0882b", classical_optimizer: "#2b9a8c", equal_weight: "#8a64c4", spy_buy_hold: "#c4597a", cash: "#8c96a3" },
    dark: { rl: "#a9a5f2", spy_tlt_60_40: "#7aa3e6", momentum: "#f0a75a", classical_optimizer: "#4fc4b2", equal_weight: "#b294e8", spy_buy_hold: "#e88aa6", cash: "#8b97a6" },
  };
  const ASSET_COL = {
    SPY: "#3f6cb5", QQQ: "#6a93d6", IWM: "#9dbbe8",
    XLK: "#2b9a8c", XLC: "#5fb8aa", XLY: "#8fcfc4", XLP: "#7f9f6b", XLE: "#a7c08f", XLF: "#c9a97a",
    XLI: "#ddc59f", XLB: "#9b7aa8", XLV: "#bf9fcb", XLU: "#7c8fa8", XLRE: "#a9b7c9",
    SHY: "#f2c48c", IEF: "#e9a35e", TLT: "#d27f3a", TIP: "#b8682f",
    LQD: "#8d8f99", HYG: "#b7b9c2",
    GLD: "#d4b04a", DBC: "#a3884a",
    VEA: "#d9849b", VWO: "#b85d78",
  };
  const scolor = (id) => (isDark() ? STRAT_COL.dark : STRAT_COL.light)[id] || (strat(id) || {}).color || "#888888";
  function assetColor(tk) {
    if (tk === "CASH") return isDark() ? "#4a5664" : "#cfd6de";
    return ASSET_COL[tk] || "#9aa3ad";
  }
  const isDark = () => S.theme === "dark" || (S.theme === "system" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);

  /* ------------------------------------------------------------------ small components */
  function seg(kind, key, opts, cur, extra) {
    return `<span class="seg${extra ? " " + extra : ""}" role="group">${opts.map(([v, l]) =>
      `<button type="button" data-${kind}="${esc(key)}" data-v="${esc(v)}" aria-pressed="${String(cur) === String(v)}">${esc(l)}</button>`).join("")}</span>`;
  }
  const ceilingSeg = () => seg("set", "ceiling", D.manifest.ceilings.map((c) => [c, c + "%"]), S.ceiling);
  /* Label / control rows on a two-column grid, so labels and controls line up on a phone. */
  const ctl = (rows) => `<div class="ctl">${rows.map(([l, html]) => `<span class="lbl">${l}</span><div class="ctl-v">${html}</div>`).join("")}</div>`;
  const ceilingRow = () => [t("ceiling"), ceilingSeg()];
  /* The holdings limit ("at most n ETFs"): shown only when the data offers more than one. */
  const maxEtfSeg = () => seg("set", "maxEtf", (D.manifest.holdings || [0]).map((k) => [k, k ? k + t("maxEtfUnit") : t("maxEtfAll")]), S.maxEtf);
  const maxEtfRows = () => ((D.manifest.holdings || [0]).length > 1 ? [[t("maxEtf"), maxEtfSeg()]] : []);
  function spark(values, w = 120, h = 36) {
    if (!values || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), sx = w / (values.length - 1);
    const y = (v) => (h - 3 - ((v - lo) / ((hi - lo) || 1)) * (h - 6)).toFixed(1);
    const d = values.map((v, k) => (k ? "L" : "M") + (k * sx).toFixed(1) + " " + y(v)).join("");
    const col = values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)";
    return `<svg class="spark" width="${w}" height="${h}" viewBox="-3 0 ${w + 6} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${w}" cy="${y(values[values.length - 1])}" r="2.6" fill="${col}"/></svg>`;
  }
  function freshBadge() {
    const f = C.freshness(D.manifest, Date.now());
    return f === "ok" ? `<span class="badge ok">${t("dataAsOf")} ${esc(D.manifest.data_date)}</span>`
      : `<span class="badge bad">${t(f)} · ${esc(D.manifest.data_date)}</span>`;
  }
  function staleBanner() {
    const f = C.freshness(D.manifest, Date.now());
    if (f === "ok") return "";
    return `<div class="alert"><b>${t(f)}.</b> ${esc(t(f + "Msg", { d: D.manifest.data_date }))}</div>`;
  }
  const loadingCard = () => `<div class="center muted">${t("loading")}</div>`;
  const errorCard = (e) => `<div class="center"><h2>${t("loadError")}</h2><p class="muted">${t("loadErrorHint")}</p>
    <p class="muted small num">${esc(e && e.message ? e.message : e)}</p><button class="btn primary" type="button" data-act="retry">${t("retry")}</button></div>`;
  const riskChip = (e) => `<span class="badge ${e.risk_state === "normal" ? "" : "bad"}" title="${esc(t("riskHelp_" + e.risk_state))}">${t("risk_" + e.risk_state)}</span>`;
  function lockBadge(e, tk) {
    const d = e.locks[tk];
    return d ? `<span class="badge acc" title="${esc(t("locked"))}">${esc(t("sellableFrom", { d: md(d) }))}</span>` : "";
  }

  /* ------------------------------------------------------------------ charts */
  function disposeCharts() { charts.forEach((c) => { try { c.dispose(); } catch (e) { /* already gone */ } }); charts = []; }
  function mk(id, opt) {
    const el = document.getElementById(id);
    if (!el || !window.echarts) return null;
    const c = echarts.init(el, null, { renderer: "canvas" });
    const fg = css("--fg"), mu = css("--muted"), ln = css("--line");
    const axisX = { axisLine: { lineStyle: { color: ln } }, axisTick: { show: false }, axisLabel: { color: mu, hideOverlap: true }, splitLine: { show: false } };
    const axisY = { axisLine: { show: false }, axisLabel: { color: mu }, splitLine: { lineStyle: { color: ln, opacity: 0.7 } } };
    const base = {
      animation: false, textStyle: { fontFamily: css("--f-body"), color: fg },
      grid: { left: 10, right: 26, top: 28, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", confine: true, backgroundColor: css("--surface"), borderColor: ln, textStyle: { color: fg, fontSize: 12 } },
      legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: mu }, itemWidth: 14, itemHeight: 8, pageIconColor: mu, pageTextStyle: { color: mu } },
    };
    const baseTip = base.tooltip;
    const o = Object.assign(base, opt);
    // Merge, do not replace: a chart's own tooltip settings (e.g. a value formatter) must keep
    // the axis trigger, or the tooltip only appears on the (hidden) data points.
    if (opt.tooltip) o.tooltip = Object.assign({}, baseTip, opt.tooltip);
    // Crosshair: hovering (desktop) or pressing (phone) draws dashed lines to both axes, with the
    // date and the value at the pointer labelled on the axes; the tooltip lists every series.
    const ptrLabel = { backgroundColor: css("--accent"), color: css("--accent-fg"), padding: [3, 6], borderRadius: 4, fontSize: 11 };
    const ptrLine = { color: mu, type: "dashed", width: 1 };
    if (opt.xAxis && o.tooltip.trigger === "axis") {
      o.tooltip.axisPointer = { type: "cross", crossStyle: ptrLine, lineStyle: ptrLine, label: ptrLabel };
      o.tooltip.triggerOn = "mousemove|click";
    }
    if (opt.xAxis) o.xAxis = [].concat(opt.xAxis).map((x) => {
      const ax = Object.assign({}, axisX, x);
      const d = x.data;
      if (d && d.length && typeof d[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d[0])) {
        const long = d.length > 70;          // months for long ranges, month-day for short ones
        ax.axisLabel = Object.assign({}, axisX.axisLabel, { formatter: (v) => (long ? v.slice(0, 7) : v.slice(5)) });
        ax.axisPointer = { label: Object.assign({}, ptrLabel, { formatter: (p) => p.value }) };   // the full date
      }
      return ax;
    });
    if (opt.yAxis) o.yAxis = [].concat(opt.yAxis).map((y) => {
      const ay = Object.assign({}, axisY, y);
      const f = y.axisLabel && y.axisLabel.formatter;
      ay.axisPointer = { label: Object.assign({}, ptrLabel, { formatter: (p) => {
        const v = Number(p.value), r = Math.abs(v) >= 1000 ? Math.round(v) : +v.toFixed(2);
        return typeof f === "function" ? f(r) : r.toLocaleString(locale());
      } }) };
      return ay;
    });
    c.setOption(o);
    charts.push(c);
    return c;
  }
  const coarse = () => !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  let resizeTimer = null;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => charts.forEach((c) => c.resize()), 120); });
  const line = (name, data, color, extra) => Object.assign({ name, type: "line", data, showSymbol: false, lineStyle: { width: 1.5, color }, itemStyle: { color }, emphasis: { disabled: true } }, extra || {});

  /* ------------------------------------------------------------------ routing and shell */
  const PAGES = ["today", "strategies", "compare", "settings", "about"];
  const ICONS = {
    today: '<path d="M5 7h14M5 12h9M5 17h6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    strategies: '<path d="M4 18l5-6 4 3 7-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    compare: '<path d="M7 4v16M17 4v16M3 9h8M13 15h8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    settings: '<circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    about: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  function route() {
    const h = (location.hash || "").replace(/^#/, "");
    if (h.startsWith("s-") && D.manifest && strat(h.slice(2))) return { page: "detail", id: h.slice(2) };
    return { page: PAGES.includes(h) ? h : "today" };
  }
  function applyTheme() {
    const r = document.documentElement;
    if (S.theme === "system") delete r.dataset.theme; else r.dataset.theme = S.theme;
    r.dataset.updown = S.updown;
    r.lang = S.lang === "zh" ? "zh-CN" : "en";
  }
  function shell(page) {
    const base = page === "detail" ? "strategies" : page;
    const cur = (k) => (k === base ? ' aria-current="page"' : "");
    document.getElementById("tabs").innerHTML = PAGES.map((k) => `<a href="#${k}"${cur(k)}>${t(k)}</a>`).join("");
    document.getElementById("btabs").innerHTML = PAGES.map((k) =>
      `<a href="#${k}"${cur(k)}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${t(k)}</a>`).join("");
    document.getElementById("topmeta").innerHTML = D.manifest ? freshBadge() : "";
    document.title = "ETFRegulus · " + t(base);
  }

  async function render() {
    const token = ++renderToken;
    disposeCharts();
    applyTheme();
    const r = route();
    shell(r.page);
    if (!D.manifest) return;
    try {
      if (r.page === "detail") {
        app.innerHTML = loadingCard();
        const b = await backtest(pidOf(r.id));
        const bb = view.bench && view.bench !== r.id ? await backtest(pidOf(view.bench)).catch(() => null) : null;
        if (token !== renderToken) return;
        app.innerHTML = pageDetail(r.id, b, bb);
        drawDetail(r.id, b, bb);
      } else if (r.page === "compare") {
        app.innerHTML = loadingCard();
        const bts = await Promise.all(view.cmp.map((id) => backtest(pidOf(id))));
        if (token !== renderToken) return;
        app.innerHTML = pageCompare(bts);
        drawCompare(bts);
      } else if (r.page === "strategies") app.innerHTML = pageStrategies();
      else if (r.page === "settings") app.innerHTML = pageSettings();
      else if (r.page === "about") app.innerHTML = pageAbout();
      else {
        if (useRL()) {
          app.innerHTML = loadingCard();
          await loadRL();
          if (token !== renderToken) return;
        }
        app.innerHTML = pageToday(); drawToday();
      }
    } catch (e) {
      if (token === renderToken) app.innerHTML = errorCard(e);
      console.error(e);
    }
  }

  /* ------------------------------------------------------------------ Today */
  function planHead(e) {
    const opts = D.manifest.strategies.map((s) => `<option value="${esc(s.id)}"${s.id === S.plan ? " selected" : ""}>${esc(s.name[S.lang])}</option>`).join("");
    return `<div class="card">
      ${ctl([[t("myPlan"), `<select class="plan-sel" data-set="plan" aria-label="${esc(t("planStrategy"))}">${opts}</select>`],
        ceilingRow(), ...maxEtfRows(),
        [t("holdingsMode"), seg("set", "mode", [["sim", t("modeSim")], ["real", t("modeReal")]], S.mode)],
        ...(useRL() ? [] : [[t("riskStateLbl"), riskChip(e)]])])}
    </div>`;
  }
  function statsRow(e, valueLabel, value) {
    const c = S.ceiling / 100, dd = e.drawdown;
    const scale = c * 1.5, w = Math.min(100, (dd / scale) * 100), lim = (c / scale) * 100;
    return `<div class="stats">
      <div class="stat"><span class="label">${valueLabel}</span><span class="v">${money(value)}</span></div>
      <div class="stat"><span class="label">${t("d1")}</span><span class="v ${cls(e.returns.d1)}">${pct(e.returns.d1, 2, true)}</span></div>
      <div class="stat"><span class="label">${t("ytd")}</span><span class="v ${cls(e.returns.ytd)}">${pct(e.returns.ytd, 1, true)}</span></div>
      <div class="stat" title="${esc(t("ddNote"))}"><span class="label">${t("drawdown")}</span><span class="v">${pct(dd > 0 ? -dd : 0, 1)}</span>
        <div class="gauge" aria-hidden="true"><i class="${dd > c ? "over" : ""}" style="width:${w.toFixed(1)}%"></i><span class="lim" style="left:${lim.toFixed(1)}%"></span></div>
        <span class="muted small">${t("ddNote")} · ${t("ceiling")} ${S.ceiling}%</span></div>
    </div>`;
  }
  function pageToday() {
    const e = entry(S.plan);
    if (!e) return errorCard(new Error("missing " + pidOf(S.plan)));
    return staleBanner() + planHead(e) + (S.mode === "real" ? todayReal(e) : todaySim(e));
  }
  function todaySim(e) {
    const amt = S.amount, nd = nextDay();
    const sh = (w, tk) => Math.floor((amt * w) / price(tk) + 1e-9);
    const trades = e.next_trades.map((c) => {
      const d = sh(c.to, c.ticker) - sh(c.from, c.ticker), side = c.to > c.from ? "buy" : "sell";
      return `<div class="trade"><span class="side ${side}">${t(side)}</span><span class="num">${esc(c.ticker)}</span>
        <span class="muted small" style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(aname(c.ticker))} · ${pp(c.from)} → ${pp(c.to)}</span>
        ${d ? `<span class="num">${(d > 0 ? "+" : "") + intFmt(d)} ${t("sharesUnit")}</span>` : `<span class="muted small">${t("lt1Share")}</span>`}</div>`;
    }).join("");
    const plan = C.sharesFor(e.weights, amt, Object.fromEntries(Object.keys(e.weights).map((k) => [k, price(k)])));
    const rows = Object.entries(e.weights).filter(([k]) => k !== "CASH").sort((a, b) => b[1] - a[1]);
    const holds = rows.map(([tk, w]) => `<div class="hold"><span class="tk">${esc(tk)}</span>
        <div style="display:grid;gap:4px;min-width:0"><span class="nm">${esc(aname(tk))} · <span class="num">${intFmt(plan.shares[tk] || 0)}</span> ${t("sharesUnit")}</span>
        <div class="bar"><i style="width:${(w * 100).toFixed(1)}%;background:${assetColor(tk)}"></i></div></div>
        <div class="rt"><span class="num">${pp(w)}</span>${lockBadge(e, tk)}</div></div>`).join("");
    const cashW = e.weights.CASH || 0;
    const lr = e.last_rebalance;
    return statsRow(e, t("amount"), amt) + `
      <div class="card"><div class="card-head"><h2>${t("nextTrades")}</h2><span class="muted small">${esc(t("executesOn", { d: nd }))}</span></div>
        ${trades ? `<div>${trades}</div><p class="muted small">${t("relock")}</p>` : `<p class="muted">${t("noTrades")}</p>`}</div>
      <div class="card"><div class="card-head"><h2>${t("targetHoldings")}</h2><span class="muted small">${esc(t("estimatedAt", { d: D.manifest.data_date }))}</span></div>
        <div class="hero"><div id="c-donut" class="chart sm"></div><div>${holds}
          <div class="hold"><span class="tk">${t("cash")}</span><div style="display:grid;gap:4px;min-width:0"><span class="nm num">${money(plan.cash)}</span>
          <div class="bar"><i style="width:${(cashW * 100).toFixed(1)}%;background:var(--muted)"></i></div></div><div class="rt"><span class="num">${pp(cashW)}</span></div></div>
        </div></div></div>
      <div class="card"><div class="card-head"><h3>${t("lastRebalance")}</h3><span class="muted small num">${lr ? esc(lr.date) : t("never")}</span></div>
        ${lr ? `<div class="row">${lr.changes.map((c) => `<span class="chip"><span class="${c.to > c.from ? "up" : "down"}">${c.to > c.from ? t("buy") : t("sell")}</span> ${label(c.ticker)} ${pp(c.from)}→${pp(c.to)}</span>`).join("")}</div>` : ""}</div>`;
  }
  function drawToday() {
    const e = entry(S.plan);
    if (!e || S.mode !== "sim") return;
    const data = Object.entries(e.weights).sort((a, b) => b[1] - a[1]).map(([k, w]) =>
      ({ name: labelText(k), value: +(w * 100).toFixed(1), itemStyle: { color: assetColor(k) } }));
    const n = Object.keys(e.weights).filter((k) => k !== "CASH").length;
    mk("c-donut", { tooltip: { trigger: "item", confine: true, formatter: "{b}: {c}%" }, legend: { show: false },
      title: { text: String(n), subtext: t("etfCount"), left: "center", top: "39%", itemGap: 2,
        textStyle: { color: css("--fg"), fontSize: 26, fontFamily: css("--f-mono"), fontWeight: 500 }, subtextStyle: { color: css("--muted"), fontSize: 12 } },
      series: [{ type: "pie", radius: ["58%", "86%"], avoidLabelOverlap: true, label: { show: false }, padAngle: 1.5,
        itemStyle: { borderColor: css("--surface"), borderWidth: 2, borderRadius: 4 }, emphasis: { scale: true, scaleSize: 4 }, data }] });
  }
  /* The RL model decides on the user's own book (app/rl.js) instead of copying its
     simulated target: real-holdings mode with the RL strategy, when the data carries it. */
  const useRL = () => S.mode === "real" && S.plan === "rl" && !!D.manifest.files.rl;
  async function loadRL() {
    if (!D.rl) [D.rl, D.risk] = await Promise.all([getJSON(D.manifest.files.rl), getJSON(D.manifest.files.risk)]);
  }
  function todayRealRL(e, prices, nd) {
    const p = RL.userPlan(D.rl, D.risk, { holdings: S.holdings, cash: S.cash, peak: S.peak, prices,
      hold_days: D.manifest.lock_days, ceiling: S.ceiling, max_holdings: S.maxEtf });
    if (p.nav > (S.peak || 0)) { S.peak = Math.round(p.nav * 100) / 100; save(); }  // a new 12-month high
    const tk = D.rl.tickers;
    const rows = tk.map((t0, j) => ({ t: t0, sh: p.current[j], tsh: p.shares[j], px: prices[t0], rem: p.remaining[j] }))
      .filter((r) => r.sh > 0 || r.tsh > 0)
      .sort((a, b) => b.tsh * b.px - a.tsh * a.px || a.t.localeCompare(b.t))
      .map((r) => {
        const trade = r.tsh - r.sh, side = trade > 0 ? "buy" : trade < 0 ? "sell" : "hold";
        const sellable = r.rem > 0 ? C.firstSessionOnOrAfter(C.addDays(D.manifest.data_date, r.rem), D.sessions) : null;
        return `<div class="trade r3"><span class="side ${side === "hold" ? "keep" : side}">${t(side)}${trade ? " " + intFmt(Math.abs(trade)) : ""}</span><span class="num">${esc(r.t)}</span>
          <span class="small" style="min-width:0;display:grid;gap:2px"><span class="muted">${esc(aname(r.t))}</span>
            <span><span class="num">${intFmt(r.sh)} → ${intFmt(r.tsh)}</span> ${t("sharesUnit")} · <span class="num">${money(r.tsh * r.px)}</span></span>
            ${sellable ? `<span><span class="badge acc">${esc(t("sellableFrom", { d: md(sellable) }))}</span></span>` : ""}</span></div>`;
      }).join("");
    const pct = (x) => (x * 100).toFixed(1) + "%";
    return statsRow(e, t("value"), p.nav) + `<p class="muted small">${t("realStatsNote")}</p><div class="card">
      <div class="card-head"><h2>${t("realTitle")}</h2><span class="muted small">${esc(t("executesOn", { d: nd }))}</span></div>
      <p class="muted small">${t("rlRealNote")}</p>
      <div class="ctl"><span class="lbl">${t("rlMyDrawdown")}</span><div class="ctl-v"><span class="num">${pct(p.drawdown)}</span>&nbsp; <span class="muted small">${esc(t("rlFromPeak", { v: money(p.peak) }))}</span></div>
        <span class="lbl">${t("riskStateLbl")}</span><div class="ctl-v">${riskChip({ risk_state: p.riskState })}</div></div>
      <div>${rows || `<p class="muted">${t("noTrades")}</p>`}</div>
      <div class="row between" style="border-top:1px solid var(--line);padding-top:10px"><b>${t("cashAfter")}</b><span class="num">${money(p.cashAfter)}</span></div>
      <p class="muted small">${esc(t("estimatedAt", { d: D.manifest.data_date }))} · ${t("relock")}</p></div>`;
  }
  function todayReal(e) {
    const hasAny = S.holdings.some((h) => h.sh > 0) || S.cash > 0;
    if (!hasAny) return `<div class="card center"><p>${t("realEmpty")}</p><a class="btn primary" href="#settings">${t("goSettings")}</a></div>`;
    const prices = {}; for (const a of D.universe.assets) prices[a.ticker] = a.close;
    const nd = nextDay();
    if (useRL() && D.rl) return todayRealRL(e, prices, nd);
    const p = C.realPlan({ holdings: S.holdings, cash: S.cash, target: e.weights, prices, nextDay: nd, lockDays: D.manifest.lock_days, sessions: D.sessions });
    const rows = p.rows.map((r) => {
      const side = r.trade > 0 ? "buy" : r.trade < 0 ? "sell" : "hold";
      return `<div class="trade r3"><span class="side ${side === "hold" ? "keep" : side}">${t(side)}${r.trade ? " " + intFmt(Math.abs(r.trade)) : ""}</span><span class="num">${esc(r.t)}</span>
        <span class="small" style="min-width:0;display:grid;gap:2px"><span class="muted">${esc(aname(r.t))}</span>
          <span><span class="num">${intFmt(r.sh)} → ${intFmt(r.tsh)}</span> ${t("sharesUnit")} · <span class="num">${money(r.tsh * r.px)}</span></span>
          ${r.locked ? `<span><span class="badge acc">${esc(t("sellableFrom", { d: md(r.sellable) }))}</span></span>` : ""}</span></div>`;
    }).join("");
    return statsRow(e, t("value"), p.total) + `<p class="muted small">${t("realStatsNote")}</p><div class="card">
      <div class="card-head"><h2>${t("realTitle")}</h2><span class="muted small">${esc(t("executesOn", { d: nd }))}</span></div>
      <p class="muted small">${t("realNote")}</p>
      <div>${rows}</div>
      <div class="row between" style="border-top:1px solid var(--line);padding-top:10px"><b>${t("cashAfter")}</b><span class="num">${money(p.cashAfter)}</span></div>
      <p class="muted small">${esc(t("estimatedAt", { d: D.manifest.data_date }))} · ${t("relock")}</p></div>`;
  }

  /* ------------------------------------------------------------------ Strategies */
  const SORT_VALUE = {
    ytd: (e) => e.returns.ytd, d1: (e) => e.returns.d1, m1: (e) => e.returns.m1, y1: (e) => e.returns.y1,
    sharpe: (e) => e.summary.sharpe, cagr: (e) => e.summary.cagr, maxdd: (e) => -e.summary.max_drawdown,
  };
  function sortedStrategies() {
    const ids = D.manifest.strategies.map((s) => s.id);
    if (S.sortKey === "default" || !SORT_VALUE[S.sortKey]) return ids;
    return C.sortIds(ids, (id) => { const e = entry(id); return e ? SORT_VALUE[S.sortKey](e) : null; }, S.sortDir);
  }
  function sortBar() {
    const opts = C.SORT_KEYS.map((k) => `<option value="${k}"${k === S.sortKey ? " selected" : ""}>${esc(t("sort_" + k))}</option>`).join("");
    const dir = S.sortDir === "asc" ? "desc" : "asc";
    return `<div class="sortrow"><select id="f-sort" data-set="sortKey" aria-label="${esc(t("sortBy"))}">${opts}</select>
      ${S.sortKey === "default" ? "" : `<button class="btn dir" type="button" data-set="sortDir" data-v="${dir}">${S.sortDir === "asc" ? icon("up") + " " + t("sortAsc") : icon("down") + " " + t("sortDesc")}</button>`}</div>`;
  }
  function pageStrategies() {
    const cards = sortedStrategies().map(strat).map((s) => {
      const e = entry(s.id); if (!e) return "";
      const top = Object.entries(e.weights).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, w]) => `<span class="chip">${label(k)} ${pp(w)}</span>`).join("");
      const plan = s.id === S.plan;
      return `<a class="card ${plan ? "hl" : ""}" href="#s-${esc(s.id)}">
        <div class="row between"><b><span class="sw" style="background:${scolor(s.id)}"></span>${esc(s.name[S.lang])}</b>
          <span class="row" style="gap:6px">${plan ? `<span class="badge acc">${t("isPlan")}</span>` : ""}${e.risk_state !== "normal" ? riskChip(e) : ""}</span></div>
        <div class="row between" style="align-items:end"><div><div class="label">${t("ytd")}</div><div class="big ${cls(e.returns.ytd)}">${pct(e.returns.ytd, 1, true)}</div></div>${spark(e.spark)}</div>
        <div class="kv"><span>${t("d1")} <b class="${cls(e.returns.d1)}">${pct(e.returns.d1, 2, true)}</b></span><span>${t("y1")} <b class="${cls(e.returns.y1)}">${pct(e.returns.y1, 1, true)}</b></span>
          <span>${t("sharpe")} <b>${fmtNum(e.summary.sharpe)}</b></span><span>${t("maxdd")} <b>${pct(-e.summary.max_drawdown, 1)}</b></span></div>
        <div class="row" style="gap:6px">${top}</div>
        ${e.next_trades.length ? `<span class="muted small">${t("nextTrades")}: ${e.next_trades.length}</span>` : ""}</a>`;
    }).join("");
    return `${staleBanner()}<h1>${t("strategies")}</h1>
      ${ctl([ceilingRow(), ...maxEtfRows(), [t("sortBy"), sortBar()]])}<div class="grid">${cards}</div>
      <p class="muted small">${esc(t("metricsSince", { y: D.manifest.backtest_start.slice(0, 4), d: D.manifest.data_date }))}</p>`;
  }

  /* ------------------------------------------------------------------ Strategy detail */
  const RANGES = ["1M", "3M", "YTD", "1Y", "5Y", "ALL"];
  function pageDetail(id, b, bb) {
    const s = strat(id), e = entry(id), m = b.metrics;
    const years = Object.keys(b.monthly_returns).sort().reverse();
    if (!view.calYear || !years.includes(String(view.calYear))) view.calYear = Number(years[0]);
    const tabs = [["equity", t("tab_equity")], ["dd", t("tab_dd")], ["daily", t("tab_daily")], ["hold", t("tab_hold")], ["cal", t("tab_cal")]];
    const benchOpts = [["", t("none")]].concat(D.manifest.strategies.filter((x) => x.id !== id).map((x) => [x.id, x.name[S.lang]]));
    const ctrl = view.tab === "cal"
      ? `<select data-view="calYear" aria-label="${esc(t("year"))}">${years.map((y) => `<option${Number(y) === view.calYear ? " selected" : ""}>${y}</option>`).join("")}</select>`
      : seg("view", "range", RANGES.map((k) => [k, t("range")[k]]), view.range, "full");
    const statsCards = [[t("cagr"), pct(m.cagr)], [t("sharpe"), fmtNum(m.sharpe)], [t("maxdd"), pct(-m.max_drawdown)], [t("vol"), pct(m.volatility)]]
      .map(([k, v]) => `<div class="stat"><span class="label">${k}</span><span class="v">${v}</span></div>`).join("");
    const holdNow = Object.entries(e.current_weights).sort((x, y) => y[1] - x[1]).map(([k, w]) =>
      `<span class="chip">${label(k)} ${pp(w)}${e.locks[k] ? " · " + esc(md(e.locks[k])) : ""}</span>`).join("");
    const reb = b.rebalances.slice().reverse();
    const rebRows = reb.slice(0, view.rebShow).map((r) => `<tr><td class="num">${esc(r.date)}</td><td style="white-space:normal">${r.changes.map((c) =>
      `<span class="chip"><span class="${c.to > c.from ? "up" : "down"}">${c.to > c.from ? "+" : "−"}</span>${label(c.ticker)} ${pp(c.from)}→${pp(c.to)}</span>`).join(" ")}</td></tr>`).join("");
    return `${staleBanner()}
      <div class="card"><a href="#strategies" class="small" style="text-decoration:none">← ${t("strategies")}</a>
        <div class="card-head"><h1><span class="sw" style="background:${scolor(s.id)};width:14px;height:14px"></span>${esc(s.name[S.lang])}</h1>
          ${id === S.plan ? `<span class="badge acc">${icon("star")} ${t("isPlan")}</span>` : `<button class="btn" type="button" data-set="plan" data-v="${esc(id)}">${icon("star")} ${t("setAsPlan")}</button>`}</div>
        <p class="muted">${esc(s.description[S.lang])}</p>
        ${ctl([ceilingRow(), ...maxEtfRows(), [t("riskStateLbl"), riskChip(e)]])}</div>
      <div class="stats">${statsCards}</div>
      <div class="card">
        <div class="chart-ctl">${seg("view", "tab", tabs, view.tab, "full")}${ctrl}</div>
        ${view.tab === "equity" ? `<label class="row small muted">${t("benchmark")} <select data-view="bench">${benchOpts.map(([v, l]) => `<option value="${esc(v)}"${view.bench === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}
        ${view.tab === "cal" ? `<div class="cal-wrap"><div id="c-main" class="chart"></div></div>` : `<div id="c-main" class="chart"></div>`}
        <p class="muted small">${view.tab === "equity" ? t("growth") : view.tab === "dd" ? t("ddChartNote") : ""}</p>
      </div>
      <div class="card"><h3>${t("holdingsNow")}</h3><div class="row" style="gap:6px">${holdNow}</div></div>
      <div class="card"><h3>${t("monthly")}</h3>${monthlyTable(b, years)}</div>
      <div class="card"><div class="card-head"><h3>${t("rebalances")}</h3><span class="muted small">${reb.length}</span></div>
        ${reb.length ? `<div class="tbl"><table><tbody>${rebRows}</tbody></table></div>` : `<p class="muted">${t("never")}</p>`}
        ${reb.length > view.rebShow ? `<button class="btn link" type="button" data-act="more-reb">${t("showMore")}</button>` : ""}</div>
      ${liveCard(id)}`;
  }
  function monthlyTable(b, years) {
    const cell = (v) => {
      if (v == null) return `<td class="n"></td>`;
      const a = Math.min(0.55, Math.abs(v) * 7);
      return `<td class="n" style="background:color-mix(in srgb, var(${v >= 0 ? "--up" : "--down"}) ${(a * 100).toFixed(0)}%, transparent)">${(v * 100).toFixed(1)}</td>`;
    };
    return `<div class="tbl"><table class="months"><thead><tr><th>${t("year")}</th>${t("months").map((x) => `<th class="n">${x}</th>`).join("")}<th class="n">${t("fullYear")}</th></tr></thead>
      <tbody>${years.map((y) => `<tr><td class="num">${y}</td>${b.monthly_returns[y].map(cell).join("")}${cell(b.annual_returns[y])}</tr>`).join("")}</tbody></table></div>`;
  }
  function liveCard(id) {
    const L = D.live;
    const rows = L && L.launch_date ? (L.portfolios[pidOf(id)] || []) : [];
    if (!rows.length) return `<div class="card"><h3>${t("live")}</h3><p class="muted">${t("liveNone")}</p></div>`;
    const shown = rows.slice().reverse().slice(0, view.liveShow);
    return `<div class="card"><div class="card-head"><h3>${t("live")}</h3><span class="muted small">${esc(t("liveSince", { d: L.launch_date }))}</span></div>
      <div class="tbl"><table><thead><tr><th>${t("date")}</th><th class="n">${t("d1")}</th><th>${t("changes")}</th></tr></thead><tbody>
      ${shown.map((r) => `<tr><td class="num">${esc(r.date)}</td><td class="n ${cls(r.d1)}">${pct(r.d1, 2, true)}</td><td style="white-space:normal">${r.changes.length
        ? r.changes.map((c) => `<span class="chip">${c.to > c.from ? "+" : "−"}${label(c.ticker)} ${pp(c.to)}</span>`).join(" ") : `<span class="muted">${t("hold")}</span>`}</td></tr>`).join("")}
      </tbody></table></div>
      ${rows.length > view.liveShow ? `<button class="btn link" type="button" data-act="more-live">${t("showMore")}</button>` : ""}</div>`;
  }
  function drawDetail(id, b, bb) {
    const s = strat(id), a = C.rangeStart(b.dates, view.range), X = b.dates.slice(a);
    if (view.tab === "equity") {
      const norm = (bt) => {
        const i0 = C.indexOnOrAfter(bt.dates, b.dates[a]);
        const base = bt.equity[i0];
        const map = new Map(bt.dates.map((d, i) => [d, i]));
        return X.map((d) => { const i = map.get(d); return i == null || i < i0 ? null : +((bt.equity[i] / base) * 10000).toFixed(0); });
      };
      const col = scolor(id);
      const series = [line(s.name[S.lang], norm(b), col, { lineStyle: { width: 1.6, color: col },
        areaStyle: { origin: "start", color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: hexA(col, 0.28) }, { offset: 1, color: hexA(col, 0.02) }]) } })];
      if (bb) series.push(line(sname(view.bench), norm(bb), css("--muted"), { lineStyle: { width: 1.2, color: css("--muted"), type: "dashed" } }));
      mk("c-main", { xAxis: { type: "category", data: X, boundaryGap: false }, yAxis: { type: "value", scale: true, axisLabel: { formatter: (v) => Math.round(v).toLocaleString(locale()) } },
        tooltip: { valueFormatter: (v) => (v == null ? "—" : money(v)) }, series });
    } else if (view.tab === "dd") {
      const dc = css("--down");
      mk("c-main", { legend: { show: false }, xAxis: { type: "category", data: X, boundaryGap: false },
        yAxis: { type: "value", max: 0, axisLabel: { formatter: (v) => v + "%" } }, tooltip: { valueFormatter: (v) => v + "%" },
        series: [line(t("tab_dd"), b.dd12.slice(a).map((v) => -(v * 100).toFixed(2)), dc, { areaStyle: { color: dc, opacity: 0.18 },
          markLine: { symbol: "none", silent: true, label: { formatter: t("ceiling") + " " + S.ceiling + "%", color: css("--warn"), position: "insideStartTop" },
            lineStyle: { color: css("--warn"), type: "dashed" }, data: [{ yAxis: -S.ceiling }] } })] });
    } else if (view.tab === "daily") {
      const up = css("--up"), dn = css("--down");
      mk("c-main", { legend: { show: false }, xAxis: { type: "category", data: X }, yAxis: { type: "value", axisLabel: { formatter: (v) => v + "%" } },
        tooltip: { valueFormatter: (v) => v + "%" }, grid: { left: 10, right: 26, top: 16, bottom: 44, containLabel: true },
        dataZoom: coarse() ? [{ type: "slider", height: 18, bottom: 6 }] : [{ type: "inside" }, { type: "slider", height: 18, bottom: 6 }],
        series: [{ name: t("tab_daily"), type: "bar", large: true, data: b.ret.slice(a).map((v) => ({ value: +(v * 100).toFixed(2), itemStyle: { color: v >= 0 ? up : dn } })) }] });
    } else if (view.tab === "hold") {
      const w = b.weights, k0 = C.indexOnOrAfter(w.dates, b.dates[a]);
      const dates = w.dates.slice(k0), vals = w.values.slice(k0);
      const series = w.assets.map((tk, j) => ({ tk, j, max: Math.max(...vals.map((r) => r[j])) })).filter((x) => x.max > 0.001)
        .map(({ tk, j }) => ({ name: labelText(tk), type: "line", stack: "w", showSymbol: false, lineStyle: { width: 0 },
          lineStyle: { width: 0.6, color: css("--surface") }, areaStyle: { color: assetColor(tk), opacity: 1 }, itemStyle: { color: assetColor(tk) }, emphasis: { focus: "series" },
          data: vals.map((r) => +(r[j] * 100).toFixed(1)) }));
      mk("c-main", { legend: { type: "scroll", top: 0 }, grid: { left: 10, right: 26, top: 34, bottom: 8, containLabel: true },
        tooltip: { valueFormatter: (v) => v + "%", order: "valueDesc" },
        xAxis: { type: "category", data: dates, boundaryGap: false }, yAxis: { type: "value", max: 100, axisLabel: { formatter: (v) => v + "%" } }, series });
    } else {
      const y = String(view.calYear), up = css("--up"), dn = css("--down");
      const data = []; b.dates.forEach((d, i) => { if (i && d.startsWith(y)) data.push([d, +(b.ret[i] * 100).toFixed(2)]); });
      mk("c-main", { legend: { show: false }, tooltip: { trigger: "item", formatter: (p) => p.value[0] + "  " + pct(p.value[1] / 100, 2, true) },
        visualMap: { show: false, type: "piecewise", pieces: [{ lt: -1.5, color: dn }, { gte: -1.5, lt: -0.25, color: hexA(dn, 0.5) },
          { gte: -0.25, lte: 0.25, color: css("--surface-2") }, { gt: 0.25, lte: 1.5, color: hexA(up, 0.5) }, { gt: 1.5, color: up }] },
        calendar: { range: y, top: 26, left: 34, right: 8, bottom: 6, cellSize: ["auto", 16], splitLine: { show: false },
          itemStyle: { color: css("--bg"), borderColor: css("--surface"), borderWidth: 2 }, yearLabel: { show: false },
          dayLabel: { color: css("--muted"), nameMap: S.lang === "zh" ? "ZH" : "EN", firstDay: 1 }, monthLabel: { color: css("--muted"), nameMap: S.lang === "zh" ? "ZH" : "EN" } },
        series: [{ type: "heatmap", coordinateSystem: "calendar", data }] });
    }
  }
  function hexA(hex, a) {
    const h = hex.replace("#", ""); if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
    const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ------------------------------------------------------------------ Compare */
  function pageCompare(bts) {
    const chips = D.manifest.strategies.map((s) => `<label class="pick${view.cmp.includes(s.id) ? " on" : ""}">
      <input type="checkbox" data-cmp="${esc(s.id)}"${view.cmp.includes(s.id) ? " checked" : ""}><span class="sw" style="background:${scolor(s.id)};margin:0"></span><span class="pick-name">${esc(s.name[S.lang])}</span></label>`).join("");
    const ms = bts.map((b, k) => ({ id: view.cmp[k], m: C.metrics(b.equity, C.rangeStart(b.dates, view.cmpRange)) }));
    const col = { total: (m) => m.total, sharpe: (m) => m.sharpe, mdd: (m) => -m.mdd, cagr: (m) => m.cagr, vol: (m) => m.vol };
    const cs = view.cmpSort;
    const order = cs.key && col[cs.key] ? C.sortIds(ms.map((x) => x.id), (id) => col[cs.key](ms.find((x) => x.id === id).m), cs.dir) : ms.map((x) => x.id);
    const th = (k, txt, extra) => `<th class="n${extra ? " " + extra : ""}"><button type="button" class="th-sort" data-act="cmpsort" data-k="${k}" aria-sort="${cs.key === k ? (cs.dir === "asc" ? "ascending" : "descending") : "none"}">${txt}<span class="arrow">${icon(cs.key === k ? (cs.dir === "asc" ? "up" : "down") : "both")}</span></button></th>`;
    const rows = order.map((id) => ms.find((x) => x.id === id)).map(({ id, m }) => {
      return `<tr><td><span class="sw" style="background:${scolor(id)}"></span>${esc(sname(id))}</td><td class="n ${cls(m.total)}">${pct(m.total, 1, true)}</td>
        <td class="n">${fmtNum(m.sharpe)}</td><td class="n">${pct(-m.mdd)}</td><td class="n opt">${pct(m.cagr)}</td><td class="n opt">${pct(m.vol)}</td></tr>`;
    }).join("");
    return `${staleBanner()}<h1>${t("compare")}</h1>
      <div class="card"><span class="label">${t("pick")}</span><div class="pickgrid">${chips}</div>
        ${ctl([ceilingRow(), ...maxEtfRows(), [t("rangeLbl"), seg("view", "cmpRange", RANGES.map((k) => [k, t("range")[k]]), view.cmpRange)]])}</div>
      ${bts.length ? `<div class="card"><h3>${t("growthCompare")}</h3><div id="c-ceq" class="chart"></div></div>
      <div class="grid2"><div class="card"><h3>${t("tab_dd")}</h3><div id="c-cdd" class="chart sm"></div><p class="muted small">${t("ddChartNote")}</p></div>
        <div class="card"><h3>${t("rolling")}</h3><div id="c-crs" class="chart sm"></div></div></div>
      <div class="card"><h3>${t("metricsRange")}</h3><div class="tbl"><table><thead><tr><th></th>${th("total", t("totalRet"))}${th("sharpe", t("sharpe"))}${th("mdd", t("maxdd"))}${th("cagr", t("cagr"), "opt")}${th("vol", t("vol"), "opt")}</tr></thead><tbody>${rows}</tbody></table></div></div>`
        : `<div class="card"><p class="muted">${t("atLeastOne")}</p></div>`}`;
  }
  function drawCompare(bts) {
    if (!bts.length) return;
    const ref = bts[0], a = C.rangeStart(ref.dates, view.cmpRange), X = ref.dates.slice(a);
    const align = (b, f) => { const map = new Map(b.dates.map((d, i) => [d, i])); return X.map((d) => { const i = map.get(d); return i == null ? null : f(b, i); }); };
    const eqS = bts.map((b, k) => { const id = view.cmp[k], i0 = C.indexOnOrAfter(b.dates, X[0]);
      return line(sname(id), align(b, (bb, i) => +((bb.equity[i] / bb.equity[i0]) * 10000).toFixed(0)), scolor(id)); });
    mk("c-ceq", { xAxis: { type: "category", data: X, boundaryGap: false }, yAxis: { type: "value", scale: true }, tooltip: { valueFormatter: (v) => (v == null ? "—" : money(v)) }, series: eqS });
    mk("c-cdd", { xAxis: { type: "category", data: X, boundaryGap: false }, yAxis: { type: "value", max: 0, axisLabel: { formatter: (v) => v + "%" } }, tooltip: { valueFormatter: (v) => v + "%" },
      series: bts.map((b, k) => line(sname(view.cmp[k]), align(b, (bb, i) => -(bb.dd12[i] * 100).toFixed(2)), scolor(view.cmp[k]), Object.assign({ lineStyle: { width: 1.4, color: scolor(view.cmp[k]) } },
        k === 0 ? { markLine: { symbol: 'none', silent: true, label: { formatter: t('ceiling') + ' ' + S.ceiling + '%', color: css('--warn'), position: 'insideStartTop' },
          lineStyle: { color: css('--warn'), type: 'dashed' }, data: [{ yAxis: -S.ceiling }] } } : {}))) });
    const from = Math.max(a, 252), X2 = ref.dates.slice(from);
    mk("c-crs", { xAxis: { type: "category", data: X2, boundaryGap: false }, yAxis: { type: "value" }, tooltip: { valueFormatter: (v) => (v == null ? "—" : fmtNum(v)) },
      series: bts.map((b, k) => {
        const rs = C.rollingSharpe(b.equity, 252, C.indexOnOrAfter(b.dates, X2[0] || b.dates[0]));
        const start = b.dates.length - rs.length, map = new Map(b.dates.map((d, i) => [d, i]));
        return line(sname(view.cmp[k]), X2.map((d) => { const i = map.get(d); return i == null || i < start ? null : +rs[i - start].toFixed(2); }), scolor(view.cmp[k]), { lineStyle: { width: 1.4, color: scolor(view.cmp[k]) } });
      }) });
  }

  /* ------------------------------------------------------------------ Settings */
  function pageSettings() {
    const opts = D.manifest.strategies.map((s) => `<option value="${esc(s.id)}"${s.id === S.plan ? " selected" : ""}>${esc(s.name[S.lang])}</option>`).join("");
    const tickOpts = (cur) => D.universe.assets.map((a) => `<option value="${a.ticker}"${a.ticker === cur ? " selected" : ""}>${a.ticker} · ${esc(aname(a.ticker))}</option>`).join("");
    const rows = S.holdings.map((h, i) => `<div class="hrow">
        <div class="hrow-top"><select id="h-t-${i}" data-h="${i}" data-k="t" aria-label="ETF">${tickOpts(h.t)}</select>
          <button class="btn" type="button" data-act="hrm" data-i="${i}">${t("remove")}</button></div>
        <div class="hrow-grid">
          <label class="sub" for="h-s-${i}">${t("shares")}<input id="h-s-${i}" type="number" inputmode="decimal" min="0" step="1" value="${esc(h.sh)}" data-h="${i}" data-k="sh"></label>
          <label class="sub" for="h-d-${i}">${t("lastBuy")}<input id="h-d-${i}" type="date" value="${esc(h.d)}" max="${esc(D.manifest.data_date)}" data-h="${i}" data-k="d"></label>
        </div>
        <span class="err" id="h-e-${i}"${h.d || !h.sh ? " hidden" : ""}>${t("missingDate")}</span></div>`).join("");
    return `<h1>${t("settings")}</h1><p class="muted">${t("settingsPrivacy")}</p>
      <div class="card form">
        <div class="field"><label for="f-plan">${t("planStrategy")}</label><select id="f-plan" data-set="plan">${opts}</select></div>
        <div class="field"><span class="lbl">${t("ceiling")}</span>${ceilingSeg()}</div>
        ${maxEtfRows().length ? `<div class="field"><span class="lbl">${t("maxEtf")}</span>${maxEtfSeg()}</div>` : ""}
        <div class="field"><span class="lbl">${t("holdingsMode")}</span>${seg("set", "mode", [["sim", t("modeSim")], ["real", t("modeReal")]], S.mode)}</div>
        ${S.mode === "sim"
          ? `<div class="field"><label for="f-amount">${t("amount")} (USD)</label><input id="f-amount" type="number" inputmode="decimal" min="0" step="100" value="${S.amount}" data-save="amount"><span class="hint">${t("amountHint")}</span></div>`
          : `<div class="field"><label for="f-cash">${t("cash")} (USD)</label><input id="f-cash" type="number" inputmode="decimal" min="0" step="100" value="${S.cash}" data-save="cash"><span class="hint">${t("cashHint")}</span></div>
            <div class="field"><label for="f-peak">${t("peak12m")} (USD)</label><input id="f-peak" type="number" inputmode="decimal" min="0" step="100" value="${S.peak || ""}" data-save="peak"><span class="hint">${t("peak12mHint")}</span></div>
             <div class="field"><span class="lbl">${t("myHoldings")}</span><span class="hint">${t("holdingsHint")}</span>
               ${rows || `<p class="muted small">${t("noRows")}</p>`}
               <button class="btn add" type="button" data-act="hadd">+ ${t("addRow")}</button></div>`}
      </div>
      <div class="card form">
        <div class="field"><span class="lbl">${t("language")}</span>${seg("set", "lang", [["zh", "中文"], ["en", "English"]], S.lang)}</div>
        <div class="field"><span class="lbl">${t("theme")}</span>${seg("set", "theme", [["system", t("system")], ["light", t("light")], ["dark", t("dark")]], S.theme)}</div>
        <div class="field"><span class="lbl">${t("colors")}</span>${seg("set", "updown", [["red-up", t("redUp")], ["green-up", t("greenUp")]], S.updown)}</div>
      </div>
      <div class="card form"><div class="field"><label for="f-backup">${t("backup")}</label><span class="hint">${t("backupHint")}</span>
        <textarea id="f-backup" spellcheck="false" autocomplete="off">${esc(JSON.stringify(S))}</textarea>
        <div class="btn2"><button class="btn" type="button" data-act="copy">${t("copy")}</button><button class="btn primary" type="button" data-act="import">${t("importBtn")}</button></div>
        <span id="b-msg" class="muted small" role="status"></span></div></div>
      <p class="muted small">${t("addToHome")}</p>`;
  }

  /* ------------------------------------------------------------------ About */
  function pageAbout() {
    const m = D.manifest, f = C.freshness(m, Date.now());
    return `<h1>${t("about")}</h1>
      <div class="card"><h2>${t("aboutWhat")}</h2><p>${t("aboutWhatText")}</p></div>
      <div class="card"><h2>${t("rules")}</h2><ul class="plain">${t("rulesList").map((x) => `<li>${esc(x)}</li>`).join("")}</ul><div class="alert small">${t("caveat")}</div></div>
      <div class="card"><h2>${t("strategiesAbout")}</h2><div class="tbl"><table><tbody>${m.strategies.map((s) => `<tr><td><span class="sw" style="background:${scolor(s.id)}"></span><b>${esc(s.name[S.lang])}</b></td><td style="white-space:normal">${esc(s.description[S.lang])}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h2>${t("data")}</h2><p>${t("dataText")}</p></div>
      <div class="card"><h2>${t("pipeline")}</h2><div class="tbl"><table><tbody>
        <tr><td>${t("status")}</td><td>${f === "ok" ? `<span class="badge ok">${t("fresh")}</span>` : `<span class="badge bad">${t(f)}</span>`}${m.last_attempt.message ? ` <span class="muted small">${esc(m.last_attempt.message)}</span>` : ""}</td></tr>
        <tr><td>${t("dataAsOf")}</td><td class="num">${esc(m.data_date)}</td></tr>
        <tr><td>${t("lastRun")}</td><td class="num">${esc(fmtET(m.generated_at))}</td></tr>
        <tr><td>${t("nextRun")}</td><td class="num">${esc(fmtET(m.next_run))}</td></tr>
        <tr><td>${t("codeVersion")}</td><td class="num"><a href="https://github.com/${esc(m.code.repo)}/tree/${esc(m.code.commit)}" target="_blank" rel="noopener">${esc(m.code.tag || m.code.commit)}</a></td></tr>
        <tr><td>${t("config")}</td><td class="num">${esc(m.config.name)} · ${esc(m.config.hash)}</td></tr></tbody></table></div></div>
      <div class="alert">${t("disclaimer")}</div>`;
  }

  /* ------------------------------------------------------------------ events */
  function setSetting(key, value) {
    const next = Object.assign({}, S, { [key]: value });
    S = C.sanitizeSettings(next, D.manifest);
    save();
    render();
  }
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("button, a");
    if (!el) return;
    if (el.dataset.set) { setSetting(el.dataset.set, el.dataset.v); return; }
    if (el.dataset.view) {
      const k = el.dataset.view;
      view[k] = el.dataset.v;
      render(); return;
    }
    const act = el.dataset.act;
    if (!act) return;
    if (act === "retry") { boot(); return; }
    if (act === "more-reb") { view.rebShow += 30; render(); return; }
    if (act === "more-live") { view.liveShow += 30; render(); return; }
    if (act === "cmpsort") {
      const k = el.dataset.k, cs = view.cmpSort;
      view.cmpSort = cs.key === k ? { key: k, dir: cs.dir === "desc" ? "asc" : "desc" } : { key: k, dir: "desc" };
      render(); return;
    }
    if (act === "hadd") {
      S.holdings.push({ t: D.universe.assets[0].ticker, sh: 0, d: "" });
      save(); render(); return;
    }
    if (act === "hrm") { S.holdings.splice(Number(el.dataset.i), 1); save(); render(); return; }
    if (act === "copy") {
      const ta = document.getElementById("f-backup"), msg = document.getElementById("b-msg");
      const fallback = () => { ta.focus(); ta.select(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(() => { msg.textContent = t("copied"); }, fallback);
      else fallback();
      return;
    }
    if (act === "import") {
      const msg = document.getElementById("b-msg");
      try {
        const x = JSON.parse(document.getElementById("f-backup").value);
        if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("not an object");
        S = C.sanitizeSettings(x, D.manifest); save(); render();
        const m2 = document.getElementById("b-msg"); if (m2) m2.textContent = t("imported");
      } catch (e) { msg.textContent = t("badBackup"); }
    }
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset.set) { setSetting(el.dataset.set, el.value); return; }
    if (el.dataset.view) { view[el.dataset.view] = el.dataset.view === "calYear" ? Number(el.value) : el.value; render(); return; }
    if (el.dataset.cmp) {
      const id = el.dataset.cmp, order = D.manifest.strategies.map((s) => s.id);
      view.cmp = el.checked ? order.filter((x) => x === id || view.cmp.includes(x)) : view.cmp.filter((x) => x !== id);
      render(); return;
    }
    if (el.dataset.save) {
      S = C.sanitizeSettings(Object.assign({}, S, { [el.dataset.save]: el.value }), D.manifest);
      el.value = S[el.dataset.save]; save(); return;
    }
    if (el.dataset.h !== undefined) {
      const i = Number(el.dataset.h), k = el.dataset.k, h = S.holdings[i];
      if (!h) return;
      if (k === "sh") { const n = Number(el.value); h.sh = isFinite(n) && n >= 0 ? n : 0; el.value = h.sh; }
      else if (k === "d") h.d = C.isValidDate(el.value) ? el.value : "";
      else h.t = el.value;
      const err = document.getElementById("h-e-" + i);
      if (err) err.hidden = !(h.sh > 0 && !h.d);
      save();
    }
  });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  if (window.matchMedia) {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { if (S.theme === "system") render(); };
    if (mq.addEventListener) mq.addEventListener("change", onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }

  /* ------------------------------------------------------------------ boot */
  // iOS Safari ignores user-scalable=no; block its pinch gestures explicitly.
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  async function boot() {
    applyTheme(); shell(route().page);
    app.innerHTML = loadingCard();
    try {
      await loadCore();
      // Settings were first cleaned without the manifest; clean the stored ones again
      // against it, so a choice only the data defines (e.g. the holdings limit) survives.
      S = C.sanitizeSettings(readStore() || S, D.manifest);
      save();
      render();
    } catch (e) {
      console.error(e);
      app.innerHTML = errorCard(e);
    }
  }
  window.__etfr = { state: () => S, view, data: D };   // for the automated UI tests
  boot();
})();
