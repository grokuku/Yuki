/**
 * REFUS des outils LONGS appelés INLINE dans un run de CANAL (confidentiel —
 * `src/pi/sdk/**` uniquement).
 *
 * ⚠️ LE TROU QUE CE MODULE FERME (2026-11-02) : un run de canal est borné par
 * `CHAT_REPLY_TIMEOUT_MS` (90 s, `src/chat/reply/prompt.ts:72`) alors que
 * `generer_image` peut prendre jusqu'à `images.timeoutMs` (1 h,
 * `src/config/schema.ts:970-977`). L'appel était donc coupé EN PLEIN VOL : pas
 * d'image, pas de message, et une personne dans le canal qui attend. Le modèle
 * ne pouvait pas le savoir — le prompt ne dit rien de la borne du tour.
 *
 * ⚠️ POURQUOI DANS L'OUTIL, ET PAS DANS LE PROMPT : c'est le seul endroit où le
 * modèle ne peut pas « oublier » la règle. Le prompt conseille ; l'outil, lui,
 * refuse. Le refus est ACTIONNABLE (`longToolInlineRefusal`,
 * `src/llm/tool-policy.ts`) : il nomme la borne, dit pourquoi, indique
 * `delegate` et le chemin d'activation de la délégation.
 *
 * ⚠️ MAIS SEULEMENT SI LA DÉLÉGATION EXISTE : sans `delegate`
 * (`chat.remoteAgents = desactive`, le DÉFAUT), refuser reviendrait à supprimer
 * la capacité — c'est exactement la régression signalée en production le
 * 2026-11-02 (« avant, une génération courte passait ; maintenant jamais »).
 * Dans ce cas, aucun outil n'est enrobé et la borne du tour est relevée par
 * l'appelant (`channelTurnTimeoutMs`).
 *
 * ⚠️ LA LISTE N'EST PAS ICI : elle vit dans `LONG_RUNNING_TOOLS`
 * (`src/llm/tool-policy.ts`), avec la valeur MESURÉE de chaque borne. Ce module
 * ne fait que l'APPLIQUER — ajouter un outil long se fait donc en un seul
 * endroit, et un test de garde vérifie que la liste et les outils réels
 * concordent.
 *
 * ⚠️ LOCAL INCHANGÉ : ce garde-fou n'est appliqué QUE par `buildRemoteRunTools`
 * (run de canal). Le host local construit ses outils autrement : il n'a pas de
 * borne de tour, il bloque — c'est admis, et ce module ne le change pas.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { longRunningTool, longToolInlineRefusal } from "../../llm/tool-policy.js";

/**
 * Enveloppe les outils d'un run de CANAL : un outil déclaré long
 * (`LONG_RUNNING_TOOLS`) ne s'exécute PAS, il rend un refus explicite.
 *
 * `delegationAvailable` = `false` quand la politique du canal ne donne pas
 * `delegate` (défaut `chat.remoteAgents = desactive`) : **AUCUN outil n'est alors
 * enrobé** — les outils sortent INCHANGÉS et l'appel long s'exécute inline.
 * ⚠️ Refuser sans alternative reviendrait à SUPPRIMER la capacité (régression
 * mesurée en production le 2026-11-02) ; c'est la borne du tour qui est relevée
 * à la place (`channelTurnTimeoutMs`, `src/llm/tool-policy.ts`).
 *
 * ⚠️ Le refus est rendu comme un RÉSULTAT (jamais une exception) : le modèle le
 * lit, peut enchaîner sur `delegate` dans le MÊME tour, et la transcription n'a
 * pas un run cassé. Les outils NON longs sont rendus tels quels (même objet,
 * donc même `execute`, même schéma : aucun enrobage superflu).
 */
export function guardLongToolsInChannel(
  tools: readonly ToolDefinition[],
  options: { delegationAvailable?: boolean } = {},
): ToolDefinition[] {
  const delegationAvailable = options.delegationAvailable ?? true;
  // ⚠️ PAS DE DÉLÉGATION ⇒ PAS DE REFUS : on ne retire une capacité que si une
  // autre voie existe. Les définitions sont rendues TELLES QUELLES (mêmes objets).
  if (!delegationAvailable) return [...tools];
  return tools.map((tool) => {
    const info = longRunningTool(tool.name);
    if (!info) return tool;
    const refuse: ToolDefinition["execute"] = async () => ({
      // ⚠️ Texte BRUT, pas du JSON : ce message est destiné au MODÈLE, qui doit
      // le LIRE tel quel (un objet sérialisé l'inviterait à le parser).
      content: [
        {
          type: "text" as const,
          text: longToolInlineRefusal(tool.name, { delegationAvailable }) ?? "",
        },
      ],
      details: {
        status: "refused",
        tool: tool.name,
        budget_seconds: info.seconds,
        source: info.source,
        delegate_tool: "delegate",
      },
    });
    return { ...tool, execute: refuse } as ToolDefinition;
  });
}
