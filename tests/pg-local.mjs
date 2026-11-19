// Bancs d'essai VALORA : base Postgres LOCALE et jetable (pglite, en mémoire). Jamais la production.
// Prélude qui imite Supabase (rôles anon / authenticated / service_role, auth.uid()), puis :
//  - la chaîne SQL de ZESTE telle qu'en production (l'onglet Or de VALORA utilise zeste.or_*, et les
//    prêts sont copiés depuis zeste.user_data) — lue dans le dépôt Zeste (ZESTE_DIR, défaut ~/projects/zeste) ;
//  - les scripts de VALORA (sql/).
// pglite n'est pas une dépendance de l'appli : l'installer à part (`bun add @electric-sql/pglite@0.5.9`
// dans un dossier temporaire) et passer ce dossier dans PGLITE_DIR. Lancer avec node.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ici = path.dirname(fileURLToPath(import.meta.url));
export const RACINE = path.resolve(ici, '..');
export const ZESTE = process.env.ZESTE_DIR || path.join(os.homedir(), 'projects', 'zeste');

async function chargerPGlite(){
  const dir = process.env.PGLITE_DIR;
  if(!dir) throw new Error('PGLITE_DIR manquant (dossier contenant node_modules/@electric-sql/pglite)');
  const req = createRequire(path.join(dir, 'package.json'));
  return (await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href)).PGlite;
}

const PRELUDE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- comme Supabase : toute nouvelle fonction de public est exécutable par anon/authenticated
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  create schema zeste;
  grant usage on schema zeste to anon, authenticated, service_role;
`;

// Zeste : scripts dans l'ordre de la production (état au 11/11/2026)
export const ZESTE_PROD = ['zeste-setup.sql', 'zeste-push.sql', 'zeste-auth.sql', 'zeste-remboursements.sql',
  'zeste-correctif-securite.sql', 'zeste-sync-v2.sql', 'zeste-securite.sql', 'zeste-or.sql', 'zeste-or-catalogue.sql'];
export const VALORA = ['valora-setup.sql'];
export const lireZeste = (f) => readFileSync(path.join(ZESTE, 'sql', f), 'utf8');
export const lireSql = (f) => readFileSync(path.join(RACINE, 'sql', f), 'utf8');

export async function nouvelleBase({ zeste = ZESTE_PROD, valora = VALORA } = {}){
  const PGlite = await chargerPGlite();
  const db = new PGlite();
  await db.exec(PRELUDE);
  for (const f of zeste) await db.exec(lireZeste(f));
  for (const f of valora) await db.exec(lireSql(f));
  return db;
}
export async function creerUtilisateur(db, id, email){
  await db.query('insert into auth.users(id, email) values ($1, $2) on conflict do nothing', [id, email]);
}
// Exécute une requête « comme » un rôle donné (et un utilisateur connecté si uid).
export async function comme(db, { role = 'authenticated', uid = null } = {}, requete, params = []){
  const claims = JSON.stringify(uid ? { sub: uid, role } : { role });
  await db.exec(`begin; set local role ${role}; select set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', true);`);
  try{ const r = await db.query(requete, params); await db.exec('commit'); return r.rows; }
  catch(e){ await db.exec('rollback'); throw e; }
}
// Appel RPC à la manière de PostgREST : arguments nommés, résultat scalaire.
export async function rpc(db, nom, args = {}, qui = {}){
  if(!/^[a-z_][a-z0-9_]*$/.test(nom)) throw new Error('nom de fonction invalide');
  const cles = Object.keys(args);
  cles.forEach(k=>{ if(!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('argument invalide'); });
  const vals = cles.map(k=>{ const v = args[k]; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
  const rows = await comme(db, qui, `select public.${nom}(${cles.map((k,i)=>`${k} => $${i+1}`).join(', ')}) as r`, vals);
  return rows[0] ? rows[0].r : null;
}
