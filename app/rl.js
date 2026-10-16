/* ETFRegulus web app: the RL model on the user's own holdings. Pure logic (no DOM).
   Loaded by the page as window.RL and by the Node tests with require().

   A port of src/publish/rl_live.py in the ETFRegulus repository (`user_plan`), which is
   built from the research simulator's own pieces. tests/rl.test.js checks this file against
   cases generated from it (scripts/rl_fixtures.py). Change the two together.

   The model reads the user's state -- weights, lock days left, drawdown from their 12-month
   high, ceiling, holdings limit -- and its proposal then goes through the rule layer:
   holdings limit, lock floors, the risk budget (stressed loss on the published scenarios),
   stepwise de-risking past the ceiling, the no-trade band, whole shares. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 864e5;
  const MIN_N = 1.0;

  /* ---------------------------------------------------------------- weights */
  function f32(b64) {
    let bytes;
    if (typeof Buffer !== "undefined") bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    else { const s = atob(b64); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(bytes.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  /** Decode one seed's layers once: {name: {w: Float64Array(out*in), b, out, in}}. */
  function decodeSeed(seed) {
    const L = {};
    for (const [k, v] of Object.entries(seed)) L[k] = { w: f32(v.w), b: f32(v.b), out: v.shape[0], in: v.shape[1] };
    return L;
  }
  function linear(x, l, tanh) {
    const y = new Float64Array(l.out);
    for (let o = 0; o < l.out; o++) {
      let s = l.b[o];
      const row = o * l.in;
      for (let i = 0; i < l.in; i++) s += l.w[row + i] * x[i];
      y[o] = tanh ? Math.tanh(s) : s;
    }
    return y;
  }

  /* ---------------------------------------------------------------- policy */
  /** The actor's masked action mean (SharedAssetActorCritic). */
  function policyMean(L, obs, doc) {
    const K = doc.tickers.length, F = doc.n_per_asset, nG = doc.n_global, nP = doc.n_portfolio, nM = doc.n_market;
    const glob = obs.slice(0, nG);
    const pf = obs.slice(nG + K * F, nG + K * F + nP);
    const pr = obs.slice(nG + K * F + nP);
    const emb = [], avail = [];
    for (let j = 0; j < K; j++) {
      const a = obs.slice(nG + j * F, nG + (j + 1) * F);
      emb.push(linear(linear(a, L.enc1, true), L.enc2, true));
      avail.push(a[nM + 5]);
    }
    const E = L.enc2.out;
    const mean = new Float64Array(E), max = new Float64Array(E).fill(-Infinity);
    let nAv = 0;
    for (let j = 0; j < K; j++) {
      for (let e = 0; e < E; e++) {
        mean[e] += emb[j][e] * avail[j];
        max[e] = Math.max(max[e], avail[j] > 0 ? emb[j][e] : -1e4);
      }
      nAv += avail[j];
    }
    for (let e = 0; e < E; e++) mean[e] /= Math.max(nAv, 1);
    const ctx = linear(linear(Float64Array.from([...mean, ...max, ...glob, ...pf, ...pr]), L.ctx1, true), L.ctx2, true);
    const out = new Float64Array(K + 1);
    out[0] = linear(linear(ctx, L.cash1, true), L.cash2, false)[0];
    for (let j = 0; j < K; j++) {
      const v = linear(linear(Float64Array.from([...emb[j], ...ctx]), L.head1, true), L.head2, false)[0];
      out[j + 1] = avail[j] > 0.5 ? v : doc.mask_logit;
    }
    return out;
  }
  function softmaxWeights(mean, scale) {
    const a = Array.from(mean, (x) => Math.min(1, Math.max(-1, x)) * scale);
    const m = Math.max(...a);
    const e = a.map((x) => Math.exp(x - m));
    const s = e.reduce((p, q) => p + q, 0);
    return e.map((x) => x / s);
  }

  /* ---------------------------------------------------------------- the user's state */
  const dayMs = (iso) => Date.parse(iso + "T00:00:00Z");

  function userState(doc, user) {
    const T = doc.tickers, K = T.length, n = Number(user.hold_days);
    const shares = new Float64Array(K), lastBuy = {};
    for (const h of user.holdings) {
      const j = T.indexOf(h.t);
      if (j < 0 || !(user.prices[h.t] > 0)) continue;
      shares[j] += Math.max(0, Number(h.sh) || 0);
      if (h.d) lastBuy[h.t] = lastBuy[h.t] && lastBuy[h.t] > h.d ? lastBuy[h.t] : h.d;
    }
    const px = T.map((t) => Number(user.prices[t] || 0));
    const cash = Math.max(0, Number(user.cash) || 0);
    let nav = cash;
    for (let j = 0; j < K; j++) nav += shares[j] * px[j];
    const peak = Math.max(Number(user.peak) || 0, nav);
    const data = dayMs(doc.data_date);
    const remaining = new Float64Array(K);
    for (let j = 0; j < K; j++) {
      const d = lastBuy[T[j]];
      if (shares[j] > 0 && d) remaining[j] = Math.max(0, Math.round((dayMs(d) + n * DAY - data) / DAY));
    }
    const w = new Float64Array(K + 1), lower = new Float64Array(K + 1);
    if (nav > 0) { w[0] = cash / nav; for (let j = 0; j < K; j++) w[j + 1] = shares[j] * px[j] / nav; }
    for (let j = 0; j < K; j++) lower[j + 1] = remaining[j] > 0 ? w[j + 1] : 0;
    return { shares, px, cash, nav, peak, drawdown: peak > 0 ? 1 - nav / peak : 0, remaining, weights: w, lower };
  }

  function observation(doc, st, holdDays, maxDrawdown, maxHoldings) {
    const K = doc.tickers.length, nM = doc.n_market, F = doc.n_per_asset;
    const av = doc.inputs.available.map((x) => (x ? 1 : 0));
    const n = Math.max(holdDays, MIN_N);
    const obs = [...doc.inputs.global];
    let lw = 0, lrw = 0, nLocked = 0;
    for (let j = 0; j < K; j++) {
      const w = st.weights[j + 1], rem = st.remaining[j], locked = rem > 0;
      const row = new Array(F).fill(0);
      for (let f = 0; f < nM; f++) row[f] = av[j] ? doc.inputs.per_asset[j][f] : 0;
      row[nM] = w; row[nM + 1] = st.shares[j] > 0 ? 1 : 0; row[nM + 2] = locked ? 1 : 0;
      row[nM + 3] = rem / n; row[nM + 4] = locked ? 1 - Math.min(rem, n) / n : 0; row[nM + 5] = av[j];
      obs.push(...row);
      if (locked) { lw += w; lrw += w * rem; nLocked += 1; }
    }
    const wavg = nLocked && lw > 1e-12 ? lrw / lw : 0;
    obs.push(st.weights[0], 1.0, st.peak / Math.max(st.nav, 1e-9), st.drawdown, maxDrawdown - st.drawdown,
             nLocked / Math.max(K, 1), lw, wavg / n);
    obs.push(holdDays / doc.hold_days_divisor, maxDrawdown);
    if (doc.holdings_param) obs.push((maxHoldings <= 0 ? K : Math.min(maxHoldings, K)) / K);
    return Float64Array.from(obs, (x) => Math.min(doc.clip, Math.max(-doc.clip, Math.fround(x))));
  }

  /* ---------------------------------------------------------------- risk */
  function cvarLoss(paths, w, q) {
    const n = paths.length;
    if (!n) return 0;
    const losses = paths.map((p) => { let s = 0; for (let i = 0; i < w.length; i++) s -= p[i] * w[i]; return s; });
    const k = q * n;
    losses.sort((a, b) => b - a);
    if (k <= 0) return losses[0];
    const whole = Math.floor(k);
    let total = 0;
    for (let i = 0; i < whole; i++) total += losses[i];
    if (whole < n) total += (k - whole) * losses[whole];
    return total / k;
  }
  function riskModel(riskDoc, budget) {
    const q = riskDoc.quantile, agg = riskDoc.aggregation, samples = riskDoc.samples.map((s) => s.paths);
    if (riskDoc.measure !== "cvar") throw new Error("only the cvar measure is supported");
    return {
      budget: () => budget,
      stress(w) {
        const l = samples.map((p) => cvarLoss(p, w, q));
        if (agg === "max") return Math.max(...l);
        if (agg === "mean") return l.reduce((a, b) => a + b, 0) / l.length;
        throw new Error("unsupported aggregation " + agg);
      },
    };
  }

  /* ---------------------------------------------------------------- rule layer */
  /** engine.cap_holdings */
  function capHoldings(a, lower, cur, k) {
    const out = Float64Array.from(a);
    const K = a.length - 1;
    let n = 0;
    for (let j = 1; j <= K; j++) if (out[j] > 1e-12) n++;
    if (k <= 0 || n <= k) return out;
    const idx = [];
    for (let j = 0; j < K; j++) if (out[j + 1] > 1e-12 || lower[j + 1] > 1e-12) idx.push(j);
    const locked = (j) => lower[j + 1] > 1e-12, held = (j) => cur[j + 1] > 1e-12;
    idx.sort((x, y) => (locked(x) === locked(y) ? 0 : locked(x) ? -1 : 1) || (out[y + 1] - out[x + 1])
      || (held(x) === held(y) ? 0 : held(x) ? -1 : 1) || x - y);
    let nLocked = 0;
    for (let j = 0; j < K; j++) if (locked(j)) nLocked++;
    const keep = new Set(idx.slice(0, Math.max(k, nLocked)));
    let dropped = 0, kept = 0;
    for (let j = 0; j < K; j++) {
      if (!keep.has(j)) { dropped += out[j + 1]; out[j + 1] = 0; } else kept += out[j + 1];
    }
    if (kept > 1e-12) for (let j = 1; j <= K; j++) out[j] *= (kept + dropped) / kept;
    else out[0] += dropped;
    return out;
  }

  const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  function dualTheta(y, lo, hi, budget) {
    const fin = hi.filter((v) => isFinite(v));
    const span = Math.max(...y.map(Math.abs)) + Math.max(...lo.map(Math.abs)) + (fin.length ? Math.max(...fin) : 0) + 1;
    let a = -span - budget, b = span + budget;
    for (let it = 0; it < 200; it++) {
      const mid = 0.5 * (a + b);
      let s = 0;
      for (let i = 0; i < y.length; i++) s += clip(y[i] - mid, lo[i], hi[i]);
      if (s > budget) a = mid; else b = mid;
      if (b - a < 1e-15 * Math.max(1, span)) break;
    }
    return 0.5 * (a + b);
  }
  /** projector.project_with_lower_bounds -> [w, degenerate] */
  function projectLower(y, lower, mask, budget, upper) {
    const n = y.length, w = new Float64Array(n);
    if (!mask.some(Boolean)) return [w, false];
    const lo = Array.from(lower, (v, i) => (mask[i] ? v : 0));
    const hi = Array.from(lo, (l, i) => Math.max(mask[i] ? (upper ? upper[i] : Infinity) : 0, l));
    const totalLower = lo.reduce((a, b) => a + b, 0);
    if (totalLower > budget + 1e-12) {
      for (let i = 0; i < n; i++) if (mask[i]) w[i] = lo[i] * (budget / totalLower);
      return [w, true];
    }
    const idx = [];
    for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
    const yi = idx.map((i) => y[i]), li = idx.map((i) => lo[i]), ui = idx.map((i) => hi[i]);
    if (!ui.every((v) => isFinite(v)) || ui.reduce((a, b) => a + b, 0) >= budget - 1e-12) {
      const th = dualTheta(yi, li, ui, budget);
      idx.forEach((i, k) => { w[i] = clip(yi[k] - th, li[k], ui[k]); });
      const gap = budget - idx.reduce((a, i) => a + w[i], 0);
      if (Math.abs(gap) > 1e-12) {
        let best = 0, bv = -Infinity;
        idx.forEach((i, k) => { const s = gap > 0 ? ui[k] - w[i] : w[i] - li[k]; if (s > bv) { bv = s; best = k; } });
        w[idx[best]] = clip(w[idx[best]] + gap, li[best], ui[best]);
      }
      return [w, false];
    }
    idx.forEach((i, k) => { w[i] = ui[k]; });
    return [w, true];
  }
  function safePortfolio(lower, mask) {
    const lo = Array.from(lower, (v, i) => (mask[i] ? v : 0));
    lo[0] = 0;
    const total = lo.reduce((a, b) => a + b, 0);
    if (total > 1) return Float64Array.from(lo, (v) => v / total);
    const w = Float64Array.from(lo);
    w[0] = 1 - total;
    return w;
  }
  const blend = (a, w, ref) => Float64Array.from(w, (v, i) => a * v + (1 - a) * ref[i]);
  function bisect(w, ref, risk, bound, tolAlpha, steps) {
    let lo = 0, hi = 1;
    for (let s = 0; s < steps; s++) {
      if (hi - lo < tolAlpha) break;
      const mid = 0.5 * (lo + hi);
      if (risk.stress(blend(mid, w, ref)) <= bound) lo = mid; else hi = mid;
    }
    return lo;
  }
  /** AnalyticProjector.project (risk on; D-F and O-2 as configured). */
  function project(raw, { lower, available, risk, capitalPreservation, current, rules }) {
    const n = raw.length, tolA = rules.alpha_tolerance || 1e-3, STEPS = 32, tol = 1e-12;
    const mask = Array.from(available, Boolean); mask[0] = true;
    const lo = Array.from(lower, (v, i) => (i === 0 || !mask[i] ? 0 : v));
    const diag = { no_risk_increase: false, derisk_forced: false, risk_binding: false };
    const dF = rules.over_budget_rule === "no_risk_increase" && risk && current;
    let upper = null;
    if (capitalPreservation && !dF) {
      upper = Array.from(lo, (l, i) => (mask[i] ? Math.max(current ? current[i] : l, l) : 0));
      upper[0] = Infinity;
    }
    let [w] = projectLower(Array.from(raw), lo, mask, 1, upper);
    const refOf = () => {
      const r = Array.from(current, (v, i) => (mask[i] ? Math.max(v, 0) : 0));
      const t = r.reduce((a, b) => a + b, 0);
      return t > 0 ? Float64Array.from(r, (v) => v / t) : safePortfolio(new Float64Array(n), mask);
    };
    if (risk) {
      const budget = risk.budget();
      if (dF && capitalPreservation) {
        const ref = refOf();
        diag.no_risk_increase = true;
        let bound, toward;
        if (rules.derisk_step > 0) {
          toward = safePortfolio(lo, mask);
          bound = Math.max(budget, risk.stress(toward), (1 - rules.derisk_step) * risk.stress(ref));
        } else { toward = ref; bound = Math.max(budget, risk.stress(ref)); }
        if (risk.stress(w) > bound + tol) {
          diag.risk_binding = true;
          if (rules.derisk_step > 0) diag.derisk_forced = true;
          const a = bisect(w, toward, risk, bound + tol, tolA, STEPS);
          const c = blend(a, w, toward);
          w = risk.stress(c) > bound + tol ? toward : c;
        }
      } else if (risk.stress(w) > budget) {
        diag.risk_binding = true;
        const wSafe = safePortfolio(lo, mask);
        if (dF && risk.stress(wSafe) > budget) {
          const ref = refOf();
          diag.no_risk_increase = true;
          const bound = Math.max(budget, risk.stress(ref));
          if (risk.stress(w) > bound + tol) {
            const a = bisect(w, ref, risk, bound + tol, tolA, STEPS);
            const c = blend(a, w, ref);
            w = risk.stress(c) > bound + tol ? ref : c;
          }
        } else if (risk.stress(wSafe) > budget) {
          w = wSafe;
        } else {
          const a = bisect(w, wSafe, risk, budget, tolA, STEPS);
          const c = blend(a, w, wSafe);
          w = risk.stress(c) > budget ? wSafe : c;
        }
      }
    }
    w = Float64Array.from(w, (v) => Math.max(v, 0));
    const t = w.reduce((a, b) => a + b, 0);
    if (t > 0) for (let i = 0; i < n; i++) w[i] /= t;
    return { weights: w, diag };
  }

  /* ---------------------------------------------------------------- the plan */
  const decoded = new WeakMap();
  /** The model's next-open plan for the user's own book (rl_live.user_plan). */
  function userPlan(doc, riskDoc, user) {
    const holdDays = Number(user.hold_days), dMax = Number(user.ceiling) / 100, k = Number(user.max_holdings) || 0;
    const rules = doc.rules;
    const st = userState(doc, user);
    const obs = observation(doc, st, holdDays, dMax, k);
    if (!decoded.has(doc)) decoded.set(doc, doc.seeds.map(decodeSeed));
    const seeds = decoded.get(doc);
    const raw = new Float64Array(doc.tickers.length + 1);
    for (const L of seeds) softmaxWeights(policyMean(L, obs, doc), doc.logit_scale).forEach((v, i) => { raw[i] += v / seeds.length; });

    const cur = st.weights, lower = st.lower;
    const avail = [true, ...doc.inputs.available];
    const a = capHoldings(raw, lower, cur, k);
    const cp = st.drawdown > dMax;
    const budget = st.nav > 0 ? 1 - (1 - dMax) * (st.peak / st.nav) : -Infinity;
    const risk = riskModel(riskDoc, budget);
    const { weights: target, diag } = project(a, { lower, available: avail, risk, capitalPreservation: cp, current: cur, rules });
    // engine.exit_dropped: an ETF the limit dropped stays out, in cash, even where the
    // projection blended back toward the current book.
    if (k > 0) for (let j = 1; j < target.length; j++) {
      if (a[j] <= 1e-12 && lower[j] <= 1e-12 && target[j] > 0) { target[0] += target[j]; target[j] = 0; }
    }

    const K = doc.tickers.length, band = Number(rules.no_trade_band) || 0;
    const sh = st.shares, px = st.px, nw = Float64Array.from(sh);
    for (let j = 0; j < K; j++) {
      if (!(px[j] > 0)) continue;
      const gap = target[j + 1] - cur[j + 1];
      let keep = band > 0 && Math.abs(gap) < band && (!diag.derisk_forced || gap >= 0);
      if (k > 0 && target[j + 1] <= 1e-12 && sh[j] > 0) keep = false;
      if (keep) continue;
      let want = Math.floor(target[j + 1] * st.nav / px[j] + 1e-9);
      if (st.remaining[j] > 0) want = Math.max(want, sh[j]);
      if (diag.no_risk_increase && target[j + 1] <= cur[j + 1] + 1e-9) want = Math.min(want, sh[j]);
      nw[j] = want;
    }
    let sells = 0, cost = 0;
    for (let j = 0; j < K; j++) { sells += Math.max(sh[j] - nw[j], 0) * px[j]; cost += Math.max(nw[j] - sh[j], 0) * px[j]; }
    const cashAvail = st.cash + sells;
    if (cost > cashAvail + 1e-9) {
      const scale = cashAvail / cost;
      for (let j = 0; j < K; j++) if (nw[j] > sh[j]) nw[j] = sh[j] + Math.floor((nw[j] - sh[j]) * scale + 1e-9);
    }
    let cashAfter = st.cash;
    for (let j = 0; j < K; j++) cashAfter += (sh[j] - nw[j]) * px[j];
    return {
      nav: st.nav, peak: st.peak, drawdown: st.drawdown, budget, raw, target, shares: nw, cashAfter,
      remaining: st.remaining, current: st.shares,
      riskState: cp ? "capital_preservation" : diag.no_risk_increase ? "over_budget" : "normal",
      deriskForced: diag.derisk_forced,
    };
  }

  return { userPlan, userState, observation, policyMean, softmaxWeights, capHoldings, project, cvarLoss, decodeSeed };
});
