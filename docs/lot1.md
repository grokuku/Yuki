# Lot 1 — Noyau texte

> Spécification validée, recopiée telle quelle. Elle fait foi pour le périmètre,
> les contrats et les critères d'acceptation du Lot 1.

## Contexte

Implémentation du **Lot 1 : noyau texte** du projet Yuki.

Le **Lot 0 est terminé et validé** : squelette du dépôt, `docker-compose.yml`
avec un service unique `gateway`, porte de compatibilité GPU, 54 tests verts,
typecheck et build verts. Le Lot 1 **étend** ce socle sans le casser.

Conventions : **`src/` organisé par domaine**, package unique, npm, TypeScript
5.9.3, vitest 5.0.1, image Node 24.21.0 épinglée par digest, conteneur
**non-root** avec **rootfs `read_only: true`** + `tmpfs: /tmp`, aucun chemin
absolu hôte, aucun tag `latest`.

Objectif : un **tour de conversation TEXTE de bout en bout** (UI web → gateway
→ SDK Pi embarqué → streaming → UI), **instrumenté**, sans voix et sans
multi-LLM.

## Fichiers créés

```
src/pi/                     domaine « façade Pi embarqué »
  index.ts                  ré-exporte la surface publique du domaine
  types.ts                  types PUBLICS de la façade — AUCUN type du SDK ici
  host.ts                   interface `PiHost` + fabrique `createPiHost()`
  sdk-host.ts               implémentation v1 in-process — SEUL fichier autorisé à importer le SDK
  events.ts                 événements normalisés + mapping SDK → façade
  errors.ts                 `PiHostError` + codes + traduction des erreurs/timeouts/aborts du SDK
  config.ts                 résolution des chemins (agentDir, cwd, HOME), garde-fous rootfs read-only, seed de settings
  instrumentation.ts        étages de latence, `phase` / `run_summary`, comptage de tokens

src/gateway/ws/             domaine « transport temps réel »
  protocol.ts               contrat WS : types des messages client↔serveur
  server.ts                 hook `upgrade`, cycle de vie des clients, fermeture propre
  session-stream.ts         buffer borné par session, compteur `seq` monotone, rejeu, snap
  transport.ts              abstraction `Transport` (WS maintenant ; SSE prévu, non implémenté)

src/gateway/routes/static.ts   service des fichiers statiques de l'UI (lecture seule, anti-traversal)

public/ui/                  UI statique, servie telle quelle, AUCUNE chaîne de build front
  index.html  app.js  styles.css

config/pi/
  system-prompt.md          prompt système GÉNÉRALISTE (remplace celui d'« assistant de code »)
  settings.json             réglages par défaut (seedés sur le volume, jamais réécrits ensuite)

tests/pi/                   host-double.ts (FakePiHost) + instrumentation.test.ts
tests/gateway/ws/           protocol.test.ts + session-stream.test.ts + abort.test.ts
tests/integration/          ws-text.test.ts + real-sdk.test.ts (opt-in, skip par défaut)
tests/fixtures/pi/          scripts d'événements rejoués par FakePiHost
docs/lot1.md                la spec validée recopiée
```

**Fichiers modifiés** : `src/gateway/app.ts` (servir l'UI statique, brancher le
transport, enrichir `/health`) ; `src/gateway/server.ts` (**hook `upgrade`**,
arrêt gracieux qui **ferme les sockets WS** avant `server.close()`) ;
`src/gateway/routes/health.ts` (bloc `subsystems`) ; `src/index.ts` (initialiser
le PiHost **après** la porte GPU, brancher le transport, fermer le host à
l'arrêt) ; `src/config/env.ts` (nouvelles variables) ; `package.json` ;
`infra/gateway/Dockerfile` (`COPY public ./public` dans l'étage runtime) ;
`docker-compose.yml` ; `.env.example` ; `docs/{architecture,versions,runbook}.md`.

## Dépendances runtime introduites

Le « zéro dépendance runtime » du Lot 0 tombe ici.

| Paquet | Version | Rôle |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **`0.85.1` EXACT, sans caret** | SDK Pi embarqué (sessions, streaming, événements). Le paquet publie un `npm-shrinkwrap.json` → un caret ferait dériver l'arbre. ⚠️ La 0.85.0 était cassée. Exige `engines >= 22.19.0`. |
| `ws` | version stable actuelle (figée exactement) | Serveur WebSocket. Node 24 fournit un *client* WebSocket natif mais **aucun serveur** ; `ws` est pur JS (pas de compilation native, compatible rootfs read-only). |
| `@types/ws` | aligné sur le patch de `ws` (devDependency) | Types TS. |

## Façade `PiHost`

- **Aucun type du SDK ne doit fuiter** hors de `src/pi/sdk-host.ts`. Types
  publics en JSON simple dans `src/pi/types.ts`. Toutes les données sortent par
  **événements sérialisables** ou **méthodes asynchrones** renvoyant du JSON.
- **Test de frontière automatisé** : il scanne `src/**` et **échoue** si un
  fichier autre que `src/pi/sdk-host.ts` importe `@earendil-works/...`.
- L'interface reste compatible avec une bascule ultérieure vers `pi --mode rpc`.
- Surface : `createPiHost(options) → PiHostOptions { agentDir, cwd,
  systemPrompt, model?, thinking?, logger }` ; et sur le host : `start()`,
  `ensureSession(target)`, `newSession()`, `continueRecent()`,
  `resume(sessionFile)`, `send(sessionId, text, opts?) → RunHandle { runId,
  sessionId, queued }`, `abort(sessionId, runId?)`, `subscribe(sessionId,
  listener) → unsubscribe`, `getState(sessionId) → SessionState { sessionId,
  state: "idle"|"streaming"|"error", activeRunId?, transcript:[{role,text}] }`,
  `listSessions()`, `stop()`.
- **Événements** (union discriminée) : `run_started`, `delta { channel:
  "content"|"thinking", text }`, `run_finished { reason: "done"|"abort"|"error",
  usage?, errorMessage? }`, `phase { stage, at, sinceT0Ms }`, `run_summary {
  ttftMs?, totalMs, tokensIn?, tokensOut? }`, `state`. Le champ `channel` est
  **structurant** : la réflexion transite mais **n'apparaît jamais comme
  réponse**.
- **Cycle de vie** : `start()` construit le loader, crée le runtime, puis la
  session initiale (`continueRecent` si des sessions existent, sinon nouvelle),
  et **pose l'abonnement immédiatement, avant tout prompt**. `send` est refusé
  tant que l'abonnement n'est pas posé (garde-fou anti-perte d'événements).
- **Remplacement de session** : après tout remplacement, désabonner l'ancienne,
  **ré-abonner la nouvelle** (le SDK l'exige), mettre à jour la table des
  sessions. Le mécanisme est posé et testé même si l'UI ne l'expose pas encore
  (il conditionne le Lot 3).
- **Erreurs** : traduire toute exception du SDK en `PiHostError { code,
  message, cause?, runId?, sessionId? }` avec des codes propres (`PI_NOT_READY`,
  `PI_PROMPT_REJECTED`, `PI_ABORTED`, `PI_TIMEOUT`, `PI_SESSION_ERROR`,
  `PI_RESOURCE_ERROR`, `PI_UNKNOWN`). **Aucun message d'erreur brut du SDK ne
  franchit la façade.** Un `abort` qui rejette doit être normalisé en
  `run_finished(reason:"abort")`, sans exception propagée.

## Intégration du SDK dans le conteneur — les 4 points durs

⚠️ Les noms exacts ont été vérifiés dans la doc locale du SDK
(`docs/environment-variables.md`, `docs/sdk.md`, `docs/settings.md`,
`docs/sessions.md`, `docs/containerization.md`) avant codage.

1. **Redirection de l'état du SDK vers le volume persistant.** Le SDK écrit
   `settings.json`, `auth.json`, `models.json`, `sessions/` dans un répertoire
   utilisateur — or notre **rootfs est read-only**. Tout est redirigé vers le
   volume `yuki-pi` (volume nommé monté sur `/data/pi`) via `PI_CODING_AGENT_DIR` et
   `PI_CODING_AGENT_SESSION_DIR`, et les opérations réseau du SDK sont coupées
   (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`). *Constat de
   vérification :* `PI_CODING_AGENT_SESSION_DIR` est documenté mais n'est lu que
   par le CLI (`main.js`) ; le SDK `SessionManager` ne le lit pas → le répertoire
   de sessions est **aussi** passé explicitement (`SessionManager.create(cwd,
   sessionDir)`).
2. **HOME inscriptible.** `HOME=/data/pi/home` (répertoire dédié sur le volume,
   créé au démarrage, uid non-root). Le rootfs reste read-only ; `/tmp` reste le
   tmpfs existant.
3. **cwd fixe.** `cwd = /workspace` (volume `workspace`). Le SDK nomme le dossier
   de sessions d'après le cwd → `--workspace--`, sessions **stables à travers les
   redémarrages** (règle confirmée dans `session-manager.js`).
4. **Neutraliser les hypothèses « coding ».** Prompt système **généraliste** via
   `systemPromptOverride` ; **découverte d'`AGENTS.md` vidée**
   (`agentsFilesOverride` renvoyant une liste vide) ; **aucun outil** (`noTools:
   "all"`) ; **`defaultProjectTrust` forcé** dans `settings.json` global. Le
   `settings.json` du volume est **seedé depuis `config/pi/settings.json` au
   premier démarrage, puis jamais réécrit**.

## Contrat de transport WebSocket

- **`seq` = entier monotone PAR SESSION**, démarrant à 1. **Chaque** trame
  serveur→client porte `{ seq, ts, sessionId }`.
- **Rejeu** : strictement `seq > fromSeq`. Le client n'applique un événement que
  si `seq === dernierAppliqué + 1` ; s'il détecte un trou, il redemande un
  `resume` → **ni trou ni doublon**.
- **Buffer borné** : annulaire, par session (pas par connexion), capacité via
  `YUKI_WS_REPLAY_BUFFER` (défaut 1000), dimensionné aussi en octets
  (`YUKI_WS_REPLAY_BYTES`, défaut 5 000 000). Si la fenêtre est dépassée →
  **`snapshot`** (état courant + transcript **contenu seul** + `seq` courant) et
  le client réinitialise son rendu.
- Le buffer vit **au-dessus** de l'abonnement au PiHost, installé au démarrage →
  les événements émis **sans client connecté** sont déjà bufferisés.

**Client → serveur** : `hello { clientVersion?, sessionId? }` · `resume {
sessionId, fromSeq }` · `message { clientMsgId, text }` · `abort { runId? }` ·
`ping { t }`.

**Serveur → client** : `welcome { serverVersion, resumed, replayFrom? }` ·
`accepted { clientMsgId, runId, queued }` · `state { state, activeRunId? }` ·
`run_started { runId, userText? }` · `delta { runId, channel, text }` ·
`run_finished { runId, reason, usage?, errorMessage? }` · `phase { runId, stage,
at, sinceT0Ms }` · `run_summary { runId, ttftMs?, totalMs, tokensIn?,
tokensOut? }` · `snapshot { state, activeRunId?, transcript }` · `error { code,
message, runId? }` · `pong { t }` · `bye { reason }`.

- **Aucune authentification au Lot 1** (réseau de confiance / localhost) : le
  champ `auth` est simplement **réservé**, non implémenté.
- **Trames binaires** : réservées pour l'audio des lots 6/7. Au Lot 1, toute
  trame binaire reçue est **ignorée proprement** (log warn, pas de crash).
- **Abstraction `Transport`** : la surface permet d'ajouter plus tard un
  `SseTransport` réutilisant `session-stream.ts` **sans refonte**.

## UI minimale

Vanilla HTML/CSS/JS servie par le gateway (`GET /` → `public/ui/index.html`,
`GET /ui/*` → assets, via `routes/static.ts` avec refus de traversal et en-têtes
sûrs). **Aucune chaîne de build front, aucun framework, aucune dépendance npm
front.**

Contenu : zone de conversation (rendu incrémental sur les `delta`
`channel:"content"`), champ de saisie (Entrée = envoyer, Shift+Entrée = retour
ligne), **bouton Stop** (désactivé en `idle`), indicateur d'état
(`idle`/`streaming`/`erreur`) + indicateur de connexion, libellé « en file » si
`accepted.queued`, reconnexion automatique avec backoff borné et **renvoi du
dernier `seq` appliqué**. Les deltas `thinking` ne sont **pas** affichés comme
réponse (au plus un indicateur discret, sans contenu). Laissés de côté : thème,
markdown riche, historique de sessions, pièces jointes.

## Abort et concurrence

- **Un seul run actif par session** ; `AbortController` par run. L'abort est
  **sérialisé derrière l'envoi en vol**.
- Un `message` reçu pendant un run est **mis en file FIFO** avec `accepted {
  queued: true }`, et devient le run suivant.
- Le **Stop aborte le run en vol ET vide la file** (arrêt net).
- États transmis : `idle`, `streaming`, `error` (l'état interne « aborting » est
  visible via `phase`/`run_finished`). `abort` en `idle` = no-op idempotent.
- Ce mécanisme **sera réutilisé tel quel** au Lot 7 pour le barge-in vocal.

## Instrumentation

- Étage : `phase { runId, sessionId, stage, at (ISO-8601), sinceT0Ms }` —
  **`stage` est une chaîne OUVRTE**. Étages du Lot 1 : `send_received` (t0 =
  réception serveur du message), `prompt_accepted`, `run_started`, `first_token`
  (**c'est le TTFT**), `turn_end`, `run_finished`, `abort`, `error`.
- Synthèse : `run_summary { runId, sessionId, ttftMs?, totalMs, tokensIn?,
  tokensOut? }`.
- **Journalisation** : une ligne JSON-lines par étage (`pi.phase`) et une ligne
  `pi.run_summary`, corrélées par `session_id` puis `run_id`.
- **Extensibilité** : les étages audio (`asr_start`, `tts_first_byte`, …) s'insèrent
  sans refonte — même forme, même corrélation.
- **`GET /health`** : conserve les champs actuels et ajoute `subsystems: { pi: {
  status: "ready"|"starting"|"error", cwd, agentDir, sessionsDir, model?,
  sessionsCount, activeRuns }, transport: { ws: { clients, replayBufferSize },
  sse: false } }`. `/health/ready` renvoie 200 si la porte GPU **et** le PiHost
  sont prêts, sinon 503.

## Critères d'acceptation

1. Un message texte obtient une réponse **streamée token par token** (plusieurs
   trames `delta` `channel:"content"`).
2. Le **Stop** coupe net : `run_finished(reason:"abort")`, **aucun `delta`
   après**, retour en `idle`.
3. **Déconnexion/reconnexion** : rejeu des événements manqués **sans trou ni
   doublon** (`seq` contigus), ou `snapshot` si la fenêtre est dépassée.
4. Le journal affiche le **TTFT** et la **durée totale** de chaque tour.
5. **Test de frontière** : aucun fichier hors `src/pi/sdk-host.ts` n'importe le
   SDK.
6. Les deltas `thinking` **ne figurent jamais** dans le transcript ni comme
   réponse (transcript = contenu seul).
7. Les **54 tests existants du Lot 0 restent verts** ; les nouveaux tests
   passent.
8. `npm run typecheck`, `npm test`, `npm run build` passent ; `docker-compose.yml`
   reste **valide** (pas de clé `version:`, réservation GPU intacte, conteneur
   non-root, rootfs read-only).

## Périmètre exclu

Multi-LLM / 2 providers neutres par rôle (`llm-light` / `llm-heavy`) / 2 clés /
allowlist par modèle / outil `delegate` / JobStore (Lot 2) · UI d'historique et
sélecteur de sessions
(Lot 3) · sidecar d'exécution et outil `shell` (Lot 4) · pont MCP et skills
(Lot 5) · ASR/PTT (Lot 6) · TTS/barge-in/trames audio (Lot 7) · retour proactif
(Lot 8) · **authentification, TLS, rate limiting** (Lot 9) · doc n8n (Lot 10) ·
markdown riche, thème, pièces jointes, base de données, chaîne de build front.

## Pour la suite (Lot 2)

Le Lot 2 branche deux modèles via un fournisseur compatible OpenAI (nommage
neutre par rôle, deux `BASE_URL` possibles) avec **deux clés distinctes** :
`gemma4:31b` (léger, **seul à parler**) et
`deepseek-v4.1-flash` (lourd, arrière-plan, thinking actif). Prévu dès le Lot 1 :
un `PiHostOptions.model` optionnel et un point d'extension de sélection de
modèle (`SendOptions.model`) ; des **événements agnostiques du provider** ; la
séparation `content`/`thinking` ; et `run_finished.usage` déjà présent (il
alimentera le JobStore).
