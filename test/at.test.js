// --at / ts: imports and migrations carry REAL dates, and the override must not
// break the hash chain (the hash covers `prev` + `payload`, not `ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

test("TAMPERING with ts IS DETECTED (the timeline is part of the chain)", () => {
  const h = tmp();
  const id = h.propose("a", 0.5, "de-novo", [], undefined, "2026-08-03T13:34:24-03:00");
  // unvalidated evidence does NOT move the belief, so a threshold-gated verdict is
  // refused: that is the auditability the protocol exists for, so it is asserted.
  h.transition(id, "under_test");
  assert.throws(() => h.transition(id, "supported"), /requires belief/);
  assert.equal(h.verify().ok, true);
  const lines = readFileSync(h.path, "utf8").trim().split("\n").map((l) => {
    const e = JSON.parse(l);
    e.ts = new Date(Date.UTC(2030, 0, 1)).toISOString();   // reescreve a data
    return JSON.stringify(e);
  });
  writeFileSync(h.path, lines.join("\n") + "\n");
  assert.equal(h.verify().ok, false, "rewriting ts must break the chain");
  assert.equal(h.verify().badSeq, 1);
});

// v1 canonical form, exactly as 0.1.2 / hep.py wrote it: object keys sorted,
// undefined-valued keys dropped, non-ASCII escaped as \uXXXX. Pinning it here is the
// point -- the test fails loudly if the legacy rule ever drifts.
function v1Canonical(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(v1Canonical).join(", ")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${v1Canonical(v[k])}`).join(", ")}}`;
}

test("registries written before v2 still verify, and the weaker rule is REPORTED", () => {
  const h = tmp();
  const payload = { hyp: "hyp_beef", statement: "legacy", prior: 0.5, mechanism: "de-novo",
                    parents: [], testable_observable: undefined, state: "proposed" };
  const prev = "0".repeat(64);
  const hash = createHash("sha256").update(prev + v1Canonical(payload)).digest("hex");
  writeFileSync(h.path, JSON.stringify({ seq: 1, prev, type: "propose", ts: "2026-08-03T16:34:24.000Z", payload, hash }) + "\n");
  const v = h.verify();
  assert.equal(v.ok, true, "a v1 registry must stay verifiable");
  assert.equal(v.legacy, 1, "and be reported as verified under the weaker rule");
});
