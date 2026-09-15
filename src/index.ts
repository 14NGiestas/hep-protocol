/**
 * HEP — Hypothesis Evolution Protocol registry
 * Paper: arXiv:2607.09195v1 "Toward Auditable AI Scientists" — Takahara & Mizoguchi (2026-07-10)
 * §4 Methods faithful port + backward-compat with hep.py registry.jsonl
 *
 * Registry: append-only, event-sourced, hash-chained JSONL. Current state derived by replay.
 * Tools (paper §4.1): propose_hypothesis, refine_hypothesis, merge_hypotheses,
 *   attach_evidence, transition_hypothesis, list_hypotheses, get_hypothesis
 * Rules (paper §2 + §4.1): belief moves only by validated evidence; verdict thresholds
 *   supported >=0.8, refuted <=0.2; refine/merge require parent has evidence or verdict;
 *   inspired-by is provenance-only (generation 0, not descendant).
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VALID_STATES = new Set(["proposed", "under_test", "supported", "refuted", "dormant"] as const);
export const VALID_MECH = new Set(["de-novo", "inspired-by", "refine", "merge"] as const);
export const VALID_DIR = new Set(["supports", "refutes", "inconclusive"] as const);
export const VALID_KIND = new Set(["simulation", "experiment", "literature", "derivation", "analysis"] as const);

export type HEPState = string;
export type HEPMech = string;
export type HEPDir = string;

export interface HEPEvent { seq: number; prev: string; type: string; ts: string; payload: unknown; hash: string; v?: number; }
export interface HypRecord {
  statement: string; prior: number; mechanism: string; parents: string[];
  state: string; belief: number; evidence: unknown[]; generation: number;
  testable_observable?: string;
}

function nowIso(): string { return new Date().toISOString(); }

/** Timestamp of an event. `--at`/`ts` exists for IMPORTS and MIGRATIONS: a legacy
 *  corpus has real dates that a registry built today would otherwise flatten to the
 *  migration moment. The value is validated (a typo must not silently corrupt the
 *  timeline) and normalised to ISO. NOTE: the hash covers `prev` + `payload` only --
 *  `ts` is deliberately OUTSIDE the chain -- so an override keeps `verify()` green. */
function resolveTs(ts?: string): string {
  if (ts === undefined || ts === "") return nowIso();
  // JS `new Date(...)` is LENIENT: it happily parses "07/08/2026" (and, in some
  // engines, "2026-13-45"). For a timeline that must be trustworthy, only ISO 8601
  // is accepted -- the shape is checked before the value.
  const iso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!iso.test(ts)) {
    throw new Error(`invalid --at timestamp: "${ts}" (expected ISO 8601, e.g. 2026-08-07T05:54:14-03:00)`);
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid --at timestamp: "${ts}" (not a real date)`);
  }
  return d.toISOString();
}
function hid(): string { return `hyp_${randomBytes(3).toString("hex")}`; }

/** Chain version of NEW events. v1 (0.1.2 and earlier, and the Python `hep.py`) hashed
 *  `prev + payload` only, which left `ts` and `type` OUTSIDE the chain: the timeline
 *  (and the kind of an event) could be rewritten without `verify` noticing. v2 hashes
 *  the whole event, minus the hash itself. */
const CHAIN_V2 = 2;

/** Canonical hash input. Version-aware so registries written by v1 stay verifiable:
 *  a legacy event is checked with the weaker rule it was written under, and `verify`
 *  reports how many those were (a weaker guarantee is reported, not hidden). */
function eventHash(e: { seq: number; prev: string; type: string; ts: string; payload: unknown; v?: number }): string {
  const body = (e.v ?? 1) >= CHAIN_V2
    ? stableStringify({ v: e.v, seq: e.seq, type: e.type, ts: e.ts, payload: e.payload })
    : stableStringify(e.payload);
  return createHash("sha256").update(`${e.prev}${body}`).digest("hex");
}

function stableStringify(v: unknown): string {
  // `undefined` must be handled EXPLICITLY: JSON.stringify(undefined) returns the
  // VALUE undefined (not a string), which used to make `.replace` below throw. That
  // crashed the most common CLI invocation -- `hep propose` without `--testable`,
  // since arg() yields undefined -- so a hypothesis could not be proposed without a
  // testable observable. The semantics here now MATCH JSON: object keys whose value
  // is undefined are dropped, and undefined inside an array becomes null. That is
  // also what the stored line contains, so hash and payload stay consistent.
  const raw = (() => {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(", ")}]`;
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${stableStringify(rec[k])}`).join(", ")}}`;
  })();
  // Python json.dumps(..., ensure_ascii=True) escapes non-ASCII as \uXXXX — match it for hash compat
  return raw.replace(/[\u0080-\uFFFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export class HEP {
  path: string;
  private seq: number;
  private prev: string;

  constructor(path?: string) {
    this.path = path ?? join(process.cwd(), "hep", "registry.jsonl");
    mkdirSync(dirname(this.path), { recursive: true });
    const t = this.tail();
    this.seq = t.seq; this.prev = t.prev;
  }

  private tail(): { seq: number; prev: string } {
    let seq = 0; let prev = "0".repeat(64);
    if (!existsSync(this.path)) return { seq, prev };
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const e = JSON.parse(s) as HEPEvent;
        seq = e.seq; prev = e.hash;
      } catch { continue; }
    }
    return { seq, prev };
  }

  private append(etype: string, payload: unknown, ts?: string): HEPEvent {
    this.seq += 1;
    const base = { seq: this.seq, prev: this.prev, type: etype, ts: resolveTs(ts), payload, v: CHAIN_V2 };
    const h = eventHash(base);
    const ev: HEPEvent = { ...base, hash: h };
    appendFileSync(this.path, `${JSON.stringify(ev)}\n`);
    this.prev = h;
    return ev;
  }

  /** paper: propose_hypothesis — every hypothesis records statement, prior P(H) with rationale, testable observable, lineage */
  propose(statement: string, prior: number, mechanism = "de-novo", parents: string[] = [], testable?: string, ts?: string): string {
    if (!VALID_MECH.has(mechanism as never)) throw new Error(`mechanism must be one of ${[...VALID_MECH].join(", ")}`);
    const id = hid();
    this.append("propose", { hyp: id, statement, prior: Number(prior), mechanism, parents, testable_observable: testable, state: "proposed" }, ts);
    // alias for paper name
    return id;
  }
  proposeHypothesis = this.propose;

  /** paper §4.1: refine_hypothesis — child of single parent; only if parent has evidence or is terminal */
  refineHypothesis(parentHyp: string, statement: string, prior: number, _rationale = "", testable?: string, ts?: string): string {
    const st = this.status();
    const p = st[parentHyp];
    if (!p) throw new Error(`parent not found: ${parentHyp}`);
    if (p.evidence.length === 0 && p.state !== "supported" && p.state !== "refuted" && p.state !== "dormant") {
      throw new Error(`refine rejected: parent ${parentHyp} has no evidence and no verdict (paper §4.1)`);
    }
    const id = hid();
    this.append("refine", { hyp: id, parent: parentHyp, statement, prior: Number(prior), mechanism: "refine", parents: [parentHyp], testable_observable: testable, state: "proposed" }, ts);
    return id;
  }
  refine_hypothesis = this.refineHypothesis;

  /** paper §4.1: merge_hypotheses — combines 2+ parents; parents must have evidence/verdict; unresolved parents become dormant (subsumed) */
  mergeHypotheses(parentHyps: string[], statement: string, prior: number, _rationale = "", testable?: string, ts?: string): string {
    if (parentHyps.length < 2) throw new Error("merge requires >=2 parents");
    const st = this.status();
    for (const ph of parentHyps) {
      const p = st[ph];
      if (!p) throw new Error(`parent not found: ${ph}`);
      if (p.evidence.length === 0 && p.state !== "supported" && p.state !== "refuted" && p.state !== "dormant") {
        throw new Error(`merge rejected: parent ${ph} has no evidence and no verdict`);
      }
    }
    const id = hid();
    this.append("merge", { hyp: id, parents: parentHyps, statement, prior: Number(prior), mechanism: "merge", testable_observable: testable, state: "proposed" }, ts);
    // paper: unresolved parents transition to dormant as subsumed (recorded as separate events)
    for (const ph of parentHyps) {
      const p = st[ph];
      if (p.state === "proposed" || p.state === "under_test") {
        try { this.append("transition", { hyp: ph, state: "dormant", reason: `subsumed by ${id}` }, ts); } catch { /* ignore */ }
      }
    }
    return id;
  }
  merge_hypotheses = this.mergeHypotheses;

  /**
   * paper §4.1: attach_evidence — kind in {simulation,experiment,literature,derivation,analysis},
   * direction in {supports,refutes,inconclusive}, belief moves only if validated.
   * For computational/analytical evidence, agent must certify trustworthy (diagnostic);
   * uncertified is recorded as insufficient and leaves belief unchanged.
   */
  attachEvidence(hyp: string, kind: string, direction: string, prior: number, updated: number, rationale: string, source = "", validated = true, bpb: number | null = null, commit = "", ts?: string): HEPEvent {
    if (!VALID_DIR.has(direction as never)) throw new Error(`direction must be one of ${[...VALID_DIR].join(", ")}`);
    const needsValidation = kind === "simulation" || kind === "experiment" || kind === "analysis";
    const effectiveUpdated = needsValidation && !validated ? Number(prior) : Number(updated);
    const payload: Record<string, unknown> = { hyp, kind, direction, prior: Number(prior), updated: effectiveUpdated, bpb, commit, rationale, source, validated, insufficient: needsValidation && !validated };
    // keep alias "evidence" for backward compat with hep.py logs
    return this.append("evidence", payload, ts);
  }
  attach_evidence = this.attachEvidence;

  /** backward-compat alias used by hep.py CLI (evidence without kind) */
  evidence(hyp: string, kind: string, direction: string, prior: number, updated: number, rationale: string, source = "", bpb: number | null = null, commit = ""): HEPEvent {
    return this.attachEvidence(hyp, kind, direction, prior, updated, rationale, source, true, bpb, commit);
  }

  /** paper §2 + §4.1: verdict thresholds — supported >=0.8, refuted <=0.2; any out-of-order transition rejected */
  transition(hyp: string, state: string, ts?: string): HEPEvent {
    if (!VALID_STATES.has(state as never)) throw new Error(`state must be one of ${[...VALID_STATES].join(", ")}`);
    const st = this.status()[hyp];
    if (st) {
      if (state === "supported" && st.belief < 0.8) throw new Error(`transition rejected: supported requires belief >=0.8 (got ${st.belief})`);
      if (state === "refuted" && st.belief > 0.2) throw new Error(`transition rejected: refuted requires belief <=0.2 (got ${st.belief})`);
    }
    return this.append("transition", { hyp, state }, ts);
  }
  transitionHypothesis = this.transition;

  listHypotheses(): Record<string, HypRecord> { return this.status(); }
  list_hypotheses = this.listHypotheses;

  getHypothesis(hyp: string): HypRecord | undefined { return this.status()[hyp]; }
  get_hypothesis = this.getHypothesis;

  status(): Record<string, HypRecord> {
    const hyps: Record<string, HypRecord> = {};
    if (!existsSync(this.path)) return hyps;
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim(); if (!s) continue;
      let e: HEPEvent; try { e = JSON.parse(s) as HEPEvent; } catch { continue; }
      const p = e.payload as Record<string, unknown>;
      const t = e.type;
      if (t === "propose" || t === "propose_hypothesis") {
        const hyp = p["hyp"] as string;
        hyps[hyp] = {
          statement: p["statement"] as string,
          prior: p["prior"] as number,
          mechanism: (p["mechanism"] as string) ?? "de-novo",
          parents: (p["parents"] as string[]) ?? [],
          state: (p["state"] as string) ?? "proposed",
          belief: p["prior"] as number,
          evidence: [],
          generation: 0,
          testable_observable: p["testable_observable"] as string | undefined,
        };
        // generation: 0 for de-novo and inspired-by per paper Fig2a
        const mech = hyps[hyp].mechanism;
        if (mech === "refine" && hyps[hyp].parents.length === 1) {
          const par = hyps[hyp].parents[0];
          hyps[hyp].generation = (hyps[par]?.generation ?? 0) + 1;
        } else if (mech === "merge") {
          let mx = 0; for (const ph of hyps[hyp].parents) mx = Math.max(mx, hyps[ph]?.generation ?? 0);
          hyps[hyp].generation = mx + 1;
        }
      } else if (t === "refine") {
        const hyp = p["hyp"] as string;
        const par = p["parent"] as string;
        hyps[hyp] = {
          statement: p["statement"] as string, prior: p["prior"] as number, mechanism: "refine",
          parents: [par], state: "proposed", belief: p["prior"] as number, evidence: [],
          generation: (hyps[par]?.generation ?? 0) + 1, testable_observable: p["testable_observable"] as string | undefined,
        };
      } else if (t === "merge") {
        const hyp = p["hyp"] as string;
        const pars = (p["parents"] as string[]) ?? [];
        let mx = 0; for (const ph of pars) mx = Math.max(mx, hyps[ph]?.generation ?? 0);
        hyps[hyp] = {
          statement: p["statement"] as string, prior: p["prior"] as number, mechanism: "merge",
          parents: pars, state: "proposed", belief: p["prior"] as number, evidence: [],
          generation: mx + 1, testable_observable: p["testable_observable"] as string | undefined,
        };
      } else if ((t === "evidence" || t === "attach_evidence") && hyps[p["hyp"] as string]) {
        const h = hyps[p["hyp"] as string];
        // paper: belief moves only if validated; payload.updated already reflects gate
        h.belief = p["updated"] as number;
        h.evidence.push(p);
      } else if (t === "transition" && hyps[p["hyp"] as string]) {
        hyps[p["hyp"] as string].state = p["state"] as string;
      }
    }
    return hyps;
  }

  verify(): { ok: boolean; badSeq?: number; legacy?: number } {
    if (!existsSync(this.path)) return { ok: true, legacy: 0 };
    let prev = "0".repeat(64);
    const raw = readFileSync(this.path, "utf8");
    let seq = 0;
    let legacy = 0;
    for (const line of raw.split("\n")) {
      const s = line.trim(); if (!s) continue;
      let e: HEPEvent; try { e = JSON.parse(s) as HEPEvent; } catch { return { ok: false, badSeq: seq + 1 }; }
      seq += 1;
      if (e.seq !== seq || e.prev !== prev) return { ok: false, badSeq: e.seq };
      const exp = eventHash(e);
      if ((e.v ?? 1) < CHAIN_V2) legacy += 1;
      if (e.hash !== exp) return { ok: false, badSeq: e.seq };
      prev = e.hash;
    }
    return { ok: true, legacy };
  }
}
