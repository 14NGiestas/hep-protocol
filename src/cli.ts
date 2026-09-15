#!/usr/bin/env node
import { HEP } from "./index.js";
import { bestCkpt, colorsEnabled, loadNodes } from "./tree.js";
import { renderTree } from "./tree.js";

function help() {
  console.log(`hep — Hypothesis Evolution Protocol (arXiv:2607.09195v1)

Usage:
  hep propose  --statement "..." --prior 0.5 [--mechanism de-novo|inspired-by|refine|merge] [--parents hyp_a,hyp_b] [--testable "..."]
  hep evidence --hyp hyp_XXXX --kind simulation --direction supports --prior 0.5 --updated 0.65 --rationale "..." [--source run.log] [--bpb 1.2] [--commit abc] [--no-validate]
  hep refine   --parent hyp_XXXX --statement "..." --prior 0.6 --rationale "..."
  hep merge    --parents hyp_a,hyp_b --statement "..." --prior 0.7 --rationale "..."
  hep transition --hyp hyp_XXXX --state supported|refuted|dormant|under_test|proposed
  hep list [--json]
  hep get --hyp hyp_XXXX
  hep attachments [--check]  # regenera (ou confere) o indice de anexos do registry
  hep verify
  hep status
  hep tree [--registry PATH] [--type auto|hep|ckpt] [--no-color]
      ASCII DAG of the registry (works for hep/ AND ckpt/ registries).
      Ids are colored deterministically; colors off when piped or NO_COLOR.
`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
/** Todas as ocorrencias de `--name v` (para flags repetiveis, como `--file`). */
function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const cmd = process.argv[2];
const at = arg("at");
const h = new HEP();

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { help(); process.exit(0); }

try {
  if (cmd === "propose") {
    const statement = arg("statement"); const prior = arg("prior");
    if (!statement || !prior) throw new Error("--statement and --prior required");
    const mechanism = arg("mechanism") ?? "de-novo";
    const parents = (arg("parents") ?? "").split(",").filter(Boolean);
    const testable = arg("testable");
    const id = h.propose(statement, Number(prior), mechanism, parents, testable, at);
    console.log(`proposed ${id}`);
  } else if (cmd === "evidence" || cmd === "attach-evidence") {
    const hyp = arg("hyp"); const kind = arg("kind") ?? "analysis";
    const direction = arg("direction"); const prior = arg("prior"); const updated = arg("updated");
    const rationale = arg("rationale");
    if (!hyp || !direction || !prior || !updated || !rationale) throw new Error("--hyp --direction --prior --updated --rationale required");
    const validated = !flag("no-validate");
    const ev = h.attachEvidence(hyp, kind, direction, Number(prior), Number(updated), rationale, arg("source") ?? "", validated, arg("bpb") ? Number(arg("bpb")) : null, arg("commit") ?? "", at, argAll("file"));
    console.log(`evidence recorded for ${hyp} (${(ev.payload as Record<string, unknown>)["direction"]}, validated=${validated})`);
  } else if (cmd === "refine") {
    const parent = arg("parent"); const statement = arg("statement"); const prior = arg("prior");
    if (!parent || !statement || !prior) throw new Error("--parent --statement --prior required");
    const id = h.refineHypothesis(parent, statement, Number(prior), arg("rationale") ?? "", arg("testable"), at);
    console.log(`refined ${id} from ${parent}`);
  } else if (cmd === "merge") {
    const parents = (arg("parents") ?? "").split(",").filter(Boolean);
    const statement = arg("statement"); const prior = arg("prior");
    if (!parents.length || !statement || !prior) throw new Error("--parents --statement --prior required");
    const id = h.mergeHypotheses(parents, statement, Number(prior), arg("rationale") ?? "", arg("testable"), at);
    console.log(`merged ${id} from ${parents.join(",")}`);
  } else if (cmd === "transition") {
    const hyp = arg("hyp"); const state = arg("state");
    if (!hyp || !state) throw new Error("--hyp and --state required");
    h.transition(hyp, state, at);
    console.log(`transitioned ${hyp} -> ${state}`);
  } else if (cmd === "attachments") {
    if (flag("check")) {
      const r = h.checkAttachments();
      console.log(`checked ${r.checked} attachment pointer(s)`);
      if (!r.ok) {
        for (const b of r.bad) console.error(`BAD ${b.hyp} ${b.path} (${b.why})`);
        process.exit(1);
      }
      console.log("all attachments match their recorded sha256");
    } else {
      console.log(`wrote ${h.rebuildAttachmentsIndex()} pointer(s) to the attachment index`);
    }
  } else if (cmd === "list" || cmd === "status") {
    const s = h.status();
    if (flag("json")) { console.log(JSON.stringify(s, null, 2)); }
    else {
      console.log(`${"hyp".padEnd(12)}${"state".padEnd(12)}${"belief".padStart(7)}  mechanism   statement`);
      for (const [hid, d] of Object.entries(s)) {
        const v = d as { state: string; belief: number; mechanism: string; statement: string };
        console.log(`${hid.padEnd(12)}${v.state.padEnd(12)}${v.belief.toFixed(2).padStart(7)}  ${v.mechanism.padEnd(10)} ${v.statement.slice(0, 60)}`);
      }
      console.log(`\n${Object.keys(s).length} hypotheses`);
    }
  } else if (cmd === "get") {
    const hyp = arg("hyp"); if (!hyp) throw new Error("--hyp required");
    const r = h.getHypothesis(hyp);
    if (!r) { console.error(`not found: ${hyp}`); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "tree") {
    const regPath = arg("registry") ?? `${process.cwd()}/hep/registry.jsonl`;
    const type = (arg("type") ?? "auto") as "auto" | "hep" | "ckpt";
    if (type !== "auto" && type !== "hep" && type !== "ckpt") throw new Error("--type must be auto|hep|ckpt");
    const { nodes, flavor } = loadNodes(regPath, type);
    const color = colorsEnabled(flag("no-color") ? false : undefined);
    const out = renderTree(nodes, { color, starId: flavor === "ckpt" ? bestCkpt(nodes) : null });
    console.log(out);
  } else if (cmd === "verify") {
    const r = h.verify();
    console.log(r.ok ? "registry ok — hash chain valid" : `registry BAD at seq ${r.badSeq}`);
    process.exit(r.ok ? 0 : 1);
  } else { help(); process.exit(1); }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
