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

echo "== publish hep-protocol@$VERSION =="
npm publish --access public

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

echo "ok: hep-protocol e @igpauli/hep publicados em $VERSION"
