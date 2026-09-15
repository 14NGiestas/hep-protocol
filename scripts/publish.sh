#!/usr/bin/env bash
# Publica o MESMO commit nos dois nomes: `hep-protocol` (unscoped) e `@igpauli/hep`.
#
# Por que dois passos: o `npm publish` usa o campo `name` do package.json, entao o
# nome escopado exige trocar o manifesto, publicar e restaurar. O trap garante a
# restauracao mesmo se o publish falhar.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
echo "== build + testes =="
npm run build
npm test

# O `npm publish` pode retornar 0 e a versao nao subir (aconteceu: o escopado ficou
# em 0.1.1 enquanto o script anunciava 0.1.3). Entao cada publish e' VERIFICADO no
# registry, e o gitHead tem de ser este commit -- sem isso o script falha alto.
HEAD=$(git rev-parse HEAD)
verify_published() {
  local name="$1" got head
  got=$(npm view "$name" version 2>/dev/null || echo "")
  head=$(npm view "$name" gitHead 2>/dev/null || echo "")
  if [ "$got" != "$VERSION" ]; then
    echo "ERRO: $name esta' em '$got' no registry (esperado $VERSION) -- o publish nao subiu" >&2
    exit 1
  fi
  if [ "$head" != "$HEAD" ]; then
    echo "ERRO: $name subiu do commit '$head' (esperado $HEAD)" >&2
    exit 1
  fi
  echo "  verificado no registry: $name@$got (gitHead $head)"
}

echo "== publish hep-protocol@$VERSION =="
npm publish --access public
verify_published hep-protocol

echo "== publish @igpauli/hep@$VERSION (troca o name, publica, restaura) =="
cp package.json package.json.bak
trap 'mv -f package.json.bak package.json' EXIT
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.name = "@igpauli/hep";
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
npm publish --access public
mv -f package.json.bak package.json
trap - EXIT
verify_published @igpauli/hep

echo "ok: hep-protocol E @igpauli/hep em $VERSION, ambos verificados no registry"
