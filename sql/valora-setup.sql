-- ============================================================
--  VALORA 💎 — schéma « valora » (Prêts, Coffres, Montres) + photos + quota d'estimation
--  ⚠️ PRÉPARÉ, NON APPLIQUÉ. À exécuter seulement après le « go » de David,
--     sous le verrou de déploiement, d'abord en répétition BEGIN … ROLLBACK.
--
--  Même principe que Zeste (déjà éprouvé en production) :
--   - UNE ligne par compte (valora.user_data), tout l'état dans « data » (jsonb) :
--     prêts (debts), coffres (coffres), montres (montres) ;
--   - numéro de version « rev » : un appareil qui n'a pas la dernière version
--     est refusé (« Conflit de synchronisation »), jamais d'écrasement silencieux ;
--   - aucun accès direct aux tables (RLS activée, AUCUNE policy) : tout passe par
--     des fonctions security definer, réservées aux comptes connectés (auth.uid()).
--  Les photos (objets des coffres, montres) sont à part (valora.photos), pour que
--  l'état synchronisé reste léger.
--  L'onglet Or n'est PAS ici : ses tables restent zeste.or_* (déjà en production,
--  aucune copie, aucun risque pour les achats, ventes et l'historique).
--  Idempotent : peut être rejoué.
-- ============================================================

begin;

create schema if not exists valora;
revoke all on schema valora from public;

-- ------------------------------------------------------------
--  1. État synchronisé par compte
-- ------------------------------------------------------------
create table if not exists valora.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table valora.user_data enable row level security;
revoke all on valora.user_data from public;

-- Contrôle des remboursements de prêts : copie EXACTE de zeste.verif_remboursements
-- (mêmes règles, mêmes messages : l'appli reconnaît « Remboursement refusé »).
create or replace function valora.verif_remboursements(p_data jsonb)
returns void language plpgsql immutable set search_path = valora, public as $$
declare
  d jsonb; r jsonb; a numeric; init numeric; tot numeric; n int; nd int;
begin
  if p_data is null or jsonb_typeof(p_data->'debts') is distinct from 'array' then return; end if;
  for d in select value from jsonb_array_elements(p_data->'debts') loop
    if jsonb_typeof(d) <> 'object' or coalesce(jsonb_typeof(d->'repays'),'null') = 'null' then continue; end if;
    if jsonb_typeof(d->'repays') <> 'array' then
      raise exception 'Remboursement refusé : liste de remboursements invalide';
    end if;
    n := jsonb_array_length(d->'repays');
    if n = 0 then continue; end if;
    if d->>'kind' is distinct from 'money' then
      raise exception 'Remboursement refusé : seul un prêt d''argent peut avoir des remboursements';
    end if;
    if jsonb_typeof(d->'amount') is distinct from 'number' then
      raise exception 'Remboursement refusé : montant du prêt invalide';
    end if;
    init := round((d->>'amount')::numeric, 2);
    tot := 0;
    for r in select value from jsonb_array_elements(d->'repays') loop
      if jsonb_typeof(r->'amount') is distinct from 'number' then
        raise exception 'Remboursement refusé : montant manquant ou non numérique';
      end if;
      a := (r->>'amount')::numeric;
      if a <= 0 then raise exception 'Remboursement refusé : le montant doit être supérieur à 0'; end if;
      if a <> round(a, 2) then raise exception 'Remboursement refusé : 2 décimales au maximum'; end if;
      if coalesce(r->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Remboursement refusé : date manquante ou invalide';
      end if;
      begin
        perform (r->>'date')::date;
      exception when others then
        raise exception 'Remboursement refusé : date invalide (%)', r->>'date';
      end;
      tot := tot + a;
    end loop;
    select count(distinct value->>'id') into nd from jsonb_array_elements(d->'repays');
    if nd <> n then raise exception 'Remboursement refusé : remboursement en double'; end if;
    if tot > init then
      raise exception 'Remboursement refusé : % remboursés pour un prêt de %', tot, init;
    end if;
  end loop;
end;
$$;

-- Contrôle global de l'état : remboursements + forme + taille (les photos n'y sont jamais)
create or replace function valora.verif_donnees(p_data jsonb)
returns void language plpgsql immutable set search_path = valora, public as $$
declare k text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Enregistrement refusé : données invalides';
  end if;
  foreach k in array array['debts','coffres','montres'] loop
    if p_data ? k and jsonb_typeof(p_data->k) <> 'array' then
      raise exception 'Enregistrement refusé : liste « % » invalide', k;
    end if;
  end loop;
  if octet_length(p_data::text) > 2000000 then
    raise exception 'Enregistrement refusé : données trop volumineuses (2 Mo maximum)';
  end if;
  perform valora.verif_remboursements(p_data);
end;
$$;

create or replace function public.valora_load_mine()
returns jsonb language plpgsql stable security definer set search_path = valora, public as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select data, rev into r from valora.user_data where user_id = auth.uid();
  if not found then return jsonb_build_object('data', null, 'rev', null); end if;
  return jsonb_build_object('data', r.data, 'rev', r.rev);
end;
$$;

create or replace function public.valora_save_mine(p_data jsonb, p_base_rev bigint)
returns bigint language plpgsql security definer set search_path = valora, public as $$
declare cur bigint;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform valora.verif_donnees(p_data);
  select rev into cur from valora.user_data where user_id = auth.uid() for update;
  if not found then
    if p_base_rev is not null then
      raise exception 'Conflit de synchronisation : aucune donnée sur le serveur (version % attendue)', p_base_rev;
    end if;
    insert into valora.user_data(user_id, data, updated_at, rev) values (auth.uid(), p_data, now(), 1);
    return 1;
  end if;
  if p_base_rev is distinct from cur then
    raise exception 'Conflit de synchronisation : version % attendue, % sur le serveur', p_base_rev, cur;
  end if;
  update valora.user_data set data = p_data, updated_at = now(), rev = cur + 1 where user_id = auth.uid();
  return cur + 1;
end;
$$;

create or replace function public.valora_rev_mine()
returns jsonb language plpgsql stable security definer set search_path = valora, public as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select rev, updated_at into r from valora.user_data where user_id = auth.uid();
  if not found then return jsonb_build_object('rev', null); end if;
  return jsonb_build_object('rev', r.rev, 'maj', r.updated_at);
end;
$$;

-- ------------------------------------------------------------
--  2. Photos (objets des coffres, montres) — JPEG en base64, 450 Ko maximum
--     (mêmes limites que les photos de l'onglet Or)
-- ------------------------------------------------------------
create table if not exists valora.photos (
  id       uuid primary key,
  user_id  uuid not null references auth.users(id) on delete cascade,
  image    text not null,
  cree_le  timestamptz not null default now()
);
create index if not exists photos_user_idx on valora.photos(user_id);
alter table valora.photos enable row level security;
revoke all on valora.photos from public;

-- l'identifiant est choisi par l'appareil (uuid) : renvoyer la même photo deux fois
-- (réponse perdue, nouvel essai) ne crée jamais de doublon
create or replace function public.valora_photo_enregistrer(p_id uuid, p_image text)
returns void language plpgsql security definer set search_path = valora, public as $$
declare u uuid := auth.uid(); proprio uuid;
begin
  if u is null then raise exception 'Photo : connexion requise'; end if;
  if p_id is null then raise exception 'Photo : identifiant manquant'; end if;
  if p_image is null or p_image not like 'data:image/jpeg;base64,%' or length(p_image) > 600000 then
    raise exception 'Photo refusée (JPEG de 450 Ko maximum)';
  end if;
  select user_id into proprio from valora.photos where id = p_id;
  if found and proprio <> u then raise exception 'Photo : identifiant déjà utilisé'; end if;
  if not found and (select count(*) from valora.photos where user_id = u) >= 1000 then
    raise exception 'Photo refusée : 1000 photos au maximum';
  end if;
  insert into valora.photos (id, user_id, image) values (p_id, u, p_image)
  on conflict (id) do update set image = excluded.image, cree_le = now();
end;
$$;

create or replace function public.valora_photo_lire(p_id uuid)
returns text language plpgsql stable security definer set search_path = valora, public as $$
declare u uuid := auth.uid(); img text;
begin
  if u is null then raise exception 'Photo : connexion requise'; end if;
  select image into img from valora.photos where id = p_id and user_id = u;
  return img;
end;
$$;

create or replace function public.valora_photo_supprimer(p_id uuid)
returns void language plpgsql security definer set search_path = valora, public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Photo : connexion requise'; end if;
  delete from valora.photos where id = p_id and user_id = u;
end;
$$;

-- ------------------------------------------------------------
--  3. Estimation des montres : journal + quota (appelé par l'edge function
--     valora-montre-cote avec la clé service, jamais par l'appli)
--     20 estimations par jour et par compte, 300 par mois au total.
-- ------------------------------------------------------------
create table if not exists valora.montres_cotes (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  cree_le   timestamptz not null default now(),
  statut    text not null default 'en_cours' check (statut in ('en_cours','fiable','non_fiable','erreur')),
  resultat  jsonb,
  fini_le   timestamptz
);
create index if not exists montres_cotes_date_idx on valora.montres_cotes(cree_le);
alter table valora.montres_cotes enable row level security;
revoke all on valora.montres_cotes from public;

create or replace function public.valora_montre_cote_reserver(p_user uuid)
returns uuid language plpgsql security definer set search_path = valora, public as $$
declare n_jour int; n_mois int; nid uuid;
begin
  if p_user is null then raise exception 'Estimation : compte manquant'; end if;
  -- un seul compteur à la fois (deux demandes simultanées ne dépassent pas le quota)
  perform pg_advisory_xact_lock(hashtext('valora_montre_cote'));
  select count(*) into n_jour from valora.montres_cotes
   where user_id = p_user and cree_le >= date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  if n_jour >= 20 then raise exception 'Quota atteint : 20 estimations par jour, réessaie demain'; end if;
  select count(*) into n_mois from valora.montres_cotes
   where cree_le >= date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  if n_mois >= 300 then raise exception 'Quota atteint : 300 estimations ce mois-ci'; end if;
  insert into valora.montres_cotes (user_id) values (p_user) returning id into nid;
  return nid;
end;
$$;

create or replace function public.valora_montre_cote_terminer(p_id uuid, p_statut text, p_resultat jsonb)
returns void language plpgsql security definer set search_path = valora, public as $$
begin
  if p_statut not in ('fiable','non_fiable','erreur') then raise exception 'Estimation : statut invalide'; end if;
  update valora.montres_cotes set statut = p_statut, resultat = p_resultat, fini_le = now()
   where id = p_id and statut = 'en_cours';
end;
$$;

-- ------------------------------------------------------------
--  4. Droits : rien pour anon ; l'appli (authenticated) n'a que ses fonctions ;
--     le quota d'estimation est réservé à la clé service
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'valora.verif_remboursements(jsonb)', 'valora.verif_donnees(jsonb)',
    'public.valora_load_mine()', 'public.valora_save_mine(jsonb,bigint)', 'public.valora_rev_mine()',
    'public.valora_photo_enregistrer(uuid,text)', 'public.valora_photo_lire(uuid)', 'public.valora_photo_supprimer(uuid)',
    'public.valora_montre_cote_reserver(uuid)', 'public.valora_montre_cote_terminer(uuid,text,jsonb)'
  ] loop
    execute format('revoke all on function %s from public', f);
    begin
      execute format('revoke all on function %s from anon, authenticated, service_role', f);
    exception when undefined_object then null; end;
  end loop;
end $$;

do $$ begin
  grant execute on function public.valora_load_mine()                       to authenticated;
  grant execute on function public.valora_save_mine(jsonb,bigint)           to authenticated;
  grant execute on function public.valora_rev_mine()                        to authenticated;
  grant execute on function public.valora_photo_enregistrer(uuid,text)      to authenticated;
  grant execute on function public.valora_photo_lire(uuid)                  to authenticated;
  grant execute on function public.valora_photo_supprimer(uuid)             to authenticated;
  grant execute on function public.valora_montre_cote_reserver(uuid)        to service_role;
  grant execute on function public.valora_montre_cote_terminer(uuid,text,jsonb) to service_role;
exception when undefined_object then null; end $$;

commit;

-- Vérification après application :
--   select to_regprocedure('public.valora_load_mine()'), to_regprocedure('public.valora_save_mine(jsonb,bigint)'),
--          to_regprocedure('public.valora_photo_enregistrer(uuid,text)'), to_regprocedure('public.valora_montre_cote_reserver(uuid)');
--   select relname, relrowsecurity from pg_class where relnamespace = 'valora'::regnamespace and relkind = 'r';
-- Retour arrière : sql/valora-setup-retour.sql (⚠️ efface tout VALORA : prêts copiés, coffres, montres, photos).
