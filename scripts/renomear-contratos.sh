#!/usr/bin/env bash
# Organiza os 8 contratos oficiais em contracts/<responsavel>/<aluno>__<matricula>.pdf
# e atualiza os caminhos em document_acceptances.
# Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... bash scripts/renomear-contratos.sh
set -euo pipefail

: "${SUPABASE_URL:?defina SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?defina SUPABASE_SERVICE_ROLE_KEY}"
KEY="$SUPABASE_SERVICE_ROLE_KEY"

api() {
  curl -fsS -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/json" "$@"
}

move() {
  api -X POST "$SUPABASE_URL/storage/v1/object/move" \
    -d "{\"bucketId\":\"contract-files\",\"sourceKey\":\"$1\",\"destinationKey\":\"$2\"}" > /dev/null
}

# acceptance_id | nome atual (responsavel__aluno__matricula) | pasta/arquivo novo
while IFS='|' read -r id old new; do
  move "contracts/$old.pdf" "contracts/$new.pdf"
  move "contracts/$old-assinado.pdf" "contracts/$new-assinado.pdf"
  api -X PATCH "$SUPABASE_URL/rest/v1/document_acceptances?id=eq.$id" -H "Prefer: return=minimal" \
    -d "{\"generated_storage_path\":\"contracts/$new.pdf\",\"signed_storage_path\":\"contracts/$new-assinado.pdf\"}"
  echo "ok  $new"
done <<'EOF'
82185467-b7c1-4df4-a68f-268182d12314|ivana-lara-costa-dos-santos__lara-costa-dos-santos-folgado__5b210ff8|ivana-lara-costa-dos-santos/lara-costa-dos-santos-folgado__5b210ff8
de049399-7932-47a0-9f7b-0f7c5d909e5a|lidiane-alves-de-souza__liz-alves-lima__ca116a54|lidiane-alves-de-souza/liz-alves-lima__ca116a54
d779f2bf-2960-47c4-9247-bf0e13c12d53|luciel-gomes-dos-santos-costa__perola-lopes-gomes-costa__5fb2d744|luciel-gomes-dos-santos-costa/perola-lopes-gomes-costa__5fb2d744
e750e2fc-1bd3-42ba-bb82-b8c11b44cda0|lulialia-prates-costa__ayla-sousa-prates__95027c62|lulialia-prates-costa/ayla-sousa-prates__95027c62
0aa16e8b-1cfa-476c-88a9-83daf9c8e60b|ramatila-justino-de-abreu__davi-de-abreu-nascimento__ee85c5e9|ramatila-justino-de-abreu/davi-de-abreu-nascimento__ee85c5e9
c2590f30-8034-4b40-9581-a94144e1ecc1|sarah-ivana-souza-miranda__samuel-souza-mranda__be4e2b59|sarah-ivana-souza-miranda/samuel-souza-mranda__be4e2b59
10021654-0093-4fbd-b221-8e6cfe2945ee|simone-batista-dos-santos__davi-angelo-santos-santana__33fa48ce|simone-batista-dos-santos/davi-angelo-santos-santana__33fa48ce
c9eadbe1-e15e-402a-a3e6-f5281c77d8d2|thiago-de-oliveira-martins__nicole-zaine-nunes-martins__79f00dfc|thiago-de-oliveira-martins/nicole-zaine-nunes-martins__79f00dfc
EOF
