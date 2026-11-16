# Lot 49 — modèle de vision de repli

Demande utilisateur du 2026-11-16 :

> « est-ce que c'est possible d'ajouter dans les paramètres généraux la config
> d'un modèle de vision de repli quand le modèle utilisé (léger ou lourd) ne
> possède pas la vision (et qu'il a besoin de la vision) »

## Le manque

La capacité vision est une **déclaration** (`/config` `llm.<rôle>.vision`), produite
en `input` dans `models.json` et lue au runtime par `sdkModelSupportsImages`
(`src/pi/sdk/model-runtime.ts`). Un modèle déclaré texte seul ne reçoit **aucune**
image : le SDK remplace la partie image par « (tool image omitted…) ». Jusqu'ici la
seule issue était de **refuser** l'image en le disant.

## Ce qui est livré

| Élément | Où |
|---|---|
| Clé `vision.fallback.model` (portée `instance`, défaut **vide**, `apply: hot`) | `src/config/schema.ts` |
| Décision pure « garder / décrire / refuser » | `planVision`, `src/files/vision-fallback.ts` |
| Textes injectés (description, échec, absence de repli) | `src/files/vision-fallback.ts` |
| Appel du modèle de repli (session éphémère, aucun outil) | `createSdkVisionDescriber`, `src/pi/sdk/vision-fallback.ts` |
| Réglage (liste déroulante des modèles réels) | `/config` → onglet **Modèles** → groupe **Vision de repli** |
| Liste servie | `GET /api/config` → `modelesDisponibles` |

Compte des clés : **93 → 94** (instance **69 → 70**, bot 19, mixte 5).

## Comportement

- **modèle AVEC vision** ⇒ le repli n'est **jamais** appelé (aucune requête, aucun coût) ;
- **modèle SANS vision + image + repli configuré** ⇒ l'image est **décrite** par le
  modèle de repli, et cette description (clairement identifiée, avec le nom du
  modèle) remplace l'image dans le message — donc **visible dans la conversation** :
  l'utilisateur lit exactement ce que le modèle a reçu ;
- **aucun repli configuré** ⇒ comportement d'origine, message honnête (rien n'est
  inventé) ;
- **repli en échec** (modèle introuvable, lui aussi sans vision, délai, exception,
  réponse vide) ⇒ message explicite « impossible d'analyser l'image : … » et **le
  tour continue sans l'image** — jamais un tour perdu.

Le prompt de description est **factuel** : ce qui est visible, le texte recopié,
les chiffres, les couleurs et les états ; l'interprétation est explicitement
interdite, et une description « peut manquer de détails » est annoncée au modèle
comme à l'utilisateur.

## Bornes

| Borne | Valeur | Où |
|---|---|---|
| Délai d'une description | 60 s (`VISION_DESCRIPTION_TIMEOUT_MS`) | `src/files/vision-fallback.ts` |
| Images par appel | 4 (`VISION_DESCRIPTION_MAX_IMAGES`) | idem |
| Poids / dimensions d'une image | politique de vision partagée (`files.imageMaxBytes`, `files.imageMaxWireBytes`, côté max 2 000 px) | `src/files/vision.ts` |
| Une description par image | cache LRU borné (32) sur l'empreinte de l'image | `src/pi/sdk/vision-fallback.ts` |

## Chemins couverts

| Chemin | Point d'entrée |
|---|---|
| Conversation locale (léger) | `src/gateway/ws/server.ts` (garde `file_image_vision_disabled`) |
| Message dans un canal (léger) | `readChatImages`, `src/index.ts` |
| Worker lourd — `lire_fichier` | `src/pi/sdk/read-file-tool.ts` |
| Worker lourd — `recuperer_fichier` | `src/pi/sdk/execution-tools.ts` |
| Run distant — `lire_fichier` | `src/pi/sdk/remote-run-tools.ts` |

⚠️ Une tâche planifiée / un déclencheur passe par `buildHeavyActionTools` : elle est
donc couverte par les deux derniers outils, sans chemin parallèle.

⚠️ **Garde modifiée** : `file_image_vision_disabled` (`src/gateway/ws/server.ts`)
n'est plus inconditionnelle — elle ne refuse un message porteur d'image que si
**aucun** modèle de repli n'est configuré. Aucune autre garde n'est touchée.

## Journaux

- `vision.repli.utilise` : modèle, raison, nombre d'images, octets base64 ;
- `vision.repli.echec` : modèle, raison (`runtime_indisponible`, `modele_introuvable`,
  `modele_sans_vision`, `appel_echoue`, `reponse_vide`).

## Non couvert (assumé)

`capture_libraire`, `generer_image` et `consulter_workflow` gardent leur message
actuel quand le modèle ne voit pas les images : ce sont des images **produites** par
le tour (une capture qu'on peut rouvrir, une génération qu'on peut redemander), pas
des pièces jointes que l'utilisateur croit transmises.
