# Lot 31 — Tâches planifiées (`planifier_tache`)

## 1. Ce que ce lot ajoute

Yuki peut désormais **faire AGIR un LLM plus tard** : `planifier_tache(quand, instruction, nom?)`
crée une **tâche ponctuelle** (`SourceRecord.declencheur.type: "ponctuel"`, un instant
absolu) qui réveille le worker lourd à l'heure dite ; son résultat est publié dans la
**conversation demandeuse**.

Deux capacités, deux outils — la distinction est écrite dans la description de l'outil :

| | `programmer_envoi` (lot 28) | `planifier_tache` (lot 31) |
|---|---|---|
| ce qui part à l'heure dite | un texte **figé** | une **instruction** exécutée par un LLM |
| modèle appelé à l'heure dite | aucun | oui (worker lourd) |
| fichiers possibles | fichiers déjà présents | fichiers **produits** par la tâche |
| pré-autorisations | celles de l'envoi | **aucune** (l'action échoue proprement) |

⚠️ **1 appel = 1 tâche** : deux heures ⇒ deux appels.

## 2. Décisions et règles tenues

- **Heure seule déjà passée ⇒ PROCHAINE occurrence (demain)** — `analyserQuand("00:00")` à
  17 h rendait aujourd'hui minuit, donc « déjà passé », donc un refus : l'exemple d'une
  demande récurrente échouait. Une **ISO datée passée reste refusée** (elle nomme un jour
  précis, la reporter changerait la demande). La confirmation porte la **date complète**.
  ⚠️ Impact assumé sur `programmer_envoi` (même parseur) : « 16:10 » demandé à 17 h part
  maintenant **demain 16:10**, et la confirmation le montre (`5 novembre 2026 à 16:10`).
- **Jours relatifs** `demain` / `après-demain` acceptés devant une heure (« demain à 8 h »,
  forme qui n'était pas comprise) ; « demain » seul réclame l'heure au lieu de deviner.
- **Quotas séparés** : `MAX_SOURCES` (20) ne compte que les déclencheurs **durables** ;
  les tâches ponctuelles ont leur borne (`MAX_TACHES_PONCTUELLES`, 20) et des erreurs
  distinctes (`TachesPonctuellesFullError`).
- **Nom** : libellé humain conservé (`libelle`, affiché), `nom` slugifié et dédupliqué
  côté serveur (`resume-du-journal`, `resume-du-journal-2`).
- **Balayeur** : la tâche est **désarmée AVANT d'être lancée** (`setActif(false, …)`) —
  un plantage ne la rejoue pas ; à l'échéance le motif devient `terminée : <heure>` ou
  `échouée : …`, par le **même canal que `DÉSACTIVER`**. Échéance manquée de plus d'une
  heure ⇒ « non exécutée » (une tâche datée ne se rejoue pas à contretemps).
- **Publication** : dans la conversation demandeuse tant qu'elle existe (`perso` : elle
  n'est **jamais** renommée « Déclencheurs »), sinon repli sur « Déclencheurs ».
- **Échecs** (décision utilisateur : B) : **toujours publiés** ; le **même** échec, même
  raison, **en série** ne publie pas une ligne de plus (compteur persisté,
  `SourceRecord.serieEchecs`), et le **retour à la normale** est publié avec le compte.
  ⚠️ Le port de publication ne sait pas **modifier** un message (`publierMessage` ajoute,
  `src/pi/sdk-host.ts:2509`) : on applique donc **« ouverture + clôture »** — la première
  ligne dit « en échec depuis 14:32 », la clôture dit « après 37 tentatives ». Aucun
  silence, aucune rafale.
- **Fichiers du résultat** : le port de publication reçoit la liste structurée, et le
  service **ajoute les marqueurs** `[fichier] <id> <nom> (<n> octets)`
  (`formatFileMarker`, `src/files/frame.ts:63`) au texte publié — sans eux, une image
  produite restait invisible et la carte ne s'affichait pas.
- **Rôle** : outil du **léger seul** (`TOOL_POLICY.light.planifierTaches`), groupe
  `toujours` ; le worker lourd ne l'a pas (une tâche de fond ne programme pas de tâche de
  fond). En **canal distant**, l'outil n'est pas construit : le résultat n'y aurait pas de
  conversation locale où revenir.

## 3. Ce qui reste invérifiable / hors de ce lot

- **Lots ② (fin de récurrence : `jusquAu`, `occurrencesMax`) et ③ (chaînes d'étapes) ne
  sont PAS implémentés** : les champs `occurrencesFaites`, `occurrencesMax` et `jusquAu`
  sont déclarés et relus (ils survivent à un redémarrage, et `update` invalide bien le
  compteur quand le déclencheur change), mais **aucune extinction automatique n'est
  branchée** et l'interface n'a pas encore les deux champs.
- **Rendu visuel de la carte de fichier** : vérifié par test (marqueur présent dans le
  texte publié) et par le format partagé avec `public/ui/file-block.js`, pas par capture
  d'écran dans ce lot.
- **Modification d'un message publié** : impossible avec le port actuel ; la variante
  « ouverture + clôture » est celle qui est implémentée (voir § 2).

## 4. Lot ② — FIN DE RÉCURRENCE (livré)

Les deux bornes étaient déclarées, validées et relues ; elles sont désormais **branchées**.

- **`occurrencesMax`** (1–10 000, `src/sources/types.ts:74`) : le compteur
  `occurrencesFaites` est **persisté** et n'est incrémenté qu'à l'endroit où le passage est
  **réellement lancé** (`src/sources/scheduler.ts:630`, après un `started`) — ⚠️ un **saut**
  (rattrapage refusé, chevauchement, garde-fou) **ne compte pas**, sinon « 14/14 passages »
  s'afficherait alors que Yuki n'a rien exécuté. L'échéance est constatée **au réarmement**
  (`finDeRecurrence`, `scheduler.ts:452` appelé `:373`, **avant** le réarmement) : plus aucun
  passage ne part, et l'extinction passe par `setActif(false, raison)` + journal `desactive`
  (le **même canal** que `DÉSACTIVER`) avec la raison `terminée : 14/14 passages`
  (`raisonFinOccurrences`, `:167`).
- **`jusquAu`** (ISO) : passé cet instant, plus aucun passage ; raison
  `terminée : fin prévue le 19 novembre 2026` (`raisonFinDate`, `:172`), dans le **fuseau du
  déclencheur**.
- **`update` invalide le compteur** quand le déclencheur change (`src/sources/store.ts:1269`,
  vérifié par test) : « 12/14 » décrivait l'ancien programme.
- **API** : `settingsFrom` transmet enfin `occurrencesMax` / `jusquAu`
  (`src/gateway/routes/sources.ts`), et une **chaîne vide** (ou `null`) les **retire**
  (`store.ts`, branche `=== null`) — sans quoi on ne pourrait jamais revenir à « sans fin ».
- **UI** : deux champs au formulaire (`source-jusqu-au`, `source-occurrences-max`,
  `public/ui/sources-panel.js:521`/`:543`) et l'affichage `reste 6/14` /
  `terminée (14/14 passages)` / `fin prévue le …` (`texteOccurrences`,
  `public/ui/declencheurs-vue.js:344`, porté par la colonne « Quand »).
- ⚠️ **Tests de verrou mis à jour en connaissance de cause** :
  `tests/ui/sources-notifications.test.ts` (les deux nouveaux champs) ; les 10 onglets de
  `/config` et les autres compteurs de `tests/integration/static-ui.test.ts` sont **inchangés**.

## 5. Lot ③ — CHAÎNES D'ÉTAPES (livré)

- **Modèle** : `SourceRecord` réutilisé. `chaine { id, etape, apres? }`
  (`src/sources/types.ts`) — `apres` porte le **NOM** de l'étape précédente (c'est ce nom
  qui désigne le `resultatEtape` à relire et qui porte les pré-autorisations), et
  `resultatEtape { jobId, texte, fichiers[], at }`, **borné à l'écriture** (texte ≤ 2 000 c.,
  fichiers ≤ 8 : `MAX_TEXTE_ETAPE_CHARS`, `MAX_FICHIERS_ETAPE`, re-borné à la relecture).
- **Création ATOMIQUE** : `POST /api/sources/chaines` avec `etapes[]`
  (`src/gateway/routes/sources.ts`) → `SourcesService.creerChaine` (`service.ts:1052`) →
  `SourcesStore.createChaine` (`store.ts:882`), qui valide **tout** (2 à 5 étapes, une
  `planning` chacune) puis vérifie le **quota** avant la moindre écriture, et publie les
  étapes en **une seule** écriture. ⚠️ 3 étapes demandées et 1 place libre ⇒ **AUCUNE** étape
  créée, `429 chaines_full` avec `placesRestantes`/`demandees` (message : « Rien n'a été
  créé »).
- **LE RELAIS** : (1) `recevoirResultat` ne se contente plus d'afficher les marqueurs de
  fichiers : les identifiants sont **transportés** ; (2) `resultatEtape` est **persisté après
  publication** (`noterResultatEtape`, `service.ts:1613` → `store.ts:976`) — y compris un
  résultat **vide** quand l'étape répond `RIEN`, pour que la suivante ne bloque pas ;
  (3) `declencher` **ajoute au contexte** le texte de l'étape précédente **et ses
  identifiants de fichiers** (`relaisDeChaine`, `service.ts:339`) : le worker lourd les ouvre
  avec `lire_fichier`.
- **ÉCHEC = A** (décidé) : l'étape en échec est éteinte `échouée : …`, les suivantes
  `annulée : l'étape « X » a échoué`, et **UN SEUL** message est publié —
  « ⚠️ Étape 1 échouée (raison). Étapes 2 et 3 annulées, rien n'a été envoyé. »
  (`arreterChaine`, `service.ts:1435`) ; jamais une notification par étape.
- **Chaîne interrompue** (étape supprimée ou éteinte à la main) : `verdictChaine`
  (`service.ts:1387`) répond `rompue` ⇒ cascade de l'étape courante et des suivantes avec la
  raison lisible (« l'étape précédente « X » n'existe plus / a été éteinte »), une seule
  ligne publiée. Une précédente qui n'a pas encore de résultat ⇒ `attente` : l'étape ne part
  pas, **rien n'est cassé**, le tick suivant réessaie.
- **Pré-autorisations par NOM d'étape** : chaque étape est un déclencheur ordinaire ; le job
  porte l'origine `declencheur:<nom de l'étape>` (`service.ts`), donc le registre applique
  l'autorisation de **cette** étape et d'aucune autre (test dédié).
- **UI** : `grouperParChaine` (`declencheurs-vue.js:263`, pure, à côté de
  `grouperParSection`), une **carte par chaîne** (`renderChaines`,
  `sources-panel.js:1122`), étapes dans l'ordre, **nom** de chaque étape affiché (il porte les
  pré-autorisations), état de chacune via `etatEtape` (`:303`) : « faite le … », « en
  attente », « annulée : … ». Les trois sections historiques ne listent plus que les
  déclencheurs **isolés** (aucune fiche perdue : `chaines` + `isolees`).
- **Purge** : `purgerChainesTerminees` (`store.ts:1008`) ne retire qu'une chaîne dont
  **toutes** les étapes sont éteintes ; ⚠️ **jamais une étape en attente** (une seule étape
  armée ⇒ on ne touche à rien), et **jamais** un déclencheur hors chaîne. Aucun minuteur ne
  l'appelle automatiquement : une source éteinte reste listée indéfiniment (règle
  d'affichage du lot 26/3).
- **Limites assumées du lot** : (a) une étape récurrente réutilise le `resultatEtape` de la
  **dernière** exécution de la précédente — il n'y a pas d'appariement « même tour » entre
  étapes (le `at` est affiché, c'est la seule garantie) ; (b) l'interface ne **crée** pas
  encore de chaîne (aucun formulaire `etapes[]`) — la route existe et l'affichage est complet
  ; (c) `DÉSACTIVER` dans une étape **arrête la chaîne** : l'étape s'éteint, et l'étape
  suivante constate que sa précédente est éteinte ⇒ cascade « annulée : l'étape précédente
  « X » a été éteinte (…) ». C'est la conséquence directe de la règle « jamais orpheline »,
  et la carte de la chaîne le montre étape par étape.
