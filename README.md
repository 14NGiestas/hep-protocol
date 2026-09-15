# hep-protocol

Auditable Hypothesis Evolution Protocol — JS port of arXiv:2607.09195v1 (Takahara & Mizoguchi).

Every hypothesis is a persistent object with a belief `P(H)`, lineage, and an append-only hash-chained log. Belief moves only by validated evidence. Verdicts are threshold-gated. All 7 paper tools are implemented.

## Install

```bash
npx --yes hep-protocol status          # no install, runs 0.1.0
npm i -g hep-protocol && hep status    # or global
npm i hep-protocol                     # as library
```

`@igpauli/hep` is the same package under your scope: `npx --yes @igpauli/hep status`.


## Tree (v0.1.2+)

ASCII DAG of any hash-chained registry — hypotheses *or* model checkpoints:

```bash
hep tree                                            # ./hep/registry.jsonl
hep tree --registry ckpt/registry.jsonl             # auto-detected flavor
hep tree --registry x.jsonl --type hep|ckpt         # force flavor
hep tree --no-color                                 # plain (also automatic when piped or NO_COLOR)
```

Node ids are colored deterministically (same id, same color, every run);
ckpt mode crowns the lowest-bpb node with ★. Shared children (e.g. a soup
with two parents) render once, with `↩ id (see above)` at the other parent.

## CLI

```bash
# propose
hep propose --statement "B-site size drives rock-salt order" --prior 0.45 --mechanism de-novo --testable "predicts ordering for Ba2FeMoO6"

# attach evidence — belief moves only if validated (simulation/experiment/analysis)
hep evidence --hyp hyp_abc123 --kind simulation --direction supports --prior 0.45 --updated 0.83 --rationale "DFT: -0.42eV/f.u." --source run.log

# evolve (paper §4.1 — requires parent has evidence or verdict)
hep refine --parent hyp_abc123 --statement "refined: size + covalency" --prior 0.58
hep merge --parents hyp_abc123,hyp_def456 --statement "merged governing rule" --prior 0.81

# verdict — enforced thresholds
hep transition --hyp hyp_abc123 --state supported   # requires P(H) ≥ 0.8
hep transition --hyp hyp_abc123 --state refuted     # requires P(H) ≤ 0.2
hep transition --hyp hyp_abc123 --state dormant

# read
hep status                 # table: hyp, state, belief, mechanism
hep list --json
hep get --hyp hyp_abc123
hep verify                 # checks hash chain: registry ok / BAD at seq N
```

Mechanisms: `de-novo` | `inspired-by` (provenance-only, gen 0) | `refine` (parent+1) | `merge` (max(parents)+1)  
Kinds: `simulation` `experiment` `literature` `derivation` `analysis`  
Directions: `supports` `refutes` `inconclusive`  
States: `proposed` `under_test` `supported` `refuted` `dormant`

## JS API

```ts
import { HEP } from "hep-protocol"; // or "@igpauli/hep"

const hep = new HEP(); // defaults to ./hep/registry.jsonl
const h1 = hep.propose("B-site size drives order", 0.45, "de-novo", [], "predicts ordering");
hep.attachEvidence(h1, "simulation", "supports", 0.45, 0.83, "DFT -0.42eV", "run.log", true);
hep.transition(h1, "supported");

const h2 = hep.refineHypothesis(h1, "size + covalency", 0.58);
const h3 = hep.mergeHypotheses([h1, h2], "governing rule", 0.81);

console.log(hep.status());
console.log(hep.verify()); // { ok: true }
```

Registry is `hep/registry.jsonl` — append-only, `sha256(prev + stableStringify(payload))` with Python `json.dumps(sort_keys=True, ensure_ascii=True)` compat. Existing `hep.py` logs read verbatim.

## Why

Without HEP, hypotheses and belief updates stay buried in chat logs. HEP externalizes the hypothesis–test–evidence–belief cycle so both agent and human can audit how each belief moved and how each hypothesis descends.
