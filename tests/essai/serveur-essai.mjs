// Serveur d'ESSAI local de VALORA (recette, captures d'écran). Aucune donnée réelle, aucune requête
// vers la production, Swissquote, la BCE ou l'API Claude.
// - sert index.html en remplaçant supabase-js par un bouchon et l'adresse du serveur par le local ;
// - base Postgres jetable en mémoire : chaîne de production de Zeste + sql/valora-setup.sql ;
//   les prêts du jeu d'essai sont écrits dans ZESTE puis copiés par le VRAI sql/valora-import-prets.sql ;
// - VRAIE fonction du cours de l'or (dépôt Zeste) branchée sur un faux Swissquote (cours FICTIF) ;
// - VRAIE fonction d'estimation des montres branchée sur un faux Claude et une fausse BCE (prix FICTIFS) :
//   référence contenant « 126610 » → estimation fiable ; toute autre → « pas d'estimation fiable ».
// Lancer : PGLITE_DIR=<dossier pglite> node --experimental-strip-types tests/essai/serveur-essai.mjs [port]
// Pilotage (GET) : /essai/decor (remise à zéro), /essai/vide (compte sans données VALORA), /essai/journal
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { nouvelleBase, creerUtilisateur, rpc, RACINE, ZESTE, lireSql } from '../pg-local.mjs';
import { traiter as traiterOr } from '../../../zeste/supabase/functions/zeste-or-cours/index.ts';
import { traiter as traiterMontre } from '../../supabase/functions/valora-montre-cote/logique.ts';

if (path.resolve(RACINE, '..', 'zeste') !== path.resolve(ZESTE)) console.warn('⚠️ dépôt Zeste attendu à côté de VALORA (fonction du cours de l\'or)');
const PORT = Number(process.argv[2] || 8777);
const U = '44444444-4444-4444-8444-444444444444';
const db = await nouvelleBase();
await creerUtilisateur(db, U, 'essai@valora.local');
const journal = { ecritures: [], estimations: 0 };

const uidDe = (auth) => { const m = /^Bearer jeton-([0-9a-f-]{36})$/.exec(auth || ''); return m ? m[1] : null; };
async function appelRpc(nom, args, auth){
  const uid = uidDe(auth);
  const qui = auth === 'Bearer cle-service' ? { role: 'service_role' } : uid ? { uid } : { role: 'anon' };
  if (nom === 'zeste_or_cours_maj' && args.p) {   // cours enregistré : marqué FICTIF
    if (args.p.actuel) args.p.actuel.source = 'Banc d\'essai — cours FICTIF';
    (args.p.jours || []).forEach(j => { j.source = 'Banc d\'essai — cours FICTIF'; });
  }
  return rpc(db, nom, args, qui);
}
// --- faux Swissquote : cours fictif (~ 112 €/g) ---
const fauxSwissquote = () => { const m = 112.4 * 31.1034768;
  return new Response(JSON.stringify([{ topo: { platform: 'Essai' }, ts: Date.now() - 20_000, spreadProfilePrices: [{ spreadProfile: 'premium', bid: m - 0.6, ask: m + 0.6 }] }])); };
// --- fausse BCE : 1 € = 1,08 $ = 3,95 ₪ ---
const fausseBce = () => new Response(`<Cube><Cube time='${new Date().toISOString().slice(0, 10)}'><Cube currency='USD' rate='1.08'/><Cube currency='ILS' rate='3.95'/><Cube currency='CHF' rate='0.94'/></Cube></Cube>`);
const fauxReseau = async (url, init = {}) => {
  const u = new URL(url), h = init.headers || {};
  if (u.pathname === '/auth/v1/user') { const uid = uidDe(h.Authorization); return new Response(JSON.stringify(uid ? { id: uid } : { msg: 'jeton invalide' }), { status: uid ? 200 : 401 }); }
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    try { const r = await appelRpc(u.pathname.split('/').pop(), JSON.parse(init.body || '{}'), h.Authorization); return new Response(r == null ? '' : JSON.stringify(r)); }
    catch (e) { return new Response(JSON.stringify({ message: e.message }), { status: 400 }); }
  }
  if (u.hostname === 'forex-data-feed.swissquote.com') return fauxSwissquote();
  if (u.hostname === 'www.ecb.europa.eu') return fausseBce();
  throw new Error('requête externe refusée : ' + url);
};
// --- faux Claude : pages et prix FICTIFS ---
let nId = 0;
const fauxClaude = async (params) => {
  journal.estimations++;
  const txt = JSON.stringify(params.messages);
  const pages = ['https://www.chrono24.fr/essai/fictif-1.htm', 'https://watchcharts.com/essai/fictif-2', 'https://www.phillips.com/essai/fictif-3'];
  const releves = /126610/.test(txt) ? [
    { source: 'Chrono24 (FICTIF)', url: pages[0], prix: 11950, devise: 'EUR', date: '2026-10-28', type: 'annonce', reference_exacte: true },
    { source: 'WatchCharts (FICTIF)', url: pages[1], prix: 12600, devise: 'USD', date: '2026-11-10', type: 'indice', reference_exacte: true },
    { source: 'Phillips (FICTIF)', url: pages[2], prix: 11200, devise: 'EUR', date: '2026-06-14', type: 'vente', reference_exacte: true },
  ] : [];
  const id = 'srvtoolu_' + (++nId);
  return { id: 'msg_essai', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
    content: [
      { type: 'server_tool_use', id, name: 'web_search', input: { query: 'essai' } },
      { type: 'web_search_tool_result', tool_use_id: id, content: pages.map(url => ({ type: 'web_search_result', url, title: 'page fictive', encrypted_content: 'x', page_age: null })) },
      { type: 'text', text: 'Relevés (banc d\'essai).\n```json\n' + JSON.stringify({ releves }) + '\n```' },
    ] };
};
const ENV_OR = { SUPABASE_URL: 'http://local', ANON_KEY: 'cle-anon', SERVICE_KEY: 'cle-service' };

// --- jeu d'essai FICTIF ---
async function decor(vide = false){
  await db.exec(`delete from zeste.user_data; delete from valora.user_data; delete from valora.photos; delete from valora.montres_cotes;
    delete from zeste.or_ventes; delete from zeste.or_lots; delete from zeste.or_cours_jour; delete from zeste.or_cours_actuel; delete from zeste.or_cours_meta; delete from zeste.or_appels_api;`);
  if (vide) return;
  // Zeste (avant séparation) : tâches, films ET prêts
  await rpc(db, 'zeste_save_mine_v2', { p_data: {
    todos: [{ id: 't1', txt: 'Tâche fictive', cat: 'perso', done: false }], films: [{ id: 'f1', txt: 'Film fictif', plat: 'net', done: false }],
    debts: [
      { id: 'd1', who: 'Paul', kind: 'money', amount: 1500, cur: 'EUR', note: 'voiture', date: '2026-03-02', done: false, ts: 1,
        repays: [{ id: 'r1', amount: 500, date: '2026-05-01', note: 'virement', ts: 2 }] },
      { id: 'd2', who: 'Paul', kind: 'money', amount: 2000, cur: 'ILS', date: '2026-06-10', done: false, ts: 3 },
      { id: 'd3', who: 'Léa', kind: 'thing', amount: 0, txt: 'ma perceuse', done: false, ts: 4 },
      { id: 'd4', who: 'Sarah', kind: 'money', amount: 120, cur: 'EUR', date: '2026-01-15', done: true, ts: 5, repays: [{ id: 'r2', amount: 120, date: '2026-02-01', ts: 6 }] },
    ] }, p_base_rev: null }, { uid: U });
  await db.exec(lireSql('valora-import-prets.sql'));   // la VRAIE copie des prêts
  // or : quelques achats fictifs
  const lots = [
    { type: 'napoleon20', quantite: 10, date_achat: '2023-03-14', prix_total: 3650, frais: 25 },
    { type: 'souverain', quantite: 2, date_achat: '2025-01-20', prix_total: 1160 },
  ];
  for (const p of lots) await rpc(db, 'zeste_or_lot_enregistrer', { p }, { uid: U });
  // coffres et montres fictifs
  const v = await rpc(db, 'valora_load_mine', {}, { uid: U });
  const data = { ...v.data,
    coffres: [
      { id: 'c1', nom: 'Coffre maison', ts: 1, items: [
        { id: 'e1', type: 'objet', nom: 'Collier en or', qte: 1, valeurC: 240000, cur: 'EUR', photo: null, ts: 1 },
        { id: 'e2', type: 'objet', nom: 'Pièces anciennes', qte: 3, valeurC: 45000, cur: 'EUR', photo: null, ts: 2 },
        { id: 'e3', type: 'objet', nom: 'Bague de mamie', qte: 1, valeurC: null, cur: 'EUR', photo: null, ts: 3 },
        { id: 'e4', type: 'enveloppe', nom: 'Réserve', montantC: 500000, cur: 'EUR', ts: 4 },
        { id: 'e5', type: 'enveloppe', nom: 'Voyage USA', montantC: 120000, cur: 'USD', ts: 5 },
      ] },
      { id: 'c2', nom: 'Banque Tel-Aviv', ts: 2, items: [{ id: 'e6', type: 'enveloppe', nom: 'Shekels', montantC: 1500000, cur: 'ILS', ts: 6 }] },
    ],
    montres: [
      { id: 'm1', marque: 'Rolex', modele: 'Submariner Date', ref: '126610LN', prixC: 950000, cur: 'EUR', dateAchat: '2021-04-03', photo: null, cote: null, ts: 1 },
      { id: 'm2', marque: 'Omega', modele: 'Speedmaster Professional', ref: '310.30.42.50.01.002', prixC: 620000, cur: 'EUR', dateAchat: '2022-09-12', photo: null,
        cote: { valeurC: 590000, cur: 'EUR', methode: 'manuel', source: 'offre d\'un bijoutier (fictif)', date: '2026-11-01' }, ts: 2 },
      { id: 'm3', marque: 'Tudor', modele: 'Black Bay 58', ref: 'M79030N', prixC: 380000, cur: 'USD', dateAchat: '', photo: null, cote: null, ts: 3 },
    ] };
  await rpc(db, 'valora_save_mine', { p_data: data, p_base_rev: Number(v.rev) }, { uid: U });
}
await decor();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const pageApp = () => readFileSync(path.join(RACINE, 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, '<script src="/bouchon-supabase.js"></script>')
  .replace("const SB_URL = 'https://api.srv.proformationplus.fr';", "const SB_URL = '';");
const BOUCHON = `
window.supabase = { createClient(url, cle, opts){
  window.__optsSupabase = opts;
  const U = { id: '${U}', email: 'essai@valora.local' };
  const session = { access_token: 'jeton-' + U.id, user: U };
  const co = () => localStorage.getItem('bouchon_deconnecte') !== '1';
  const ec = [];
  return {
    auth: {
      onAuthStateChange(cb){ ec.push(cb); setTimeout(()=>cb(co()?'INITIAL_SESSION':'SIGNED_OUT', co()?session:null), 0); return { data:{ subscription:{ unsubscribe(){} } } }; },
      async getSession(){ return { data:{ session: co()?session:null } }; },
      async signInWithPassword(){ localStorage.removeItem('bouchon_deconnecte'); ec.forEach(cb=>cb('SIGNED_IN', session)); return { data:{ session, user:U }, error:null }; },
      async signOut(){ localStorage.setItem('bouchon_deconnecte','1'); ec.forEach(cb=>cb('SIGNED_OUT', null)); return { error:null }; },
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

const lireCorps = (req) => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
const ok = (res, txt) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof txt === 'string' ? txt : JSON.stringify(txt)); };
const versFonction = async (req, u, f) => {
  const corps = await lireCorps(req);
  const r = await f(new Request('http://local' + u.pathname, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined }));
  return [r.status, Object.fromEntries(r.headers), await r.text()];
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(pageApp()); }
    if (u.pathname === '/bouchon-supabase.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(BOUCHON); }
    if (u.pathname === '/sw.js') { res.writeHead(404); return res.end(); }       // pas de cache hors-ligne pendant l'essai
    if (u.pathname === '/essai/decor') { await decor(); return ok(res, 'decor'); }
    if (u.pathname === '/essai/vide') { await decor(true); return ok(res, 'vide'); }
    if (u.pathname === '/essai/journal') {
      const v = (await db.query(`select rev, data from valora.user_data where user_id = $1`, [U])).rows[0];
      const z = (await db.query(`select rev, data from zeste.user_data where user_id = $1`, [U])).rows[0];
      const ph = (await db.query(`select id from valora.photos where user_id = $1`, [U])).rows.map(r => r.id);
      return ok(res, { ...journal, valora: v, zeste: z, photos: ph });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const nom = u.pathname.split('/').pop(), corps = await lireCorps(req);
      try {
        const r = await appelRpc(nom, JSON.parse(corps || '{}'), req.headers.authorization);
        if (/save_mine/.test(nom)) journal.ecritures.push({ nom, rev: r });
        return ok(res, r == null ? '' : JSON.stringify(r));
      } catch (e) {
        if (/save_mine/.test(nom)) journal.ecritures.push({ nom, refus: e.message });
        res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: e.message }));
      }
    }
    if (u.pathname === '/functions/v1/zeste-or-cours') {
      const [s, h, t] = await versFonction(req, u, r => traiterOr(r, ENV_OR, fauxReseau)); res.writeHead(s, h); return res.end(t);
    }
    if (u.pathname === '/functions/v1/valora-montre-cote') {
      const [s, h, t] = await versFonction(req, u, r => traiterMontre(r, ENV_OR, { claude: fauxClaude, fetch: fauxReseau })); res.writeHead(s, h); return res.end(t);
    }
    const f = path.join(RACINE, path.normalize(u.pathname).replace(/^\/+/, ''));
    if (f.startsWith(RACINE) && existsSync(f) && !f.includes('/sql/') && !f.includes('/tests/')) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); return res.end(readFileSync(f));
    }
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, '127.0.0.1', () => console.log('VALORA — essai sur http://127.0.0.1:' + PORT));
