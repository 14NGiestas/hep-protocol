#!/usr/bin/env bash
# Publica o MESMO commit nos dois nomes: `hep-protocol` (unscoped) e `@igpauli/hep`.
#
# Idempotente e com paciencia, porque duas coisas mordem:
#  1. `npm publish` usa o campo `name` do manifesto, entao o nome escopado exige trocar,
#     publicar e restaurar (com trap, para restaurar mesmo em falha);
#  2. o registry do npm TEM ATRASO DE REPLICACAO -- publicar e' sucesso, mas um
#     `npm view` imediato ainda devolve a versao antiga ("being processed and may take a
#     few minutes"). Conferir uma vez so' produz alarme falso e derruba o outro nome.
# Por isso: se a versao JA' esta' no registry, PULA o publish (rerodar e' seguro);
# depois publicar, espera ate' ~3 min pela replicacao antes de dar o veredito.
set -uo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
HEAD=$(git rev-parse HEAD)
FAIL=0

published_version() { npm view "$1" version 2>/dev/null || echo ""; }

# Publica so' se faltar. Devolve 0 tambem quando pula (mas registra em SKIPPED).
publish_if_needed() {
  local name="$1" have
  have=$(published_version "$name")
  if [ "$have" = "$VERSION" ]; then
    echo "== $name@$VERSION ja' esta' no registry -- pulando o publish =="
    SKIPPED="yes"
    return 0
  fi
  SKIPPED="no"
  echo "== publish $name@$VERSION (registry tem '${have:-nada}') =="
  npm publish --access public
}

# Confere o resultado NO REGISTRY, com retentativas. O gitHead so' e' exigido para o que
# ESTA' publicando agora; para o que foi pulado ele e' informativo (o HEAD local ja' pode
# ter andado por commits que nao mexeram no pacote).
verify_published() {
  local name="$1" got head tries=0
  while :; do
    got=$(published_version "$name")
    head=$(npm view "$name" gitHead 2>/dev/null || echo "")
    if [ "$got" = "$VERSION" ]; then
      if [ "$SKIPPED" = "yes" ] || [ "$head" = "$HEAD" ]; then
        echo "  verificado no registry: $name@$got (gitHead ${head:0:8}$([ "$head" = "$HEAD" ] || echo ' -- de outro commit, ok pois foi pulado'))"
        return 0
      fi
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 12 ]; then
      echo "ERRO: $name esta' em '${got:-nada}' (gitHead '${head:0:8}'); esperado $VERSION de ${HEAD:0:8}" >&2
      return 1
    fi
    echo "  aguardando replicacao do npm (${tries}/12, 15s): registry ainda diz '${got:-nada}'..."
    sleep 15
  done
}

echo "== build + testes =="
npm run build
npm test

publish_if_needed hep-protocol || FAIL=1
verify_published hep-protocol || FAIL=1

echo
echo "== @igpauli/hep@$VERSION (troca o name, publica, restaura) =="
cp package.json package.json.bak
trap 'mv -f package.json.bak package.json' EXIT
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.name = "@igpauli/hep";
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
publish_if_needed @igpauli/hep || FAIL=1
verify_published @igpauli/hep || FAIL=1
mv -f package.json.bak package.json
trap - EXIT

if [ "$FAIL" = 0 ]; then
  echo "ok: hep-protocol E @igpauli/hep em $VERSION, ambos conferidos no registry"
else
  echo "FALHOU: veja acima QUAL dos dois nomes nao subiu" >&2
fi
exit "$FAIL"
