import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestCkpt,
  detectFlavor,
  loadNodes,
  renderTree,
} from "../dist/tree.js";
import { createHash } from "node:crypto";

function ckptEvent(seq, prev, ckpt, label, parents, bpb, machine) {
  const payload = {
    ckpt, label, parents, machine,
    eval: { bpb, spec: "t" },
  };
  const hash = createHash("sha256").update(prev + JSON.stringify(payload)).digest("hex");
  return JSON.stringify({ seq, prev, type: "register", ts: "t", payload, hash });
}

describe("tree", () => {
  it("renders a diamond with a shared-child marker (no colors)", () => {
    const nodes = [
      { id: "r", label: "root", parents: [], meta: {} },
      { id: "a", label: "left", parents: ["r"], meta: {} },
      { id: "b", label: "right", parents: ["r"], meta: {} },
      { id: "s", label: "soup", parents: ["a", "b"], meta: {} },
    ];
    const out = renderTree(nodes, { color: false });
    assert.match(out, /^root  r$/m);
    assert.match(out, /├── left/);
    assert.match(out, /└── right/);
    assert.match(out, /↩ s \(see above\)/);
    assert.doesNotMatch(out, /\x1b\[/);
  });

  it("colors ids deterministically when enabled", () => {
    const nodes = [{ id: "ckpt_abc", label: "x", parents: [], meta: {} }];
    const a = renderTree(nodes, { color: true });
    const b = renderTree(nodes, { color: true });
    assert.match(a, /\x1b\[38;5;\d+mckpt_abc\x1b\[0m/);
    assert.equal(a, b);
  });

  it("marks the best-bpb ckpt with a star", () => {
    const nodes = [
      { id: "a", label: "a", parents: [], meta: { bpb: "2.5" } },
      { id: "b", label: "b", parents: ["a"], meta: { bpb: "2.1" } },
    ];
    const out = renderTree(nodes, { color: false, starId: bestCkpt(nodes) });
    assert.equal(bestCkpt(nodes), "b");
    assert.match(out, /★/);
  });

  it("auto-detects ckpt registries and renders bpb + machine", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-"));
    const p0 = "0".repeat(64);
    const e1 = ckptEvent(1, p0, "ckpt_1", "phase-4", [], 6.69, "fermi");
    const h1 = JSON.parse(e1).hash;
    const e2 = ckptEvent(2, h1, "ckpt_2", "phase-5", ["ckpt_1"], 2.4, "halfbeast");
    const file = join(dir, "registry.jsonl");
    writeFileSync(file, e1 + "\n" + e2 + "\n");
    assert.equal(detectFlavor(file), "ckpt");
    const { nodes, flavor } = loadNodes(file, "auto");
    assert.equal(flavor, "ckpt");
    assert.equal(nodes.length, 2);
    const out = renderTree(nodes, { color: false, starId: bestCkpt(nodes) });
    assert.match(out, /phase-5.*bpb=2\.4.*halfbeast.*ckpt_2/);
  });

  it("auto-detects hep registries and renders state", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-"));
    const p0 = "0".repeat(64);
    const payload = { hyp: "hyp_x", statement: "s", prior: 0.5, mechanism: "de-novo", parents: [], testable_observable: "", state: "proposed" };
    const hash = createHash("sha256").update(p0 + JSON.stringify(payload)).digest("hex");
    const file = join(dir, "registry.jsonl");
    writeFileSync(file, JSON.stringify({ seq: 1, prev: p0, type: "propose", ts: "t", payload, hash }) + "\n");
    assert.equal(detectFlavor(file), "hep");
    const { nodes, flavor } = loadNodes(file, "auto");
    assert.equal(flavor, "hep");
    assert.equal(nodes[0].id, "hyp_x");
    const out = renderTree(nodes, { color: false });
    assert.match(out, /proposed/);
  });
});
