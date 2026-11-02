/**
 * FILE D'ENVOI PAR CONVERSATION — **une seule publication EN VOL à la fois**.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME (production, 2026-11-02) : dans un canal,
 * `REPLY_MAX_CONCURRENT` (2, `src/chat/reply/limiter.ts`) autorise DEUX rédactions
 * simultanées — ce qui est voulu — mais leurs publications partaient alors en
 * parallèle : deux `POST` en vol, donc un ordre non garanti et, côté lecture, « deux
 * messages qui arrivent collés ». Le tour de Yuki peut, lui, publier un accusé, une
 * image et sa réponse : ces trois-là sortent déjà d'une file (`ReplyProgress`), mais
 * rien ne les protégeait d'un AUTRE tour du même canal.
 *
 * ⚠️ CE QUI EST SÉRIALISÉ : les ENVOIS, par conversation. Pas les runs : la
 * concurrence des rédactions reste entière (`tests/chat/reply-concurrency.test.ts`).
 * Deux conversations DIFFÉRENTES restent parallèles.
 *
 * ⚠️ Aucune imbrication possible (donc aucun interblocage) : un envoi ne déclenche
 * jamais un autre envoi de la MÊME conversation depuis l'intérieur de sa tâche. Une
 * publication inter-canal passe par la file de la conversation CIBLE.
 */

/** File FIFO d'envois, une par conversation. */
export class ConversationSendQueue {
  /** Chaîne en cours par conversation (jamais rejetée : les erreurs sont rendues). */
  private readonly files = new Map<string, Promise<unknown>>();

  /**
   * Exécute `tache` APRÈS l'envoi précédent de la même conversation.
   *
   * ⚠️ La tâche rend sa valeur (ou son erreur) à SON appelant : la file ne change
   * pas la sémantique d'erreur des adaptateurs (un échec d'envoi reste un échec
   * visible), elle n'ordonne que le moment où la tâche commence.
   */
  async run<T>(conversationId: string, tache: () => Promise<T>): Promise<T> {
    const precedente = this.files.get(conversationId) ?? Promise.resolve();
    // ⚠️ On attend la précédente QU'ELLE RÉUSSISSE OU NON : un envoi en échec ne doit
    // pas bloquer la conversation pour toujours.
    const resultat = precedente.then(tache, tache);
    // La chaîne retenue est neutralisée (ni valeur, ni rejet) : elle ne sert qu'à
    // ordonner. Le résultat, lui, part vers l'appelant.
    this.files.set(
      conversationId,
      resultat.then(
        () => undefined,
        () => undefined,
      ),
    );
    return resultat;
  }
}
