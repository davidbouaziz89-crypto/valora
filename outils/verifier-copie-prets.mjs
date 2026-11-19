// VALORA 💎 — répétition de la mise en ligne sur une COPIE LOCALE des vraies données (jamais la production).
// Recharge une sauvegarde de Zeste (zeste.sql produit par outils/sauvegarde-zeste.sh du dépôt Zeste) dans une
// base jetable en mémoire (pglite, Postgres 17), puis : schéma VALORA, copie des prêts, contrôles, rejeu,
// retour arrière. Affiche seulement des nombres et des totaux (aucun nom).
// Usage : PGLITE_DIR=<dossier pglite> node outils/verifier-copie-prets.mjs <dossier de la sauvegarde>
// Le dossier de sauvegarde contient des données personnelles : le supprimer après usage.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lireSql = f => readFileSync(path.join(RACINE, 'sql', f), 'utf8');

// Base jetable = structure ET données exactes de la sauvegarde, plus un prélude qui imite Supabase
export async function baseDepuisSauvegarde(dir){
  const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
  const { PGlite } = await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href);
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role supabase_admin nologin; create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
  const empreintes = readFileSync(path.join(dir, 'empreintes.txt'), 'utf8').trim().split('\n').map(l => l.split(' '));
  for (const [, id] of empreintes.filter(x => x[0] === 'compte')) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.exec(readFileSync(path.join(dir, 'zeste.sql'), 'utf8').split('\n').filter(l => !/^\\(un)?restrict /.test(l)).join('\n'));
  // fonctions public.zeste_* : définitions exactes de la production (fonctions.sql de la même sauvegarde)
  await db.exec(readFileSync(path.join(dir, 'fonctions.sql'), 'utf8'));
  await db.exec('grant usage on schema zeste to anon, authenticated, service_role;');
  // fonctions de la sauvegarde : mêmes droits qu'en production (pg_dump --no-privileges ne les recopie pas)
  for (const f of (await db.query(`select p.oid::regprocedure::text f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'zeste%'`)).rows)
    await db.exec(`grant execute on function ${f.f} to authenticated, service_role`);
  return { db, comptes: empreintes.filter(x => x[0] === 'compte').map(x => x[1]) };
}
export async function rpc(db, nom, args, uid){
  const cles = Object.keys(args);
  await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: 'authenticated' })}', true);`);
  try{
    const r = await db.query(`select public.${nom}(${cles.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, cles.map(k => typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
    await db.exec('commit'); return r.rows[0].r;
  }catch(e){ await db.exec('rollback'); throw e; }
}
const empreinteZeste = async db => (await db.query(`select md5(string_agg(md5(data::text), '' order by user_id)) h from zeste.user_data`)).rows[0].h;
const empreinteOr = async db => (await db.query(`select md5(coalesce((select string_agg(md5(t::text), '' order by t.id) from zeste.or_lots t), '') || coalesce((select string_agg(md5(t::text), '' order by t.id) from zeste.or_ventes t), '')) h`)).rows[0].h;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage : node outils/verifier-copie-prets.mjs <dossier de la sauvegarde>'); process.exit(2); }
  const { db, comptes } = await baseDepuisSauvegarde(dir);
  let ok = 0, ko = 0;
  const v = (bon, txt) => { console.log((bon ? 'OK   ' : 'KO   ') + txt); bon ? ok++ : ko++; };

  const zAvant = await empreinteZeste(db), orAvant = await empreinteOr(db);
  const orLu = {};
  for (const u of comptes) orLu[u] = await rpc(db, 'zeste_or_lire', {}, u);
  await db.exec(lireSql('valora-setup.sql'));
  await db.exec(lireSql('valora-import-prets.sql'));
  v(await empreinteZeste(db) === zAvant, 'données de Zeste inchangées après la copie (empreinte identique)');
  v(await empreinteOr(db) === orAvant, 'données de l\'Or inchangées (achats et ventes)');

  for (const u of comptes) {
    const z = (await db.query('select data from zeste.user_data where user_id = $1', [u])).rows[0].data;
    const prets = Array.isArray(z.debts) ? z.debts : [];
    const val = await rpc(db, 'valora_load_mine', {}, u);
    const vp = val && val.data && Array.isArray(val.data.debts) ? val.data.debts : [];
    const rep = l => l.reduce((n, d) => n + (Array.isArray(d.repays) ? d.repays.length : 0), 0);
    const parDevise = l => { const t = {}; l.forEach(d => { if (d.kind !== 'money') return; const c = d.cur || 'EUR';
      t[c] = t[c] || { prete: 0, rembourse: 0 }; t[c].prete += +d.amount || 0; (d.repays || []).forEach(r => { t[c].rembourse += +r.amount || 0; }); });
      for (const c in t) { t[c].prete = Math.round(t[c].prete * 100) / 100; t[c].rembourse = Math.round(t[c].rembourse * 100) / 100; } return t; };
    console.log(`\nCompte …${u.slice(-4)} : ${prets.length} prêt(s) dans Zeste (${prets.filter(d => d.kind === 'money').length} d'argent, ${prets.filter(d => d.kind !== 'money').length} objet(s), ${prets.filter(d => d.archived).length} archivé(s)), ${rep(prets)} remboursement(s)`);
    console.log('     totaux Zeste  :', JSON.stringify(parDevise(prets)));
    console.log('     totaux VALORA :', JSON.stringify(parDevise(vp)));
    v(vp.length === prets.length, `${vp.length}/${prets.length} prêts présents dans VALORA`);
    v(rep(vp) === rep(prets), `${rep(vp)}/${rep(prets)} remboursements présents dans VALORA`);
    v(isDeepStrictEqual(vp, prets), 'chaque prêt est copié à l\'identique (montant, devise, dates, notes, remboursements, archives, même ordre)');
    v(isDeepStrictEqual(parDevise(vp), parDevise(prets)), 'totaux prêtés et remboursés identiques, devise par devise');
    v(isDeepStrictEqual(await rpc(db, 'zeste_or_lire', {}, u), orLu[u]), `Or : lecture identique avant/après (${(orLu[u].lots || []).length} achat(s), ${(orLu[u].ventes || []).length} vente(s))`);
  }
  const controle = lireSql('valora-import-prets.sql').split('Résultat attendu : 0 ligne.')[1].split('--  Totaux')[0]
    .split('\n').map(l => l.replace(/^--\s?/, '')).join('\n').trim().replace(/;\s*$/, '');
  v((await db.query(controle)).rows.length === 0, 'requête de contrôle livrée avec le script : 0 ligne');

  const revs = (await db.query('select user_id, rev from valora.user_data order by user_id')).rows;
  await db.exec(lireSql('valora-import-prets.sql'));
  v(isDeepStrictEqual((await db.query('select user_id, rev from valora.user_data order by user_id')).rows, revs), 'copie rejouée : aucun doublon, rien ne bouge');

  await db.exec(lireSql('valora-setup-retour.sql'));
  v(await empreinteZeste(db) === zAvant && await empreinteOr(db) === orAvant, 'retour arrière : VALORA effacé, Zeste et l\'Or intacts');
  console.log(`\n${ko ? '❌' : '✅'} ${ok} contrôle(s) réussi(s), ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
}
