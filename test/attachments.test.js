// Anexos: o evento carrega o POINTER DE CONTEUDO (sha256 + size), entao a propria
// cadeia cobre o anexo. A tabela ao lado do registry e' indice derivado -- reconstruivel,
// nunca fonte de confianca (por isso adulterar a tabela nao salva um anexo adulterado).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEP } from "../dist/index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hep-att-"));
  const annex = join(dir, "anexo.txt");
  writeFileSync(annex, "evidencia");
  const h = new HEP(join(dir, "registry.jsonl"));
  const id = h.propose("a", 0.5);
  h.attachEvidence(id, "analysis", "supports", 0.5, 0.5, "com anexo", "doc.md",
                   false, null, "", undefined, [annex]);
  return { dir, annex, h, id };
}

test("--file grava o pointer INLINE no evento (a cadeia cobre o anexo)", () => {
  const { dir, annex, h } = setup();
  const ev = JSON.parse(readFileSync(h.path, "utf8").trim().split("\n").pop());
  assert.equal(ev.payload.attachments.length, 1);
  assert.equal(ev.payload.attachments[0].path, annex);
  assert.equal(ev.payload.attachments[0].size, 9);
  assert.match(ev.payload.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(h.verify().ok, true, "o pointer esta' no payload, entao a cadeia o cobre");
  assert.equal(h.checkAttachments().ok, true);
  assert.equal(existsSync(join(dir, "attachments.jsonl")), true, "indice ao lado do registry");
});

test("editar o ANEXO e' detectado -- e adulterar a TABELA nao salva", () => {
  const { dir, annex, h } = setup();
  appendFileSync(annex, "x");
  const r = h.checkAttachments();
  assert.equal(r.ok, false);
  assert.equal(r.bad[0].path, annex);
  assert.equal(r.bad[0].why, "conteudo mudou");
  // a tabela e' DERIVADA do payload: regenera-la nao muda nada (e nao esconde o anexo)
  const idx = join(dir, "attachments.jsonl");
  const before = readFileSync(idx, "utf8");
  h.rebuildAttachmentsIndex();
  assert.equal(readFileSync(idx, "utf8"), before, "reconstrucao devolve o mesmo (vem do payload)");
  assert.equal(h.checkAttachments().ok, false, "e o anexo adulterado continua acusado");
});

test("adulterar o POINTER no evento quebra a cadeia", () => {
  const { h } = setup();
  const linhas = readFileSync(h.path, "utf8").trim().split("\n").map((l, i) => {
    if (i !== 1) return l;
    const e = JSON.parse(l);
    e.payload.attachments[0].sha256 = "0".repeat(64);   // mente sobre o anexo
    return JSON.stringify(e);
  });
  writeFileSync(h.path, linhas.join("\n") + "\n");
  assert.equal(h.verify().ok, false, "o payload esta' na cadeia: mentir quebra o hash");
});
