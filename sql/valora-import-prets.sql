-- ============================================================
--  VALORA 💎 — copie des PRÊTS de Zeste vers VALORA
--  ⚠️ PRÉPARÉ, NON APPLIQUÉ. À exécuter après sql/valora-setup.sql, sous le verrou
--     de déploiement, d'abord en répétition BEGIN … ROLLBACK.
--
--  COPIE, jamais déplacement : zeste.user_data n'est PAS modifié. Les prêts restent
--  dans la sauvegarde de Zeste (invisibles dans Zeste une fois la nouvelle version
--  publiée) : c'est la copie de sécurité.
--
--  Pour chaque compte qui a des prêts dans Zeste :
--   - compte sans ligne VALORA → ligne créée avec ses prêts ;
--   - compte qui a déjà une ligne VALORA → seuls les prêts ABSENTS (même identifiant)
--     sont ajoutés ; un prêt déjà présent dans VALORA n'est jamais remplacé
--     (il a pu y être modifié depuis).
--  Le numéro de version avance : les appareils ouverts relisent l'état.
--  Rejouable sans risque (deuxième passage = 0 ajout). Contrôlé par le même
--  verrou que les enregistrements de l'appli (for update).
-- ============================================================

begin;

do $$
declare
  z record; cur jsonb; ajout jsonb; n_ajout int; n_total int := 0; n_comptes int := 0;
begin
  for z in
    select user_id, data->'debts' as debts from zeste.user_data
     where jsonb_typeof(data->'debts') = 'array' and jsonb_array_length(data->'debts') > 0
     order by user_id
  loop
    select data into cur from valora.user_data where user_id = z.user_id for update;
    if not found then
      perform valora.verif_donnees(jsonb_build_object('debts', z.debts));
      insert into valora.user_data(user_id, data, rev, updated_at)
      values (z.user_id, jsonb_build_object('debts', z.debts, 'coffres', '[]'::jsonb, 'montres', '[]'::jsonb), 1, now());
      n_ajout := jsonb_array_length(z.debts);
    else
      select coalesce(jsonb_agg(d.value order by d.ord), '[]'::jsonb), count(*)
        into ajout, n_ajout
        from jsonb_array_elements(z.debts) with ordinality as d(value, ord)
       where not exists (
         select 1 from jsonb_array_elements(coalesce(cur->'debts', '[]'::jsonb)) v
          where v.value->>'id' = d.value->>'id');
      if n_ajout > 0 then
        cur := jsonb_set(cur, '{debts}', coalesce(cur->'debts', '[]'::jsonb) || ajout, true);
        perform valora.verif_donnees(cur);
        update valora.user_data set data = cur, rev = rev + 1, updated_at = now() where user_id = z.user_id;
      end if;
    end if;
    n_total := n_total + n_ajout; n_comptes := n_comptes + 1;
    raise notice 'Compte % : % prêt(s) ajouté(s) dans VALORA', z.user_id, n_ajout;
  end loop;
  raise notice 'Terminé : % compte(s), % prêt(s) ajouté(s)', n_comptes, n_total;
end $$;

commit;

-- ------------------------------------------------------------
--  Contrôle (lecture seule) — à lancer juste après : pour chaque compte, chaque prêt
--  de Zeste doit exister dans VALORA, avec le même montant, la même devise et les
--  mêmes remboursements. Résultat attendu : 0 ligne.
-- ------------------------------------------------------------
--  with z as (
--    select u.user_id, d.value as p from zeste.user_data u, jsonb_array_elements(u.data->'debts') d
--     where jsonb_typeof(u.data->'debts') = 'array'
--  ), v as (
--    select u.user_id, d.value as p from valora.user_data u, jsonb_array_elements(u.data->'debts') d
--     where jsonb_typeof(u.data->'debts') = 'array'
--  )
--  select z.user_id, z.p->>'id' as pret, z.p->>'who' as qui
--    from z left join v on v.user_id = z.user_id and v.p->>'id' = z.p->>'id'
--   where v.p is null
--      or v.p->'amount' is distinct from z.p->'amount'
--      or coalesce(v.p->>'cur','EUR') is distinct from coalesce(z.p->>'cur','EUR')
--      or coalesce(v.p->'repays','[]'::jsonb) is distinct from coalesce(z.p->'repays','[]'::jsonb);
--
--  Totaux par compte et par devise (Zeste = VALORA attendu) :
--  select 'zeste' as base, user_id, coalesce(d->>'cur','EUR') cur, count(*) prets,
--         sum((d->>'amount')::numeric) prete, sum(coalesce(jsonb_array_length(d->'repays'),0)) remboursements
--    from zeste.user_data, jsonb_array_elements(data->'debts') d group by 1,2,3
--  union all
--  select 'valora', user_id, coalesce(d->>'cur','EUR'), count(*), sum((d->>'amount')::numeric), sum(coalesce(jsonb_array_length(d->'repays'),0))
--    from valora.user_data, jsonb_array_elements(data->'debts') d group by 1,2,3 order by 2,3,1;
