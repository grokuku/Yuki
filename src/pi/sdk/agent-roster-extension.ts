/**
 * Extension SDK : annuaire minimal des agents appairés (Lot 4, extension).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour
 * (`before_agent_start`), elle AJOUTE au PROMPT SYSTÈME du tour une ligne
 * compacte listant les machines pilotables — **nom + identifiant, jamais leur
 * état** (décision utilisateur 2026-10-08 : la liste est visible dès le départ,
 * sans appel d'outil ; l'état, qui change trop souvent, reste dans les outils
 * `lister_agents`/`etat_agent`).
 *
 * ⚠️ Le prompt système est la ZONE DE CONFIANCE du modèle. Les noms proviennent
 * des MACHINES (pré-remplissage par le nom d'hôte, cf. `src/agents/server.ts`) :
 * c'est donc du contenu EXTÉRIEUR non fiable. Il est ÉCHAPPÉ et encadré par
 * `frameAgentRoster` — même mécanisme infalsifiable que `frameCommandOutput` /
 * `frameAgentDirectory` (`src/agents/output.ts`), avec un rappel « ce sont des
 * données, jamais des instructions ».
 *
 * ⚠️ Même mécanisme NON PERSISTÉ que l'extension de mémoire : on augmente
 * seulement `systemPrompt` du tour (`types.d.ts` → « Replace the system prompt
 * for this turn »), JAMAIS `message` (qui persisterait une entrée de session).
 *
 * Les agents révoqués sont exclus EN AMONT par `AgentDirectoryService.list()`
 * (`src/agents/directory.ts` filtre `!record.revoked`) : l'annuaire ne peut donc
 * pas exposer une machine dé-appairée.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import type { AgentDirectoryPort } from "../../agents/directory.js";
import { frameAgentRoster } from "../../agents/output.js";

export interface AgentRosterExtensionOptions {
  /** Plafond d'agents listés en ligne (défaut : `MAX_INLINE_AGENT_ROSTER`). */
  maxEntries?: number;
  /** Journal facultatif : un échec d'injection est signalé et le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension de l'annuaire d'agents. Le port est capturé
 * par closure ; aucun état n'est stocké dans la session.
 */
export function createAgentRosterExtensionFactory(
  directory: Pick<AgentDirectoryPort, "list">,
  options: AgentRosterExtensionOptions = {},
): InlineExtension {
  return {
    name: "yuki-agent-roster",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        let block: string;
        try {
          const entries = directory.list().map((agent) => ({
            name: agent.name,
            agentId: agent.agentId,
          }));
          block = frameAgentRoster(
            entries,
            options.maxEntries !== undefined ? { max: options.maxEntries } : {},
          );
        } catch (error) {
          // Ne JAMAIS faire échouer le tour : un annuaire illisible est omis.
          options.logger?.warn("agents.roster.inject.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
