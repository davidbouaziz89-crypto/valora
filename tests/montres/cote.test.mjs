// Edge function valora-montre-cote : logique testée hors Deno, avec un faux client Claude,
// un faux Supabase (auth + RPC de quota) et une fausse BCE. Aucun appel réseau réel, aucune clé.
// Lancer depuis ~/projects/valora : node --experimental-strip-types --test tests/montres/cote.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  traiter, viderCacheBce, extraireJson, normaliserUrl, contenuARenvoyer, moinsMois, lireBce,
  MSG_INDISPONIBLE, MODELE, TTL_BCE_MS,
} from '../../supabase/functions/valora-montre-cote/logique.ts';

const ENV = { SUPABASE_URL: 'http://kong', ANON_KEY: 'cle-anon', SERVICE_KEY: 'cle-service' };
const U = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const MAINTENANT = Date.parse('2026-11-19T11:00:00Z');   // jour de Paris : 2026-11-19 ; limite 18 mois : 2025-05-19

// --- fausse BCE : 1 EUR = 1,10 USD = 4 ILS -------------------------------------------------
const xmlBce = (date = '2026-11-18', taux = { USD: 1.1, JPY: 160.5, GBP: 0.85, CHF: 0.95, ILS: 4 }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
	<Cube>
		<Cube time='${date}'>
${Object.entries(taux).map(([c, r]) => `			<Cube currency='${c}' rate='${r}'/>`).join('\n')}
		</Cube>
	</Cube>
</gesmes:Envelope>`;

// --- pages de marché fictives -----------------------------------------------------------------
const C24 = 'https://www.chrono24.fr/rolex/submariner-date--id111.htm';
const WC = 'https://watchcharts.com/watch_model/123-rolex-submariner-date-126610ln/overview';
const PH = 'https://www.phillips.com/detail/rolex/12345';
const EB = 'https://www.ebay.com/itm/987654321';

// --- blocs de réponse Claude ------------------------------------------------------------------
let nId = 0;
const recherche = (urls) => {
  const id = 'srvtoolu_' + (++nId);
  return [
    { type: 'server_tool_use', id, name: 'web_search', input: { query: 'rolex 126610LN prix' }, caller: { type: 'direct' } },
    { type: 'web_search_tool_result', tool_use_id: id, caller: { type: 'direct' },
      content: urls.map((url) => ({ type: 'web_search_result', url, title: 'page', encrypted_content: 'xyz', page_age: null })) },
  ];
};
const rechercheEnErreur = (code = 'max_uses_exceeded') => {
  const id = 'srvtoolu_' + (++nId);
  return [
    { type: 'server_tool_use', id, name: 'web_search', input: { query: 'q' }, caller: { type: 'direct' } },
    { type: 'web_search_tool_result', tool_use_id: id, caller: { type: 'direct' }, content: { type: 'web_search_tool_result_error', error_code: code } },
  ];
};
const texteFinal = (releves, avant = 'Voici les relevés trouvés.\n') =>
  ({ type: 'text', citations: null, text: avant + '```json\n' + JSON.stringify({ releves }, null, 2) + '\n```' });
const message = (blocs, stop_reason = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: MODELE,
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, ...blocs],
  stop_reason, stop_details: null,
  usage: { input_tokens: 30000, output_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 3 } },
});
const rel = (source, url, prix, devise, plus = {}) =>
  ({ source, url, prix, devise, date: '2026-10-01', type: 'annonce', etat: 'très bon état, boîte et papiers', reference_exacte: true, ...plus });

// --- faux réseau + faux client Claude ---------------------------------------------------------
function banc({ reponses = [], bce = 'ok', quota = false } = {}) {
  const appels = { claude: [], bce: 0, auth: 0, reserver: [], terminer: [] };
  const f = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {};
    if (u.host === 'kong' && u.pathname === '/auth/v1/user') {
      appels.auth++;
      assert.equal(h.apikey, 'cle-anon');
      const ok = h.Authorization === 'Bearer jeton-ok';
      return new Response(JSON.stringify(ok ? { id: U, email: 'u@test.local' } : { msg: 'invalid JWT' }), { status: ok ? 200 : 401 });
    }
    if (u.host === 'kong' && u.pathname.startsWith('/rest/v1/rpc/')) {
      assert.equal(h.apikey, 'cle-service');                       // RPC appelées avec la clé service
      assert.equal(h.Authorization, 'Bearer cle-service');
      const nom = u.pathname.split('/').pop(), args = JSON.parse(init.body);
      if (nom === 'valora_montre_cote_reserver') {
        appels.reserver.push(args);
        if (quota) return new Response(JSON.stringify({ code: 'P0001', message: 'Quota journalier atteint : 20 estimations par jour', details: null, hint: null }), { status: 400 });
        return new Response(JSON.stringify(ID), { status: 200 });
      }
      if (nom === 'valora_montre_cote_terminer') { appels.terminer.push(args); return new Response(null, { status: 204 }); }
    }
    if (u.hostname === 'www.ecb.europa.eu') {
      assert.equal(u.pathname, '/stats/eurofxref/eurofxref-daily.xml');
      appels.bce++;
      if (bce === 'panne') throw new TypeError('fetch failed');
      if (bce === '503') return new Response('Service Unavailable', { status: 503 });
      return new Response(typeof bce === 'string' && bce.startsWith('<?xml') ? bce : xmlBce(), { status: 200 });
    }
    throw new Error('requête réseau inattendue : ' + url);
  };
  const file = [...reponses];
  const claude = async (params) => {
    appels.claude.push(structuredClone(params));
    const r = file.shift();
    if (r instanceof Error) throw r;
    if (!r) throw new Error('le faux client Claude n\'a plus de réponse');
    return r;
  };
  return { f, claude, appels };
}
const requete = (corps, { jeton = 'jeton-ok', methode = 'POST', brut } = {}) => new Request('http://x/functions/v1/valora-montre-cote', {
  method: methode,
  headers: { ...(jeton ? { authorization: 'Bearer ' + jeton } : {}), 'content-type': 'application/json' },
  ...(methode === 'POST' ? { body: brut ?? JSON.stringify(corps) } : {}),
});
const MONTRE = { marque: 'Rolex', modele: 'Submariner Date', reference: '126610LN', devise: 'EUR' };
async function appeler(b, corps = MONTRE, opts = {}, maintenant = MAINTENANT) {
  const r = await traiter(requete(corps, opts), ENV, { claude: b.claude, fetch: b.f, maintenant });
  const texte = await r.text();
  return { status: r.status, texte, j: texte ? JSON.parse(texte) : null, headers: r.headers };
}
// « terminer » appelé exactement une fois, avec la réservation et le statut attendus
function termineUneFois(b, statut) {
  assert.equal(b.appels.reserver.length, 1);
  assert.deepEqual(b.appels.reserver[0], { p_user: U });
  assert.equal(b.appels.terminer.length, 1, 'terminer doit être appelé une fois');
  assert.equal(b.appels.terminer[0].p_id, ID);
  assert.equal(b.appels.terminer[0].p_statut, statut);
  return b.appels.terminer[0].p_resultat;
}

test.beforeEach(() => viderCacheBce());

// ===========================================================================================
test('estimation fiable : 3 relevés, médiane calculée par le code, conversion USD→EUR au taux BCE', async () => {
  const b = banc({ reponses: [message([
    ...recherche([C24, WC]), ...recherche([PH]),
    texteFinal([
      rel('Chrono24', C24, 10000, 'EUR'),
      rel('WatchCharts', WC, 12100, 'USD', { type: 'indice' }),                       // 12100 / 1,10 = 11000 €
      rel('Phillips', PH, 12500, 'EUR', { type: 'vente', date: '2026-06-12' }),
    ]),
  ])] });
  const { status, j, headers } = await appeler(b);
  assert.equal(status, 200);
  assert.equal(headers.get('access-control-allow-origin'), '*');
  assert.equal(j.fiable, true);
  assert.equal(j.valeur, 11000);                                                       // médiane de 10000 / 11000 / 12500
  assert.equal(j.devise, 'EUR');
  assert.deepEqual(j.fourchette, { min: 10000, max: 12500 });
  assert.deepEqual(j.taux, { date: '2026-11-18', source: 'BCE' });
  assert.equal(j.sources, 'Chrono24, WatchCharts, Phillips');
  assert.equal(j.date, '2026-11-19');
  assert.deepEqual(j.points.map((p) => [p.source, p.prix, p.devise, p.prix_converti, p.type]), [
    ['Chrono24', 10000, 'EUR', 10000, 'annonce'], ['WatchCharts', 12100, 'USD', 11000, 'indice'], ['Phillips', 12500, 'EUR', 12500, 'vente'],
  ]);
  assert.deepEqual(Object.keys(j.points[0]).sort(), ['date', 'devise', 'prix', 'prix_converti', 'source', 'type', 'url']);
  assert.deepEqual(Object.keys(j).sort(), ['date', 'devise', 'fiable', 'fourchette', 'note', 'points', 'sources', 'taux', 'valeur']);
  assert.match(j.note, /médiane de 3 relevés/);
  assert.match(j.note, /BCE du 18\/11\/2026/);
  assert.equal(b.appels.bce, 1);
  // paramètres envoyés à Claude
  const p = b.appels.claude[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.max_tokens, 16000);
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.deepEqual(p.output_config, { effort: 'medium' });
  assert.deepEqual(p.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }]);
  assert.equal(p.tool_choice, undefined);
  assert.equal(p.output_config.format, undefined);                                       // pas de structured outputs
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.match(p.messages[0].content, /"reference":"126610LN"/);
  assert.match(p.messages[0].content, /2026-11-19/);
  // terminer : statut fiable, résultat = la réponse + le journal de recherche (coût)
  const res = termineUneFois(b, 'fiable');
  assert.equal(res.valeur, 11000);
  assert.equal(res.recherche.usage.recherches, 3);
  assert.equal(res.recherche.usage.cout_estime_usd, 0.23);                              // 30k × 4 $/M + 4k × 20 $/M + 3 recherches × 0,01 $
});

test('conversion EUR→ILS et USD→ILS, nombre pair de relevés : médiane = moyenne des deux du milieu', async () => {
  const b = banc({ reponses: [message([
    ...recherche([C24, WC, PH, EB]),
    texteFinal([
      rel('Chrono24', C24, 10000, 'EUR'),                     // 40 000 ₪
      rel('WatchCharts', WC, 44000, 'ILS', { type: 'indice' }), // 44 000 ₪ (aucune conversion)
      rel('Phillips', PH, 13200, 'USD', { type: 'vente' }),   // 13200 / 1,1 × 4 = 48 000 ₪
      rel('eBay', EB, 11500, 'EUR', { type: 'vente' }),        // 46 000 ₪
    ]),
  ])] });
  const { status, j } = await appeler(b, { ...MONTRE, devise: 'ILS' });
  assert.equal(status, 200);
  assert.equal(j.fiable, true);
  assert.equal(j.devise, 'ILS');
  assert.equal(j.valeur, 45000);
  assert.deepEqual(j.fourchette, { min: 40000, max: 48000 });
  assert.deepEqual(j.points.map((p) => p.prix_converti), [40000, 44000, 48000, 46000]);
  assert.deepEqual(j.taux, { date: '2026-11-18', source: 'BCE' });
  termineUneFois(b, 'fiable');
});

test('tout dans la devise demandée : aucun appel BCE, taux = null', async () => {
  const b = banc({ bce: 'panne', reponses: [message([...recherche([C24, PH]), texteFinal([rel('Chrono24', C24, 10000, 'EUR'), rel('Phillips', PH, 11000, 'EUR')])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, true);
  assert.equal(j.valeur, 10500);
  assert.equal(j.taux, null);
  assert.equal(b.appels.bce, 0);
});

test('URL hallucinée (absente des résultats de recherche) : relevé rejeté ; URL normalisée acceptée', async () => {
  const b = banc({ reponses: [message([
    ...recherche([C24 + '/', WC]),
    texteFinal([
      rel('Chrono24', 'https://WWW.Chrono24.fr/rolex/submariner-date--id111.htm?utm_source=x#photos', 10000, 'EUR'), // même page
      rel('WatchCharts', WC, 10500, 'EUR', { type: 'indice' }),
      rel('Phillips', 'https://www.phillips.com/detail/rolex/99999', 3000, 'EUR', { type: 'vente' }),               // jamais vue
    ]),
  ])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, true);
  assert.equal(j.points.length, 2);
  assert.ok(!j.points.some((p) => p.url.includes('99999')));
  assert.equal(j.points[0].url, C24 + '/');                       // l'URL renvoyée est celle des résultats de recherche
  assert.equal(j.valeur, 10250);
  const res = termineUneFois(b, 'fiable');
  assert.ok(res.recherche.rejets.some((r) => r.url.includes('99999') && /absente des résultats/.test(r.motif)));
});

test('URL présente seulement dans une citation : acceptée', async () => {
  const cite = { type: 'text', text: 'Une vente Phillips', citations: [{ type: 'web_search_result_location', url: PH, title: 'Phillips', encrypted_index: 'x', cited_text: '...' }] };
  const b = banc({ reponses: [message([...recherche([C24]), cite, texteFinal([rel('Chrono24', C24, 10000, 'EUR'), rel('Phillips', PH, 11000, 'EUR', { type: 'vente' })])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, true);
  assert.equal(j.points.length, 2);
});

test('un seul relevé : non fiable, raison claire, statut non_fiable', async () => {
  const b = banc({ reponses: [message([...recherche([C24]), texteFinal([rel('Chrono24', C24, 10000, 'EUR')])])] });
  const { status, j } = await appeler(b);
  assert.equal(status, 200);
  assert.equal(j.fiable, false);
  assert.match(j.raison, /^Un seul relevé/);
  assert.equal(j.points.length, 1);
  assert.equal(j.date, '2026-11-19');
  assert.deepEqual(Object.keys(j).sort(), ['date', 'fiable', 'points', 'raison']);
  assert.equal(j.valeur, undefined);                               // aucun prix inventé
  termineUneFois(b, 'non_fiable');
});

test('aucun relevé (liste vide) : « Aucune donnée de marché fiable trouvée pour cette référence »', async () => {
  const b = banc({ reponses: [message([...recherche([C24]), texteFinal([], 'Rien de sûr trouvé.\n')])] });
  const { j } = await appeler(b);
  assert.deepEqual(j, { fiable: false, raison: 'Aucune donnée de marché fiable trouvée pour cette référence', points: [], date: '2026-11-19' });
  termineUneFois(b, 'non_fiable');
});

test('deux relevés de la même page : non fiable (2 URL distinctes exigées)', async () => {
  const b = banc({ reponses: [message([...recherche([WC]), texteFinal([rel('WatchCharts', WC, 10000, 'EUR'), rel('WatchCharts', WC, 10400, 'EUR')])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, false);
  assert.match(j.raison, /même page/);
});

test('dispersion > 3 : non fiable « Prix trop dispersés (de X à Y) »', async () => {
  const b = banc({ reponses: [message([...recherche([C24, PH, EB]), texteFinal([
    rel('Chrono24', C24, 3000, 'EUR'), rel('Phillips', PH, 15000, 'EUR', { type: 'vente' }), rel('eBay', EB, 8000, 'EUR', { type: 'vente' }),
  ])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, false);
  assert.match(j.raison, /^Prix trop dispersés \(de 3\s000\s€ à 15\s000\s€\)$/u);
  assert.equal(j.points.length, 3);
  termineUneFois(b, 'non_fiable');
});

test('date de plus de 18 mois : relevé rejeté ; 17 mois et date absente : acceptés', async () => {
  assert.equal(moinsMois('2026-11-19', 18), '2025-05-19');
  const b = banc({ reponses: [message([...recherche([C24, PH, EB]), texteFinal([
    rel('Chrono24', C24, 10000, 'EUR', { date: null }),
    rel('Phillips', PH, 11000, 'EUR', { type: 'vente', date: '2025-06-20' }),
    rel('eBay', EB, 30000, 'EUR', { type: 'vente', date: '2024-01-10' }),          // trop ancien
  ])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, true);
  assert.deepEqual(j.points.map((p) => p.source), ['Chrono24', 'Phillips']);
  assert.equal(j.points[0].date, null);
  assert.equal(j.valeur, 10500);
  assert.match(j.note, /1 relevé sans date/);
  const res = termineUneFois(b, 'fiable');
  assert.ok(res.recherche.rejets.some((r) => /trop ancien \(2024-01-10\)/.test(r.motif)));
});

test('relevés invalides rejetés : référence non confirmée, prix nul ou texte, devise inconnue, date future, doublon', async () => {
  const b = banc({ reponses: [message([...recherche([C24, WC, PH, EB]), texteFinal([
    rel('Chrono24', C24, 10000, 'EUR'),
    rel('Chrono24', C24, 10000, 'EUR'),                                       // doublon
    rel('WatchCharts', WC, 10500, 'EUR', { reference_exacte: false }),
    rel('Phillips', PH, 0, 'EUR'),
    rel('Phillips', PH, 'environ 11000', 'EUR'),
    rel('eBay', EB, 11000, 'XYZ'),
    rel('eBay', EB, 11000, 'EUR', { date: '2027-03-01' }),
    rel('eBay', EB, '11000', 'eur', { type: 'inconnu' }),                     // prix en texte numérique + devise en minuscules : accepté
  ])])] });
  const { j } = await appeler(b);
  assert.equal(j.fiable, true);
  assert.deepEqual(j.points.map((p) => [p.source, p.prix, p.devise, p.type]), [['Chrono24', 10000, 'EUR', 'annonce'], ['eBay', 11000, 'EUR', 'annonce']]);
  const motifs = termineUneFois(b, 'fiable').recherche.rejets.map((r) => r.motif);
  for (const m of ['doublon', 'référence non confirmée', 'prix invalide', 'devise non convertible (XYZ)', 'date dans le futur (2027-03-01)']) {
    assert.ok(motifs.includes(m), 'motif attendu : ' + m + ' — reçus : ' + motifs.join(' | '));
  }
});

test('BCE en panne et conversion nécessaire : relevés en devise étrangère rejetés, jamais de taux inventé', async () => {
  for (const panne of ['panne', '503']) {
    viderCacheBce();
    const b = banc({ bce: panne, reponses: [message([...recherche([C24, WC, PH]), texteFinal([
      rel('Chrono24', C24, 10000, 'EUR'), rel('WatchCharts', WC, 11000, 'USD'), rel('Phillips', PH, 12000, 'USD', { type: 'vente' }),
    ])])] });
    const { status, j } = await appeler(b);
    assert.equal(status, 200);
    assert.equal(j.fiable, false);
    assert.match(j.raison, /^Un seul relevé.*\(2 relevés en devise étrangère écartés : taux de change BCE indisponibles\)$/);
    assert.deepEqual(j.points.map((p) => p.devise), ['EUR']);
    assert.equal(b.appels.bce, 1);                                 // une seule tentative pour toute la requête
    termineUneFois(b, 'non_fiable');
  }
});

test('BCE : taux gardés 6 h en mémoire ; taux figés ou incomplets refusés', async () => {
  const fabriquer = () => banc({ reponses: [message([...recherche([C24, WC]), texteFinal([rel('Chrono24', C24, 10000, 'EUR'), rel('WatchCharts', WC, 11000, 'USD')])])] });
  const b1 = fabriquer(); await appeler(b1);
  const b2 = fabriquer(); const { j } = await appeler(b2, MONTRE, {}, MAINTENANT + 3600_000);
  assert.equal(j.fiable, true);
  assert.equal(b2.appels.bce, 0);                                  // cache
  const b3 = fabriquer(); await appeler(b3, MONTRE, {}, MAINTENANT + TTL_BCE_MS + 1);
  assert.equal(b3.appels.bce, 1);                                  // cache expiré : relu
  assert.throws(() => lireBce(xmlBce('2026-10-01'), MAINTENANT), /périmés/);
  assert.throws(() => lireBce(xmlBce('2026-11-18', { USD: 1.1 }), MAINTENANT), /absents/);
  assert.throws(() => lireBce('<html>maintenance</html>', MAINTENANT), /date absente/);
  assert.deepEqual(lireBce(xmlBce(), MAINTENANT).taux.ILS, 4);
});

test('pause_turn : relancé avec le contenu assistant renvoyé tel quel, puis résultat final', async () => {
  const pause = message([...recherche([C24, WC])], 'pause_turn');
  const suite = message([...recherche([PH]), texteFinal([rel('Chrono24', C24, 10000, 'EUR'), rel('WatchCharts', WC, 10400, 'EUR'), rel('Phillips', PH, 10800, 'EUR', { type: 'vente' })])]);
  const b = banc({ reponses: [pause, suite] });
  const { j } = await appeler(b);
  assert.equal(b.appels.claude.length, 2);
  const m2 = b.appels.claude[1].messages;
  assert.equal(m2.length, 2);
  assert.equal(m2[0].role, 'user');
  assert.deepEqual(m2[1], { role: 'assistant', content: pause.content });   // pas de message « continue »
  assert.equal(b.appels.claude[0].messages.length, 1);                      // le 1er appel n'a pas été modifié après coup
  assert.equal(j.fiable, true);
  assert.equal(j.points.length, 3);                                         // URL vues dans la 1re partie acceptées
  assert.equal(j.valeur, 10400);
  termineUneFois(b, 'fiable');
});

test('pause_turn : 2 relances au plus, puis 502 (statut erreur)', async () => {
  const b = banc({ reponses: [1, 2, 3, 4].map(() => message([...recherche([C24])], 'pause_turn')) });
  const { status, j } = await appeler(b);
  assert.equal(b.appels.claude.length, 3);
  assert.equal(status, 502);
  assert.deepEqual(j, { erreur: MSG_INDISPONIBLE });
  assert.match(termineUneFois(b, 'erreur').erreur, /inachevée/);
});

test('erreur de l\'outil de recherche (content = objet) : gérée sans plantage et journalisée', async () => {
  const b = banc({ reponses: [message([...recherche([C24, PH]), ...rechercheEnErreur('max_uses_exceeded'),
    texteFinal([rel('Chrono24', C24, 10000, 'EUR'), rel('Phillips', PH, 10600, 'EUR', { type: 'vente' })])])] });
  const { status, j } = await appeler(b);
  assert.equal(status, 200);
  assert.equal(j.fiable, true);
  assert.deepEqual(termineUneFois(b, 'fiable').recherche.erreurs_recherche, ['max_uses_exceeded']);
});

test('refus du modèle (stop_reason refusal) : non fiable, rien d\'inventé', async () => {
  const refus = { ...message([]), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } };
  const b = banc({ reponses: [refus] });
  const { status, j } = await appeler(b);
  assert.equal(status, 200);
  assert.equal(j.fiable, false);
  assert.match(j.raison, /n'a pas pu traiter/);
  assert.deepEqual(j.points, []);
  termineUneFois(b, 'non_fiable');
});

test('erreur de l\'API Claude : 502 sans aucun détail technique ni clé ; terminer(erreur)', async () => {
  const err = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key sk-ant-api03-SECRET_abc"}}'), { status: 401 });
  const b = banc({ reponses: [err] });
  const { status, texte } = await appeler(b);
  assert.equal(status, 502);
  assert.equal(texte, JSON.stringify({ erreur: "Service d'estimation indisponible, réessaie plus tard" }));
  const res = termineUneFois(b, 'erreur');
  assert.ok(!JSON.stringify(res).includes('sk-ant'), 'la clé ne doit jamais être enregistrée');
  assert.match(res.erreur, /\[clé masquée\]/);
});

test('réponse sans JSON exploitable ou réponse inattendue : 502 et terminer(erreur)', async () => {
  for (const r of [message([{ type: 'text', text: 'Je n\'ai rien trouvé de concluant.', citations: null }]), { oups: true }]) {
    const b = banc({ reponses: [r] });
    const { status, j } = await appeler(b);
    assert.equal(status, 502);
    assert.deepEqual(j, { erreur: MSG_INDISPONIBLE });
    termineUneFois(b, 'erreur');
  }
});

test('jeton absent, clé anon ou jeton refusé : 401, ni quota ni Claude', async () => {
  for (const jeton of [null, 'cle-anon', 'jeton-faux']) {
    const b = banc();
    const { status, j } = await appeler(b, MONTRE, { jeton });
    assert.equal(status, 401);
    assert.deepEqual(j, { erreur: 'connexion requise' });
    assert.equal(b.appels.reserver.length + b.appels.terminer.length + b.appels.claude.length, 0);
  }
});

test('entrée invalide : 400, quota non consommé', async () => {
  const cas = [
    [{ ...MONTRE, marque: '' }, /marque/],
    [{ ...MONTRE, marque: undefined }, /marque/],
    [{ ...MONTRE, reference: 'x'.repeat(81) }, /référence/],
    [{ ...MONTRE, reference: '   ' }, /référence/],
    [{ ...MONTRE, modele: 'm'.repeat(121) }, /modèle/],
    [{ ...MONTRE, modele: 42 }, /modèle/],
    [{ ...MONTRE, devise: 'GBP' }, /devise/],
    [[1, 2], /corps JSON/],
  ];
  for (const [corps, motif] of cas) {
    const b = banc();
    const { status, j } = await appeler(b, corps);
    assert.equal(status, 400, JSON.stringify(corps));
    assert.match(j.erreur, motif);
    assert.equal(b.appels.reserver.length + b.appels.claude.length, 0);
  }
  const b = banc();
  const { status } = await appeler(b, null, { brut: '{pas du json' });
  assert.equal(status, 400);
  // limites acceptées : 80 / 80 / 120 caractères, modèle absent
  const ok = banc({ reponses: [message([texteFinal([])])] });
  const r = await appeler(ok, { marque: 'm'.repeat(80), reference: 'r'.repeat(80), modele: 'x'.repeat(120), devise: 'USD' });
  assert.equal(r.status, 200);
  const sansModele = banc({ reponses: [message([texteFinal([])])] });
  assert.equal((await appeler(sansModele, { marque: 'Omega', reference: '310.30.42.50.01.001', devise: 'EUR' })).status, 200);
});

test('quota dépassé : 429 avec le message de la base, ni Claude ni terminer', async () => {
  const b = banc({ quota: true });
  const { status, j } = await appeler(b);
  assert.equal(status, 429);
  assert.deepEqual(j, { erreur: 'Quota journalier atteint : 20 estimations par jour' });
  assert.equal(b.appels.reserver.length, 1);
  assert.equal(b.appels.claude.length, 0);
  assert.equal(b.appels.terminer.length, 0);
});

test('OPTIONS → 200 CORS ; autre méthode → 405', async () => {
  const b = banc();
  const o = await traiter(requete(null, { methode: 'OPTIONS' }), ENV, { claude: b.claude, fetch: b.f });
  assert.equal(o.status, 200);
  assert.equal(o.headers.get('access-control-allow-origin'), '*');
  assert.match(o.headers.get('access-control-allow-headers'), /authorization/);
  const g = await traiter(requete(null, { methode: 'GET' }), ENV, { claude: b.claude, fetch: b.f });
  assert.equal(g.status, 405);
  assert.equal(b.appels.auth, 0);
});

// --- fonctions utilitaires ----------------------------------------------------------------------
test('extraireJson : texte autour, ```json, accolades dans les chaînes, dernier objet retenu', () => {
  assert.equal(extraireJson('rien ici'), null);
  assert.equal(extraireJson('{"autre": 1}'), null);
  assert.deepEqual(extraireJson('Résultat {brouillon} :\n```json\n{"releves":[{"etat":"boîte {orig} \\"ok\\""}]}\n```\nfin'),
    { releves: [{ etat: 'boîte {orig} "ok"' }] });
  assert.deepEqual(extraireJson('{"releves":[1]} puis correction {"releves":[2]}'), { releves: [2] });
});

test('normaliserUrl : hôte en minuscules sans www, sans query/ancre/slash final, http(s) seulement', () => {
  assert.equal(normaliserUrl('https://WWW.Chrono24.FR/a/b/?x=1#y'), 'chrono24.fr/a/b');
  assert.equal(normaliserUrl('http://chrono24.fr/a/b'), 'chrono24.fr/a/b');
  assert.equal(normaliserUrl('https://chrono24.fr/'), 'chrono24.fr');
  assert.equal(normaliserUrl('javascript:alert(1)'), null);
  assert.equal(normaliserUrl('pas une url'), null);
  assert.equal(normaliserUrl(42), null);
});

test('reprise après un repli de modèle (bloc fallback) : blocs internes avant la bascule retirés', () => {
  const blocs = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'server_tool_use', id: 'a', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
    { type: 'server_tool_use', id: 'b', name: 'web_search', input: {} },           // sans résultat
    { type: 'text', text: 'partiel' },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
    { type: 'thinking', thinking: '', signature: 't' },
    { type: 'server_tool_use', id: 'c', name: 'web_search', input: {} },
  ];
  assert.deepEqual(contenuARenvoyer(blocs).map((b) => b.type + (b.id ? ':' + b.id : '')),
    ['server_tool_use:a', 'web_search_tool_result', 'text', 'fallback', 'thinking', 'server_tool_use:c']);
  const sansRepli = [{ type: 'thinking' }, { type: 'text' }];
  assert.equal(contenuARenvoyer(sansRepli), sansRepli);
});
