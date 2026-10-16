// app/rl.js against the Python reference (ETFRegulus src/publish/rl_live.py).
// Fixture: python -m scripts.rl_fixtures --out ../etfregulus-site/tests/fixtures/rl_cases.json
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const RL = require("../app/rl.js");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "rl_cases.json"), "utf8"));
const maxDiff = (a, b) => Math.max(...Array.from(a, (x, i) => Math.abs(x - b[i])));

test("every reference case: same model output, same projected target, same shares", () => {
  for (const [n, c] of FIX.cases.entries()) {
    const p = RL.userPlan(FIX.doc, FIX.risk, c.user);
    const where = `case ${n}`;
    assert.ok(maxDiff(p.raw, c.expect.raw) < 1e-9, `${where}: raw ${maxDiff(p.raw, c.expect.raw)}`);
    assert.ok(maxDiff(p.target, c.expect.target) < 1e-7, `${where}: target ${maxDiff(p.target, c.expect.target)}`);
    assert.deepEqual(Array.from(p.shares), c.expect.shares, `${where}: shares`);
    assert.ok(Math.abs(p.cashAfter - c.expect.cash_after) < 1e-6, `${where}: cash`);
    assert.equal(p.riskState, c.expect.risk_state, `${where}: risk state`);
    assert.equal(p.deriskForced, c.expect.derisk_forced, `${where}: forced`);
    assert.ok(Math.abs(p.budget - c.expect.budget) < 1e-12, `${where}: budget`);
  }
});

test("the fixture covers every risk state", () => {
  const states = new Set(FIX.cases.map((c) => c.expect.risk_state));
  for (const s of ["normal", "over_budget", "capital_preservation"]) assert.ok(states.has(s), s);
});

test("a holdings limit is met and a locked position is never cut", () => {
  for (const c of FIX.cases) {
    const p = RL.userPlan(FIX.doc, FIX.risk, c.user);
    const k = c.user.max_holdings;
    const held = Array.from(p.shares).filter((s) => s > 0).length;
    const lockedHeld = Array.from(p.remaining).filter((r, j) => r > 0 && p.current[j] > 0).length;
    if (k > 0) assert.ok(held <= Math.max(k, lockedHeld), `held ${held} > ${k}`);
    p.remaining.forEach((r, j) => { if (r > 0) assert.ok(p.shares[j] >= p.current[j]); });
    assert.ok(p.cashAfter >= -1e-6, "no borrowing");
  }
});
