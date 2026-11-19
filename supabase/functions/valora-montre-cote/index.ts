// Valora ⌚ — Edge function « valora-montre-cote » : point d'entrée Deno.
//
// Toute la logique (contrôle du jeton, quota, appel Claude, contrôles anti-invention, médiane,
// conversion BCE) est dans logique.ts, testée hors Deno par tests/montres/cote.test.mjs.
// Ici on ne fait que brancher les variables d'environnement et le client Claude officiel.
//
// Variables d'environnement (serveur Supabase auto-hébergé) : SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY. La vérification JWT du runtime est désactivée :
// la fonction contrôle elle-même le jeton de l'utilisateur.

import Anthropic from "npm:@anthropic-ai/sdk@1.10.0";
import { traiter, type AppelClaude, type Env, type MessageClaude } from "./logique.ts";

const env: Env = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "",
  ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
};

// Client créé au premier appel : une clé absente devient une réponse 502 propre, pas un plantage au démarrage.
let client: Anthropic | null = null;
const claude: AppelClaude = async (params) => {
  client ??= new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY"), timeout: 120_000, maxRetries: 2 });
  const r = await client.beta.messages.create(
    params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  );
  return r as unknown as MessageClaude;
};

Deno.serve((req: Request) => traiter(req, env, { claude }));
