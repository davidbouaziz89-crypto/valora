#!/bin/bash
# VALORA 💎 — sauvegarde du schéma valora de la PRODUCTION (lecture seule), à lancer SUR LE SERVEUR.
# Même principe que outils/sauvegarde-zeste.sh (dépôt Zeste). Produit dans ~/sauvegardes/valora-<date>/ :
#   valora.dump     format personnalisé (restauration : pg_restore), structure + données (prêts, coffres, montres, photos)
#   empreintes.txt  nombre de lignes par table + md5 des données de chaque compte
# Rien n'est modifié en base (transaction en lecture seule).
# ⚠️ L'onglet Or est dans le schéma zeste (zeste.or_*) : sauvegardé par outils/sauvegarde-zeste.sh du dépôt Zeste.
set -euo pipefail
D=~/sauvegardes/valora-$(date +%Y%m%d-%H%M%S); mkdir -p "$D"; chmod 700 "$D"; umask 077
cd /opt/supabase
DC="sudo docker compose exec -T db"
$DC pg_dump -U supabase_admin -d postgres -n valora -Fc > "$D/valora.dump"
Q(){ sudo docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' db psql -U supabase_admin -d postgres -At "$@"; }
Q -F ' ' -c "select 'table', c.relname, (xpath('//n/text()', query_to_xml('select count(*) n from valora.'||quote_ident(c.relname), false, false, '')))[1]::text from pg_class c where c.relnamespace='valora'::regnamespace and c.relkind='r' union all select 'compte', user_id::text, md5(data::text) from valora.user_data order by 1,2" > "$D/empreintes.txt"
ls -la "$D" | tail -n +2
echo "$D"
