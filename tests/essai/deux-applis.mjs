// Banc « deux applis » : Zeste (version en ligne = main, et nouvelle version = branche separation-valora) et VALORA
// servies sur la MÊME origine (comme sur github.io), branchées sur la MÊME base jetable, pour vérifier qu'elles
// ne mélangent ni leurs données ni leurs sessions. Jamais la production.
// Données : DONNEES=<dossier d'une sauvegarde Zeste> (copie locale des vraies données ; dossier à supprimer après),
// sinon jeu fictif. Cours de l'or : VRAIE fonction zeste-or-cours ; COURS_REEL=1 → vraie cotation Swissquote
// (publique, sans clé), sinon cours fictif.
// Lancer : PGLITE_DIR=… DONNEES=… COURS_REEL=1 FIGER=1 node --experimental-strip-types tests/essai/deux-applis.mjs [port]
// Pages : /zeste-actuel/ (main), /zeste/ (branche), /valora/ ; /essai/etat (empreintes des deux sauvegardes)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { RACINE, ZESTE } from '../pg-local.mjs';
import { baseDepuisSauvegarde, rpc } from '../../outils/verifier-copie-prets.mjs';
import { traiter as traiterOr } from '../../../zeste/supabase/functions/zeste-or-cours/index.ts';

const PORT = Number(process.argv[2] || 8788);
const DONNEES = process.env.DONNEES;
if (!DONNEES) { console.error('DONNEES=<dossier de sauvegarde> requis'); process.exit(2); }
const { db, comptes } = await baseDepuisSauvegarde(DONNEES);
const U = comptes[0];
await db.exec(readFileSync(path.join(RACINE, 'sql/valora-setup.sql'), 'utf8'));
// FIGER=1 : prêts figés dans Zeste (sql/zeste-prets-figes.sql de la branche), posé AVANT la copie comme le jour J
if (process.env.FIGER === '1') await db.exec(readFileSync(path.join(process.env.ZESTE_BRANCHE_DIR || path.join(path.dirname(ZESTE), 'zeste-separation'), 'sql/zeste-prets-figes.sql'), 'utf8'));
await db.exec(readFileSync(path.join(RACINE, 'sql/valora-import-prets.sql'), 'utf8'));
for (const f of (await db.query(`select p.oid::regprocedure::text f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'valora%'`)).rows)
  if (!/cote_(reserver|terminer)/.test(f.f)) await db.exec(`grant execute on function ${f.f} to authenticated`);

const uidDe = a => { const m = /^Bearer jeton-([0-9a-f-]{36})$/.exec(a || ''); return m ? m[1] : null; };
async function appel(nom, args, auth){
  if (auth === 'Bearer cle-service') {   // fonction du cours : rôle service
    const cles = Object.keys(args);
    await db.exec(`begin; set local role service_role;`);
    try { const r = await db.query(`select public.${nom}(${cles.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, cles.map(k => typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k])); await db.exec('commit'); return r.rows[0].r; }
    catch (e) { await db.exec('rollback'); throw e; }
  }
  const uid = uidDe(auth); if (!uid) throw new Error('permission denied');
  return rpc(db, nom, args, uid);
}
const reseau = async (url, init = {}) => {
  const u = new URL(url), h = init.headers || {};
  if (u.pathname === '/auth/v1/user') { const uid = uidDe(h.Authorization); return new Response(JSON.stringify(uid ? { id: uid } : {}), { status: uid ? 200 : 401 }); }
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    try { const r = await appel(u.pathname.split('/').pop(), JSON.parse(init.body || '{}'), h.Authorization); return new Response(r == null ? '' : JSON.stringify(r)); }
    catch (e) { return new Response(JSON.stringify({ message: e.message }), { status: 400 }); }
  }
  if (u.hostname === 'forex-data-feed.swissquote.com' && process.env.COURS_REEL === '1') return fetch(url, init);   // vraie cotation publique
  if (u.hostname === 'forex-data-feed.swissquote.com') { const m = 112 * 31.1034768; return new Response(JSON.stringify([{ ts: Date.now(), spreadProfilePrices: [{ spreadProfile: 'premium', bid: m - 1, ask: m + 1 }] }])); }
  return new Response('refusé', { status: 503 });   // GoldAPI et le reste : jamais appelés
};
const ENV = { SUPABASE_URL: 'http://local', ANON_KEY: 'cle-anon', SERVICE_KEY: 'cle-service' };

// une session par appli, comme supabase-js : rangée sous la clé de stockage de l'appli (storageKey)
const BOUCHON = `
window.supabase = { createClient(url, cle, opts){
  const cleSession = 'bouchon-session:' + ((opts && opts.auth && opts.auth.storageKey) || 'sb-api-auth-token');
  const U = { id: '${U}', email: 'compte@copie.local' };
  const session = { access_token: 'jeton-' + U.id, user: U };
  if (localStorage.getItem(cleSession) === null) localStorage.setItem(cleSession, 'connecte');
  const co = () => localStorage.getItem(cleSession) === 'connecte';
  const ec = [];
  return {
    auth: {
      onAuthStateChange(cb){ ec.push(cb); setTimeout(()=>cb(co()?'INITIAL_SESSION':'SIGNED_OUT', co()?session:null), 0); return { data:{ subscription:{ unsubscribe(){} } } }; },
      async getSession(){ return { data:{ session: co()?session:null } }; },
      async signInWithPassword(){ localStorage.setItem(cleSession, 'connecte'); ec.forEach(cb=>cb('SIGNED_IN', session)); return { data:{ session, user:U }, error:null }; },
      async signOut(){ localStorage.setItem(cleSession, 'deconnecte'); ec.forEach(cb=>cb('SIGNED_OUT', null)); return { error:null }; },
    },
    async rpc(nom, args){
      try{ const r = await fetch('/rest/v1/rpc/'+nom, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+(co()?session.access_token:'anon') }, body: JSON.stringify(args||{}) });
        const t = await r.text(), j = t ? JSON.parse(t) : null;
        return r.ok ? { data:j, error:null } : { data:null, error: j || { message:'HTTP '+r.status } };
      }catch(e){ return { data:null, error:{ message: e.message } }; }
    },
    channel(){ return { on(){ return this; }, subscribe(){ return this; } }; }, removeChannel(){},
  };
} };`;
const adapter = html => html
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, '<script src="/bouchon-supabase.js"></script>')
  .replace(/<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/, '')
  .replace("const SB_URL = 'https://api.srv.proformationplus.fr';", "const SB_URL = '';");
const BRANCHE = process.env.ZESTE_BRANCHE_DIR || path.join(path.dirname(ZESTE), 'zeste-separation');
const pages = {
  '/zeste-actuel/': () => adapter(execFileSync('git', ['-C', ZESTE, 'show', 'main:index.html'], { encoding: 'utf8', maxBuffer: 1e8 })),
  '/zeste/': () => adapter(readFileSync(path.join(BRANCHE, 'index.html'), 'utf8')),
  '/valora/': () => adapter(readFileSync(path.join(RACINE, 'index.html'), 'utf8')),
};
const lire = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (pages[u.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(pages[u.pathname]()); }
    if (u.pathname === '/bouchon-supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(BOUCHON); }
    if (u.pathname.endsWith('/sw.js')) { res.writeHead(404); return res.end(); }
    if (u.pathname === '/essai/etat') {
      const z = (await db.query(`select md5(data::text) h, rev, jsonb_array_length(coalesce(data->'debts','[]')) prets, md5(coalesce(data->'debts','[]')::text) hp from zeste.user_data where user_id = $1`, [U])).rows[0];
      const v = (await db.query(`select md5(data::text) h, rev, jsonb_array_length(coalesce(data->'debts','[]')) prets from valora.user_data where user_id = $1`, [U])).rows[0];
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ zeste: z, valora: v }));
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      try { const r = await appel(u.pathname.split('/').pop(), JSON.parse(await lire(req) || '{}'), req.headers.authorization); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(r == null ? '' : JSON.stringify(r)); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: e.message })); }
    }
    if (u.pathname === '/functions/v1/zeste-or-cours') {
      const corps = await lire(req);
      const r = await traiterOr(new Request('http://local' + u.pathname, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined }), ENV, reseau);
      res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
    }
    const dossier = u.pathname.startsWith('/valora/') ? RACINE : u.pathname.startsWith('/zeste/') ? BRANCHE : ZESTE;
    const f = path.join(dossier, path.basename(u.pathname));
    if (existsSync(f) && /\.(png|json)$/.test(f)) { res.writeHead(200); return res.end(readFileSync(f)); }
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, '127.0.0.1', () => console.log('deux applis sur http://127.0.0.1:' + PORT));
