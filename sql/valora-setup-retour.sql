-- ============================================================
--  VALORA 💎 — RETOUR ARRIÈRE de sql/valora-setup.sql (+ valora-import-prets.sql)
--  ⛔ EFFACE TOUT VALORA : prêts copiés, coffres, montres, photos, journal des estimations.
--  Sans danger pour Zeste et pour l'Or : zeste.user_data (dont la copie des prêts)
--  et zeste.or_* ne sont pas touchés.
--  À n'utiliser QUE si VALORA n'a pas encore servi (sinon : sauvegarde d'abord,
--  outils/sauvegarde-valora.sh), et seulement avec l'accord de David.
-- ============================================================
begin;
drop function if exists public.valora_load_mine();
drop function if exists public.valora_save_mine(jsonb, bigint);
drop function if exists public.valora_rev_mine();
drop function if exists public.valora_photo_enregistrer(uuid, text);
drop function if exists public.valora_photo_lire(uuid);
drop function if exists public.valora_photo_supprimer(uuid);
drop function if exists public.valora_montre_cote_reserver(uuid);
drop function if exists public.valora_montre_cote_terminer(uuid, text, jsonb);
drop schema if exists valora cascade;
commit;
