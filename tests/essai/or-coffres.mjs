// Recette « Or ↔ Coffres » (emplacement des pièces d'or) sur le serveur d'ESSAI local — données FICTIVES.
// Parcours complet, sur ordinateur ET en iPhone (390 × 844, tactile) :
//  achats existants « non renseignés » → répartition dans 2 coffres → plafond respecté → « Coffre : X »
//  → onglet Coffres (liste, quantités, valeur du module Or, total sans double compte) → vente (répartition à revoir)
//  → vente totale (retrait automatique) → nouveau coffre depuis l'Or → suppression d'un coffre avec or (refus puis accord)
//  → achats et ventes de l'Or jamais modifiés par la fonctionnalité ; état accepté par le serveur.
// Contrôle visuel mesuré : aucun défilement horizontal, rien hors de son conteneur, boutons assez grands au doigt.
// Lancer (serveur d'essai déjà démarré sur PORT) :
//   PUPPETEER_DIR=<dossier contenant node_modules/puppeteer-core> node tests/essai/or-coffres.mjs [port] [dossier captures]
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.argv[2] || 8791);
const CAPT = process.argv[3] || path.join(process.cwd(), 'captures-or-coffres');
const BASE = 'http://127.0.0.1:' + PORT;
const require = createRequire(path.join(process.env.PUPPETEER_DIR || '.', 'package.json'));
const puppeteer = require('puppeteer-core');
mkdirSync(CAPT, { recursive: true });

let echecs = 0, oks = 0;
const ok = (c, m) => { if (c) { oks++; console.log('  ✅ ' + m); } else { echecs++; console.log('  ❌ ' + m); } };
const pause = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const t = await (await fetch(BASE + p)).text(); try { return JSON.parse(t); } catch { return t; } };

async function parcours(nom, viewport, theme){
  console.log(`\n=== ${nom} ===`);
  await get('/essai/decor');
  const navig = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run'] });
  const page = await navig.newPage();
  await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme || 'dark' }]);
  const erreursJs = [];
  page.on('pageerror', e => erreursJs.push(String(e.message)));
  let reponse = 'accept', dernierDialogue = '';
  page.on('dialog', async d => { dernierDialogue = d.message(); if (d.type() === 'prompt') await d.accept(typeof reponse === 'string' && reponse !== 'accept' && reponse !== 'dismiss' ? reponse : d.defaultValue());
    else if (reponse === 'dismiss') await d.dismiss(); else await d.accept(); });
  const capt = async n => page.screenshot({ path: path.join(CAPT, `${nom}-${n}.png`) });
  const ev = (f, ...a) => page.evaluate(f, ...a);
  const clic = async sel => { await page.waitForSelector(sel, { visible: true }); await page.click(sel); await pause(250); };
  const texte = sel => ev(s => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; }, sel);
  const ouverte = id => ev(i => document.getElementById(i + 'Sheet').classList.contains('open'), id);
  const fermerTout = () => ev(() => { document.querySelectorAll('.sheet.open, .sheet-bg.open').forEach(e => e.classList.remove('open')); orLotId = null; orp = null; coffreOpenId = null; });
  // contrôle visuel mesuré : débordements, éléments sortis de leur conteneur, cibles tactiles
  const geo = async (zone, conteneur) => ev((z, cont) => {
    const pb = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) pb.push('défilement horizontal de la page');
    const root = document.querySelector(cont); if (!root) return ['conteneur absent ' + cont];
    const rc = root.getBoundingClientRect();
    root.querySelectorAll(z).forEach(e => {
      const r = e.getBoundingClientRect(); if (!r.width) return;
      if (r.left < rc.left - 1 || r.right > rc.right + 1) pb.push('hors du conteneur : ' + (e.className || e.tagName) + ' ' + Math.round(r.left) + '→' + Math.round(r.right) + ' / ' + Math.round(rc.left) + '→' + Math.round(rc.right));
      if (r.right > innerWidth + 1) pb.push('hors écran : ' + (e.className || e.tagName));
      if (e.matches('button') && innerWidth < 500 && r.height < 36) pb.push('bouton trop petit (' + Math.round(r.height) + ' px) : ' + e.textContent.trim().slice(0, 20));
    });
    return pb;
  }, zone, conteneur);
  // vente datée de la veille : le banc (comme le serveur) compte les jours en UTC, le navigateur en heure locale
  const veille = () => ev(() => { const d = new Date(Date.now() - 2 * 864e5); document.getElementById('orVDate').value = d.toISOString().slice(0, 10); });
  const lireOr = () => ev(async () => { const { data } = await cloud.sb.rpc('zeste_or_lire'); return { lots: data.lots, ventes: data.ventes }; });

  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof OR !== 'undefined' && OR.charge && OR.lots.length === 2 && orCoursG() > 0 && S.coffres.length === 2, { timeout: 15000 });
  const avant = await lireOr();
  const idNapo = avant.lots.find(l => l.type === 'napoleon20').id, idSouv = avant.lots.find(l => l.type === 'souverain').id;

  console.log('1. Achats existants : emplacement non renseigné');
  await clic('.tab.t-or'); await pause(300);
  const emps = await ev(() => [...document.querySelectorAll('#view-or .or-emp')].map(e => e.innerText.trim()));
  ok(emps.length === 2 && emps.every(t => t === '📍 Emplacement non renseigné'), 'les 2 achats affichent « Emplacement non renseigné » (' + emps.join(' | ') + ')');
  await capt('1-or-non-renseigne');

  console.log('2. Fiche de l\'achat → répartir entre 2 coffres');
  await ev(id => orOuvrirLot(id), idNapo); await pause(300);
  ok((await texte('#orLotBody .or-d-emp')).includes('Emplacement non renseigné'), 'fiche : bloc Emplacement « non renseigné »');
  await clic('#orLotEmp');
  ok(await ouverte('orEmp'), 'fenêtre Emplacement ouverte au-dessus de la fiche');
  ok((await texte('#orEmpBody .emp-tete')).includes('10 pièces détenues'), 'fenêtre : 10 pièces détenues');
  const rows = await ev(() => [...document.querySelectorAll('#orEmpBody .emp-row')].map(r => r.dataset.cid));
  ok(rows.join() === 'c1,c2', 'les coffres proposés sont ceux de l\'onglet Coffres (c1, c2)');
  await page.click('#orEmpBody .emp-row[data-cid="c1"] input', { clickCount: 3 }); await page.keyboard.type('6');
  for (let i = 0; i < 6; i++) await page.click('#orEmpBody .emp-row[data-cid="c2"] [data-em="1"]');
  ok(await ev(() => orp.q.c2) === 4, 'le bouton ＋ s\'arrête au total détenu (6 + 4 = 10, malgré 6 appuis)');
  ok((await texte('#orEmpBilan')).includes('Les 10 pièces sont rangées'), 'bilan : les 10 pièces sont rangées');
  ok(!(await geo('.emp-row, .emp-row > *, .emp-ctl > *, .emp-row .or-step > *, .emp-liens > *', '#orEmpSheet')).length, 'fenêtre Emplacement : mesures OK ' + JSON.stringify(await geo('.emp-row, .emp-row > *, .emp-ctl > *, .emp-row .or-step > *, .emp-liens > *', '#orEmpSheet')));
  await capt('2-fenetre-emplacement');
  // dépassement saisi au clavier : refusé
  await page.click('#orEmpBody .emp-row[data-cid="c1"] input', { clickCount: 3 }); await page.keyboard.type('9');
  ok((await texte('#orEmpBilan')).includes('13 pièces réparties pour 10 détenues') && await ev(() => document.getElementById('orEmpOk').disabled), 'dépassement (9 + 4 > 10) : message + Enregistrer désactivé');
  await capt('3-depassement');
  await page.click('#orEmpBody .emp-row[data-cid="c1"] input', { clickCount: 3 }); await page.keyboard.type('6');
  await clic('#orEmpOk');
  ok(!(await ouverte('orEmp')), 'enregistré : fenêtre fermée');
  const blocFiche = await texte('#orLotBody .or-d-emp .l');
  ok(blocFiche === '6 pièces · Coffre maison 4 pièces · Banque Tel-Aviv', 'fiche : détail par coffre (' + blocFiche + ')');
  await capt('4-fiche-repartie');
  await fermerTout(); await ev(() => renderOr());
  ok((await ev(id => document.querySelector(`#view-or [data-oremp="${id}"]`)?.innerText.trim(), idNapo)) === '🔐 6 dans Coffre maison · 4 dans Banque Tel-Aviv', 'carte Or : « 6 dans Coffre maison · 4 dans Banque Tel-Aviv »');

  console.log('3. « Tout ici » → « Coffre : X »');
  await ev(id => document.querySelector(`#view-or [data-oremp="${id}"]`).click(), idSouv); await pause(300);
  ok(await ouverte('orEmp'), 'la ligne d\'emplacement de la carte ouvre la fenêtre');
  await clic('#orEmpBody .emp-row[data-cid="c1"] .emp-tout'); await clic('#orEmpOk');
  ok((await ev(id => document.querySelector(`#view-or [data-oremp="${id}"]`)?.innerText.trim(), idSouv)) === '🔐 Coffre : Coffre maison', 'carte Or : « Coffre : Coffre maison »');
  ok(!(await geo('.or-ref, .or-emp', '#view-or')).length, 'onglet Or : mesures OK ' + JSON.stringify(await geo('.or-ref, .or-emp', '#view-or')));
  await ev(() => document.querySelector('#view-or .or-ref').scrollIntoView({ block: 'start' })); await pause(200);
  await capt('5-or-avec-emplacements');
  await ev(() => window.scrollTo(0, 0));

  console.log('4. Onglet Coffres : pièces, valeur du module Or, aucun double compte');
  await clic('.tab.t-coffre'); await pause(300);
  const att = await ev((n, s) => {
    const g = orCoursG(), st = id => orLotStats(orLot(id), OR.ventes, g), u = id => st(id).valeur / st(id).detenu;
    const P = orPortefeuille(OR.lots, OR.ventes, g);
    return { uN: u(n), uS: u(s), valeurOr: P.valeur,
      t1: coffreTotaux(coffreById('c1')), t2: coffreTotaux(coffreById('c2')) };
  }, idNapo, idSouv);
  ok(att.t1.or.n === 8 && att.t2.or.n === 4, 'quantités : Coffre maison 8 (6 Napoléon + 2 souverains), Banque 4');
  ok(att.t1.or.valC === 6 * att.uN + 2 * att.uS && att.t2.or.valC === 4 * att.uN, 'valeurs = valeur d\'une pièce du module Or × quantité');
  ok(att.t1.or.valC + att.t2.or.valC === att.valeurOr, 'toutes les pièces rangées : somme des coffres = « Valeur actuelle » de l\'Or (aucun double compte)');
  // Coffre maison : objets 2400 + 3×450 = 3750 € + enveloppe 5000 € = 8750 € (+ or) ; 1200 $ à part
  ok(att.t1.tot.EUR === 875000 + att.t1.or.valC && att.t1.tot.USD === 120000, 'total du coffre = objets + enveloppes + or (€), dollars jamais additionnés');
  const carte = await texte('#view-coffres [data-cof="c1"]');
  ok(carte.includes('8 pièces d\'or'), 'carte du coffre : « 8 pièces d\'or » (' + carte + ')');
  await capt('6-liste-coffres');
  await clic('#view-coffres [data-cof="c1"]');
  const lignesOr = await ev(() => [...document.querySelectorAll('#coffreBody [data-orp]')].map(b => b.innerText.replace(/\s+/g, ' ').trim()));
  ok(lignesOr.length === 2 && lignesOr[0].includes('Quantité : 6') && lignesOr[1].includes('Quantité : 2'), 'coffre ouvert : 2 lignes d\'or avec leur quantité (' + lignesOr.join(' | ') + ')');
  ok((await texte('#coffreBody .remb-ctx')).includes('dont or'), 'coffre ouvert : « dont or » sous la valeur totale');
  ok(!(await geo('.vrow, .vrow > *', '#coffreSheet')).length, 'coffre ouvert : mesures OK ' + JSON.stringify(await geo('.vrow, .vrow > *', '#coffreSheet')));
  await capt('7-coffre-ouvert');
  // depuis le coffre : la ligne ouvre la fenêtre Emplacement AU-DESSUS du coffre
  await clic('#coffreBody [data-orp]');
  const z = await ev(() => [getComputedStyle(document.getElementById('orEmpSheet')).zIndex, getComputedStyle(document.getElementById('coffreSheet')).zIndex].map(Number));
  ok(await ouverte('orEmp') && z[0] > z[1], 'depuis un coffre : fenêtre Emplacement au-dessus (z ' + z.join(' > ') + ')');
  await capt('8-deplacer-depuis-coffre');
  await clic('#orEmpAnnuler'); await fermerTout();

  console.log('5. Vente de 3 Napoléon répartis dans 2 coffres → répartition à revoir');
  await clic('.tab.t-or'); await ev(id => orOuvrirLot(id), idNapo); await pause(300);
  await clic('#orLotVente');
  await page.click('#orVQte', { clickCount: 3 }); await page.keyboard.type('3');
  await page.click('#orVPrix'); await page.keyboard.type('400'); await veille();
  await clic('#orVenteOk'); await page.waitForFunction(() => OR.ventes.length === 1, { timeout: 5000 }).catch(async () => { console.log('  vente non enregistrée :', await texte('#orVenteErr'), await ev(() => [document.getElementById('orVQte').value, document.getElementById('orVPrix').value, document.getElementById('orVDate').value])); });
  await pause(400);
  ok(await ouverte('orEmp') && (await texte('#orEmpBody .emp-alerte')).includes('Il te reste 7 pièces'), 'après la vente : fenêtre ouverte avec « Il te reste 7 pièces… »');
  await capt('9-apres-vente');
  await clic('#orEmpAnnuler');
  ok((await texte('#orLotBody .or-d-emp .l')).includes('10 pièces rangées pour 7 détenues'), 'annulé : fiche « à revoir : 10 rangées pour 7 détenues »');
  const plaf = await ev(() => [coffreTotaux(coffreById('c1')).or.n, coffreTotaux(coffreById('c2')).or.n]);
  ok(plaf[0] === 8 && plaf[1] === 1, 'en attendant : coffres plafonnés à 7 Napoléon comptés (6 + 1), jamais 10 (' + plaf.join(' / ') + ')');
  await clic('#orLotEmp');
  await page.click('#orEmpBody .emp-row[data-cid="c1"] input', { clickCount: 3 }); await page.keyboard.type('5');
  await page.click('#orEmpBody .emp-row[data-cid="c2"] input', { clickCount: 3 }); await page.keyboard.type('2');
  await clic('#orEmpOk');
  ok((await texte('#orLotBody .or-d-emp .l')) === '5 pièces · Coffre maison 2 pièces · Banque Tel-Aviv', 'corrigé : 5 + 2 = 7');
  await fermerTout();

  console.log('6. Vente des 2 souverains (un seul coffre) → retirés automatiquement');
  await ev(id => orOuvrirLot(id), idSouv); await pause(300);
  await clic('#orLotVente');
  await page.click('#orVQte', { clickCount: 3 }); await page.keyboard.type('2');
  await page.click('#orVPrix'); await page.keyboard.type('600'); await veille();
  await clic('#orVenteOk'); await page.waitForFunction(() => OR.ventes.length === 2); await pause(400);
  ok(!(await ouverte('orEmp')), 'pas de question (aucune ambiguïté)');
  ok(await ev(() => (coffreById('c1').orPieces || []).every(p => p.lot !== OR.lots.find(l => l.type === 'souverain').id)), 'souverains retirés du Coffre maison');
  ok(!(await ev(id => !!document.querySelector(`#orLotBody .or-d-emp`), idSouv)), 'fiche d\'un achat entièrement vendu : pas de bloc Emplacement');
  await fermerTout();

  console.log('7. Nouveau coffre depuis la fenêtre Emplacement (même système de coffres)');
  await ev(id => orpOuvrir(id), idNapo); await pause(300);
  reponse = 'Coffre bureau'; await clic('#orEmpNouveau'); reponse = 'accept'; await pause(300);
  const nc = await ev(() => S.coffres.map(c => c.nom));
  ok(nc.join() === 'Coffre maison,Banque Tel-Aviv,Coffre bureau' && !(await ouverte('coffre')), 'coffre créé dans S.coffres, la fenêtre Emplacement reste au premier plan');
  ok((await ev(() => document.querySelectorAll('#orEmpBody .emp-row').length)) === 3, 'il apparaît dans la répartition');
  await clic('#orEmpAnnuler'); await fermerTout();

  console.log('8. Suppression d\'un coffre contenant de l\'or');
  await clic('.tab.t-coffre'); await clic('#view-coffres [data-cof="c2"]');
  reponse = 'dismiss'; await clic('#cofDel');
  ok(dernierDialogue.includes('2 pièces d\'or') && dernierDialogue.includes('Emplacement non renseigné'), 'confirmation explicite mentionnant l\'or : « ' + dernierDialogue.split('\n').filter(Boolean)[1] + ' »');
  ok(await ev(() => !!coffreById('c2')), 'refusé : coffre conservé');
  reponse = 'accept'; await clic('#cofDel'); reponse = 'accept';
  ok(await ev(() => !coffreById('c2')), 'accepté : coffre supprimé');
  await clic('.tab.t-or'); await pause(300);
  ok((await ev(id => document.querySelector(`#view-or [data-oremp="${id}"]`)?.innerText.trim(), idNapo)) === '🔐 5 dans Coffre maison · 2 non renseignées', 'pièces conservées dans l\'Or : « 5 dans Coffre maison · 2 non renseignées »');
  await ev(() => document.querySelector('#view-or .or-ref').scrollIntoView({ block: 'start' })); await pause(200);
  await capt('10-apres-suppression-coffre');

  console.log('9. Données : Or intact, état accepté par le serveur');
  await page.waitForFunction(() => !isPending(), { timeout: 8000 }).catch(() => {});
  const apres = await lireOr();
  ok(JSON.stringify(apres.lots) === JSON.stringify(avant.lots), 'achats d\'or strictement identiques (aucun achat modifié par la fonctionnalité)');
  ok(apres.ventes.length === 2 && avant.ventes.length === 0, 'seules les 2 ventes saisies par la recette ont été ajoutées');
  const j = await get('/essai/journal');
  const pieces = j.valora.data.coffres.map(c => [c.id, c.orPieces || []]);
  ok(JSON.stringify(pieces) === JSON.stringify([['c1', [{ lot: idNapo, qte: 5 }]], [pieces[1][0], []]]) && !j.ecritures.some(e => e.refus), 'serveur : répartition enregistrée (c1 = 5 Napoléon), aucun refus');
  ok(!erreursJs.length, 'aucune erreur JavaScript ' + JSON.stringify(erreursJs));
  await navig.close();
}

await parcours('ordinateur', { width: 1280, height: 900 });
await parcours('iphone', { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await parcours('iphone-clair', { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, 'light');
console.log(`\n${oks} contrôles OK, ${echecs} échec(s). Captures : ${CAPT}`);
process.exit(echecs ? 1 : 0);
