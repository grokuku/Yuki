# Lot 35g — Visibilité des agents (liste de bots par agent)

Décision utilisateur : les agents sont **globaux** (`state/agents.jsonl` commun) ;
chaque agent porte la **liste** des bots autorisés à l'utiliser. Supprimer un bot
le retire des listes, **l'agent reste configuré**.

## ① Le champ

| Élément | Où |
|---|---|
| `AgentRecord.bots: string[]` (obligatoire en mémoire) | `src/agents/types.ts:70` |
| `AgentPatch.bots?: string[]` | `src/agents/types.ts:112` |
| Défaut de lecture/migration `["yuki"]` (**jamais `[]`**) | `src/agents/store.ts:76` (`newRecord`), `AGENT_BOT_PAR_DEFAUT` (`types.ts:32`) |
| Validation (format `ID_BOT_PATTERN`, sans doublon, ≤ `MAX_BOTS`) | `src/agents/store.ts:141` (`normaliserBotsAgent`) |
| Règle unique de visibilité | `src/agents/types.ts:121` (`agentAutorisePourBot`) |

`[]` = agent **neutralisé** : il reste LISTÉ (trace conservée : machine au rebut,
agent compromis) mais plus aucun bot ne le résout ni ne l'exécute.
`MAX_BOTS` (6) a déménagé dans `src/bots/registry.ts:48` et reste ré-exporté par
`src/bots/admin.ts:73` (source unique, aucun cycle d'import).

## ② Le filtrage — SERVEUR, à TROIS endroits

Le bot courant vient du **RUN** (`src/index.ts:347`, `bots.bot?.id ?? "yuki"`),
jamais d'une requête : un identifiant forgé ne change rien.

1. `AgentDirectoryService.list()` / `find()` — `src/agents/directory.ts:184,202`
   (donc `lister_agents`, `etat_agent` et l'annuaire du prompt à chaque tour).
2. `AgentStore.resolve()` — `src/agents/store.ts:407` (résolution publique filtrée ;
   `resolveBrut()` reste disponible pour les garde-fous qui doivent DISTINGUER
   « inconnu » de « non autorisé »).
3. **`authorize()`** — `src/agents/execution.ts:1351`, et `authorizeTransfer`
   qui l'appelle (`:1313`). Refus `agent_not_allowed` (`ExecutionOutcome.code`),
   message explicite « … n'est pas autorisé pour ce bot … » — jamais « agent
   introuvable », qui ferait croire à une panne. Rien n'est transmis à la machine.

## ③ Suppression d'un bot

`bot.agents.detached` est journalisé avec le nombre d'agents modifiés ;
`bot.agents.detach_failed` si le nettoyage échoue — **la suppression aboutit
quand même** (`src/bots/admin.ts:611`). Le retrait vit dans
`AgentStore.retirerBotDesListes` (`src/agents/store.ts:600`) et le câblage dans
`src/index.ts:3279`.

## ④⑤ Interface

- Onglet « Agents » de `/config` : une **case par bot**, liste lue sur
  `GET /api/bots` (`listerBots`, `public/ui/bots-api.js`) — jamais codée en dur ;
  agent neutralisé signalé par un badge « Neutralisé » + une phrase
  (`public/ui/agents-panel.js`, styles `.agent-bots` dans `config.css`).
- Barre latérale : le serveur envoie déjà la liste filtrée
  (`listPourBot`, `src/index.ts:644`) ; `agentsVisiblesPourBot`
  (`public/ui/sidebar-agents.js:122`) applique la même règle en défense
  supplémentaire, avec la trame `agents.botActif`.
- `/api/agents` (administration) reste NON filtré : un agent neutralisé doit
  rester visible pour être réactivé.

## Tests

`tests/agents/visibilite-agents.test.ts`, `tests/agents/visibilite-route.test.ts`,
`tests/ui/visibilite-agents-ui.test.ts`. Preuve d'échec sur l'origine :
`/tmp/preuve-lot35g` (copie de l'arbre à `HEAD 2a917ca`) ⇒ **29 échecs / 30**
(le seul vert est la garde CSP, déjà vraie avant).

## Non couvert / invérifiable ici

- Le comportement « plusieurs bots simultanément » : le processus ne sert qu'UN
  bot actif (`bots.bot`), la visibilité est donc évaluée par processus.
- Aucune capture d'une vraie instance (stub local uniquement).
