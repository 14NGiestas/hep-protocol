// --at / ts: imports and migrations carry REAL dates, and the override must not
// break the hash chain (the hash covers `prev` + `payload`, not `ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEP } from "../dist/index.js";

const tmp = () => new HEP(join(mkdtempSync(join(tmpdir(), "hep-at-")), "registry.jsonl"));

test("ts is taken from the caller, normalised to ISO", () => {
  const h = tmp();
  h.propose("legacy hypothesis", 0.4, "de-novo", [], undefined, "2026-08-07T05:54:14-03:00");
  const ev = JSON.parse(readFileSync(h.path, "utf8").trim().split("\n")[0]);
  assert.equal(ev.ts, new Date("2026-08-07T05:54:14-03:00").toISOString());
});

test("without ts the wall clock is used", () => {
  const h = tmp();
  h.propose("now", 0.5);
  const ev = JSON.parse(readFileSync(h.path, "utf8").trim());
  assert.ok(Math.abs(Date.now() - new Date(ev.ts).getTime()) < 60_000);
});

test("a bad ts is rejected instead of silently corrupting the timeline", () => {
  const h = tmp();
  assert.throws(() => h.propose("x", 0.5, "de-novo", [], undefined, "07/08/2026"), /invalid --at/);
});

test("the chain stays valid with overridden timestamps", () => {
  const h = tmp();
  const id = h.propose("a", 0.5, "de-novo", [], undefined, "2026-08-03T13:34:24-03:00");
  // validated=true -> belief moves 0.5 -> 0.85, which is what the gate needs
  h.attachEvidence(id, "analysis", "supports", 0.5, 0.85, "legacy result", "H01/HYPOTHESIS.md",
                   true, null, "", "2026-08-04T10:00:00-03:00");
  h.transition(id, "supported", "2026-08-05T09:00:00-03:00");
  assert.equal(h.verify().ok, true);
});

test("REWRITING ts AFTERWARDS is chain-safe (a migration can post-process)", () => {
  const h = tmp();
  const id = h.propose("a", 0.5);
  // unvalidated evidence does NOT move the belief, so a threshold-gated verdict is
  // refused: that is the auditability the protocol exists for, so it is asserted.
  h.transition(id, "under_test");
  assert.throws(() => h.transition(id, "supported"), /requires belief/);
  const before = h.verify().ok;
  const lines = readFileSync(h.path, "utf8").trim().split("\n").map((l, i) => {
    const e = JSON.parse(l);
    e.ts = new Date(Date.UTC(2026, 7, 3 + i)).toISOString();   // datas historicas
    return JSON.stringify(e);
  });
  writeFileSync(h.path, lines.join("\n") + "\n");
  assert.equal(before, true);
  assert.equal(h.verify().ok, true, "post-processing ts must not break the chain");
});
