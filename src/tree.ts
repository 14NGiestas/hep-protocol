/**
 * tree.ts — generic ASCII DAG visualizer for hash-chained JSONL registries.
 *
 * Works for both registry flavors in this repo:
 *   - hep  (hypotheses):  propose/refine/merge events, id = payload.hyp
 *   - ckpt (checkpoints): register events, id = payload.ckpt
 * Entry shape is auto-detected from payloads; no other coupling.
 *
 * Zero dependencies. Colors are deterministic per id (same id, same color,
 * every run) and are disabled when stdout is not a TTY, NO_COLOR is set,
 * or { color: false } is passed — so piped output stays clean for scripts.
 */
import { existsSync, readFileSync } from "node:fs";
import { HEP } from "./index.js";

export interface TreeNode {
  id: string;
  label: string;
  parents: string[];
  meta: Record<string, string>;
}

export interface TreeOptions {
  color?: boolean; // default: isTTY && !NO_COLOR
  starId?: string | null; // idem potent marker, e.g. best-bpb node
  starGlyph?: string; // default ★
  maxLabel?: number; // default 64, 0 = no truncation
}

// Full-spectrum palette for ids: the 6x6x6 cube (codes 16-231) minus the
// near-black (r+g+b<=1) and near-white (r+g+b>=14) corners, which are unreadable
// on dark/light terminals respectively. 208 colors: at registry scale, two
// different ids sharing a color is essentially impossible, so color reads as
// identity (same id, same color, every run) — never as status.
function buildPalette(): number[] {
  const out: number[] = [];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) {
        const s = r + g + b;
        if (s <= 1 || s >= 14) continue;
        out.push(16 + 36 * r + 6 * g + b);
      }
  return out;
}
const PALETTE = buildPalette();

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function colorsEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env["NO_COLOR"] !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

function paint(code: number, s: string, on: boolean): string {
  return on ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export function colorForId(id: string, on: boolean): (s: string) => string {
  const code = PALETTE[hashStr(id) % PALETTE.length];
  return (s: string) => (on ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
}

function trunc(s: string, n: number): string {
  if (n > 0 && s.length > n) return s.slice(0, n - 1) + "…";
  return s;
}

function metaLine(m: Record<string, string>): string {
  const parts: string[] = [];
  if (m["bpb"] !== undefined) parts.push(`bpb=${m["bpb"]}`);
  if (m["state"] !== undefined) {
    const belief = m["belief"] !== undefined ? ` ${m["belief"]}` : "";
    parts.push(`${m["state"]}${belief}`);
  }
  let s = parts.length ? `  [${parts.join("]  [")}]` : "";
  const paren = m["machine"] ?? m["mechanism"];
  if (paren !== undefined) s += `  (${paren})`;
  return s;
}

const STATE_COLORS: Record<string, number> = {
  supported: 32,
  refuted: 31,
  dormant: 33,
  under_test: 36,
  proposed: 0,
};

function stateColor(state: string | undefined, on: boolean): (s: string) => string {
  const code = (state && STATE_COLORS[state]) || 0;
  if (!code || !on) return (s: string) => s;
  return (s: string) => paint(code, s, on);
}

export function renderTree(nodes: TreeNode[], opts: TreeOptions = {}): string {
  const on = colorsEnabled(opts.color);
  const star = opts.starId ?? null;
  const glyph = opts.starGlyph ?? "★";
  const maxLabel = opts.maxLabel ?? 64;
  if (!nodes.length) return "(empty registry)";
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes) for (const p of n.parents) {
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n.id);
  }
  for (const v of children.values()) v.sort();
  const roots = nodes
    .filter((n) => !n.parents.length || !n.parents.some((p) => byId.has(p)))
    .map((n) => n.id)
    .sort();

  const lines: string[] = [];
  const visited = new Set<string>();
  const labelOf = (id: string): string => {
    const n = byId.get(id)!;
    const starPart = star === id ? ` ${paint(33, glyph, on)}` : "";
    const paintId = colorForId(id, on);
    const paintState = stateColor(n.meta["state"], on);
    const head = paintState(trunc(n.label, maxLabel)) + starPart;
    return `${head}${metaLine(n.meta)}  ${paintId(id)}`;
  };
  const walk = (id: string, prefix: string): void => {
    const kids = (children.get(id) ?? []).filter((k) => byId.has(k));
    const ext = (children.get(id) ?? []).filter((k) => !byId.has(k));
    const all = [...kids, ...ext];
    all.forEach((k, i) => {
      const last = i === all.length - 1;
      const elbow = last ? "└── " : "├── ";
      const paintId = colorForId(k, on);
      if (!byId.has(k)) {
        lines.push(`${prefix}${elbow}${paintId(k)}  (outside registry)`);
        return;
      }
      if (visited.has(k)) {
        lines.push(`${prefix}${elbow}↩ ${paintId(k)} (see above)`);
        return;
      }
      visited.add(k);
      lines.push(`${prefix}${elbow}${labelOf(k)}`);
      walk(k, prefix + (last ? "    " : "│   "));
    });
  };
  for (const r of roots) {
    visited.add(r);
    lines.push(labelOf(r));
    walk(r, "");
  }
  return lines.join("\n");
}

export type RegistryFlavor = "hep" | "ckpt";

export function detectFlavor(path: string): RegistryFlavor | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as { payload?: Record<string, unknown> };
      const p = e.payload ?? {};
      if ("ckpt" in p) return "ckpt";
      if ("hyp" in p) return "hep";
    } catch { continue; }
  }
  return null;
}

/** Nodes from a ckpt registry (register events; eval-only entries carry no nodes). */
export function nodesFromCkpt(path: string): TreeNode[] {
  const raw = readFileSync(path, "utf8");
  const nodes: TreeNode[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as { type?: string; payload?: Record<string, unknown> };
      if (e.type !== "register") continue;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const ev = (p["eval"] as Record<string, unknown> | undefined) ?? {};
      const meta: Record<string, string> = {};
      if (ev["bpb"] !== undefined && ev["bpb"] !== null) meta["bpb"] = String(ev["bpb"]);
      if (p["machine"] !== undefined) meta["machine"] = String(p["machine"]);
      nodes.push({
        id: String(p["ckpt"]),
        label: String(p["label"] ?? p["ckpt"]),
        parents: ((p["parents"] as string[]) ?? []).map(String),
        meta,
      });
    } catch { continue; }
  }
  return nodes;
}

/** Nodes from a hep registry (replays propose/refine/merge like status()). */
export function nodesFromHep(path: string): TreeNode[] {
  const h = new HEP(path);
  const st = h.status();
  return Object.entries(st).map(([id, r]) => {
    const meta: Record<string, string> = { state: r.state, mechanism: r.mechanism };
    if (typeof r.belief === "number") meta["belief"] = r.belief.toFixed(2);
    return { id, label: r.statement, parents: r.parents ?? [], meta };
  });
}

export function loadNodes(path: string, flavor?: RegistryFlavor | "auto"): { nodes: TreeNode[]; flavor: RegistryFlavor } {
  const f = flavor && flavor !== "auto" ? flavor : detectFlavor(path);
  if (!f) throw new Error(`cannot detect registry flavor: ${path} (empty or unknown)`);
  const nodes = f === "ckpt" ? nodesFromCkpt(path) : nodesFromHep(path);
  return { nodes, flavor: f };
}

/** Best-bpb ckpt id, or null. HEP mode has no star (no single scalar to crown). */
export function bestCkpt(nodes: TreeNode[]): string | null {
  let best: string | null = null;
  let bestV = Infinity;
  for (const n of nodes) {
    const v = Number(n.meta["bpb"]);
    if (Number.isFinite(v) && v < bestV) { bestV = v; best = n.id; }
  }
  return best;
}
