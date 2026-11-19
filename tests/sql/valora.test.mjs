// Tests de la base VALORA (sql/valora-setup.sql, valora-import-prets.sql, valora-setup-retour.sql)
// sur une base locale jetable chargée avec la chaîne de production de Zeste. Jamais la production.
// Lancer : PGLITE_DIR=<dossier pglite> node --test tests/sql/valora.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nouvelleBase, creerUtilisateur, rpc, comme, lireSql } from '../pg-local.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(200);
const refus = async (p, motif) => { await assert.rejects(p, e => motif.test(e.message), 'refus attendu : ' + motif); };

async function base(){
  const db = await nouvelleBase();
  await creerUtilisateur(db, A, 'a@essai.local'); await creerUtilisateur(db, B, 'b@essai.local'); await creerUtilisateur(db, C, 'c@essai.local');
  return db;
}

test('synchro : chargement, numéro de version, conflit, cloisonnement entre comptes', async () => {
  const db = await base();
  assert.deepEqual(await rpc(db, 'valora_load_mine', {}, { uid: A }), { data: null, rev: null });
  const r1 = await rpc(db, 'valora_save_mine', { p_data: { debts: [], coffres: [{ id: 'c1', nom: 'Maison', items: [] }], montres: [] }, p_base_rev: null }, { uid: A });
  assert.equal(Number(r1), 1);
  await refus(rpc(db, 'valora_save_mine', { p_data: { debts: [] }, p_base_rev: null }, { uid: A }), /Conflit de synchronisation/);
  await refus(rpc(db, 'valora_save_mine', { p_data: { debts: [] }, p_base_rev: 7 }, { uid: A }), /Conflit de synchronisation/);
  assert.equal(Number(await rpc(db, 'valora_save_mine', { p_data: { debts: [], coffres: [], montres: [] }, p_base_rev: 1 }, { uid: A })), 2);
  assert.equal(Number((await rpc(db, 'valora_rev_mine', {}, { uid: A })).rev), 2);
  // B ne voit rien de A
  assert.deepEqual(await rpc(db, 'valora_load_mine', {}, { uid: B }), { data: null, rev: null });
  // anonyme : refusé (droits retirés)
  await refus(rpc(db, 'valora_load_mine', {}, { role: 'anon' }), /permission denied/);
  await refus(rpc(db, 'valora_save_mine', { p_data: {}, p_base_rev: null }, { role: 'anon' }), /permission denied/);
  // aucun accès direct aux tables
  await refus(comme(db, { uid: A }, 'select * from valora.user_data'), /permission denied/);
});

test('contrôles serveur : remboursements (mêmes règles que Zeste), forme, taille', async () => {
  const db = await base();
  const pret = { id: 'p1', who: 'Paul', kind: 'money', amount: 100, cur: 'EUR', repays: [{ id: 'r1', amount: 150, date: '2026-01-02' }] };
  await refus(rpc(db, 'valora_save_mine', { p_data: { debts: [pret] }, p_base_rev: null }, { uid: A }), /Remboursement refusé/);
  pret.repays = [{ id: 'r1', amount: 40, date: '2026-01-02' }, { id: 'r1', amount: 10, date: '2026-01-03' }];
  await refus(rpc(db, 'valora_save_mine', { p_data: { debts: [pret] }, p_base_rev: null }, { uid: A }), /en double/);
  await refus(rpc(db, 'valora_save_mine', { p_data: { coffres: {} }, p_base_rev: null }, { uid: A }), /Enregistrement refusé/);
  await refus(rpc(db, 'valora_save_mine', { p_data: { montres: [], gros: 'x'.repeat(2_100_000) }, p_base_rev: null }, { uid: A }), /trop volumineuses/);
  pret.repays = [{ id: 'r1', amount: 40, date: '2026-01-02' }];
  assert.equal(Number(await rpc(db, 'valora_save_mine', { p_data: { debts: [pret] }, p_base_rev: null }, { uid: A })), 1);
});

test('photos : enregistrement idempotent, lecture et suppression réservées au propriétaire', async () => {
  const db = await base();
  const pid = 'aaaaaaaa-0000-4000-8000-000000000001';
  await rpc(db, 'valora_photo_enregistrer', { p_id: pid, p_image: JPEG }, { uid: A });
  await rpc(db, 'valora_photo_enregistrer', { p_id: pid, p_image: JPEG }, { uid: A });   // renvoi : pas de doublon
  assert.equal((await db.query('select count(*)::int n from valora.photos')).rows[0].n, 1);
  assert.equal(await rpc(db, 'valora_photo_lire', { p_id: pid }, { uid: A }), JPEG);
  assert.equal(await rpc(db, 'valora_photo_lire', { p_id: pid }, { uid: B }), null);
  await refus(rpc(db, 'valora_photo_enregistrer', { p_id: pid, p_image: JPEG }, { uid: B }), /déjà utilisé/);
  await rpc(db, 'valora_photo_supprimer', { p_id: pid }, { uid: B });                    // sans effet : pas à lui
  assert.equal(await rpc(db, 'valora_photo_lire', { p_id: pid }, { uid: A }), JPEG);
  await refus(rpc(db, 'valora_photo_enregistrer', { p_id: 'aaaaaaaa-0000-4000-8000-000000000002', p_image: 'data:image/png;base64,AAAA' }, { uid: A }), /JPEG/);
  await refus(rpc(db, 'valora_photo_enregistrer', { p_id: 'aaaaaaaa-0000-4000-8000-000000000003', p_image: JPEG + 'A'.repeat(600000) }, { uid: A }), /450 Ko/);
  await refus(rpc(db, 'valora_photo_lire', { p_id: pid }, { role: 'anon' }), /permission denied/);
  await rpc(db, 'valora_photo_supprimer', { p_id: pid }, { uid: A });
  assert.equal(await rpc(db, 'valora_photo_lire', { p_id: pid }, { uid: A }), null);
});

test('quota des estimations : clé service seulement, 20 par jour et par compte', async () => {
  const db = await base();
  await refus(rpc(db, 'valora_montre_cote_reserver', { p_user: A }, { uid: A }), /permission denied/);
  let dernier = null;
  for (let i = 0; i < 20; i++) dernier = await rpc(db, 'valora_montre_cote_reserver', { p_user: A }, { role: 'service_role' });
  await refus(rpc(db, 'valora_montre_cote_reserver', { p_user: A }, { role: 'service_role' }), /Quota/);
  assert.ok(await rpc(db, 'valora_montre_cote_reserver', { p_user: B }, { role: 'service_role' }));   // autre compte : libre
  await rpc(db, 'valora_montre_cote_terminer', { p_id: dernier, p_statut: 'fiable', p_resultat: { valeur: 1 } }, { role: 'service_role' });
  const r = (await db.query('select statut, resultat from valora.montres_cotes where id = $1', [dernier])).rows[0];
  assert.equal(r.statut, 'fiable');
  await refus(rpc(db, 'valora_montre_cote_terminer', { p_id: dernier, p_statut: 'n_importe', p_resultat: null }, { role: 'service_role' }), /statut invalide/);
});

test('copie des prêts Zeste → VALORA : complète, sans toucher Zeste, sans écraser, rejouable', async () => {
  const db = await base();
  const pretsA = [
    { id: 'pa1', who: 'Paul', kind: 'money', amount: 500, cur: 'EUR', date: '2026-01-10', done: false, ts: 1,
      repays: [{ id: 'ra1', amount: 200, date: '2026-02-01', note: 'virement', ts: 2 }, { id: 'ra2', amount: 50.5, date: '2026-03-01', ts: 3 }] },
    { id: 'pa2', who: 'Léa', kind: 'money', amount: 1200, cur: 'ILS', done: false, ts: 4 },
    { id: 'pa3', who: 'Marc', kind: 'thing', amount: 0, txt: 'perceuse', done: true, returnedAt: '2026-04-01', ts: 5 },
    { id: 'pa4', who: 'Zoé', kind: 'money', amount: 80, cur: 'EUR', done: true, archived: true, archivedAt: 9, ts: 6,
      repays: [{ id: 'ra3', amount: 80, date: '2026-05-05', ts: 7 }] },
  ];
  // Zeste : A a des tâches, films ET des prêts ; B a des prêts ; C n'a pas de prêts
  await rpc(db, 'zeste_save_mine_v2', { p_data: { todos: [{ id: 't', txt: 'x' }], films: [], debts: pretsA }, p_base_rev: null }, { uid: A });
  await rpc(db, 'zeste_save_mine_v2', { p_data: { todos: [], debts: [{ id: 'pb1', who: 'Tom', kind: 'money', amount: 30, cur: 'EUR', done: false }] }, p_base_rev: null }, { uid: B });
  await rpc(db, 'zeste_save_mine_v2', { p_data: { todos: [{ id: 't2', txt: 'y' }], debts: [] }, p_base_rev: null }, { uid: C });
  // A a déjà ouvert VALORA : un coffre, et le prêt pa2 MODIFIÉ depuis (montant 1300) → ne doit pas être écrasé
  await rpc(db, 'valora_save_mine', { p_data: { debts: [{ ...pretsA[1], amount: 1300 }], coffres: [{ id: 'c1', nom: 'Banque', items: [] }], montres: [] }, p_base_rev: null }, { uid: A });
  const zesteAvant = (await db.query('select user_id, data::text d, rev from zeste.user_data order by user_id')).rows;

  await db.exec(lireSql('valora-import-prets.sql'));

  const zesteApres = (await db.query('select user_id, data::text d, rev from zeste.user_data order by user_id')).rows;
  assert.deepEqual(zesteApres, zesteAvant, 'Zeste ne doit pas être modifié');
  const vA = await rpc(db, 'valora_load_mine', {}, { uid: A });
  assert.equal(Number(vA.rev), 2, 'le numéro de version avance (les appareils relisent)');
  assert.deepEqual(vA.data.coffres, [{ id: 'c1', nom: 'Banque', items: [] }], 'coffre conservé');
  const parId = Object.fromEntries(vA.data.debts.map(d => [d.id, d]));
  assert.deepEqual(Object.keys(parId).sort(), ['pa1', 'pa2', 'pa3', 'pa4']);
  assert.equal(parId.pa2.amount, 1300, 'prêt déjà présent dans VALORA : jamais remplacé');
  for (const id of ['pa1', 'pa3', 'pa4']) assert.deepEqual(parId[id], pretsA.find(p => p.id === id), 'copie à l\'identique : ' + id);
  const vB = await rpc(db, 'valora_load_mine', {}, { uid: B });
  assert.equal(Number(vB.rev), 1);
  assert.deepEqual(vB.data, { debts: [{ id: 'pb1', who: 'Tom', kind: 'money', amount: 30, cur: 'EUR', done: false }], coffres: [], montres: [] });
  assert.deepEqual(await rpc(db, 'valora_load_mine', {}, { uid: C }), { data: null, rev: null }, 'pas de prêts : pas de ligne');

  // contrôle livré avec le script : seul l'écart VOULU (pa2 modifié dans VALORA) ressort
  const controle = lireSql('valora-import-prets.sql').split('Résultat attendu : 0 ligne.')[1].split('--  Totaux')[0]
    .split('\n').map(l => l.replace(/^--\s?/, '')).join('\n').trim().replace(/;\s*$/, '');
  const ecarts = (await db.query(controle)).rows;
  assert.deepEqual(ecarts.map(e => e.pret), ['pa2']);

  // rejoué : rien de plus, aucun numéro de version qui bouge
  await db.exec(lireSql('valora-import-prets.sql'));
  const vA2 = await rpc(db, 'valora_load_mine', {}, { uid: A });
  assert.equal(Number(vA2.rev), 2); assert.equal(vA2.data.debts.length, 4);
  assert.equal(Number((await rpc(db, 'valora_load_mine', {}, { uid: B })).rev), 1);
});

test('retour arrière : VALORA effacé, Zeste et l\'Or intacts', async () => {
  const db = await base();
  await rpc(db, 'zeste_save_mine_v2', { p_data: { debts: [{ id: 'p', who: 'X', kind: 'money', amount: 1, cur: 'EUR' }] }, p_base_rev: null }, { uid: A });
  await rpc(db, 'zeste_or_lot_enregistrer', { p: { type: 'napoleon20', quantite: 2, date_achat: '2024-01-02', prix_total: 800 } }, { uid: A });
  await db.exec(lireSql('valora-import-prets.sql'));
  await db.exec(lireSql('valora-setup-retour.sql'));
  assert.equal((await db.query(`select count(*)::int n from pg_namespace where nspname = 'valora'`)).rows[0].n, 0);
  assert.equal((await db.query(`select to_regprocedure('public.valora_load_mine()') r`)).rows[0].r, null);
  assert.equal((await rpc(db, 'zeste_load_mine_v2', {}, { uid: A })).data.debts.length, 1);
  assert.equal((await rpc(db, 'zeste_or_lire', {}, { uid: A })).lots.length, 1);
  // et la mise en place est rejouable après un retour
  await db.exec(lireSql('valora-setup.sql'));
  await db.exec(lireSql('valora-setup.sql'));
});
