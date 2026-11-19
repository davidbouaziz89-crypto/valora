#!/bin/bash
# Estimation des montres : appel RÉEL (Claude + recherche web + BCE) de valora-montre-cote sur l'environnement
# de TEST (~/zeste-test, jamais la production), avec le compte fictif essai@zeste-test.fr.
# Coût : ≈ 0,25 $ par montre. Prérequis : fonction copiée dans ~/zeste-test/functions/valora-montre-cote,
# sql/valora-setup.sql appliqué sur zt-db, ANTHROPIC_API_KEY dans ~/zeste-test/functions.env (retirée après l'essai).
# Usage (sur le serveur, fichier copié) : bash test-cote-reel.sh 'marque|modele|reference|devise' …
cd ~/zeste-test || exit 1
. ./.env
API=https://zeste-test.srv.proformationplus.fr
ANON=$(cat anon.key)
b64url(){ openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt(){ h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url); p=$(printf '{"sub":"%s","role":"authenticated","aud":"authenticated","iss":"supabase","iat":%s,"exp":%s}' "$1" "$(date +%s)" "$(( $(date +%s) + 1800 ))" | b64url); s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url); printf '%s.%s.%s' "$h" "$p" "$s"; }
E=$(docker exec zt-db psql -U supabase_admin -d postgres -At -c "select id from auth.users where email='essai@zeste-test.fr'" < /dev/null)
T=$(jwt "$E")
for m in "$@"; do
  IFS='|' read -r MARQUE MODELE REF DEV <<< "$m"
  CORPS=$(jq -cn --arg a "$MARQUE" --arg b "$MODELE" --arg c "$REF" --arg d "$DEV" '{marque:$a, modele:$b, reference:$c, devise:$d}')
  DEBUT=$(date +%s)
  R=$(curl -s --max-time 300 -w '\n%{http_code}' -X POST "$API/functions/v1/valora-montre-cote" -H "apikey: $ANON" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$CORPS")
  echo "=== $MARQUE $MODELE $REF ($DEV) — HTTP $(tail -n1 <<< "$R") en $(( $(date +%s) - DEBUT )) s"
  head -n -1 <<< "$R"
done
# journal du quota et coût réel enregistré par la fonction (sans données personnelles : compte fictif)
docker exec zt-db psql -U supabase_admin -d postgres -At -c "select statut, round((resultat->'recherche'->'usage'->>'cout_estime_usd')::numeric, 3), resultat->'recherche'->>'stop_reason', extract(epoch from fini_le - cree_le)::int from valora.montres_cotes order by cree_le desc limit $#" < /dev/null
