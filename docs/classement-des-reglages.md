# Classement des réglages — global (instance) ou par bot

**Comment répondre :** remplis la colonne **Décision** avec `global` ou `bot`.
Si tu ne changes rien, laisse la valeur de la colonne **Avis** (elle sera appliquée).
Les lignes marquées **⚠️ à trancher** sont les seules où ta réponse est vraiment nécessaire.

*Note : `personality` et `rules` ne sont pas des clés — ce sont deux fichiers (`personality.md`, `rules.md`), un par bot.*

## 1 · Modèles & IA (21 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Dialecte d'API — discussion | `llm.light.api` | global | global — fournisseur unique | |
| Adresse du service — discussion | `llm.light.baseUrl` | global | global — un seul service | |
| Modèle de discussion | `llm.light.model` | global | global — un modèle pour tous | |
| Niveau de réflexion — discussion | `llm.light.thinking` | global | global — coût, pas personnalité | |
| Reçoit les images — discussion | `llm.light.vision` | global | global — capacité du modèle | |
| Clé d'API — discussion | `llm.light.apiKey` | global | global — secret d'installation | |
| Dialecte d'API — travail | `llm.heavy.api` | global | global — un seul worker | |
| Adresse du service — travail | `llm.heavy.baseUrl` | global | global — un seul service | |
| Modèle de travail | `llm.heavy.model` | global | global — jobs de fond communs | |
| Niveau de réflexion — travail | `llm.heavy.thinking` | global | global — coût, pas personnalité | |
| Reçoit les images — travail | `llm.heavy.vision` | global | global — capacité du modèle | |
| Clé d'API — travail | `llm.heavy.apiKey` | global | global — secret d'installation | |
| Politique si clé manquante | `llm.missingKeyMode` | global | global — comportement d'installation | |
| Attente avant délégation (ms) | `delegation.defaultDeadlineMs` | global | global — latence du tour commun | |
| Travaux lourds simultanés | `delegation.maxConcurrent` | global | global — GPU et file partagés | |
| Taille de la file d'attente | `delegation.maxQueue` | global | global — file partagée | |
| Délai d'inactivité d'un travail | `delegation.idleTimeoutMs` | global | global — politique commune | |
| Durée maximale d'un travail délégué | `delegation.totalTimeoutMs` | global | global — plafond de sécurité | |
| Mode de compatibilité GPU | `gpu.compatMode` | global | global — un seul GPU | |
| Profil GPU forcé | `gpu.profile` | global | global — matériel commun | |
| Version minimale du pilote NVIDIA | `gpu.minDriver` | global | global — matériel commun | |

## 2 · Conversation & voix (16 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Prompt système — discussion | `prompts.light` | MIXTE | bot — le global sert de défaut | |
| Prompt système — travail | `prompts.heavy` | MIXTE | bot — le global sert de défaut | |
| Activer la voix | `tts.enabled` | MIXTE | global — interrupteur maître, le bot se retire | |
| Moteur de synthèse vocale | `tts.engine` | global | global — un seul moteur | |
| Adresse du moteur de voix | `tts.baseUrl` | global | global — une seule adresse | |
| Langue de la voix | `tts.language` | global | global — capacité du moteur | |
| Voix du bot | `tts.voice` | bot | bot — trait du bot | |
| Émotion de la voix | `tts.emotion` | bot | bot — trait du bot | |
| Débit de parole (%) | `tts.speed` | bot | bot — trait du bot | |
| Exagération de l'émotion | `tts.exaggeration` | bot | bot — trait du bot | |
| Fidélité au style (CFG) | `tts.cfg` | bot | bot — trait du bot | |
| Profondeur de prélecture audio | `tts.prefetchDepth` | global | ⚠️ à trancher — pipeline commun, latence liée à la voix | |
| Longueur minimale d'une phrase dite | `tts.minSentenceChars` | global | ⚠️ à trancher — découpe commune, voix propre | |
| Longueur maximale d'une phrase dite | `tts.maxSentenceChars` | global | ⚠️ à trancher — idem | |
| Délai maximal d'une synthèse (ms) | `tts.timeoutMs` | global | global — latence du moteur partagé | |
| Volume de lecture (navigateur) | `tts.volume` | global | ⚠️ à trancher — c'est ton casque, pas le bot | |

## 3 · Mémoire (13 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Activer la mémoire durable | `memory.enabled` | bot | bot — mémoire propre au bot | |
| Souvenirs rappelés (top-k) | `memory.recall.topK` | bot | bot — pertinence du bot | |
| Budget de rappel (caractères) | `memory.recall.budgetChars` | bot | bot — coût du tour du bot | |
| Délai maximal du rappel (ms) | `memory.recall.timeoutMs` | bot | bot — attente avant réponse | |
| Souvenirs extraits par tour | `memory.extract.maxItems` | bot | bot — densité de sa mémoire | |
| Délai maximal d'extraction (ms) | `memory.extract.timeoutMs` | bot | bot — job du bot | |
| Mise de côté — taille relue | `memory.setAside.maxChars` | bot | bot — conversations du bot | |
| Mise de côté — nombre d'appels | `memory.setAside.maxChunks` | bot | bot — coût du bot | |
| Consolidation hebdomadaire | `memory.consolidation.enabled` | MIXTE | global — cadence d'installation, le bot se retire | |
| Quand consolider (cron) | `memory.consolidation.cron` | global | ⚠️ à trancher — une seule planification pour tous | |
| Fuseau de la planification | `memory.consolidation.timeZone` | global | ⚠️ à trancher — heure d'exploitation, pas trait de bot | |
| Budget de jetons par passe | `memory.consolidation.budgetTokens` | global | global — coût GPU commun | |
| Nombre d'archives conservées | `memory.consolidation.retention` | global | global — archives d'installation | |

## 4 · Canaux & notifications (7 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Mode de conversation | `chat.mode` | bot | bot — chaque bot a son canal | |
| Agents distants autorisés | `chat.remoteAgents` | bot | bot — sécurité décidée par bot | |
| Outils autorisés depuis un canal | `chat.remoteTools` | bot | bot — sécurité décidée par bot | |
| Serveur Discord suivi | `chat.discord.guildId` | bot | bot — serveur du bot | |
| Taille maximale d'un envoi Discord | `chat.discord.maxUploadBytes` | bot | bot — limites du serveur du bot | |
| Activer les notifications | `push.enabled` | MIXTE | global — appareils de l'installation, le bot se retire | |
| Contact VAPID | `push.contact` | global | global — un seul contact | |

## 5 · Fichiers & images (16 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Taille maximale d'un fichier | `files.maxFileBytes` | global | global — disque partagé | |
| Taille maximale d'une image | `files.imageMaxBytes` | global | global — modèle commun | |
| Taille maximale d'une image au modèle | `files.imageMaxWireBytes` | global | global — limite du fournisseur | |
| Budget d'images par requête | `files.imageRequestBudgetBytes` | global | global — budget de requête | |
| Rétention des fichiers (jours) | `files.retentionDays` | global | ⚠️ à trancher — magasin commun, règle unique | |
| Fichiers joints max. par message | `files.maxAttachments` | global | ⚠️ à trancher — par message, disque commun | |
| Texte d'un fichier transmis au modèle | `files.promptChars` | global | ⚠️ à trancher — contexte du modèle commun | |
| Texte de tous les fichiers d'un message | `files.promptTotalChars` | global | global — coût d'un tour | |
| Transfert — plafond par transfert | `files.agentMaxBytes` | global | global — canal machines commun | |
| Transfert — taille d'un morceau | `files.agentChunkBytes` | global | global — trame du canal machines | |
| Transfert — délai maximal | `files.agentTimeoutMs` | global | global — canal machines commun | |
| Adresse du serveur d'images (ComfyUI) | `images.baseUrl` | global | global — un seul serveur | |
| Clé du serveur d'images | `images.apiKey` | global | global — secret d'installation | |
| Largeur demandée des images | `images.width` | global | global — imposé par l'outil | |
| Hauteur demandée des images | `images.height` | global | global — imposé par l'outil | |
| Plafond d'une génération d'image | `images.timeoutMs` | global | global — plafond de sécurité | |

## 6 · Déclencheurs (1 clé)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Notifications de sources injectées | `sources.promptTotalChars` | global | ⚠️ à trancher — pile par bot, borne unique | |

## 7 · Agents (4 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Interface d'écoute | `agents.bindHost` | global | global — réseau de la machine | |
| Nom du serveur | `agents.serverName` | global | global — certificat serveur | |
| Port du canal machines | `agents.port` | global | global — un seul port | |
| Confirmation des commandes distantes | `agents.defaultLevel` | global | global — garde-fou d'installation | |

## 8 · Libraire (5 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Adresse du libraire | `librarian.baseUrl` | global | global — un seul Libry | |
| Clé d'API du libraire | `librarian.apiKey` | global | global — secret unique | |
| Jeton agent du libraire | `librarian.agentToken` | global | global — un seul serveur | |
| Autoriser la capture de pages | `librarian.screenshot` | global | global — outil commun | |
| Délai maximal d'archivage | `librarian.archiveTimeoutMs` | global | global — client commun | |

## 9 · Interface (4 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Fuseau horaire des horodatages | `ui.timeZone` | global | ⚠️ à trancher — un seul fuseau sert tout | |
| Buffer de rejeu — trames | `transport.replayBuffer` | global | global — transport du gateway | |
| Buffer de rejeu — octets | `transport.replayBytes` | global | global — transport du gateway | |
| Délai maximal du récapitulatif | `recap.timeoutMs` | global | ⚠️ à trancher — modèle commun, longueur du bot | |

## 10 · Système (2 clés)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Rétention du journal d'audit | `audit.retentionDays` | global | ⚠️ à trancher — un seul journal | |
| Taille maximale d'un fichier d'audit | `audit.maxSizeMb` | global | global — rotation du même journal | |

## 11 · Bots (1 clé)

| Réglage | Clé technique | Aujourd'hui | Avis | Décision |
|---|---|---|---|---|
| Bots qui tournent en même temps | `bots.maxActifs` | global | global — plafond de l'installation | |

---

## Les 5 réglages MIXTES — que fait chaque côté ?

| Réglage | Partie GLOBALE | Partie PAR BOT | Avis |
|---|---|---|---|
| `prompts.light` | le texte par défaut | le sien remplace | garder mixte |
| `prompts.heavy` | le texte par défaut | le sien remplace | garder mixte |
| `tts.enabled` | interrupteur maître (off ⇒ tous off) | le bot peut seulement se couper | garder mixte |
| `memory.consolidation.enabled` | la cadence (dimanche 3 h) | ce bot participe ou non | garder mixte |
| `push.enabled` | appareils abonnés | ce bot notifie ou non | garder mixte |

⚠️ **Éclater un MIXTE créerait deux interrupteurs qu'il faudrait baisser tous les deux.**

## Réglages qui n'ont AUCUN écran aujourd'hui

`agents.bindHost` · `agents.port` · `agents.defaultLevel` · `audit.retentionDays` · `audit.maxSizeMb` · `recap.timeoutMs` · `bots.maxActifs` — **non modifiables depuis l'interface.**
