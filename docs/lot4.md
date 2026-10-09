# Lot 4 — Agent d'exécution (ex-« sidecar d'exécution ») pour Yuki

> **Spécification du Lot 4 — « agent d'exécution »** (nom historique du lot :
> « sidecar d'exécution »). Ce document décrit la
> **conception** d'un composant qui permet à Yuki de **faire exécuter des
> commandes sur d'autres machines** du réseau local, sans que Yuki n'exécute
> elle-même quoi que ce soit. Il **complète** [`docs/architecture.md`](architecture.md)
> (carte des lots, où le Lot 4 figure « à venir », `docs/architecture.md:110`) et
> [`docs/lot1.md`](lot1.md) (« sidecar d'exécution et outil `shell` (Lot 4) »,
> `docs/lot1.md:246`).
>
> **Date.** 2026-10-07.
>
> **Nature du document.** Document de **conception** : **aucun code** n'est
> écrit ni modifié. Tout y est marqué **ACTÉ** (décisions réelles de
> l'utilisateur) ou **PROPOSÉ** (détails de conception, **non bloquants**).
> **Aucun point `C##` n'est ouvert** : `C64`–`C74` sont **tous tranchés**.
>
> **Numérotation.** Ce document **poursuit** celle des lots précédents :
> décisions **D109 → D128**, **plus aucun point ouvert** (dernier `D108` :
> `docs/lot12.md` ; dernier `C63` : `docs/lot12.md`). ⚠️ `D59` et `C37` ont été
> créés puis **retirés** lors d'un travail intermédiaire et ne sont **pas
> réattribués** (`docs/lot9.md:23-25`). **D118 à D128** ont été actées le
> **2026-10-07**.

---

## ⚡ Résumé — tout est tranché

> **Toutes les décisions sont prises ; le document est prêt pour l'implémentation.**

- **Nom & périmètre** : « agent d'exécution », shell complet ; Yuki délègue, n'exécute pas (**D122**, **D123**).
- **Appairage & canal** : code affiché sur la machine, recopié dans Yuki (**D119**) ; port machines LAN, mTLS (**D114**–**D116**).
- **Garde-fous** : confirmation 4 niveaux + privilèges, **par agent** (**D118**, **D120**) ; hors ligne = **rejet** (**D124**) ; destructrices = liste validée (**D126**).
- **Journal d'audit** : commande + machine + horodatage + code de sortie, **jamais la sortie complète** ; ~30 j, rotation par taille, paramétrable (**D127**).
- **Ordre des lots** : **Lot 4 AVANT Lot 9** (l'accès est protégé en amont par Caddy + authentik) (**D128**).
- **Interface** : page par agent (état, dernière connexion, historique) (**D125**) ; OpenClaw levé (**D121**).

---

## 1. Objet et périmètre

**Objet.** Donner à Yuki la capacité de **faire agir d'autres machines** :
lancer une commande sur une machine de confiance, récupérer sa sortie, et
l'utiliser dans une conversation. L'utilisateur pilote Yuki ; Yuki **délègue
l'exécution** à un petit programme installé sur la machine cible.

**Ce que le Lot 4 fait :**

- définit un **agent d'exécution** installé sur une **machine cible** (locale
  **ou** distante — un agent peut tourner **sur la même machine que Yuki** ; un
  « exécutant bête », **sans LLM** — décision **D109**, `docs/architecture.md:110`) ;
- définit le **canal** Yuki ↔ agent (un **port « machines »** dédié, réseau
  **local** uniquement — décisions **D114/D116**) ;
- définit l'**appairage** (première mise en relation de confiance — décision
  **D111**) et la **sécurité** du canal (chiffrement + authentification
  mutuelle — décision **D115**) ;
- encadre les **garde-fous** (confirmation par agent — **D118**, privilèges par
  machine — **D120**, journal d'audit, périmètre…) (§7).

**Ce que le Lot 4 NE fait PAS (bornes explicites) :**

| Hors périmètre | Raison / renvoi |
| --- | --- |
| **Aucun LLM dans l'agent** | L'agent est un **exécutant bête** ; l'intelligence reste dans Yuki (**D109**). |
| **Yuki n'exécute rien en local** | Yuki **lance** les commandes mais **ne les exécute pas** : elle délègue (**D110**, **D112**). |
| **Pas d'authentification applicative ni de durcissement complet** | C'est le **Lot 9**. L'accès à Yuki est protégé **en amont** par l'infrastructure (**D113**). |
| **Pas de pont MCP ni de skills** | C'est le **Lot 5** (`docs/architecture.md:110`, `docs/lot1.md:246`). |
| **Pas d'intégration n8n** | Anticipée mais **hors périmètre** ; la conception ne doit pas la bloquer (§9). |
| **Aucun numéro de port ni adresse IP fixés** | Aucun fait d'infra fiable n'est disponible (voir §13). |
| **Aucune donnée Docker/socket** | Le socket Docker est **déjà refusé** par ailleurs ; non concerné ici. |

**Décision-cadre rappelée (ACTÉ) :** **D109 — l'agent n'est pas un LLM.** C'est
un exécutant minimal ; toute l'intelligence (décider *quoi* exécuter) reste dans
Yuki.

---

## 2. Vocabulaire

⚠️ **Ambiguïté levée (ACTÉ — D122).** Le mot « **sidecar** » désigne
techniquement un processus **local**, **co-localisé** avec son application
(même machine, même pod) : il est **abandonné** comme nom du composant. Le nom
retenu est **« agent d'exécution »** ; le mot « **distant** » est **retiré** —
un agent **peut** tourner **sur la même machine que Yuki**. « Sidecar
d'exécution » n'est **conservé que comme libellé historique du lot** (nom
inscrit dans la carte des lots, `docs/architecture.md:110`). Le reste de ce
document emploie **« agent »**.

| Terme | Définition |
| --- | --- |
| **Orchestrateur** | **Yuki**. Elle décide, planifie, envoie les commandes, agrège les résultats. Un seul orchestrateur. |
| **Agent d'exécution** (ex-« sidecar ») | Petit programme installé sur une machine cible. **Exécutant bête** : reçoit une commande, l'exécute, renvoie la sortie. **Aucun LLM**, aucune décision de haut niveau. |
| **Port machines** | Le **port dédié** de Yuki qui parle aux agents. **LAN uniquement**, **hors Caddy et hors authentik** (**D114/D116**, §5). |
| **Identité** | Une entité authentifiée sur le port machines (un agent = une identité ; n8n = une identité distincte, §9). |
| **Appairage** | Mise en relation initiale de confiance entre Yuki et un agent, par **code** validé dans l'interface (**D111**, §4). |
| **Révocation** | Retrait d'une identité (dé-appairage) depuis l'interface ; l'accès de l'agent cesse (§5, §8). |

---

## 3. Architecture

### 3.1 Briques

| # | Brique | Rôle | Où elle vit |
| --- | --- | --- | --- |
| **(a)** | **Yuki / orchestrateur** | Décide *quoi* exécuter, émet les commandes, reçoit la sortie. | Serveur Yuki, derrière **Caddy + authentik** pour l'accès humain. |
| **(b)** | **Agent d'exécution** | **Exécute** la commande demandée et renvoie la sortie. | **Machine cible**, dans le LAN (locale **ou** distante). |
| **(c)** | **Port « machines »** | Canal Yuki ↔ agents. **Dédié**, **LAN uniquement**, **hors Caddy / hors authentik**. | Serveur Yuki (écoute séparée de l'accès humain). |
| **(d)** | **Identités multiples** | Un port machines sert **N agents + n8n**, chacun avec son **péremètre**. n8n **n'a PAS** les droits d'exécution. | Côté port machines. |

### 3.2 Schéma (ASCII)

```
  navigateur ──(Caddy v2 + authentik, SSO)──►  Yuki  (gateway node:http)
      │                                            │
      │  WS/HTTP humain (:port humain)             │  port « machines » dédié, LAN only
      │                                            │  (hors Caddy / hors authentik — D114/D116)
      │                                            ▼  mTLS (autorité interne Yuki — D115)
      │                              ┌─────────────────────────────────────┐
      │                              │ port machines (1 port, N identités) │
      │                              └───┬───────────────┬───────────────┬─┘
      │                                  ▼               ▼               ▼
      │                           agent A (machine 1) agent B (machine 2)  n8n (jeton étroit,
      │                           [exécuteur bête]      [exécuteur bête]   AUCUN droit d'exéc.)
```

### 3.3 Pourquoi cette séparation

| Étage | Pourquoi il est **séparé** |
| --- | --- |
| Accès humain (Caddy + authentik) | C'est la **seule** voie que protège l'infrastructure (**D113**). Elle sert au navigateur. |
| Port machines (LAN) | Les agents ne passent **ni** par Caddy **ni** par authentik (**D114**) : un agent est un processus, pas un utilisateur ; il ne peut pas faire de SSO. Ce canal a donc **sa propre** sécurité (§5). |
| Agent sur la machine cible | Yuki **n'exécute pas** ; l'exécution a lieu **là où la commande doit tourner** (**D110/D112**). |

> **Point clé.** Le proxy (Caddy + authentik) protège l'**accès** à Yuki, pas
> l'**usage** qu'on en fait. Le port machines, lui, est **hors** de cette
> protection : sa sécurité repose **entièrement** sur le protocole et le canal
> (§5, §6).

---

## 4. Appairage

**Buts.** (i) que l'agent apprenne **l'adresse de Yuki** ; (ii) que Yuki et
l'agent établissent une **relation de confiance durable** ; (iii) que
l'utilisateur **contrôle** cette mise en relation depuis l'interface.

### 4.1 Flux nominal (ACTÉ — **D111**)

**D111 — appairage à la première configuration.** Le flux acté est :

1. **Installer** l'agent sur la machine cible.
2. **Lui donner l'adresse de Yuki** (là où écouter : le port machines).
3. L'agent **rend un code**.
4. **Valider ce code dans l'interface Yuki** ⇒ l'appairage est acté.

### 4.2 Faiblesse du flux naïf (à discuter)

⚠️ **Le flux naïf est faible.** Si l'agent se contente de « demander un
appairage » et d'**attendre une approbation** côté Yuki, alors **n'importe qui
sur le LAN** peut déclencher une demande d'appairage et attendre qu'un
utilisateur distrait l'approuve. Le code n'est alors qu'un identifiant de
demande, pas une **preuve**.

### 4.3 Variante retenue (ACTÉ — preuve de possession, **D119**)

**Décision (D119).** Inverser le sens de circulation du code : **le code
s'affiche sur la machine de l'agent** (dans sa console) et l'utilisateur
le **recopie dans Yuki**. Recopier ce code prouve que l'utilisateur a **accès
physique / console** à la machine de l'agent — c'est une **preuve de possession**,
pas une simple demande.

Comparaison des deux variantes :

| Variante | Qui émet le code | Ce que ça prouve | Faiblesse |
| --- | --- | --- | --- |
| **Yuki émet** (naïve) | Yuki affiche un code, l'agent le saisit | Que l'agent a lu le code sur Yuki | **N'importe qui sur le LAN** peut initier et attendre l'approbation. |
| **Machine émet** (retenue, **D119**) | L'agent affiche un code sur la machine cible ; l'utilisateur le recopie dans Yuki | Que l'utilisateur a **accès à la machine cible** | Suppose un accès console initial (SSH/écran) — acceptable pour un appairage. |

### 4.4 Paramètres d'implémentation (à préciser — non bloquants)

Le **flux** est acté (**D119**) ; restent des paramètres d'implémentation,
**non bloquants** :

- **Fenêtre / expiration** du code (durée de validité).
- **Limitation de débit** (anti-brute-force sur les tentatives d'appairage).
- **Code à usage unique** (invalidé après appairage réussi).

---

## 5. Canal et sécurité (cœur du lot)

**Énoncé fondateur (ACTÉ — D114).** Le canal Yuki ↔ agents **ne passe pas par le
net** : **LAN direct, hors Caddy et hors authentik**. Conséquence directe :
**toute** la sécurité repose sur **le protocole et le canal** — le proxy ne peut
rien protéger ici.

### 5.1 Chiffrement et authentification mutuelle (mTLS — ACTÉ D115, mécanisme PROPOSÉ)

**ACTÉ — D115 :** le **chiffrement est souhaité** ; la voie envisagée est
**mTLS** (TLS mutuel), qui apporte **trois** propriétés d'un coup :

| Propriété | Apport |
| --- | --- |
| **Chiffrement** | Le trafic sur le LAN n'est pas lisible en clair. |
| **Authentification mutuelle** | Yuki **et** l'agent prouvent chacun leur identité par certificat : pas de simple mot de passe partagé. |
| **Révocation** | Un agent compromis ou retiré peut être **révoqué** (son certificat cesse d'être accepté). |

**PROPOSÉ — autorité interne à Yuki.** Yuki porte une **autorité de certification
interne** qui **signe le certificat de l'agent au moment de l'appairage**. Ainsi
la confiance naît exactement là où l'utilisateur a validé (§4) ; aucun tiers ni
service externe n'est requis.

> ⚠️ **Détail non bloquant (§13).** Le choix exact de mTLS (et de l'autorité
> interne) est **proposé**, pas acté : D115 acte l'**intention** de chiffrer,
> pas la technique.

### 5.2 Le reste de l'arsenal

| Mesure | Statut | Rôle |
| --- | --- | --- |
| **Port dédié LAN** | **ACTÉ** (D116) | Un port **rien qu'aux agents**, lié **uniquement au LAN**. |
| **Limitation de débit** | PROPOSÉ | Anti-abus sur le port machines et sur l'appairage (§4.4). |
| **Journalisation** | PROPOSÉ (non négociable, §7) | On journalise les **connexions** **et** les **commandes** (qui, quoi, quand). |
| **Périmètres par identité** | **ACTÉ** (D117) | n8n **jamais** les droits d'exécution (§9). |
| **Dé-appairage = révocation** | Bouton **ACTÉ** (D118) ; révocation **PROPOSÉE** | Le **bouton « supprimer l'agent »** est acté (D118) ; le mécanisme (révoquer le certificat) reste **proposé** (§8). |

---

## 6. Modèle de menace

Constat **factuel**, sans dramatiser ni minimiser.

| # | Menace | Description |
| --- | --- | --- |
| **(i)** | **Qui atteint Yuki peut faire exécuter** | Le proxy protège l'**accès**, pas l'**usage**. Toute personne/processus capable de parler à Yuki peut, si les garde-fous le permettent, faire exécuter une commande sur une machine appairée. |
| **(ii)** | **Injection via la sortie des commandes** | La sortie d'une commande **revient dans le contexte** de Yuki. Une sortie malveillante (ex. un fichier lu qui contient des instructions) peut influencer le modèle suivant ⇒ **boucle de rétroaction exploitable**. |
| **(iii)** | **Injection via la mémoire automatique** | La mémoire (Lot 12) **injecte** des souvenirs au prompt. Un souvenir empoisonné redevient une instruction. ⇒ Règle : **« la mémoire est une donnée, jamais une instruction »** (renvoi `docs/lot12.md`, D97–D108). |
| **(iv)** | **Mouvement latéral** | Depuis la machine de l'agent, un attaquant peut rebondir sur le reste du LAN (la machine est appairée, donc atteignable et potentiellement outillée). |
| **(v)** | **Appairage détourné / rejeu / pas de rotation** | Un appairage faible (§4.2) ou un code qui n'expire jamais ou rejouable ouvre la porte ; l'absence de **rotation** de certificat prolonge une compromission. |
| **(vi)** | **Confidentialité** | La **sortie des commandes** peut être **envoyée au fournisseur LLM distant** (le modèle qui lit le résultat). Des secrets lus par une commande peuvent ainsi sortir du LAN. |

**Réponse de conception (renvois).** (i) → garde-fous §7 + périmètres §9 ;
(ii)/(iii) → **balisage de la sortie** + rappel système §7 ; (iv) → privilèges §7 ;
(v) → appairage à preuve §4 + révocation §5 ; (vi) → **rétention/confidentialité**
(**D127**, §7).

---

## 7. Garde-fous — options à la carte

⚠️ **Ces garde-fous sont des CHOIX**, désormais **tous tranchés** —
**confirmation avant exécution** (**D118**) et **privilèges de l'agent**
(**D120**) : réglés **par agent** sur une **page de configuration dédiée**,
**pas globalement** ; **périmètre = shell complet** (**D123**) ; **hors ligne =
rejet** (**D124**) ; **« commande destructrice » = liste validée** (**D126**) ;
**journal d'audit** : contenu et rétention **actés** (**D127**).

| Garde-fou | Options | Implications | Statut |
| --- | --- | --- | --- |
| **Confirmation avant exécution** | **4 niveaux PAR AGENT** : (1) désactivé (2) validation à chaque commande (3) validation des commandes destructrices (4) pas de validation | Réglage **par agent (par machine)**, **pas global** ; se choisit sur une **page de configuration dédiée** qui liste les agents. Le niveau 3 s'appuie sur la définition de « commande destructrice », **actée** (**D126**). | **ACTÉ — D118** |
| **Périmètre d'exécution** | **Shell complet** (pas de liste blanche de commandes) | Shell = souple mais très permissif ; le **niveau 3** (validation des destructrices, **D126**) est le garde-fou associé. | **ACTÉ — D123** |
| **Journal d'audit** | — | On journalise **connexions + commandes** ; contenu **acté** : commande + métadonnées (machine, quand, code de sortie), **pas** la sortie complète ; **~30 jours**, rotation par taille, **paramétrable** (`int`). | **ACTÉ — D127** |
| **Privilèges de l'agent** | **2 niveaux PAR AGENT** : **root** / **compte normal** | Réglage **par agent (par machine)**, **pas global** ; champ **`enum`** du schéma de config (⚠️ le schéma n'accepte que les types `string`, `int`, `enum` — **pas de booléen**, `src/config/schema.ts:19`). Compte normal = limite le mouvement latéral (iv) ; root = tout est possible. | **ACTÉ — D120** |
| **Troncature / balisage de la sortie** | Délimiteurs non ambigus + rappel système | Casse la boucle d'injection (ii)/(iii). | **PROPOSÉ** |
| **Comportement hors ligne** | **Rejet** (si Yuki injoignable) | Yuki injoignable ⇒ l'agent **rejette** : ni file d'attente, ni exécution différée — évite tout rejeu. | **ACTÉ — D124** |

**ACTÉ — page de configuration des agents (D118).** L'interface comporte une
**page dédiée** qui **liste les agents** (un par machine appairée). Pour
**chaque agent**, un **niveau parmi quatre** : **(1) désactivé**,
**(2) validation à chaque commande**, **(3) validation des commandes
destructrices**, **(4) pas de validation** ; plus un **bouton « supprimer
l'agent »** (dé-appairage). Réglage **par agent**, **pas global**.

**ACTÉ — privilèges de l'agent, par machine (D120).** Le niveau de privilège du
processus de l'agent est un **réglage par agent** (comme les 4 niveaux de
validation), **pas global** : soit **root**, soit **compte normal**, **selon la
machine**. Dans le schéma de config de Yuki c'est un **`enum`** (le schéma
n'accepte que les types `string`, `int`, `enum` — **pas de booléen**,
`src/config/schema.ts:19`).

**ACTÉ — définition de « commande destructrice » (D126, ex-C74).** Une commande
est **destructrice** si elle correspond à une **liste de motifs** (`rm`, `dd`,
`mkfs`, `shutdown`, `systemctl stop/disable`, redirections vers des chemins
système, `docker … down`…). **Limites conservées** : une liste de motifs se
**contourne** ; une commande **anodine** peut être destructrice **selon le
contexte**.

**ACTÉ — journal d'audit, contenu et rétention (D127).**
Journaliser la **commande + des métadonnées** (quelle machine, quand, **code de
sortie**) mais **PAS la sortie complète** : elle peut contenir des **secrets**
lus par la commande (fuite hors LAN, §6-vi). **Rétention ~30 jours**, **rotation
par taille**, **paramétrable** (un `int` du schéma de config suffit —
`string`/`int`/`enum`, `src/config/schema.ts:19`). **Acté.**

**PROPOSÉ — balisage de la sortie.** Encadrer la sortie des commandes par des
**délimiteurs non ambigus** (ex. `<sortie machine="A">…</sortie>`) et rappeler
au système que **c'est une donnée, pas une instruction** — même logique que la
mémoire (§6-iii). But : **casser** la boucle d'injection.

**PROPOSÉ — enveloppe de commande/résultat alignée sur l'existant.** Réutiliser
le format d'erreur de Yuki (`{ error, code }`, cf. `src/gateway/routes/tts.ts:1050`,
`:1075`, `:1135`) et un **journal JSON-lines avec redaction** — Yuki possède déjà
un mécanisme de **redaction** (`src/observability/logger.ts:19`, `:42`, `:112`).

---

## 8. Identités & multi-machines

**Principe (ACTÉ — D117).** **Un port machines, plusieurs identités et
périmètres.** Chaque machine appairée = **un agent** = **une identité**, avec
**ses propres droits**.

**ACTÉ — interface par agent (D125, ex-C72).** La page des agents montre, **par
agent** : **état** (en ligne / hors ligne / révoqué), **dernière connexion**, et
un **petit historique** (exécutions récentes). Les **droits par machine** sont
déjà actés (**D120** : confirmation 4 niveaux + privilèges root/compte normal,
**par agent**) — ici **confirmés**, sans doublon.

---

## 9. Intégration n8n (futur)

**Règle (ACTÉ — D117).** Pour l'avenir, **n8n partage le même port machines**
mais avec un **jeton séparé** et un **périmètre étroit**. ⚠️ **n8n n'a PAS la
capacité d'exécution** : il **n'hérite jamais** des droits des agents.

| Aspect | Décision |
| --- | --- |
| Transport | **Même port machines** que les agents. |
| Authentification | **Jeton séparé** (identité distincte, pas un certificat d'agent). |
| Périmètre | **Étroit** : lecture/notification, **pas d'exécution**. |
| Périmètre du lot | **Hors Lot 4** — mais la conception **ne doit pas le bloquer**. |

Le modèle retenu — **« 1 port = N identités + N périmètres »** — rend cette
extension naturelle : ajouter n8n = ajouter une identité et un périmètre, **sans**
toucher au reste.

---

## 10. Ce qui existe déjà / reste à faire

### 10.1 Art antérieur — Docky (⚠️ **autre projet, ne pas modifier**)

**Docky** (`/projects/Docky`) n'est **pas** modifié par ce document. On y relève
du **réutilisable** et ce qui **manque**.

| Réutilisable | Preuve |
| --- | --- |
| Transport **REST(JSON) + WebSocket** | `agent/routes.py:1`, `:190`, `:278` |
| Enveloppe `{error, …}` | `agent/auth.py:38-40` (`{"error": "Invalid or missing API key"}`) |
| **Validation humaine** sur outils sensibles (marqueur `__NEEDS_HUMAN_VALIDATION__`) | `orchestrator/app/llm/constants.py:9` ; `docs/mcp-server.md:68` |

| Ce qui manque partout | Constat |
| --- | --- |
| **Appairage** | Docky utilise une **clé API statique** : `DOCKY_AGENT_API_KEY` en `Authorization: Bearer` (`agent/auth.py:11`, `:17` ; `roadmap.md:405`). **Secret pré-partagé hors bande** : **aucun code échangé** ⇒ pas d'appairage. |
| **TLS orchestrateur ↔ agent** | **Non implémenté** : communication **en clair** (`roadmap.md:518`, `:668`). |

**Conclusion.** Docky **motive** le Lot 4 : c'est précisément l'**appairage par
code** (§4) et le **chiffrement du canal** (§5) qui manquent à l'existant.

### 10.2 Ce qui existe déjà dans Yuki (ancrages)

| Élément | Preuve |
| --- | --- |
| Interdiction structurelle des outils d'exécution au Lot 2 (l'agent d'exécution n'existe qu'au Lot 4) | `src/llm/tool-policy.ts:1-16` ; `FORBIDDEN_TOOLS` `:91-96` (`write`, `edit`, `bash`, `powershell`) |
| Rôles modèles `llm.light` / `llm.heavy` | `src/llm/providers.ts` ; `docs/lot2.md:94-98` |
| Enveloppe d'erreur `{ error, code }` | `src/gateway/routes/tts.ts:1050`, `:1075`, `:1135` |
| Journalisation avec **redaction** | `src/observability/logger.ts:19`, `:42`, `:112` |
| Mémoire automatique (à **baliser** : donnée, jamais instruction) | `docs/lot12.md` (D97–D108) |

### 10.3 Reste à faire (Lot 4)

1. **Agent** (exécutant bête, sans LLM) + son installation sur une machine cible.
2. **Port machines** dédié, LAN only, hors Caddy/authentik.
3. **Appairage** par code + autorité interne signant les certificats.
4. **mTLS** + révocation.
5. **Garde-fous** actés en §7 (confirmation, privilèges, shell complet, hors ligne = rejet, « destructrices », **journal d'audit D127**).
6. **Interface** : liste/état des machines, exécutions récentes, dé-appairage.

---

## 11. Tension OpenClaw — levée (ACTÉ)

**Décision (D121, 2026-10-07).** **OpenClaw n'existe plus.** Il n'y a donc **plus
de tension** : **Yuki pilote elle-même ses agents** ; elle n'est le « bras » de
personne et reste le **seul orchestrateur** de ce périmètre.

**Traçabilité (fait).** Un art antérieur de l'écosystème,
`holaf-lib/docs/design-webhooks-mcp.md` (**autre projet**, non modifié), plaçait
**OpenClaw comme le cerveau** et **Pi-Web / Yuki comme un bras** piloté via
**MCP** (`pi.run_session_prompt`, `design-webhooks-mcp.md:154`, `:167`, `:191`).
Ce design est **caduc** du fait de **D121** ; il n'est conservé ici qu'à titre de
**référence historique**.

---

## 12. Décisions (D109–D128) et points ouverts (aucun)

### 12.1 Décisions **ACTÉES** (décisions réelles de l'utilisateur)

| # | Décision | Preuve / contexte |
| --- | --- | --- |
| **D109** | L'agent **n'est PAS un LLM** : exécutant bête ; l'intelligence reste dans Yuki. | Décision utilisateur ; contexte `docs/architecture.md:110` |
| **D110** | C'est **Yuki qui lance les commandes** (pas l'utilisateur) ; « éventuellement un LLM spécifique outillé ». | Cohérent avec `llm.light`/`llm.heavy` (`src/llm/providers.ts`, `docs/lot2.md:94-98`) |
| **D111** | **Appairage à la première configuration** : installer l'agent, lui donner l'adresse de Yuki, il **rend un code**, on **valide le code dans l'interface**. | Décision utilisateur (§4.1) |
| **D112** | **Yuki n'exécute pas directement** (elle passe par l'agent) ⇒ **l'utilisateur ne donne pas son mot de passe à Yuki**. | Décision utilisateur |
| **D113** | **Exposition** : Yuki est **derrière Caddy v2 + authentik**. L'application **n'implémente pas d'authentification** ; l'accès est protégé **en amont par l'infrastructure** (voir note ci-dessous). | Décision utilisateur |
| **D114** | Le canal Yuki ↔ agents **ne passe pas par le net** : **LAN direct, hors Caddy et hors authentik** ⇒ **toute la sécurité repose sur le protocole et le canal**. | Décision utilisateur |
| **D115** | **Chiffrement souhaité** ⇒ **mTLS** envisagé (chiffrement + authentification mutuelle + révocation). | Décision utilisateur |
| **D116** | **Port dédié aux agents**, **lié uniquement au LAN**. | Décision utilisateur |
| **D117** | **Mutualisation** : un port « machines », plusieurs identités/périmètres ; **n8n n'hérite PAS** des droits d'exécution. | Décision utilisateur |
| **D118** | **Confirmation avant exécution : 4 niveaux PAR AGENT** — (1) désactivé, (2) validation à chaque commande, (3) validation des commandes destructrices, (4) pas de validation — **plus un bouton « supprimer l'agent »** ; réglage **par machine**, **pas global**, sur une **page de configuration dédiée**. | Décision utilisateur du **2026-10-07** (§7, §8) |
| **D119** | **Appairage — preuve de possession** : le **code s'affiche sur la machine distante** (console de l'agent) et l'utilisateur le **recopie dans Yuki**. | Décision utilisateur du **2026-10-07** (§4.3) |
| **D120** | **Privilèges PAR AGENT** : l'agent tourne **root** ou en **compte normal**, **selon la machine** ; réglage **par agent**, **pas global** ; champ **`enum`** du schéma de config (`string`/`int`/`enum`, `src/config/schema.ts:19`). | Décision utilisateur du **2026-10-07** (§7, §8) |
| **D121** | **OpenClaw n'existe plus** ⇒ **plus de tension** : **Yuki pilote elle-même ses agents** (seul orchestrateur) ; le design écosystème centré OpenClaw est **caduc**. | Décision utilisateur du **2026-10-07** (§11) |
| **D122** | **Nom : « agent d'exécution »** ; le mot **« distant » est retiré** (un agent peut tourner **sur la même machine que Yuki**). « Sidecar » est **abandonné** comme nom du composant (conservé comme **libellé historique du lot** uniquement). | Décision utilisateur du **2026-10-07** (§2, résout **C64**) |
| **D123** | **Périmètre d'exécution : shell COMPLET** (pas de liste blanche de commandes) ; le **niveau 3** (D118) reste le garde-fou associé. | Décision utilisateur du **2026-10-07** (§7, résout **C67**) |
| **D124** | **Hors ligne : REJET.** Yuki injoignable ⇒ l'agent **rejette** la commande — ni file d'attente, ni exécution différée. | Décision utilisateur du **2026-10-07** (§7, résout **C71**) |
| **D125** | **Interface par agent** : **état**, **dernière connexion**, **petit historique** (exécutions récentes). Les **droits par machine** étaient déjà actés (**D120**) — **confirmés**, sans doublon. | Décision utilisateur du **2026-10-07** (§8, résout **C72**) |
| **D126** | **« Commande destructrice » : liste de motifs VALIDÉE** (passe de PROPOSÉ à ACTÉ) — `rm`, `dd`, `mkfs`, `shutdown`, `systemctl stop/disable`, redirections vers des chemins système, `docker … down`… **Limites conservées** : une liste de motifs se **contourne** ; une commande **anodine** peut être destructrice **selon le contexte**. | Décision utilisateur du **2026-10-07** (§7, résout **C74**) |
| **D127** | **Journal d'audit : ACTÉ** — on journalise **commande + machine + horodatage + code de sortie** ; **JAMAIS la sortie complète** (elle peut contenir des **secrets** lus par la commande) ; **rétention ~30 jours**, **rotation par taille**, **paramétrable** (`int` du schéma de config). | Décision utilisateur du **2026-10-07** (§7, résout **C73**) |
| **D128** | **Ordre : Lot 4 AVANT Lot 9** (durcissement d'authentification applicative) — motif : l'accès est **déjà protégé en amont** par **Caddy v2 + authentik** (**D113**), donc le Lot 9 n'est **pas bloquant**. | Décision utilisateur du **2026-10-07** (résout **C70**) |

> **Formulation imposée (D113).** **Ne jamais écrire « Yuki n'a aucune
> authentification ».** Écrire : *« l'application n'implémente pas
> d'authentification ; l'accès est protégé en amont par l'infrastructure (Caddy
> v2 + authentik) ; le canal agents, lui, est hors de cette protection. »*

### 12.2 Propositions **PROPOSÉES** (détails de conception, non bloquants)

| Proposition | Renvoi |
| --- | --- |
| **Autorité interne à Yuki** signant les certificats **au moment de l'appairage**. | §5.1 |
| Enveloppe de commande/résultat alignée sur l'existant Yuki (réutiliser `{error, code}`, journal JSON-lines avec **redaction**). | §7 |
| **Sortie balisée** (délimiteurs non ambigus, ex. `<sortie machine="A">…</sortie>`) + rappel système « donnée, pas instruction ». | §7 |
| **Dé-appairage = révocation** depuis l'interface. | §5.2, §8 |

### 12.3 Points **OUVERTS** : **aucun**

**Tous les points `C64`–`C74` sont tranchés** — cf. décisions **D109–D128** (§12.1).

---

## 13. Ce qui reste incertain (hors décisions)

> Aucune **question de conception** n'est ouverte : `C64`–`C74` sont **tous
> tranchés** (**D109–D128**). Ci-dessous, seulement des **détails
> d'implémentation**, non bloquants.

- **Choix technique exact du chiffrement** (mTLS + autorité interne) : **proposé**,
  pas acté ; D115 acte l'intention.
- **Appairage** : le **flux** est **acté** (**D119** : code affiché sur la machine,
  recopié dans Yuki) ; ses **paramètres** (expiration, débit, usage unique)
  restent à préciser (§4.4).
- **n8n** : conception **anticipée** (D117) mais **hors Lot 4** ; aucun détail
  d'implémentation.
- **OpenClaw** : **n'existe plus** (**D121**) ⇒ tension **levée** ; l'ancien
  design centré OpenClaw (`holaf-lib/docs/design-webhooks-mcp.md`) est **caduc**.
- **Aucun numéro de port ni adresse IP** n'est fixé : aucune donnée d'infra
  fiable n'est disponible (les identifiants « nuc00 » / « 10.10.1.110 » ne
  figurent dans aucun fichier).
- **Mesure de coût/latence** du canal (mTLS, appairage) : **non mesurée** ;
  aucun banc n'existe pour ce lot.
- **Docky** : réutilisation **conceptuelle** seulement (transport REST+WS,
  marqueur de validation humaine) ; c'est **un autre projet**, non modifié.

---

## 14. A6 — binaire `yuki-agent` (note d'implémentation)

> **Note d'implémentation — hors décisions de conception.** Ajoutée **après la
> validation**, le **2026-10-07**, pour consigner du **code livré**. Elle **ne
> modifie aucune décision** `D109`–`D128`, ne rouvre **aucun** point `C##` et
> n'ajoute **aucune** décision de conception : ce n'est ni **ACTÉ** ni
> **PROPOSÉ** au sens du présent document.

**« A6 »** n'est pas un lot de la spécification : c'est un **sous-lot du plan
d'implémentation interne** de l'agent (découpage de développement sans
correspondance avec la numérotation « Lot 4 / 5 / 9 / 12 » d'ici) : **A1–A7**
côté agent Go (appairage, transport, proto, exécution, garde-fous, binaire,
service) et **B1–B6** côté Yuki/TypeScript.

Le sous-lot **A6** livre le programme posable sur une machine :

- `agent/cmd/yuki-agent` : CLI (`pair`/`run`/`install`/`uninstall`/`status`/`version`) ;
- `agent/internal/agent` : configuration locale, `hello` OS, boucle `cmd → ack → classification → exécution → result`, journal JSON-lines, arrêt propre ;
- `agent/internal/service` : service Windows (SCM) ; sous Linux, `deploy/yuki-agent.service` + `deploy/install.sh` (systemd) ;
- `agent/internal/exec/proc_windows.go` : exécution réelle Windows (`cmd.exe /d /s /c`, `powershell.exe -NoProfile -NonInteractive -Command`) et **job object** tuant tout l'arbre au timeout.

### 14.1 Dépendance Go ajoutée (première du module)

- **`golang.org/x/sys` v0.35.0** — licence **BSD-3-Clause**.
- **Windows uniquement** (import sous `//go:build windows`) : service Windows (`windows/svc`, `windows/svc/mgr`) et **job object** (`windows.CreateJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`).
- Les binaires **Linux n'embarquent pas** ce code (vérifié : 0 symbole `golang.org/x/sys/windows` dans le binaire Linux ; 122 dans le binaire Windows).
- `proto.Cmd` gagne un champ optionnel **`destructive`** (`*bool`, `agent/internal/proto/types.go`) : c'est une **décision d'IMPLÉMENTATION** — **arbitrée pendant le développement, non validée par l'utilisateur**. Elle **ne contredit pas** `D118`/`D126`/`D124` (**l'agent ne bloque pas**, Yuki décide) : l'annonce de Yuki sert uniquement à **journaliser une divergence** avec le matcher local — **sans bloquer**.

---

## 15. Validation humaine DANS la conversation (note d'implémentation)

> **Note d'implémentation — hors décisions de conception.** Ajoutée **après la
> validation**, à la demande d'usage réel : une demande de validation (`D118`
> niveaux **2**/**3**) **doit apparaître dans la conversation** où la commande a
> été demandée, et non plus seulement dans l'onglet **Agents** de `/config`. Elle
> **ne modifie aucune décision** `D109`–`D128`.

**Principe.** La demande de validation n'est **PAS un message** : c'est un
**état temporaire de l'interface**. Elle apparaît **dans le fil** de la bonne
conversation, offre **Valider** / **Refuser** sur place, puis **disparaît** une
fois décidée ou expirée. Elle **n'entre jamais** dans le transcript, ni dans le
snapshot, ni dans la mémoire : elle circule par des **trames de contrôle**
WebSocket (`approval`, `approval_cleared`, `approval_result`) envoyées via
`sendDirect` (aucun `seq` consommé, **jamais bufferisées**), et **jamais** par
`SessionStream.append` (le buffer de rejeu).

**Routage.** Chaque demande porte le `sessionId` de la conversation d'où
`run_command` a été appelé (`ctx.sessionManager.getSessionId()`), et n'est
diffusée qu'aux **clients de cette session**. Le « consume-once » reste, lui,
lié à **(agent, commande)** : inchangé.

**Ré-affichage.** À la connexion, à la bascule et à la reconnexion, le serveur
renvoie les demandes **encore en attente** de la conversation (état **vivant**).
Une fois décidée ou expirée, elle ne réapparaît **plus**.

**⚠️ Après validation (comportement à VALIDER par l'utilisateur).** Le choix
retenu est l'**exécution IMMÉDIATE** : approuver déclenche la commande tout de
suite (au lieu d'attendre que le modèle la redemande), et le **résultat**
s'affiche dans la conversation **de façon éphémère** (même mécanisme que la
demande : trame `approval_result`, jamais dans l'historique). Ce comportement
est **isolé** dans `AgentExecutionService.decideApproval`
(`src/agents/execution.ts`) et dans `public/ui/approval-block.js` : il peut être
changé sans toucher au reste (par ex. ne plus exécuter et laisser le modèle
relancer, ou persister le résultat dans le transcript).

**Panneau Agents.** Conservé, **en repli** (utile hors conversation). Sa route
HTTP (`POST /api/agents/approvals/<id>/approve|deny`) **enregistre** la décision
et fait disparaître le bloc de la conversation (via l'événement `decided`), mais
n'exécute pas immédiatement : le lieu **principal** est la conversation.

---

## 16. Épinglage des conversations, encart agents, suppression définitive (note d'implémentation)

> **Notes d'implémentation — hors décisions de conception.** Ajoutées **après la
> validation**, à la demande d'usage réel (2026-10-09). Elles **ne modifient
> aucune décision** `D109`–`D128`.

**Épinglage d'une conversation.** L'action vit dans le **menu contextuel**
(clic droit) : **« Épingler » / « Désépingler »** (libellé qui bascule selon
l'état). ⚠️ La session appartient au SDK Pi (JSONL, `id` = nom de fichier) : on
**n'écrit JAMAIS** de champ maison dedans. L'état vit dans un **store hôte
séparé**, sur le volume `state` (`session-pins.json`, surchargeable par
`YUKI_SESSION_PINS_PATH`), qui associe `sessionId → épinglé`. La trame
`sessions` porte le champ `pinned` ; le serveur TRIE **les épinglées d'abord**,
puis par date décroissante. Un **indicateur visuel discret** (📌) marque les
épinglées (la seule position en tête ne suffirait pas). **Nettoyage** : une
conversation mise de côté retire son épingle (`sendSessions`/`setAside`) ;
`SessionPinStore.prune` retire les orphelines. ⚠️ La liste de l'hôte est
plafonnée (`MAX_SESSIONS = 50`) : on ne purge donc PAS en comparant à cette
liste (cela effacerait l'épingle d'un fil ancien), seulement sur action
explicite.

**Encart « agents » (bas de la barre latérale du chat).** Il liste les agents
appairés **non révoqués** avec un bouton **on/off**. ⚠️ Le on/off **réutilise le
niveau existant** (`D118`) : `off` ⇒ niveau `disabled` ; `on` ⇒ **niveau
précédent mémorisé** (reconstruit au rejeu du journal, donc persistant), ou
`destructive` si l'agent était **déjà** `disabled` (aligné sur le défaut
`agents.defaultLevel`). **Aucun second drapeau d'activation** (une seule source
de vérité). En rail (56 px), seule la pastille (initiale + témoin on/off) est
visible ; le nom et l'état n'apparaissent qu'à 280 px (CSS). **Propagation** :
le registre notifie ses abonnés (`AgentStore.subscribe`) et le transport
**rediffuse** une trame de contrôle `agents` (aucun `seq` consommé) à chaque
changement — **aucun polling**. La même trame est renvoyée à la connexion
(`hello`) et à la reconnexion (`resume`), ce qui couvre aussi les modifications
faites depuis `/config`.

**Menu contextuel de l'agent (clic droit).** Ajouté **après la validation**, à
la demande d'usage réel (2026-10-09) : un **clic droit sur l'entrée d'un agent**
(ou la touche `Menu contextuel` / **Maj+F10**) ouvre un menu de **réglage du
niveau de confirmation** (les **4 niveaux** `D118`, en français : *Désactivé* /
*Validation à chaque commande* / *Validation des commandes destructrices* /
*Pas de validation*). Le niveau **courant est marqué** (`role="menuitemradio"` +
`aria-checked` + ✓). ⚠️ **Cohérence d'état** : « Désactivé » EST l'« off » du
on/off, et un niveau ≠ `disabled` remet l'agent **en marche** en renseignant le
niveau mémorisé pour la bascule on/off — **un seul état**, jamais deux. Le
choix part par la trame **`agent_level`** (`src/gateway/ws/protocol.ts`) ; le
serveur applique `AgentStore.setLevel` et rediffuse `agents`. En **rail
(56 px)**, l'entrée EST la pastille : le clic droit dessus fonctionne de la même
façon. Le menu est **positionné au curseur** via le CSSOM (comme celui des
conversations) et **détaché du DOM** à la fermeture (aucun nœud résiduel, CSP).

**Suppression DÉFINITIVE d'un agent.** Les agents **révoqués** ne restent plus
mêlés aux actifs : ils sont regroupés dans une **section distincte, grisée**
(« Agents révoqués »). La révocation (`DELETE /api/agents/<id>`, réversible)
reste l'action des actifs ; la **suppression définitive**
(`POST /api/agents/<id>/remove`) retire la **fiche** de la projection
(`AgentStore.remove`). ⚠️ Il n'y a **PAS de liste de révocation** : Yuki refuse
un agent par l'**absence de sa fiche** (`authorizedAgent` exige
`store.has(agentId)`), donc retirer la fiche suffit à couper tout accès, même
avec un certificat signé par le CA interne. Le **journal d'audit n'est PAS
touché** (trace immuable). La confirmation passe par **`HolafModal`** et dit
explicitement ce qui disparaît et que l'agent devra être **ré-apparié** pour
revenir. Pour un **agent** (une simple fiche de connexion, pas du contenu), la
suppression définitive est légitime — contrairement à la mémoire, l'archive et
les conversations, qui restent **récupérables**.

## 17. Capture d'écran par l'agent (note d'implémentation)

> **Note d'implémentation — hors décisions de conception.** Ajoutée **après la
> validation**, à la demande d'usage réel (2026-10-09). Elle **ne modifie aucune
> décision** `D109`–`D128`.

**Le trou n'était PAS la capture** (`run_command` peut déjà lancer
`scrot`/`grim`/PowerShell) **mais le RETOUR** : le seul canal était
`stdout`/`stderr`, plafonné à 256 Kio/flux et rendu en **texte**. On ajoute donc
un **canal d'image dédié**.

**Agent (Go).**
- Paquet `internal/screen` : `Detect(goos, getenv, lookPath)` déclare la
  capacité **seulement** si un **écran** (`DISPLAY`/`WAYLAND_DISPLAY` non vides
  sous Linux/macOS ; `SESSIONNAME` sous Windows) **ET** un **outil** de capture
  (`LookPath`) sont présents. Outils : X11 `scrot`, `import`,
  `gnome-screenshot`, `spectacle` ; Wayland `grim`, `spectacle` (préférés quand
  `WAYLAND_DISPLAY` est posé) ; Windows `powershell`. Aucun écran ⇒ **capacité
  absente** (aucune déclaration à tort).
- Capture → décodage → **redimensionnement** (côté long ≤ 1600 px, box filter) →
  **JPEG** qualité 70 → **cible** ≤ 150 Kio binaire, **plafond DUR** de 256 Kio
  en base64 (`ErrTooLarge` sinon). Les outils sans sortie standard reçoivent un
  fichier **temporaire** supprimé aussitôt ; rien ne persiste.
- Protocole (`internal/proto`) : nouvelle trame `screenshot` (Yuki → agent) et
  `screenshot_data` (agent → Yuki, base64). `caps` du `hello` porte
  `screenshot` **uniquement** si la détection réussit. Erreurs : `unsupported`
  (pas d'écran/outil) et `too_large` (image trop lourde).

**Yuki (TS).**
- **Correctif du bug `caps`** : la capacité annoncée est désormais propagée
  jusqu'au **modèle** — `AgentHub.caps`/`hasCapability` → `AgentSummary.caps` →
  `frameAgentDirectory`/`frameAgentStatus` (bloc `<agents_disponibles>`).
  Le modèle sait donc ce que chaque machine **sait faire**.
- Service : `AgentExecutionService.capture()` applique **le MÊME garde-fou par
  agent** (`authorize`) que `run_command` : `disabled` refuse, niveau 2
  (`always`) demande une validation, niveau 3 (`destructive`) laisse passer
  **sans validation** (une capture n'est **jamais** classée destructrice).
  Aucun second mécanisme de validation : le registre d'approbations existant est
  réutilisé (commande synthétique `capture d'écran`, origine `capturer_ecran`).
  Capacité absente ⇒ **refus honnête** (« cette machine n'a pas d'affichage ou
  d'outil de capture »).
- Outil `capturer_ecran` (nom français, désignation par nom **ou** identifiant) :
  il ne renvoie au modèle que des **MÉTADONNÉES** (dimensions, taille) —
  **jamais** le blob (anti-exfiltration).
- Affichage : la capture est diffusée par une **trame de contrôle**
  `screenshot` (`sendDirect`, via `subscribeScreenshots`), **routée vers la
  seule conversation** demanderesse. Elle ne consomme aucun `seq`, n'est jamais
  bufferisée ⇒ **ni transcript, ni snapshot, ni rejeu, ni mémoire**. Le client
  la rend en `<img class="md-image">` (`data:image/jpeg;base64,…`), via
  `isSafeImageSrc` — **aucun élargissement de CSP** (`img-src 'self' data:`
  suffit).
- Audit : entrées d'événement `screenshot` (statuts `captured`/`unsupported`/
  `refused`/`offline`/`too_large`/`failed`) **sans contenu d'image**.
