# Lot 8 — Assistant de mise en route du TTS (interface) + documentation

> **Spécification du Lot 8 : rendre le TTS de Yuki testable ENTIÈREMENT depuis
> l'interface, sans terminal.** Ce document **complète**
> [`docs/lot7.md`](lot7.md) (spécification de référence du TTS) et
> [`docs/runbook.md`](runbook.md). Il **ne refait pas** le Lot 7 : il ajoute une
> couche de **diagnostic côté gateway** (livrée juste avant ce lot) et un
> **assistant cliquable** dans la page `/config`.
>
> **Date.** 2026-09-20. Écrit après livraison de la couche de diagnostic
> (`GET /api/tts/status`, `GET /api/tts/models`, `POST /api/tts/test`,
> `subsystems.tts` dans `/health`) et du composant
> `public/ui/tts-assistant.js`.
>
> **Style.** Sections numérotées ; tableaux de décisions **« Acté »** (`D##`) et
> **« À confirmer »** (`C##`) ; chaque affirmation est adossée à une preuve
> `fichier:ligne` ou explicitement marquée **non attestée**.

## Contexte

Le **Lot 7** (TTS / barge-in) est livré et commité (`edefdb2`) : pipeline de
segmentation + prefetch, transport WebSocket en trames binaires, lecture Web
Audio, registre de voix avec clonage par upload, réglages `tts.*`. Le **Lot C**
a ajouté le panneau des voix et le contrôle de sourdine de la topbar
(`public/ui/voices-panel.js`, `public/ui/tts-preference.js`).

Cependant, **faire fonctionner la voix demandait un terminal** : démarrer un
service Compose opt-in, déposer un modèle, redémarrer, deviner l'état du moteur.
Le gateway **ne savait pas dire** si le moteur `tts` était joignable, prêt, ou en
erreur. Ce lot comble ce trou **sans** élargir les privilèges du gateway.

**Constat de départ, et ce qui a changé :**

| Élément | Avant | Après (ce lot + la couche livrée) |
| --- | --- | --- |
| État du moteur | invisible | `GET /api/tts/status` + `subsystems.tts` dans `/health` |
| Liste des modèles | invisible | `GET /api/tts/models` |
| Test de synthèse | seulement `preview` par voix du registre | `POST /api/tts/test` (texte libre) |
| Parcours de mise en route | terminal + lecture du code | assistant cliquable dans l'onglet **Voix** |

**Décisions utilisateur intégrées** : le TTS doit être testable **sans
terminal** ; tout ce qui est faisable depuis l'UI doit l'être ; les actions
impossibles doivent être **documentées honnêtement** dans l'assistant.

---

## 1. Objet et périmètre

### Ce que fait le Lot 8

1. **Carte d'état honnête** alimentée par `GET /api/tts/status`, avec un libellé
   et un badge par état (`off`, `unreachable`, `starting`, `ready`, `error`).
2. **Présence du modèle sur le disque** (volume `yuki-models`, monté `ro`) avec
   nom(s) et taille(s), et le chemin de dépôt.
3. **Liste des modèles du moteur** (`GET /api/tts/models`), repliable, avec
   avertissement si le moteur configuré n'y figure pas.
4. **Test français** : texte libre (≤ 500 caractères, phrase par défaut en
   placeholder) → WAV lu **par Web Audio**, avec la **voix** et le **moteur**
   réellement utilisés (en-têtes de réponse).
5. **Activer la voix** : `PUT /api/config { tts.enabled: "on" }` + redémarrage
   (le champ est en `apply: restart`), avec confirmation.
6. **Bloc « Ce qui reste à faire à la main »** : les **2** actions hors UI,
   expliquées avec commandes et chemins exacts.
7. **Messages d'erreur lisibles** (moteur absent, pas de GPU, aucun modèle,
   503 occupé/mémoire, 504, 502), chacun avec **Réessayer**.

### Hors périmètre

- Démarrer un conteneur depuis l'UI (exigerait le socket Docker — **refusé**).
- Déposer un fichier dans un volume Docker depuis l'UI (volume `ro`).
- Générer des voix prédéfinies (§8).
- Vérifier en réel le **son** (timbre, langue) — non vérifiable ici.

---

## 2. Constat factuel (preuves)

### 2.1 Le gateway n'a aucun accès Docker

**Fait.** Le service `gateway` ne monte **pas** `/var/run/docker.sock` : ses
volumes sont `yuki-pi`, `yuki-workspace`, `yuki-models`, `yuki-state`,
`yuki-voices` (`docker-compose.yml:82-100`). Aucun client Docker n'est déclaré
dans les dépendances (`package.json:29-33` : `@earendil-works/pi-coding-agent`,
`typebox`, `ws`). Le seul « redémarrage » possible est **interne** :

```
src/index.ts:463-477   # POST /api/admin/restart → triggerShutdown(RESTART_REASON)
docker-compose.yml:82-100  # aucun bind du socket Docker
```

**Conséquence.** L'UI ne peut ni démarrer, ni arrêter, ni recréer un conteneur.
Le service `tts` n'est **pas** démarré par un `docker compose up -d` nu **dans
la variante du dépôt racine** : `docker-compose.yml:169` déclare encore
`profiles: ["tts"]` (`container_name: yuki-tts`, `:168`). En revanche, la
variante **serveur** `deploy/server/docker-compose.yml` a **retiré** ce profil
(commentaires `:145-152`) : le moteur y démarre **avec la stack**. La cause
« profil Compose non activé » n'est donc **exacte que pour la variante racine**,
et **fausse** pour la variante serveur — d'où son retrait des messages de
l'assistant (§3.5) : le message ne doit pas envoyer l'utilisateur sur une fausse
piste.

### 2.2 `/health` n'avait pas d'état TTS

**Avant ce lot.** `/health` exposait GPU, profil, volumes, PiHost, transport,
LLM, jobs — **pas** le TTS. **Après.** `subsystems.tts` existe et reste
**informatif** : `/health/ready` n'en dépend **jamais** (le TTS n'est pas requis
pour converser).

```
src/gateway/routes/health.ts:58-62   # TtsSubsystemSnapshot { status, modelCount, engine }
src/index.ts:446-452                 # tts: ttsDiagnostics.cachedStatus() (jamais bloquant)
```

### 2.3 L'aperçu `preview` existait déjà

`POST /api/voices/{id}/preview` permettait de synthétiser **avec une voix du
registre** (`src/gateway/routes/voices.ts:267`, `:299`). Il ne permettait **pas**
de tester un **texte libre** ni d'afficher la voix/le moteur réellement
utilisés : c'est le rôle du nouveau `POST /api/tts/test`
(`src/gateway/routes/tts.ts:673`).

### 2.4 Le modèle est dans un volume monté en lecture seule

`/models` (volume `yuki-models`) est `read_only: true` **côté gateway**
(`docker-compose.yml:91-93`) **et** côté service `tts`
(`docker-compose.yml:171-173`). L'**installateur natif** du moteur ne peut donc
pas écrire dedans. Le gateway ne fait que **lire** le répertoire pour dire à
l'utilisateur où déposer un fichier (`src/gateway/routes/tts.ts:551`,
`inspectModelsDir`).

### 2.5 Le registre est vide au départ

**Fait.** Aucun preset « factory » n'est livré : le dépôt ne contient ni
`voices.json`, ni `presets/*.wav` initial. Le registre est créé vide au premier
usage. Donc :

```
src/tts/voices-store.ts:186-188   # defaultVoice(): premier preset, sinon null
src/tts/voices-store.ts:189-206   # resolveVoice(): repli sur defaultVoice()
src/tts/audio-cpp.ts:15           # clé de CONFIG attestée : default_voice_preset
```

**Conséquence honnête.** Tant qu'aucune voix n'est clonée, `tts.voice` reste
vide, la résolution renvoie `null`, et le client n'envoie **aucun** `voice_ref`.
Le moteur applique alors **son propre `default_voice_preset`** (dont
l'existence et la valeur ne sont **pas attestées**). L'UI affiche pour cela
`x-yuki-tts-voice: default` (`src/gateway/routes/tts.ts:712-713`). C'est
précisément parce que Chatterbox est un moteur de **clonage** que le parcours
recommandé passe par le **clonage par upload** (§6, §8).

### 2.6 La forme de `/health` était une HYPOTHÈSE — démentie par l'exécution

**Fait (exécution réelle, 2026-09-21).** L'assistant a affiché, moteur
**joignable**, avec un faux état d'erreur :

```
état : error   /   joignable : oui   /   moteur : chatterbox   /   latence : 3 ms
erreur : Réponse /health sans champ booléen `ready`.
Modèles du moteur (1) : chatterbox — tts
Modèle de voix sur le disque : 1 fichier (/models) — chatterbox-q8_0.gguf
```

Autrement dit : le moteur **répond**, `GET /v1/models` liste bien
`chatterbox — tts`, le GGUF est sur le disque. Le **seul** défaut était **notre
sonde**, qui exigeait un champ booléen `ready`. Or la forme
`{ ready, model_count }` provenait d'une **archive documentaire**
(`audio-cpp-http-server`), **pas d'un test réel** : c'était une **hypothèse**.

**Conséquence.** La forme exacte de `GET /health` est **INCONNUE** et **en
attente de relevé** : la présenter comme le contrat serait une **affirmation non
prouvée**. La sonde est désormais **TOLÉRANTE** — elle ne déclare **jamais**
« erreur » sur un champ **absent ou incompris** —, **conserve le corps brut
borné** dans les détails techniques, et **journalise une fois** par forme
(`tts.health.shape`) les clés observées, pour **figer la forme** dès que le
relevé réel sera disponible. La règle « aucun `prêt` sans preuve » reste
valable, **son inverse aussi** : on ne déclare pas « erreur » sur un champ qu'on
ne comprend pas. Cf. **C25**.

---

## 3. Design retenu

### 3.1 Un composant UI autonome, monté par `id`

L'assistant est un module ES isolé, **jamais dupliqué** :

```
public/ui/tts-assistant.js:444   # initTtsAssistant(root, deps)
public/ui/tts-assistant.js:445   # root = élément OU id
public/ui/config.js:892-900      # montage dans l'onglet Voix (UNE ligne d'emplacement)
public/ui/config.html:142        # <div id="tts-assistant-root"></div>
public/ui/config.html:12         # <link rel="stylesheet" href="/ui/tts-assistant.css">
```

Déplacer l'assistant ne tient donc qu'à **une** ligne
(`public/ui/config.js:892`). Le conteneur est placé dans `#panel-voix`
**au-dessus** de `#voices-root`, ce qui **ne casse** ni les onglets, ni les ids
existants (`config.html:136-144`).

`initTtsAssistant` reçoit ses dépendances injectées (briques `HolafFetch` /
`HolafModal`, lecteur Web Audio, callbacks de redémarrage/onglet) — la partie
**mapping** est ainsi testable sans DOM (`tests/tts/ui-assistant.test.ts`), même
patron que `tests/tts/ui-audio.test.ts`.

### 3.2 Diagnostic : uniquement via les routes du gateway

**Aucun nouveau chemin d'accès au moteur.** L'UI n'appelle que :

| Route | Rôle | Garde-fou |
| --- | --- | --- |
| `GET /api/tts/status` | sonde `/health` + diagnostic disque | lecture seule, toujours 200 |
| `GET /api/tts/models` | proxy `/v1/models` | lecture seule, toujours 200 |
| `POST /api/tts/test` | synthèse d'un texte libre (WAV) | `X-Yuki-Config: 1` + même origine |
| `PUT /api/config` | `tts.enabled = "on"` | `X-Yuki-Config: 1` + même origine |
| `POST /api/admin/restart` | redémarrage interne | `X-Yuki-Config: 1` + même origine |

Preuves : `src/gateway/routes/tts.ts:602` (`status`), `:607` (`models`),
`:673` (`test`), `:721-747` (routeur) ; `requireWriteGuards`
(`src/gateway/routes/config.ts:117`). Le test E2E vérifie que
`tts-assistant.js` ne contient **ni** `8081`, **ni** `docker.sock`
(`tests/integration/static-ui.test.ts:364-376`).

### 3.3 Parcours cliquable de bout en bout

```text
/config → onglet « Voix »
   ├─ carte d'état (GET /api/tts/status)
   │    ├─ Désactivé      → [Activer la voix]  (PUT config + redémarrage)
   │    ├─ Non démarré    → action manuelle n°1 (voir §5)
   │    ├─ Démarrage      → relance discrète auto (3 s, bornée)
   │    ├─ Prêt           → modèle disque + liste moteur
   │    └─ Erreur         → détails techniques repliables + [Réessayer]
   ├─ Modèle de voix sur le disque (status.modelsDir, ro)
   ├─ Modèles du moteur (GET /api/tts/models, repliable)
   ├─ Tester la voix (texte libre → POST /api/tts/test → Web Audio)
   └─ Ce qui reste à faire à la main (les 2 actions, §5)
```

### 3.4 Mapping état → libellé (pur, testé)

`describeTtsState()` (`public/ui/tts-assistant.js:89`) est la **source unique**
des libellés. Elle **n'invente jamais** un état : sans rapport, elle retombe sur
« État inconnu ».

| `state` | Libellé | Badge | Action principale |
| --- | --- | --- | --- |
| `off` | Désactivé | neutre | Activer la voix |
| `unreachable` | Non démarré | accent | Réessayer + action manuelle n°1 (sinon **logs** du conteneur `tts`) |
| `starting` | Démarrage en cours | accent | relance auto discrète |
| `ready` | Prêt | OK | — (« Moteur prêt (N modèles) ») |
| `error` | Erreur | danger | Réessayer + détails techniques |
| *(absence)* | État inconnu | neutre | Réessayer |

Preuves : `public/ui/tts-assistant.js:89-186` ; tests
`tests/tts/ui-assistant.test.ts:51-120`.

**Règle de décision d'état (implémentée).** Elle est **tolérante à la forme**
de `/health` et ne produit **jamais** de faux « erreur ». `probe.ready` vaut
`true`/`false` quand la préparation est **explicite**, `null` quand elle est
**indéterminable** (`src/gateway/routes/tts.ts`, `deriveTtsState`).

| Condition (dans l'ordre) | État | Nature de la preuve |
| --- | --- | --- |
| `tts.enabled !== "on"` | `off` | config |
| moteur injoignable | `unreachable` | sonde (échec réseau/timeout) |
| HTTP ≠ 2xx, ou champ d'erreur explicite (`error`, `status:"failed"`) | `error` | **prouvé** |
| préparation explicitement négative (`ready:false`, `"starting"`, `"loading"`, `0`) | `starting` | prouvé |
| aucun modèle lisible (`0` dans `/health` **ou** `/v1/models`) | `error` | prouvé (aucun modèle) |
| préparation explicitement positive (`ready:true`, `"ok"`, `"ready"`, `1`) | `ready` | **prouvé** |
| préparation indéterminable **mais** modèles listés (> 0) | `ready` | **DÉDUIT** (`readinessInferred`, note dans les détails) |
| joignable mais tout est indéterminé | `starting` | ni prouvé ni déduit → jamais « erreur » |

Les variantes suivantes sont lues **sans être présumées** : `ready` booléen,
chaîne (`"true"`/`"false"`/`"ready"`/`"ok"`/`"starting"`/`"loading"`), nombre
(`1`/`0`) ; le compte de modèles via `model_count`, `modelCount`, `models_total`,
`models_loaded`, `loaded_models`, `models` (tableau **ou** nombre), `count`.
Absent, `null`, vide, non-JSON ou HTML ⇒ **indéterminé** (jamais une erreur).
Preuves : `tests/integration/tts-diagnostics.test.ts` (« sonde /health tolérante
(formes variées) »).

### 3.5 Messages d'erreur

`describeTestError()` (`public/ui/tts-assistant.js:214`) mappe le corps d'erreur
du test vers : **message + que faire + détail technique + Réessayer**.

| Cas | Message clé |
| --- | --- |
| moteur absent (`tts_unavailable`) | « Le moteur TTS n'est pas disponible côté gateway. » |
| pas de GPU / injoignable (`unreachable`) | causes **possibles, actionnables** : conteneur non démarré (action hôte), conteneur démarré mais **échoué** (voir **logs** : `docker compose logs tts`), **GPU non réservé** (§3.4) |
| aucun modèle installé (`modelsDir.fileCount = 0`) | « Aucun modèle de voix n'est installé. » + chemin + action **hors Yuki** |
| `503 server_busy` | « occupé **OU** manque de mémoire » (jamais tranché) |
| `504 timeout` | « n'a pas répondu dans le délai imparti (tts.timeoutMs). » |
| `502` / `http_error` / `synthesis_failed` | « Le moteur a renvoyé une erreur. » + corps brut |
| `400 text_too_long` | « 500 caractères maximum. » |
| réseau (statut 0) | « La requête n'a pas abouti. » |

Preuves : `public/ui/tts-assistant.js:214-300` ; tests
`tests/tts/ui-assistant.test.ts:144-187`.

---

## 4. Les 2 actions hors interface (et options écartées)

### 4.1 Démarrer le conteneur `tts`

- **Pourquoi hors UI** : le gateway n'a **aucun** accès Docker (§2.1).
- **Action hôte** : `docker compose up -d` (variante **serveur**,
  `deploy/server/docker-compose.yml`, où le service démarre avec la stack) ou
  `docker compose --profile tts up -d` (variante **racine**, où le profil `tts`
  subsiste — `docker-compose.yml:169`). GPU NVIDIA disponible.
- **En cas d'échec** : si le conteneur tourne mais que le moteur ne répond pas,
  lire ses **logs** (`docker compose logs tts`) — commande de démarrage
  invalide, fichier de configuration introuvable ou modèle absent y figurent.

**Options écartées.**

| Option | Verdict | Raison |
| --- | --- | --- |
| Monter `/var/run/docker.sock` dans le gateway | ❌ **refusé** | élévation de privilège majeure : le socket donne un contrôle root sur l'hôte |
| API Docker distante / `DOCKER_HOST` | ❌ | même surface d'attaque, non demandée |
| Piloter Compose depuis le gateway | ❌ | exige Docker + socket |

### 4.2 Déposer le fichier de modèle

- **Pourquoi hors UI** : `yuki-models` est monté `read_only` côté gateway
  (`docker-compose.yml:93`) ; l'installateur natif du moteur exige un flag de
  build **non confirmé** (hérite de `C14`/`C12` du Lot 7).
- **Action hôte** :

  ```bash
  docker run --rm -v yuki-models:/models -v "$PWD":/src alpine \
    cp /src/mon-modele.gguf /models/
  ```

  (ou déposer via un `docker cp` / un chemin bind selon le déploiement).

- **À ne pas confondre** : le **modèle** va dans `yuki-models` (ro) ; les
  **voix** vont dans `yuki-voices` (rw, gérables depuis l'UI).

> **Exactement 2 actions manuelles restent**, et ce sont celles établies par
> l'étude de conception. Aucune autre.

---

## 5. Runbook utilisateur — parcours interface

> **L'ancien runbook supposait un terminal.** Voici le parcours réécrit : ce qui
> se fait **une fois à la main**, puis **chaque clic** dans l'interface.

### 5.1 Une seule fois, à la main (les 2 actions du §4)

1. **Démarrer le moteur** (sur l'hôte) : `docker compose up -d` (variante
   serveur) ou `docker compose --profile tts up -d` (variante du dépôt racine,
   §4.1). En cas d'échec, lire ses **logs** (`docker compose logs tts`).
2. **Déposer le modèle** : copier le GGUF attendu dans le volume `yuki-models`
   (voir commande §4.2).

Tant que ces deux actions ne sont pas faites, l'assistant le **dira** (sans
échouer) et guidera — il est utilisable même TTS désactivé.

### 5.2 Chaque clic dans l'interface

1. Ouvrir **`/config`**, onglet **« Voix »** : l'**Assistant de mise en route de
   la voix** est en haut du panneau.
2. Lire la **carte d'état**.
   - **Désactivé** → cliquer **« Activer la voix »**, confirmer (« Yuki
     redémarre en interne ; le conteneur reste en place. »). Yuki redémarre et
     la page se recharge.
   - **Non démarré** → faire l'action manuelle n°1, puis **« Vérifier le
     moteur »**.
3. Vérifier **« Modèle de voix sur le disque »** : si « Aucun modèle… », faire
   l'action manuelle n°2.
4. Cliquer **« Vérifier le moteur »** jusqu'à obtenir le badge **« Prêt »**.
   (En état « Démarrage en cours », l'assistant relance **tout seul**, sans
   polling agressif.)
5. Déplier **« Modèles du moteur »** : vérifier que le moteur configuré
   (`chatterbox`) apparaît. Sinon, un avertissement s'affiche.
6. Dans **« Tester la voix »**, saisir un texte français (ou laisser vide pour la
   phrase par défaut), puis cliquer **« Tester la voix »**.
7. Écouter. L'assistant affiche la **voix réellement utilisée** et le **moteur**.

### 5.3 Comment savoir si ça marche

- **Ce qu'on doit voir** : badge **« Prêt »** + « Moteur prêt (N modèles) » ;
  le nom du modèle GGUF et sa taille ; le moteur listé ; après le test, la ligne
  « Échantillon reçu — voix réellement utilisée : … , moteur : … ».
- **Ce qu'on doit entendre** : une voix française dire le texte. ⚠️ Voir §7 :
  le test prouve que **la chaîne fonctionne**, **pas** que la voix/langue est
  correcte.
- **Clic** « Tester la voix » = **geste utilisateur** : c'est le bon endroit pour
  `resume()` du contexte audio (politique d'autoplay) ; `<audio src>` est
  **interdit** par la CSP, la lecture passe par Web Audio
  (`public/ui/tts-player.js`).

### 5.4 Dépannage

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| Badge « Non démarré » | conteneur `tts` non démarré, **ou** démarré mais échoué | action manuelle n°1 ; s'il tourne, lire **`docker compose logs tts`**, puis « Vérifier le moteur » |
| Badge « Erreur », corps `503` | occupé **ou** mémoire GPU insuffisante | attendre et « Réessayer » ; sinon libérer de la mémoire GPU |
| « Aucun modèle de voix n'est installé » | volume `yuki-models` vide | action manuelle n°2 |
| Test → `504` | modèle en cours de chargement / moteur bloqué | attendre « Prêt » puis « Réessayer » |
| Test → `502` | erreur moteur | lire le **corps brut** repliable |
| Le moteur `chatterbox` absent de la liste | modèle non chargé | vérifier le GGUF déposé et les logs du conteneur `tts` |
| Voix par défaut « générique » | registre vide (aucune voix clonée) | cloner une voix par upload (§6) |
| Conversation indisponible (bannière) | clé LLM légère manquante | onglet **Modèles** : saisir la clé |

> Le dépannage **GPU** (`nvidia-smi`, driver, `full-cuda13`/`cuda12`) reste décrit
> dans [`docs/runbook.md`](runbook.md) et le Lot 7 §11.

### 5.5 (Optionnel) Créer une voix puis l'utiliser

1. Dans **« Voix »** (sous l'assistant), cliquer **« Cloner une voix »**.
2. Choisir un **WAV PCM** (≤ 10 s, ≤ 3 Mo), saisir un libellé, créer.
3. Cliquer **« Utiliser »** pour la rendre active (`tts.voice`, à chaud).
4. Relancer **« Tester la voix »** : la voix utilisée affichée doit être son id.

---

## 6. Avertissement : le test prouve la chaîne, pas la voix

**À lire avant toute conclusion.**

- `POST /api/tts/test` prouve que **la chaîne** (gateway → moteur → WAV → Web
  Audio) **fonctionne**. Il **ne prouve pas** que la **voix** ou la **langue**
  est correcte.
- Le **contrat HTTP réel d'`audio.cpp`** (clé de sélection de voix, clé de
  langue, exposition d'`exaggeration`/`cfg`) reste **non attesté** :
  `src/tts/audio-cpp.ts:1-35` le documente point par point (`AUDIO_CPP_KEYS`,
  `attested: false`). Les archives décrivent la **config** et la **lib Python**,
  pas les **clés de requête** (Lot 7 `C1`/`C17`).
- **Si le moteur ignore les clés** (voix, langue, émotion), l'aperçu « sonne »
  quand même — avec la **voix par défaut** du moteur — **sans que l'UI puisse le
  détecter**. La seule vérification possible est **humaine** : écouter.

Preuves : `src/tts/audio-cpp.ts:8-34` ; `docs/lot7.md` §10.2, `C1`, `C17`.

---

## 7. Option C — voix prédéfinies générées : écartée en v1

**Objectif initial** : générer des voix prédéfinies (presets) à partir de
descriptions, sans clonage.

**Pourquoi ce n'est pas réalisable proprement en v1 :**

1. **Co-résidence de modèles** : générer puis servir plusieurs voix exige que le
   service `tts` **charge plusieurs modèles simultanément** — ce que le contrat
   attesté ne décrit pas.
2. **Config `models[]` non attestée** : la forme d'une liste de modèles côté
   `audio.cpp` n'est pas documentée dans les archives.
3. **Contrat de sélection de voix** : la clé de choix d'une voix par requête
   reste **non attestée** (`src/tts/audio-cpp.ts`).

**Chemin praticable aujourd'hui** : le **clonage par upload**, déjà livré
(§5.5, Lot 7 §10). C'est ce que recommande l'assistant.

**Suite envisageable (après vérification en réel)** : un générateur
`qwen3_tts` **« voice design »**, dont la licence **Apache-2.0** est **attestée
côté modèle** (plan B du Lot 7 §2.6/§12). À n'envisager qu'**après** avoir levé
`C18`/`C19` ci-dessous.

### Sources de voix permissives — enquête du 2026-09-21 (sourcée)

Question posée : « le projet `audio.cpp` fournit-il un échantillon audio de
référence utilisable ? ». Réponse **factuelle** :

- **Oui, `audio.cpp` fournit des WAV de référence**, sous la **licence du dépôt
  — Apache-2.0** (`LICENSE` : « Copyright 2026 ShugoAI LLC — Licensed under the
  Apache License, Version 2.0 »), et ils sont **utilisés dans les exemples
  officiels de clonage Chatterbox** (`docs/tts.md` :
  `--voice-ref assets/resources/b.wav` ; `README.md:638` :
  `--voice-ref assets/resources/sample.wav`). Liste exacte (API GitHub Trees,
  dépôt `0xShug0/audio.cpp`, branche `main`) :
  - `assets/resources/b.wav` **=** `assets/resources/sample.wav` — **mono
    24 kHz, 16 bits PCM, 14,07 s, 675 496 o**, **anglais** ;
  - `assets/resources/a.wav` — mono 24 kHz PCM, 5,95 s, 285 644 o (source VC) ;
  - `assets/resources/c.wav` — stéréo 24 kHz PCM, 7,53 s ;
  - `webui/native/demo_voices/demo_1_man.wav` — stéréo 48 kHz PCM, 4,71 s
    (**anglais**) ; `demo_2_man` (7,62 s), `demo_3_woman` (9,88 s),
    `demo_4_woman` (4,78 s) — **chinois** ; transcrits dans
    `webui/native/demo_voices/prompt_text`.
- **Aucun WAV français** n'existe dans `audio.cpp`, ni dans le dépôt amont
  `resemble-ai/chatterbox` (**MIT**, arbre `main` sans `.wav`), ni dans le dépôt
  HF `ResembleAI/chatterbox` (aucun fichier audio). Les `demo_voices` sont
  **EN/ZH**.
- **Chatterbox n'expose aucune voix par défaut** : `audio.cpp` documente
  « Built-in voices: Not exposed by this integration » et exige un `--voice-ref`
  (`docs/tts.md`, section Chatterbox). C'est la cause exacte du message
  `Chatterbox prepare requires speaker reference audio` (cf. **D36**).
- **Paquets GGUF** : le dossier `Chatterbox-GGUF` du dépôt
  `audio-cpp/audio.cpp-gguf` **ne contient que deux GGUF, aucun WAV** (API HF
  `…/tree/main/Chatterbox-GGUF`).

**Sources françaises sous licence permissive** (matière première d'un preset
livrable) :

| Source | Licence | Format | Remarque |
| --- | --- | --- | --- |
| Common Voice (p. ex. `fixie-ai/common_voice_17_0`, config `fr`) | **CC0-1.0** | MP3 → WAV (`ffmpeg`) | voix humaines réelles, redistribution libre |
| VoxPopuli (`facebook/voxpopuli`, config `fr`) | **CC0-1.0** (carte : « The dataset is distributed under CC0 license ») | parquet | discours du Parlement européen |
| FLEURS (`google/fleurs`, config `fr_fr`) | **CC-BY-4.0** | WAV 16 kHz, mais URLs **signées/expirantes** | attribution requise ; clips parfois > 10 s |
| **SIWIS** (miroir HF `Aviv-anthonnyolime/SIWIS_French_Speech_Synthesis_Database`) | **CC-BY-4.0** | **WAV 44,1 kHz PCM — direct** | **✅ source retenue (D38)** ; voix **humaine**, attribution requise ; **aucune conversion** (`ffmpeg` inutile) |
| Piper `fr_FR-gilles-low` (sample) | dataset **CC0** | MP3 (**synthétique**) | timbre du modèle Piper, pas d'une voix humaine |
| Piper `fr_FR-mls-medium` / `fr_FR-siwis-medium` (samples) | dataset **CC-BY-4.0** | MP3 (**synthétique**) | idem |

> ⚠️ **Provenance des WAV `audio.cpp`** : le dépôt est Apache-2.0 dans son
> ensemble, mais **aucune attribution séparée** n'est fournie pour
> `assets/resources/*.wav` ni `webui/native/demo_voices/*.wav` (contrairement
> aux fixtures LibriSpeech, explicitement créditées CC-BY-4.0). La
> **redistribution** de ces voix précises reste donc **à confirmer** auprès de
> l'amont — les sources **CC0** ci-dessus sont, elles, sans réserve.
>
> ⚠️ **Langue de la référence** : « Ensure that the reference clip matches the
> specified language tag. Otherwise, language transfer outputs may inherit the
> accent of the reference clip's language. » (carte `ResembleAI/chatterbox`).
> Une référence **anglaise** fait donc « parler français avec un accent ».

**Ce qu'il resterait à faire pour en faire un preset Yuki** (non implémenté) :
1. déposer le WAV converti en `presets/<id>.wav` dans le volume voix ;
2. ajouter une entrée `kind: "preset"`, `createdBy: "factory"` dans
   `voices.json` — le registre est lu **exclusivement** depuis ce fichier, un
   WAV seul est invisible (`src/tts/voices-store.ts:1-13,183-206`) ;
3. (optionnel) une route d'amorçage, ou livrer fichier + registre à
   l'installation.

---

## 8. Configuration UI et CSP

- **Onglet Voix** : les champs `tts.*` restent gérés par le formulaire existant
  (`public/ui/config.js`, groupe `tts`). L'assistant **n'invente** pas de champs.
- **`tts.enabled`** est en `apply: "restart"` (`src/config/schema.ts:217-218`) :
  d'où le parcours « Activer puis redémarrer » avec confirmation HolafModal.
- **CSP stricte** : tout le CSS de l'assistant vit dans
  `public/ui/tts-assistant.css` (chargé par `<link>`), **aucun** `<style>`,
  **aucun** `style=`, **aucun** script inline. Preuve :
  `public/ui/config.html:12` ; test E2E « zéro `<style>` / attribut style ».
- **Thème** : uniquement les variables existantes (`--panel`, `--panel-2`,
  `--border`, `--text`, `--muted`, `--accent`, `--danger`, `--ok`) ; ton
  « attention » = `--accent`, « erreur » = `--danger`, « prêt » = `--ok`.
  Vérifié en 2 familles × 2 modes (captures §9).
- **Accessibilité** : `aria-label` sur chaque contrôle, retours dans
  `role="status"`/`aria-live="polite"`, focus visible, navigation clavier.

---

## 9. Vérification

**Méthode** : tests unitaires (mapping pur), test d'intégration statique,
E2E Chromium headless avec la **CSP réelle**, captures. Aucun moteur réel requis.

### Tests unitaires

`tests/tts/ui-assistant.test.ts` (35 tests) : bornes du texte, mapping des 5
états + inconnu, mapping des erreurs (dont le `503` ambigu), diagnostic disque et
moteur, format des tailles, **déduction honnête de « prêt »** et
**disponibilité du bouton de test** (`isTestAvailable`) quand la préparation est
indéterminée.

### Tests d'intégration

`tests/integration/static-ui.test.ts` — bloc « Assistant de mise en route du TTS
(Lot 8) » (`:334`) : assets servis, conteneur de montage, lien CSS, absence de
style inline, routeur du gateway uniquement, pas de `window.confirm`/`innerHTML`.

`tests/integration/tts-diagnostics.test.ts` — bloc
« sonde /health tolérante (formes variées) » : `ready` booléen vrai/faux, en
chaîne, en nombre, absent ; `model_count` absent ou via clés variées ; réponse
non-JSON, vide, HTML ; `/health` en 500 ; `/v1/models` vide alors que `/health`
est OK ; `/health` OK sans modèles ; champ d'erreur explicite. **Aucun cas ne
lève ni ne produit de faux « erreur »**, et `GET /api/tts/status` reste **200**.

### E2E headless

`_tools/e2e-tts-ui.mjs` (+ `_tools/e2e-tts-serve.ts`), **hors du dossier du
dépôt mais suivis par git**. Le moteur est **simulé** via un fichier d'état
(`_tools/e2e-tts-serve.ts:134`, `:155`), ce qui exerce les **5 états** de la
carte **et** un 6ᵉ cas « `/health` **sans** champ `ready` » (forme réelle
observée). Le parcours assistant (`_tools/e2e-tts-ui.mjs:484`) vérifie : les
badges, le modèle disque, la liste moteur, le bloc manuel, les boutons, le test
de synthèse **jusque dans le cas sans `ready`**, le refus > 500 caractères, la
confirmation d'activation (annulée), et **0 violation CSP**.

### Chiffres réels

| Mesure | Avant ce lot | Après ce lot | Après correctif (D39, §11.13) | Après correctif débit (D40, §11.14) | Après correctif émotion + UI (D42, §11.16) |
| --- | --- | --- | --- | --- | --- |
| `npm test` | **437 passed / 4 skipped** (46 fichiers) | **466 passed / 4 skipped** (46 fichiers) | **483 passed / 4 skipped** (47 fichiers) | **488 passed / 4 skipped** (47 fichiers) | **514 passed / 4 skipped** (48 fichiers) |
| E2E assistant | **37/37** vérifications OK, CSP=0 | **40/40** vérifications OK, CSP=0 | **40/40** vérifications OK, CSP=0 | **40/40** vérifications OK, CSP=0 | **42/42** vérifications OK, CSP=0 |
| `npm run typecheck` | OK | OK | OK | OK | OK |
| `npm run build` | OK | OK | OK | OK | OK |
| `node --check` (JS UI) | OK | OK | OK | OK | OK |

### Captures (thèmes variés, `_tools/shots/`)

`config-assistant-ready.png`, `config-assistant-starting.png`,
`config-assistant-error.png`, `config-assistant-unreachable.png`,
`config-assistant-off.png`, `config-assistant-test.png`,
`config-assistant-health-unknown.png`,
`config-assistant-indigo-dark.png`, `config-assistant-emerald-light.png`.

### Non vérifiable ici (à faire en réel, avec GPU + Docker)

- Le **son** (timbre, qualité du français), le **contrat HTTP** d'`audio.cpp`
  (clés voix/langue/émotion), le `default_voice_preset` du moteur, le CLI/port
  exact du service, la latence réelle.

---

## 10. Décidé / À confirmer

### Acté

| # | Décision | Preuve |
| --- | --- | --- |
| **D26** | **L'assistant TTS est un composant autonome monté par `id`** (`initTtsAssistant(root, deps)`), **jamais dupliqué** ; son emplacement ne tient qu'à une ligne | `public/ui/tts-assistant.js:444`, `public/ui/config.js:892`, `public/ui/config.html:142` |
| **D27** | **Tout passe par les routes du gateway** (`/api/tts/*`, `/api/config`, `/api/admin/restart`) — **aucun** accès direct au moteur, **aucun** socket Docker | `src/gateway/routes/tts.ts:721-747`, `tests/integration/static-ui.test.ts:364-376` |
| **D28** | **Carte d'état dérivée de la sonde** ; « prêt » **seulement** sur preuve positive, et **jamais d'« erreur » sur un champ absent ou incompris** (vraie erreur seulement sur preuve : HTTP ≠ 2xx ou champ d'erreur explicite) | `src/gateway/routes/tts.ts` (`deriveTtsState`), `public/ui/tts-assistant.js:89-186` |
| **D29** | **Test par texte libre** (≤ 500 caractères, phrase par défaut en placeholder) ; lecture **Web Audio** (`<audio>` interdit) | `src/gateway/routes/tts.ts:47`, `:673`, `public/ui/tts-assistant.js:29-31` |
| **D30** | **« Activer la voix » = `PUT /api/config` (`tts.enabled=on`) + redémarrage délégué** à la logique existante de `config.js`, avec confirmation HolafModal | `src/config/schema.ts:217-218`, `public/ui/config.js:745`, `public/ui/tts-assistant.js:885` |
| **D31** | **`503` honnête : « occupé OU mémoire insuffisante »** — jamais tranché (contrat non discriminant) | `public/ui/tts-assistant.js:214-300`, `src/tts/audio-cpp.ts:24-27` |
| **D32** | **Les 2 actions hors UI sont documentées dans l'assistant** (démarrage conteneur, dépôt modèle) avec commandes exactes | `public/ui/tts-assistant.js:929-984` |
| **D33** | **Option C (presets générés) écartée en v1** ; le **clonage par upload** est le chemin praticable | §7, `docs/lot7.md` §10 |
| **D34** | **Le chemin `voice_ref` envoyé au moteur est ABSOLU, fondé sur le montage configuré** `YUKI_MOUNT_VOICES` (défaut `/voices`) : l'adaptateur joint `<voiceBaseDir>/<refAudio>` (`refAudio` est relatif au registre) | `src/tts/audio-cpp.ts:128-132`, `src/tts/voices-store.ts:278`, `src/index.ts:255,284-285,408`, `src/config/env.ts:152` |
| **D35** | **La sonde `/health` est TOLÉRANTE à la forme réelle (inconnue)** : lit `ready` booléen/chaîne/nombre/absent et le compte de modèles via plusieurs clés ; « prêt » peut être **DÉDUIT** des modèles listés (`readinessInferred`, noté dans les détails) ; jamais de faux « erreur » (non-JSON/vide/HTML/champ `null` ⇒ indéterminé) ; le **corps brut borné** est conservé (`status.payload`) et la **forme est journalisée une fois** (`tts.health.shape`). Le **test de synthèse reste utilisable** dès que le moteur est joignable, même préparation indéterminée (`isTestAvailable`) | `src/gateway/routes/tts.ts` (`probeTtsHealth`, `readReadiness`, `readModelCount`, `deriveTtsState`, `logHealthShape`), `public/ui/tts-assistant.js` (`isTestAvailable`, `statusTechnicalDetails`), `tests/integration/tts-diagnostics.test.ts`, `tests/tts/ui-assistant.test.ts` |
| **D36** | **`task` de Chatterbox = `clon` (pas `tts`)** : le runtime n'accepte pour cette famille que `clon`/`vc` (`loader.cpp:131-133`) ; les exemples de config du dépôt sont corrigés en conséquence (`config/audiocpp-server.json.example`, `deploy/server/audiocpp-server.json.example`). `mode: "offline"` conservé (seul mode supporté, et défaut). **Une voix de référence reste obligatoire** (`session.cpp:410-412`) : `task=clon` ne suffit pas, il faut **créer une voix** dans Yuki ou un `default_voice_preset`. | §11.11, `deploy/server/README.md` |
| **D37** | **Échantillons de référence : `audio.cpp` en fournit** (licence du dépôt **Apache-2.0**), **mais uniquement en anglais/chinois** — `assets/resources/b.wav`(= `sample.wav`), `a.wav`, `c.wav`, `webui/native/demo_voices/demo_1_man.wav` (EN) + `demo_2..4` (ZH). **Aucun WAV français** dans `audio.cpp`, `resemble-ai/chatterbox` (MIT) ni `ResembleAI/chatterbox` (HF) ; le dossier GGUF `Chatterbox-GGUF` **ne contient aucun WAV**. Chatterbox **n'expose aucune voix par défaut** (« Built-in voices: Not exposed », `docs/tts.md`) ⇒ une **référence est toujours requise**. Voies **permissives** pour une voix FR : **CC0** (Common Voice, VoxPopuli) ou **CC-BY-4.0** (FLEURS, Piper mls/siwis). Intégration en preset = `presets/<id>.wav` + entrée `voices.json` (non implémenté, décision à proposer). | §7 « Sources de voix permissives », `docs/tts.md`, README `audio.cpp:638`, API GitHub/HF |
| **D38** | **Référence française WAV « sans conversion » trouvée** : **SIWIS** (French Speech Synthesis Database, Idiap/Univ. Edinburgh, **CC-BY-4.0**) — miroir HF public (`Aviv-anthonnyolime/SIWIS_French_Speech_Synthesis_Database`). Fichier **`wavs/part1/neut_parl_s02_0343.wav`** : vérifié **HTTP 200** + en-tête lu ⇒ **RIFF/WAVE PCM (format 1), mono, 44 100 Hz, 16 bits, 5,05 s, 445 536 o** ⇒ dans **toutes** les bornes Yuki (≤ 10 s, ≤ 3 Mo, ≤ 192 kHz ; `src/tts/wav.ts`, `src/tts/voices-store.ts`) ⇒ **aucune conversion** (`ffmpeg` inutile). Voix **humaine**, **attribution CC-BY obligatoire**. Les échantillons Piper FR restent en **MP3** ⇒ conversion + **synthétiques**. Commande `curl` + bloc `voices.json` complets en **§11.12**. | §11.12, API HF, `src/tts/wav.ts` |
| **D39** | **La voix par défaut est TOUJOURS appliquée quand `tts.voice` est vide ou inconnu** : le premier preset du registre (`defaultVoice()`) est utilisé **par le pipeline, le test et l'aperçu**, via un résolveur **unique** (`VoiceStore.resolveVoice`). Le chemin d'échec (aucun `voice_ref` envoyé alors qu'un preset existe ⇒ moteur « requires speaker reference audio ») est **corrigé**. Un `refAudio` déclaré mais **absent** du volume échoue **avant** le moteur (`voice_ref_missing`, 422). Diagnostic exposé dans l'en-tête `x-yuki-tts-voice-ref` et affiché par l'assistant. | §11.13, `src/index.ts`, `src/tts/pipeline.ts`, `src/gateway/routes/tts.ts`, `src/tts/voices-store.ts` |
| **D40** | **Le débit n'est PAS appliqué par Chatterbox** : sa spec (`model_specs/chatterbox.json`) est **legacy** (ni `schema_version` ni `options`) ⇒ `model_contract()` renvoie `nullopt` ⇒ `accepts_speed=true` ⇒ le serveur range la valeur dans `options["speed"]`… que la **session Chatterbox ne lit jamais** (`make_voice_clone_config`) ⇒ **ignoré silencieusement**. « Aucun effet » est donc **attendu**. Correctif : `toAudioCppRequest` **n'émet `speed` que pour les moteurs qui l'appliquent** (`kokoro`, `sanotts`) ; il l'omet pour `chatterbox`/`qwen3-tts`/`cosyvoice3` (ces deux derniers le **rejettent** en HTTP 500). Champ de schéma inchangé. | §11.14, `src/tts/audio-cpp.ts` (`engineSupportsSpeed`), `app/server/runtime.cpp:2112-2124`, `src/models/chatterbox/session.cpp:43-76` |
| **D41** | **Le patch de `/config` est typé correctement et l'UI montre la VRAIE cause d'échec** : `buildPatch` (extrait dans `public/ui/config-patch.js`) envoie les champs `number`/`range` en **entiers** ; `save()` affiche le **code + message réels** de l'API (`presentConfigSaveError`) avec le nom du champ, au lieu d'un texte générique. Le soupçon « chaîne ⇒ 400 » est **écarté** : le schéma coerce les chaînes numériques (`validateDescriptor`), prouvé par test (`{"tts.speed":"150"}` → 200). | §11.15, `public/ui/config-patch.js`, `public/ui/config.js`, `src/config/schema.ts:370-379`, `tests/ui/config-patch.test.ts`, `tests/gateway/config-api.test.ts` |
| **D42** | **① L'émotion est réellement appliquée + ② l'UI est honnête sur le débit.** L'adaptateur `toAudioCppRequest` envoie **`exaggeration`** et **`guidance_scale`** **DANS l'objet `"options"`** (jamais au top-level), **uniquement** pour **Chatterbox** (`engineSupportsEmotion` ; les autres familles ne les lisent pas) ; conversion **pour-mille → réel** (`/1000`). ⚠️ Le « cfg » de Yuki (`tts.cfg`, défaut 0.5) = **`guidance_scale`** (T3 CFG = `cfg_weight` Python, défaut **0.5**) ; **`s3gen_cfg_rate`** (CFG du **flux S3Gen**, défaut **0.7**) est un **autre étage**, **non piloté** par Yuki (la doc antérieure l'identifiait à tort comme le « cfg »). Preuve moteur : `src/models/chatterbox/session.cpp:42-60`, `src/models/chatterbox/t3_component.cpp:615`, `include/engine/models/chatterbox/tts.h:19-32`, `app/server/runtime.cpp:1994-2006`. Côté UI (`public/ui/config-patch.js` `engineFieldState` + `public/ui/config.js` `refreshEngineFields`), le champ **« Débit (%) »** est **grisé + noté « Sans effet avec ce moteur. »** quand `tts.engine` ne l'applique pas (`kokoro`/`sanotts` sinon), et **suit le changement de moteur** ; les réglages d'**émotion** sont grisés pour tout moteur ≠ `chatterbox`. Un champ grisé **ne bloque PAS** l'enregistrement (le patch est inchangé). | §11.16, `src/tts/audio-cpp.ts` (`engineSupportsEmotion`, `AUDIO_CPP_KEYS.options`), `public/ui/config-patch.js`, `public/ui/config.js`, `tests/tts/audio-cpp.test.ts`, `tests/ui/config-patch.test.ts` |

### À confirmer (non vérifiable sans GPU / Docker / moteur)

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C18** | ✅ **LEVÉ (2026-09-21, source runtime)** — **Contrat HTTP réel d'`audio.cpp`** : `voice`/`voice_ref`/`reference_text` **et** `language` (top-level) sont **attestés** par le code du serveur ; `exaggeration` se passe dans `options` (le « cfg » de Chatterbox est **`guidance_scale`**, pas `s3gen_cfg_rate`). ✅ **Valeur et clés tranchées** par le correctif **D42** (§11.16), point **C27** clos. | §11.5, §11.11, §11.16, `docs/lot7.md` |
| **C19** | ✅ **LEVÉ (2026-09-21, source amont + constat réel)** — **`default_voice_preset` pour Chatterbox : inexistant par défaut.** L'intégration `audio.cpp` documente « Built-in voices: Not exposed by this integration » et exige un `--voice-ref` (`docs/tts.md`). Une requête **sans voix** échoue au `prepare` : `Chatterbox prepare requires speaker reference audio` (constat réel utilisateur). Un `default_voice_preset` (ou une voix Yuki) **doit donc être fourni explicitement** — il n'y a **pas** de voix « factory » côté moteur. | §7, §11.11, `docs/tts.md` |
| **C20** | **Heuristique `modelMatchesEngine`** (id de `/v1/models` ↔ nom de moteur) : à valider sur la vraie liste | `src/gateway/routes/tts.ts:316-323` |
| **C21** | ✅ **LEVÉ (2026-09-21, par EXÉCUTION RÉELLE)** — **CLI/port exacts** du service `tts` : l'ENTRYPOINT de l'image est un **dispatcher à sous-commandes** (`cli`/`server`/`model-manager`/`perf`) → `server --config /app/server.json` ; hôte/port sont des **clés de config** (`host`/`port`), pas des flags. Voir §11.4 | §11, `docs/lot7.md` C14 |
| **C22** | **`503` « Insufficient Memory » indiscernable du `BusyGuard`** : confirmer qu'aucun champ ne les distingue | §3.5, `docs/lot7.md` |
| **C23** | ✅ **LEVÉ (2026-09-21, API HF)** — **Noms exacts du GGUF** : `Chatterbox-GGUF/chatterbox-q8_0.gguf` (2 088 393 668 o) et `Chatterbox-GGUF/chatterbox-f16.gguf` (3 744 360 386 o). Preuve : `https://huggingface.co/api/models/audio-cpp/audio.cpp-gguf/tree/main/Chatterbox-GGUF` (le dossier ne contient **que** ces deux fichiers — **aucun WAV**). | §11.7, API HF |
| **C24** | **Divergence éventuelle entre le point de montage des voix du GATEWAY et celui du MOTEUR** : les deux variantes Compose montent le volume sur `/voices` (`docker-compose.yml:100,193`, `deploy/server/docker-compose.yml:103,194`), donc `YUKI_MOUNT_VOICES` est réutilisé comme base absolue. Si un opérateur les fait diverger (ex. changer `YUKI_MOUNT_VOICES` côté gateway seulement), le chemin envoyé deviendrait faux. **Proposition** (non implémentée) : champ `tts.voiceBaseDir` (`string`, défaut `/voices`, `apply: restart`) pour découpler les deux. | §11.9 |
| **C25** | **FORME EXACTE de `GET /health`** : la forme `{ ready, model_count }` issue de l'**archive est DÉMENTIE par l'exécution réelle** (moteur joignable, `/v1/models` = `chatterbox — tts`, mais `/health` ne renvoie pas de champ booléen `ready`). La forme réelle est **EN ATTENTE DE RELEVÉ** ; en attendant, la sonde est **tolérante** (jamais « erreur » sur un champ absent/incompris), conserve le **corps brut borné** (`status.payload`) et **journalise une fois** par forme les clés observées (`tts.health.shape`). Dès que le relevé réel sera fourni : **figer le schéma**, le documenter ici, et retirer l'heuristique de déduction si elle devient inutile. | §2.6, §11.10 |
| **C26** | ✅ **LEVÉ (2026-09-22, par l'utilisateur)** — **Chatterbox en `task=clon` + voix réelle : VALIDÉ en réel** — « le TTS fonctionne (la voix parle) ». Le message « requires speaker reference audio » a disparu et l'audio est produit (correction D39 + `task: "clon"`, D36). | §11.13, §11.16, D36, D39 |
| **C27** | ✅ **LEVÉ (2026-09-22) — correctif D42** : `exaggeration` (float, défaut moteur **0.5**) et **`guidance_scale`** (float, défaut moteur **0.5** — c'est le « cfg » de Yuki = `cfg_weight` Python/T3 CFG) sont désormais portés par **`"options": {…}`** dans `toAudioCppRequest`, **uniquement** pour `chatterbox`, à l'échelle **pour-mille → réel** (`/1000`). ⚠️ **Correction de la conclusion antérieure** : `s3gen_cfg_rate` (défaut 0.7) est le CFG du **flux S3Gen**, un **autre étage** — ce n'est **pas** le `cfg` de Yuki ; il n'est pas piloté. Les modèles qui ne lisent pas ces clés ne les reçoivent **jamais** (`engineSupportsEmotion`), et l'UI les grise pour eux. | §11.16, `src/tts/audio-cpp.ts`, `tests/tts/audio-cpp.test.ts` |
| **C28** | ✅ **LEVÉ (2026-09-22, par l'utilisateur)** — **cause de l'échec d'enregistrement identifiée** : une **valeur sous le minimum `50`** de `tts.speed` (bornes **50–200**, `src/config/schema.ts`) ⇒ `400 invalid_config`. Le patch est correctement typé (D41) et l'UI affiche désormais la **cause réelle** ; **aucun défaut de code côté Yuki**. | §11.15, D41, `src/config/schema.ts` |

---

## 11. Contrat réel du moteur (extrait des archives)

> **Ajout du 2026-09-21.** Les archives documentaires `audio-cpp-server`
> (~35 k car., README de `app/server`), `audio-cpp-gguf-packages`,
> `audio-cpp-http-server`, `audio-cpp`, `audio-cpp-model-families`,
> `chatterbox-tts` et `tts-opensource-comparison-2026` ont été relues dans
> `/app/.data/docs/tools/`. Cette section fixe le **contrat réel** du moteur et
> **lève une partie des points ouverts** (`C1`, `C2`, `C14`, `C18`, `C21`).
> Règle de lecture : **attesté** = extrait d'archive cité ; **repli** =
> hypothèse non prouvée, à ne pas présenter comme acquise.
>
> **Mise à jour du 2026-09-21 (soir) — preuve d'exécution réelle.** Le conteneur
> `tts` a été démarré réellement avec `command: ["--config", "/app/server.json"]`
> et a bouclé sur :
>
> ```
> Available commands:
> cli     Run audio tasks (TTS, ASR, VAD, VC, diar, etc.)
> server  Run the HTTP server
> model-manager  List, install, clean, or remove model packages
> perf    Run model performance benchmarks
> Unknown command: --config
> ```
>
> ⇒ **l'ENTRYPOINT de l'image est un DISPATCHER à sous-commandes** (jamais
> documenté par les archives), et le premier argument doit être **`server`**.
> C'est **la** preuve qui fait foi ci-dessous ; les archives ne la fournissent
> **pas** (voir §11.7).
>
> **Mise à jour du 2026-09-21 (nuit) — preuve par le CODE SOURCE du runtime.**
> Le message d'erreur `Chatterbox supports VoiceCloning and VoiceConversion`
> **n'existe dans aucune archive** ; sa cause a été établie en lisant le dépôt
> amont `github.com/0xShug0/audio.cpp` (commit `f7f5dd1`). Section **§11.11**
> (cause, rôle de `task`/`mode`, config corrigée, deuxième blocage = voix
> obligatoire).

### 11.1 Sources et extraits d'appui

| Archive | Extrait exact | Ce qu'il prouve |
| --- | --- | --- |
| `audio-cpp-server` | « `audiocpp_server --config server.json` — Uses models declared in the config. The UI is available unless disabled by config or `--no-ui`. » | **mode documenté = config** ; le binaire s'appelle `audiocpp_server` |
| `audio-cpp-server` | « `build/bin/audiocpp_server --config server.json` » | **ligne de commande attestée** |
| `audio-cpp-server` | bloc `cat > server.json <<'JSON' { "host": …, "models": [ { "id": …, "family": …, "path": …, "task": …, "mode": … } ] }` | **structure exacte** de `server.json` |
| `audio-cpp-http-server` | table `ServerConfig` : `host`, `port`, `backend`, `device`, `threads`, `lazy_load`, `models`, `ui_enabled`, `cors_origins`, … | **clés de premier niveau** |
| `audio-cpp-http-server` | table `ServerModelConfig` : `id`, `family`, `path`, `task`, `mode`, `lazy`, `load_options`, `session_options`, `default_request_options`, `voice_presets`, `default_voice_preset`, … | **clés d'une entrée `models[]`** |
| `audio-cpp-server` | « a single-file model's weights, the one GGUF a model directory selects (`model.gguf` or the sole `*.gguf`) » | **`path` = fichier `.gguf` OU dossier** (dossier à un seul `*.gguf`, sinon ambigu) |
| `audio-cpp-gguf-packages` | « \| `Chatterbox-GGUF` \| `chatterbox` \| F16 + Q8 \| MIT \| » + « *Pass a GGUF file directly as `--model`:* » | **famille `chatterbox`, licence MIT**, fichier GGUF utilisable directement |
| `audio-cpp` | « \| **chatterbox** \| TTS, Clone, VC \| ar, da, de, el, en, es, fi, fr, hi, it, ko, ms, nl, no, pl, pt, sv, sw, tr \| » | **`fr` est une langue supportée** par la famille `chatterbox`. ⚠️ Le « TTS » de cette table d'archive **contredit le loader** (qui rejette `tts`, cf. §11.11) : c'est **`clon`** qu'il faut déclarer. |
| `audio-cpp-server` | « Resolution precedence for a TTS request's voice fields: 1. `voice_ref` — always wins. 2. `voice` matching a configured model preset … 3. `voice` matching a wav basename in `voice_dir` … 4. Otherwise — `voice` is used as the model-native cached voice id » | **clés de voix attestées** : `voice_ref`, `voice`, presets, `voice_dir` |
| `audio-cpp-server` | « `voice_ref` accepts either a plain path string (server-side file) or an object with a `type` » + `"type": "base64"` (≤ 5 MiB) | **`voice_ref` = chemin OU référence inline base64** |
| `audio-cpp-server` | « `POST /v1/audio/speech` accepts top-level `speed` (or `speaking_rate`) as a positive speech-rate multiplier » | **`speed`/`speaking_rate` attestés (top-level)** |
| `audio-cpp-server` | « The response is `audio/wav` by default. » ; `"response_format": "json"` ; `"mp3"` (build frontend) | **format de sortie** |
| `audio-cpp-http-server` | `ui_enabled` \| `bool` \| « Enable embedded WebUI (default true) » | **clé `ui_enabled` attestée** (on la met à `false`) |
| `chatterbox-tts` | `generate(text, language_id="fr")` ; `exaggeration=0.5`, `cfg=0.5` | clés **côté lib Python** — **PAS** une preuve de la surface HTTP |

### 11.2 `server.json` — structure complète documentée

**Clés de premier niveau** (table `ServerConfig` de `audio-cpp-http-server`, toutes optionnelles sauf `models`) :

| Clé | Type | Rôle |
| --- | --- | --- |
| `host` | `string` | IP de bind (défaut `"127.0.0.1"`) |
| `port` | `int` | Port TCP (défaut `8080`) |
| `backend` | enum | `cpu` / `cuda` / `vulkan` / `metal` / `hip` (défaut CUDA) |
| `device` | `int` | Index de device (défaut `0`) |
| `threads` | `int` | Threads worker serveur |
| `lazy_load` | `bool` | Charge le modèle au 1er appel |
| `models` | `vector<ServerModelConfig>` | **liste des modèles** |
| `ui_enabled` | `bool` | WebUI embarquée (défaut `true`) |
| `ui_management` | `bool` | Gestion (downloads) — exige build natif |
| `cors_origins` | `string` | Origines CORS (défaut vide = désactivé) |
| `busy_timeout_ms` | `int` | Plafond d'attente par requête (défaut 300 000) |
| `max_loaded_models` | `int` | Modèles résidents max (0 = illimité) |
| `idle_unload_ms` | `int` | Décharge après inactivité (0 = désactivé) |
| `min_free_memory_mb` | `int` | Refuse un chargement si mémoire libre < plancher (0 = désactivé) |
| `model_spec_override` | `optional<path>` | Override de specs (top-level) |
| `voice_dir` | `optional<path>` | Dossier de WAV de voix + `prompt_text` |
| `live_ingest` | `LiveIngestLimits` | Bornes du live ASR |

**Clés d'une entrée `models[]`** (table `ServerModelConfig`) : `id` (obligatoire en pratique : c'est ce que `model` référence), `family`, `path`, `task`, `mode` (`offline`/`streaming`), `lazy`, `busy_timeout_ms`, `live_ingest`, `load_options`, `session_options`, `default_request_options`, `voice_presets`, `default_voice_preset`, `model_spec_override`. Le README d'`app/server` donne l'exemple canonique avec `id`, `family`, `path`, `task`, `mode` comme colonne vertébrale.

> **`path` = fichier ou dossier ?** Les deux sont attestés : un **fichier `.gguf` unique**, ou un **dossier** qui sélectionne « `model.gguf` **ou** the sole `*.gguf` ». Un dossier contenant **plusieurs** GGUF sans `model.gguf` est **ambigu** (le message de doc le dit explicitement). Comme `Chatterbox-GGUF` contient **F16 + Q8**, désigner **le fichier exact** (ou isoler un seul `.gguf` dans un sous-dossier).

### 11.3 `server.json` prêt à coller (Unraid, un seul modèle `chatterbox`)

```json
{
  "host": "0.0.0.0",
  "port": 8081,
  "backend": "cuda",
  "device": 0,
  "threads": 1,
  "lazy_load": true,
  "ui_enabled": false,
  "models": [
    {
      "id": "chatterbox",
      "family": "chatterbox",
      "path": "/models/Chatterbox-GGUF/<fichier-exact>.gguf",
      "task": "clon",
      "mode": "offline"
    }
  ]
}
```

- **`id` = `chatterbox`** est **impératif** : c'est le nom que Yuki envoie (`model: "chatterbox"`) et que `GET /v1/models` renverra.
- **`task` = `clon`** est **impératif** : la famille `chatterbox` du runtime n'accepte **que** `clon` (clonage) et `vc` (conversion). `tts` déclenche `Chatterbox supports VoiceCloning and VoiceConversion`. Preuve `fichier:ligne` : `src/models/chatterbox/loader.cpp:131-133` (cf. **§11.11**). ⚠️ Écrire `clon`, **pas** `clone` : `parse_voice_task_kind` n'accepte que le **token** (`src/framework/runtime/task_vocabulary.cpp:21`, `session.cpp:136`).
- **`mode` = `offline`** : **seul** mode supporté par Chatterbox (`loader.cpp:134-136`). C'est aussi la **valeur par défaut** (`app/server/config.h:47`) ⇒ clé **valide**. `streaming` serait **refusé**.
- **`host: "0.0.0.0"`** pour que le gateway joigne `http://tts:8081` sur `yuki-net` ; `port: 8081` aligné sur le défaut `tts.baseUrl`.
- **`ui_enabled: false`** : pas de WebUI ⇒ aucune écriture liée à l'UI (compatible `read_only: true`).
- **`<fichier-exact>`** : **non attesté** (§11.7) — voir le nom réel dans l'arbre HF `audio.cpp-gguf/Chatterbox-GGUF`.
- **Clé de langue** : désormais **attestée** côté requête (`language`, top-level — `app/server/runtime.cpp:1990-1991`), voir **§11.5**.

> ⚠️ **Une voix de référence est OBLIGATOIRE** pour `clon` : sans `voice_ref` (ni preset, ni `voice_dir`), la requête échoue au `prepare` avec `Chatterbox prepare requires speaker reference audio` (preuve : `src/models/chatterbox/session.cpp:410-412`). Corriger `task` **ne suffit donc pas** — il faut aussi **créer une voix** dans Yuki (cf. **§11.11**).

### 11.4 Service `tts` (compose, bind mounts Unraid) + volumes

```yaml
  tts:
    image: ghcr.io/0xshug0/audio.cpp:full-cuda13   # ou full-cuda12 selon le driver
    container_name: yuki-tts
    profiles: ["tts"]
    # ENTRYPOINT = DISPATCHER à sous-commandes (prouvé par exécution réelle :
    # `Unknown command: --config`). 1er argument = sous-commande `server`,
    # puis `--config <fichier>`. Hôte/port = clés de config, pas des flags.
    command: ["server", "--config", "/app/server.json"]
    networks: [yuki-net]
    volumes:
      # Config serveur (fournie par nous) — lecture seule.
      - type: bind
        source: /mnt/user/appdata-ssd/yuki-server/audiocpp-server.json
        target: /app/server.json
        read_only: true
      # Modèle GGUF pré-déposé (ro) — jamais écrit par le service.
      - type: bind
        source: /mnt/user/appdata-ssd/yuki-server/models
        target: /models
        read_only: true
      # Voix Yuki : le service ne fait que LIRE les WAV (voice_ref).
      - type: bind
        source: /mnt/user/appdata-ssd/yuki-server/voices
        target: /voices
        read_only: true
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    read_only: true
    tmpfs:
      - /tmp
    restart: unless-stopped
```

**Volumes (3 bind mounts, aucun `ports:`).** `audiocpp-server.json` (ro),
`models` → `/models` (ro), `voices` → `/voices` (ro).

**`read_only: true` est-il compatible ?** L'archive **ne documente aucune
écriture au démarrage** pour le mode config : le serveur lit le modèle et la
config, ne télécharge rien (`--ui-management` — le seul à écrire — **n'est pas
utilisé**), et `ui_enabled: false` coupe l'UI. `read_only: true` + `tmpfs: ["/tmp"]`
n'est donc **contredit par aucun extrait**. Si un binaire écrivait malgré tout
dans un autre dossier, l'ajustement **minimal** est d'ajouter un second `tmpfs`
(et non de passer en `rw`).

**Montage `/models` en `ro` :** compatible — on **pré-dépose** le GGUF ; le
loader ne fait que le lire (`min_free_memory_mb` le « reads »). Aucun besoin de
`--ui-management`.

> ⚠️ **Nom d'image** `full-cuda13`/`full-cuda12` : la référence aux images
> `ghcr.io/0xshug0/audio.cpp:full-*` provient de `docs/docker.md`, **non
> archivé** (seul un lien l'évoque). **Non attesté dans les archives
> disponibles** ; les noms de tags restent à vérifier sur le registre.

### 11.5 Clés de requête `POST /v1/audio/speech` — statut

| Clé de requête | Statut | Extrait / remarque |
| --- | --- | --- |
| `model` | **attestée** | tous les exemples `curl` l'utilisent |
| `input` | **attestée** | `"input": "audio.cpp is serving this request …"` |
| `response_format` | **attestée** | défaut `audio/wav` ; `"json"`, `"mp3"` (frontend) |
| `speed` / `speaking_rate` | **attestée (top-level), PAR MODÈLE** | « top-level `speed` (or `speaking_rate`) … **when the selected model supports speed control. Models without speed control reject the field.** » (`app/server/README.md:5`). Le code n'applique le multiplicateur que si le modèle le supporte ; sinon **rejet HTTP 500** (`app/server/runtime.cpp:2116-2118`, `app/server/http.cpp:824-829`) **ou ignorance silencieuse** si le modèle est en spec *legacy* sans contrat (cas de **Chatterbox** — verdict §11.14). |
| `voice_ref` | **attestée** | chemin (`"voices/alice.wav"`) **ou** `{ "type": "path", "path": … }` **ou** `{ "type": "base64", "data": … }` (≤ 5 MiB) |
| `voice` | **attestée** | preset configuré, sinon basename `voice_dir/<name>.wav`, sinon id de voix natif |
| `reference_text` | **attestée** | transcrit fourni avec `voice_ref` |
| `options` (objet) | **attestée** (l'**objet**), clés internes non | ex. `"options": { "retry_badcase": false }` |
| `stream_format` | **attestée** | `sse` / `audio` (modèles `streaming`) |
| `seed`, `max_tokens` | **attestées** | exemples README |
| `busy_timeout_ms` | **attestée** | borne d'attente par requête |
| **`language`** (top-level) | ✅ **attestée (source runtime)** | lue **à chaque requête** par `build_speech_request` : `engine::io::json::optional_string(body, "language", "")` → `request.text_input.language` (`app/server/runtime.cpp:1990-1991`). La valeur est donc **honorée** (ex. `"language": "fr"`). |
| **`language_id`** | **non attestée côté HTTP** | attestée **uniquement** dans la lib Python (`generate(..., language_id="fr")`). Le serveur ne lit **que** `language` — `language_id` est **ignoré** (clé top-level inconnue ⇒ silencieusement ignorée). |
| **`exaggeration`** / **`cfg`** (top-level) | ❌ **ignorées** | `build_speech_request` ne lit **qu'une liste fixe** de clés top-level (`seed`, `temperature`, `top_k`, `top_p`, `max_tokens`, `max_steps`, `repetition_penalty`, `guidance_scale`, `num_inference_steps`, `instructions`) + l'objet `options` (`app/server/runtime.cpp:1994-2004`). Une clé top-level inconnue n'est **pas rejetée**, mais **pas lue** ⇒ Yuki les envoie « dans le vide ». Pour Chatterbox, `exaggeration` se passe **dans `options`** (`src/models/chatterbox/session.cpp:45-46`), et le « cfg » de génération est **`guidance_scale`** (`session.cpp:47-48`, T3 CFG = `cfg_weight`), **pas** `cfg` ni `s3gen_cfg_rate` (autre étage) — **résolu** (C27/D42, §11.16). |

**Sélection de voix — mode par requête (Voie B) est donc attesté** : on peut
passer `voice_ref` (chemin ou base64) + `reference_text` **à chaque requête**,
sans passer par la config + rechargement. Le mode config (`voice_presets`,
`default_voice_preset`) reste attesté aussi ; Yuki peut basculer A↔B via
l'adaptateur unique (`src/tts/audio-cpp.ts`).

### 11.6 Le test français, en une commande copiable

**Variante A — attestée, sans voix ni langue explicites** (repli sur le défaut du moteur) :

```bash
docker run --rm --network yuki-net curlimages/curl:latest -sS -D - -o /tmp/test-fr.wav \
  http://tts:8081/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatterbox",
    "input": "Bonjour, ceci est un test de la voix française de Yuki.",
    "response_format": "wav"
  }'
```

**Variante B — clonage par référence, attestée** (voix Yuki en `/voices`, ro) :

```bash
docker run --rm --network yuki-net curlimages/curl:latest -sS -o /tmp/test-fr.wav \
  http://tts:8081/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatterbox",
    "input": "Bonjour, ceci est un test de la voix française de Yuki.",
    "voice_ref": "/voices/<id>.wav",
    "reference_text": "Transcription de la référence.",
    "response_format": "wav"
  }'
```

**Variante C — langue au niveau requête (repli, clé NON attestée)** : ajouter
`"language": "fr"` (ou `"language_id": "fr"`), **ou** `"options": { "language": "fr" }`
(l'objet `options` est attesté, la clé interne ne l'est pas) :

```bash
docker run --rm --network yuki-net curlimages/curl:latest -sS -o /tmp/test-fr.wav \
  http://tts:8081/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatterbox",
    "input": "Bonjour, ceci est un test de la voix française de Yuki.",
    "language": "fr"
  }'
```

**Variante D — langue au niveau CONFIG (nom de champ attesté, valeur non attestée)** :
ajouter dans l'entrée `models[]` : `"default_request_options": { "language": "fr" }`
(ou `"session_options"` / `"load_options"`), puis redémarrer le service.

> **Statut** : A et B reposent sur des clés **attestées** ; C et D sont des
> **replis** car le **nom d'option de langue** côté requête n'est pas prouvé.
> Le test prouve la **chaîne**, pas que la langue est honorée (§6) — seul
> l'écoute tranche. Depuis l'UI, le même test passe par `POST /api/tts/test`.

**Débit** : `"speed": 1.1` (ou `"speaking_rate": 1.1`) — **clé attestée top-level, mais sans effet pour Chatterbox** (spec legacy ⇒ champ ignoré ; rejet HTTP 500 pour les modèles à contrat v1 sans débit, ex. `qwen3-tts`/`cosyvoice3`) — verdict **§11.14**.
**Émotion** : `exaggeration` / `cfg` — **non attestés côté HTTP** (§11.5).

### 11.7 Ce qui reste NON attesté

| Point | Pourquoi |
| --- | --- |
| **Clé de langue HTTP** | ✅ **tranché (source)** : le serveur lit **`language`** top-level (`app/server/runtime.cpp:1990-1991`). `language_id` n'existe pas côté HTTP. |
| **Passage de `exaggeration` / `cfg`** | ✅ **tranché (source)** : `exaggeration` se passe **dans `options`** pour Chatterbox (`src/models/chatterbox/session.cpp:45-46`) ; le « cfg » de génération est **`guidance_scale`** (`session.cpp:47-48`, T3 CFG = `cfg_weight` Python), **pas** `cfg` ni `s3gen_cfg_rate`. Le `cfg` **top-level** envoyé par Yuki est **ignoré** — **résolu** (C27/D42, §11.16). Défauts : `exaggeration = 0.5`, `guidance_scale = 0.5`, `s3gen_cfg_rate = 0.7` (non piloté) — `include/engine/models/chatterbox/tts.h:19-32`. |
| **Nom exact du fichier GGUF** dans `Chatterbox-GGUF` | l'archive donne le **dossier** + variantes **F16 + Q8**, pas les noms de fichiers |
| **Chemin du fichier de config DANS le conteneur** (`/app/server.json` ?) | **non attesté** : ni le WORKDIR ni le `CMD`/les chemins de l'image ne sont documentés. À confirmer en réel (C14). |
| **Sous-commandes du dispatcher** (`server`/`cli`/`model-manager`/`perf`) | **non documentées par les archives** : connues **uniquement** par l'**exécution réelle** (logs `Unknown command: --config`). |
| **Tags `full-cuda13`/`full-cuda12`** | non présents dans les archives (lien vers `docs/docker.md` seulement) |
| **Écritures éventuelles au démarrage** | aucune mentionnée ⇒ `read_only` + `tmpfs /tmp` raisonnable, non garanti par un extrait |

> La liste ci-dessus vient des **archives**. Les points **tranchés** l'ont été par
> lecture du **code source du runtime** (`github.com/0xShug0/audio.cpp`, commit
> `f7f5dd1`, 2026-09-21) — cf. **§11.11**.

### 11.8 Impact sur les points ouverts

- **C1 — levé pour les voix** : `voice`, `voice_ref` (chemin **ou** base64), `reference_text`, `voice_presets`, `default_voice_preset`, `voice_dir` sont **attestés** ; le mode **par requête** est donc viable (l'hypothèse A↔B se tranche en faveur de **B disponible**). ✅ **Levé aussi pour la langue** : `language` top-level est lu par le serveur (§11.5, source). ✅ **Levé aussi pour l'émotion** : clés **`exaggeration` / `guidance_scale`** dans `options` (C27 clos, D42, §11.16).
- **C2 — partiellement levé** : `fr` est listé comme langue de la famille `chatterbox` (`audio-cpp`). La **version V3** du checkpoint n'est **pas** attestée dans les archives (la variante s'appelle `Chatterbox-GGUF`, sans « V3 »).
- **C14 — levé (par EXÉCUTION RÉELLE)** : `command: ["server", "--config", "/app/server.json"]`. L'ENTRYPOINT est un **dispatcher à sous-commandes** (`Unknown command: --config`) : c'est une **preuve d'exécution**, pas une déduction d'archive. L'hypothèse `--server --host 0.0.0.0 --port 8081` est **invalidée** : `--host`/`--port`/`--server` n'apparaissent **ni** dans les archives **ni** dans les logs ; hôte/port sont des **clés de config**. ⚠️ Le **chemin** `/app/server.json` **reste à confirmer** (WORKDIR de l'image non attesté).
- **C21 (lot 8)** — levé (hérite C14).
- **C18 (lot 8)** — ✅ **levé (source runtime)** : clé de voix (`voice`/`voice_ref`/`reference_text`) **et** clé de langue (`language`, top-level) **attestées** par le code ; `exaggeration`/`guidance_scale` passent par `options` — clés **et** valeurs tranchées (C27 clos, D42, §11.16).
- **C23 (lot 8)** — reste ouvert : nom exact du GGUF.

### 11.9 Résolution de voix — précédence attestée et décision Yuki

**Attesté** (`audio-cpp-server`, §11.1) : la résolution d'une voix de requête
suit cette précédence :

1. **`voice_ref`** — gagne toujours ; accepte **soit une chaîne de chemin**
   (fichier côté serveur), **soit un objet** avec un `type` (dont
   `{ "type": "base64", "data": … }`, ≤ 5 MiB).
2. `voice` correspondant à un **preset configuré** du modèle (`voice_presets`).
3. `voice` correspondant à un **nom de fichier `.wav` dans `voice_dir`** (le
   répertoire partagé, monté ici sur `/voices`).
4. sinon `voice` est traité comme un **id de voix natif** du modèle.

**État Yuki (décision retenue).** Le registre stocke des chemins **relatifs**
dans `Voice.refAudio` (`presets/<id>.wav`, `cloned/<id>.wav`,
`src/tts/voices-store.ts:278`). Le moteur étant un **processus séparé** qui monte
le volume en **lecture seule** (`docker-compose.yml:192-193`), un chemin relatif
ne lui dit rien : Yuki envoie donc un chemin **absolu**
`<voiceBaseDir>/<refAudio>`, avec `voiceBaseDir` = **le montage configuré**
`YUKI_MOUNT_VOICES` (défaut `/voices`, `src/config/env.ts:152`). Preuves :
`src/tts/audio-cpp.ts:128-132` (jointure), `src/index.ts:255,284-285,408`
(threading explicite). Aucune voix résolue (registre vide, `tts.voice` vide) ⇒
**aucun champ de voix** n'est envoyé : le moteur n'a alors **aucune voix par
défaut** (C19) et refuse faute de référence (`session.cpp:410-412`). C'est
pourquoi, **dès qu'un preset existe**, Yuki applique désormais ce preset quand
`tts.voice` est vide ou inconnu (cf. **D39** et §11.13). Avant ce correctif, le
résolveur de production n'appliquait **jamais** `defaultVoice()`.

**Décision explicite, plus implicite.** Auparavant, l'adaptateur retombait sur la
constante `"/voices"` (`src/tts/audio-cpp.ts:130`) sans qu'aucun appelant ne
fournisse `voiceBaseDir` : le chemin était correct **par coïncidence** (le
montage du gateway valait `/voices`). `src/index.ts` passe désormais
explicitement `voiceBaseDir: env.mountPoints.voices` (résolu depuis
`YUKI_MOUNT_VOICES`). Cf. **D34** et le point ouvert **C24** (divergence
possible gateway/moteur).

**Alternative évaluée — `voice_ref` en objet/base64.** Le gateway pourrait lire
le WAV et l'inliner (`{ "type": "base64", "data": … }`, ≤ 5 MiB).

| Critère | Chemin absolu (retenu) | Base64 inline |
| --- | --- | --- |
| Immunité à une divergence de montage | ❌ (dépend du chemin vu par le moteur) | ✅ |
| Coût par requête | nul (juste une chaîne) | lecture + encodage du WAV à chaque appel |
| Taille | illimitée | **≤ 5 MiB** (un échantillon plus gros est refusé) |
| Simplicité | ✅ (aucun I/O supplémentaire) | plus de code, plus de surface d'erreur |
| Attestation | ✅ `voice_ref` chaîne attestée | ✅ `voice_ref` base64 attestée |

**Recommandation : conserver le chemin absolu** (implémenté). Il est correct dès
lors que le moteur voit le volume au même point que le gateway — garanti par les
deux variantes Compose. Le base64 n'est à envisager **que** si une divergence de
montage (C24) rendait le chemin inexploitable ; il serait alors un correctif
ciblé, au prix d'un I/O par requête et d'un plafond de 5 MiB.

### 11.10 Forme de `GET /health` — EN ATTENTE DE RELEVÉ (C25)

> **Aucune forme n'est affirmée ici.** Ce qui suit est un **constat d'exécution**,
pas une lecture d'archive.

**Observé en réel (2026-09-21).** Moteur **joignable** (`http://tts:8081`, latence
3 ms), `GET /v1/models` renvoyant `chatterbox — tts`, GGUF sur le disque.
L'ancienne sonde exigeait un champ **booléen** `ready` dans `/health` et
concluait `state: error` — **à tort**. La forme `{ ready, model_count }` venait
d'une **archive documentaire** (`audio-cpp-http-server`), **démentie par
l'exécution** : `/health` **ne renvoie pas** ce champ sous cette forme.

**Statut.** La forme exacte est **INCONNUE** ; le relevé destiné à la figer n'est
**pas encore arrivé**. La sonde est donc **tolérante en attendant** :

| Aspect | Comportement retenu (sans présumer la forme) |
| --- | --- |
| Préparation | `ready` booléen / chaîne / nombre / absent ; aussi `ok`, `success`, `status`, `state` |
| Compte de modèles | `model_count`, `modelCount`, `models_total`, `models_loaded`, `loaded_models`, `models` (tableau/nombre), `count` |
| Corps inattendu (non-JSON, vide, HTML, `null`) | **indéterminé** — jamais `error`, jamais d'exception |
| Erreur | **seulement** sur preuve : HTTP ≠ 2xx, ou champ `error` explicite, ou `status`/`state` d'échec |
| Traçabilité | corps brut borné dans `status.payload` ; clés journalisées une fois (`tts.health.shape`) |

**À faire dès réception du relevé.** Figer le schéma réel ici, remplacer la
déduction (`readinessInferred`) par une lecture directe si possible, et clore
**C25**.

---

### 11.11 Cause réelle de `Chatterbox supports VoiceCloning and VoiceConversion`

> **Ajout du 2026-09-21 (soir) — preuve par le CODE SOURCE du runtime.**
> Contrairement aux sections précédentes, cette cause **n'est PAS dans les
> archives** : le message n'apparaît **dans aucune** d'elles (vérifié par
> `grep` sur `/app/.data/docs/tools/`). Elle a été établie en lisant le dépôt
> amont `github.com/0xShug0/audio.cpp` (commit `f7f5dd1`, 2026-09-21,
> `rawContent` recoupé). C'est une preuve **`fichier:ligne`**, plus forte qu'un
> extrait d'archive, mais elle décrit le **runtime installé** — à confirmer par
> un redémarrage réel de l'utilisateur.

**Origine exacte du message.** La famille `chatterbox` du runtime **n'implémente
que deux tâches** — le clonage et la conversion — et **rejette `tts`** au
moment de **créer la session** :

```cpp
// src/models/chatterbox/loader.cpp:131-136
if (task.task != runtime::VoiceTaskKind::VoiceCloning &&
    task.task != runtime::VoiceTaskKind::VoiceConversion) {
    throw std::runtime_error("Chatterbox supports VoiceCloning and VoiceConversion");
}
if (task.mode != runtime::RunMode::Offline) {
    throw std::runtime_error("Chatterbox only supports offline mode");
}
```

La même garde existe dans la session (`src/models/chatterbox/session.cpp:371-374`,
message `Chatterbox session supports --task clon or --task vc`). Le message est
sérialisé en 500 par le socket handler :

```cpp
// app/server/http.cpp:829
send_all(socket.get(), serialize_response(error_response(500, ex.what(), "server_error")));
```

⇒ la réponse observée `{"error":{"message":"Chatterbox supports VoiceCloning and VoiceConversion","type":"server_error"}}`
**vient bien de là**.

**Pourquoi notre config la déclenche.** Le serveur construit le `TaskSpec` du
modèle **uniquement depuis la config** (`app/server/runtime.cpp:1287-1290`) :

```cpp
loaded->task = engine::runtime::TaskSpec{
    engine::runtime::parse_voice_task_kind(loaded->config.task),
    engine::runtime::parse_run_mode(loaded->config.mode),
};
```

avec `parse_voice_task_kind("tts")` → `VoiceTaskKind::Tts`, puis
`create_task_session(Tts, …)` → **exception**. Notre `"task": "tts"` est donc
la cause. Comme `lazy_load: true`, la session n'est créée qu'à la **première
requête** : d'où l'erreur au moment de la synthèse, pas au démarrage.

**Rôle et valeurs valides de `task` / `mode` (attestés dans la source).**

- `parse_voice_task_kind` n'accepte **que les tokens** de
  `task_vocabulary.cpp`. Liste exhaustive (`src/framework/runtime/task_vocabulary.cpp:12-28`) :
  `vad`, `asr`, `diar`, `sep`, `gen`, `tts`, **`clon`**, `vc`, `s2s`, `align`,
  `vdes`, `spk`, `svc`, `midi`. Toute autre valeur ⇒
  `unsupported task: X (expected …)`.
  ⚠️ **`clone` (alias de spec) n'est PAS accepté** : seul le **token `clon`**
  l'est (`parse_voice_task_kind` compare `entries[i].token`, `session.cpp:136-158`).
- `parse_run_mode` n'accepte que **`offline`** ou **`streaming`**
  (`session.cpp:160-168`). Chatterbox **exige `offline`**.
- **Défauts** de `ServerModelConfig` : `task = "tts"`, `mode = "offline"`
  (`app/server/config.h:46-47`). Notre `"mode": "offline"` est donc **valide
  et redondant** (c'est le défaut) ; notre `"task": "tts"` est **le défaut — et
  précisément ce que Chatterbox refuse**.

**Incohérence amont à connaître.** Le **spec** `model_specs/chatterbox.json`
déclare `"tasks": ["tts", "clone", "vc"]`, mais le **loader** (autorité au
moment de créer la session) n'advertise et n'accepte que `VoiceCloning` +
`VoiceConversion`. `GET /v1/models` **reprend la tâche de la config**
(`runtime.cpp:3224`), donc il affiche `chatterbox — tts` même quand `tts` ne
marche pas : **voir `task: tts` dans `/v1/models` n'est pas une preuve que `tts`
fonctionne**.

**Lien avec l'avertissement « legacy model spec ».** L'avertissement est émis
par `warn_legacy_embedded_contract` quand le GGUF embarque un spec **sans
`schema_version`** (`src/framework/model_spec/package.cpp:133-140`) : le runtime
**ignore ce spec embarqué** et utilise **son** contrat schema-v1 (ici
`model_specs/chatterbox.json` ou le catalogue compilé). Conséquences
**concrètes**, et **limitées** : ce contrat ne sert qu'à valider les **options
de requête** (`model_accepts_request_option`, `runtime.cpp:95-115`), c.-à-d.
`reference_text`, `language`, `speed`, `speaking_rate`
(`refresh_model_option_flags`, `runtime.cpp:1303-1320`). Il **ne régit ni
`task`, ni `mode`, ni `voice_presets`** :

- `task`/`mode` viennent de **notre `server.json`** (jamais du spec) ;
- `voice_presets` / `default_voice_preset` / `voice_dir` sont **purement
  config** ;
- les options non reconnues sont **ignorées** (jamais rejetées), sauf `speed`
  qui est **rejeté** si le modèle ne le déclare pas (`runtime.cpp:2116-2118`).

⇒ l'avertissement est **bénin pour l'installation actuelle** : il n'explique
**pas** l'erreur, et il n'oblige **pas** à régénérer le GGUF.

**Ce que Yuki envoie réellement (registre vide).** `toAudioCppRequest(nullptr, …)`
produit (`src/tts/audio-cpp.ts:105-155`, émotion « neutre » par défaut
`src/tts/options.ts:42-44`) :

```json
{"model":"chatterbox","input":"<texte>","language":"fr",
 "response_format":"wav","exaggeration":0.5,"cfg":0.5}
```

Aucun champ ne demande de tâche : **Yuki n'envoie rien que le moteur
interprète comme une tâche non supportée** — l'erreur vient **uniquement** de
`"task": "tts"` dans `server.json`. (`exaggeration`/`cfg` top-level sont
**ignorés** par le serveur, cf. §11.5 : ils ne causent pas l'erreur, mais
n'ont pas d'effet au top-level — **résolu** : désormais portés par `options` (C27/D42, §11.16).)

**Verdict : H2 retenue, H1 écartée *comme cause de CE message*.**

| Hypothèse | Verdict | Preuve |
| --- | --- | --- |
| **H1** — il manque une voix de référence | **Écartée pour ce message** (mais **vraie** ensuite !) | le rejet a lieu **avant** toute lecture de voix, à la création de session (`loader.cpp:131-133`) ; le manque de voix produirait un **autre** message (`session.cpp:410-412`, cf. infra) |
| **H2** — `task`/`mode` ne correspond pas | ✅ **Retenue** | `runtime.cpp:1287` + `loader.cpp:131-133` |
| **H3** — `voice_dir`/preset mal configurés | Écartée | `voice_dir` n'est lu qu'**après** la session, dans `build_speech_request` |

**⚠️ Deuxième blocage, réel : une référence audio est obligatoire.** Avec
`task: clon`, `ChatterboxSession::prepare` exige un locuteur :

```cpp
// src/models/chatterbox/session.cpp:410-412
if (!request.voice.has_value() || !request.voice->speaker.has_value() ||
    !request.voice->speaker->audio.has_value()) {
    throw std::runtime_error("Chatterbox prepare requires speaker reference audio");
}
```

Registre Yuki vide ⇒ aucun `voice_ref` envoyé ⇒ **ce message** suivrait le
premier. **Corriger `task` seul ne suffit donc pas** : il faut **aussi** une
voix (upload WAV côté Yuki, qui enverra `voice_ref=/voices/cloned/<id>.wav`,
preuve `tests/tts/audio-cpp.test.ts:43-56`), **ou** un `default_voice_preset`
dans `server.json` (chemin d'un WAV présent dans `/voices`). Le chemin Yuki est
le plus simple, car `/voices` est monté **lecture seule** côté moteur.

**Config corrigée, prête à coller** (le chemin GGUF est celui **réel** de
l'utilisateur) :

```json
{"host":"0.0.0.0","port":8081,"backend":"cuda","device":0,"lazy_load":true,"ui_enabled":false,
 "voice_dir":"/voices",
 "models":[{"id":"chatterbox","family":"chatterbox","path":"/models/Chatterbox-GGUF/chatterbox-q8_0.gguf","task":"clon","mode":"offline"}]}
```

Seule différence avec l'actuelle : **`"task":"clon"` au lieu de `"tts"`**.

**Manip de diagnostic (si le message persiste).** Vérifier ce que le moteur a
réellement chargé et reproduire hors Yuki (depuis le réseau compose) :

```bash
docker exec -it yuki-tts cat /app/server.json          # "task":"clon" ?
docker run --rm --network yuki-net curlimages/curl:latest -sS \
  http://tts:8081/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"chatterbox","input":"Bonjour.","voice_ref":"/voices/cloned/<id>.wav","reference_text":"<transcription>","response_format":"wav"}'
```

Si ce `curl` renvoie `Chatterbox supports VoiceCloning and VoiceConversion`,
le `server.json` **chargé** porte encore `tts` ou le conteneur n'a pas été
recréé. Si le message devient `Chatterbox prepare requires speaker reference
audio`, c'est que le WAV de référence est absent/illisible.

### 11.12 Échantillon de référence français WAV directement utilisable — SIWIS (CC-BY-4.0)

> **Ajout du 2026-09-21 (soir).** Vérifié par **téléchargement réel** (HTTP 200
> + en-tête lu) : répond à **D37** (« trouver une référence française en WAV
> direct, sans `ffmpeg` »).

**Besoin.** Chatterbox exige une référence **française** — l'accent/prosodie de
la référence se transfèrent à la voix générée (carte `ResembleAI/chatterbox` :
« Ensure that the reference clip matches the specified language tag… »). Yuki
n'accepte qu'un WAV **RIFF/WAVE PCM 16/24/32 bits, mono/stéréo, ≤ 192 kHz,
≤ 10 s, ≤ 3 Mo** (`src/tts/wav.ts`, `src/tts/voices-store.ts`). Or aucun WAV
français n'existe dans `audio.cpp`/`chatterbox` (**D37**), et les échantillons
Piper FR sont des **MP3** (⇒ `ffmpeg`).

**Source retenue — SIWIS** (French Speech Synthesis Database, Idiap/Univ.
Edinburgh), **CC-BY-4.0**, miroir HF **public** (non *gated*) :
`Aviv-anthonnyolime/SIWIS_French_Speech_Synthesis_Database`. C'est la **même
base** que la voix Piper `fr_FR-siwis-medium` (MODEL_CARD Piper :
`URL: https://datashare.is.ed.ac.uk/handle/10283/2353`, `License: CC-BY 4.0`).

URL vérifiée (HTTP 200, `content-type: audio/wave`) :

```
https://huggingface.co/datasets/Aviv-anthonnyolime/SIWIS_French_Speech_Synthesis_Database/resolve/main/wavs/part1/neut_parl_s02_0343.wav
```

Fiche du fichier (en-tête lu avec le **parseur de Yuki**) :

| Champ | Valeur |
| --- | --- |
| Conteneur / codec | **RIFF/WAVE**, `audioFormat = 1` (PCM entier) |
| Canaux | **1 (mono)** |
| Fréquence | **44 100 Hz** (≤ 192 000) |
| Profondeur | **16 bits** |
| Durée | **5,05 s** (≤ 10 s) |
| Taille | **445 536 octets** (≤ 3 000 000) |
| SHA-256 | `61a007aecab8c9ec19962fd276fb61b3b52421013733e57c2f741fbcee44154c` |
| Langue | **français** (locuteur humain de la base SIWIS) |
| Licence | **CC-BY-4.0** (attribution obligatoire) |
| Nature | **humain** (locuteur principal de SIWIS) — **pas** synthétique |

Transcription officielle (`other/all_prompts_part1.txt`, 1re ligne du fichier) :
« La parole est à Monsieur Philippe Gosselin, pour soutenir l’amendement numéro
quatre-vingt un. »

**Commande unique (aucune conversion) :**

```bash
mkdir -p /mnt/user/appdata-ssd/yuki-server/voices/presets
curl -L -f -o /mnt/user/appdata-ssd/yuki-server/voices/presets/voix-fr.wav \
  "https://huggingface.co/datasets/Aviv-anthonnyolime/SIWIS_French_Speech_Synthesis_Database/resolve/main/wavs/part1/neut_parl_s02_0343.wav"
```

**`voices.json`** (registre Yuki ; si le fichier **existe déjà**, **ajouter**
l'entrée à `voices[]` au lieu de l'écraser) :

```json
{
  "schemaVersion": 1,
  "voices": [
    {
      "id": "voix-fr",
      "label": "Voix française (SIWIS)",
      "kind": "preset",
      "lang": "fr",
      "refAudio": "presets/voix-fr.wav",
      "refText": "La parole est à Monsieur Philippe Gosselin, pour soutenir l’amendement numéro quatre-vingt un.",
      "createdAt": "2026-09-21T00:00:00.000Z",
      "createdBy": "factory"
    }
  ]
}
```

**Cohérence avec Yuki.** `refAudio` est **relatif** (`presets/voix-fr.wav`) et
résolu côté serveur en `join(voiceBaseDir, refAudio)` =
`/voices/presets/voix-fr.wav` (`src/tts/voices-store.ts` `serviceSamplePath`,
`src/tts/audio-cpp.ts` `joinVoiceRef`) ; le registre est lu **exclusivement**
depuis `voices.json` (`src/tts/voices-store.ts`). Ce preset devient
automatiquement la **voix par défaut** (`defaultVoice()` = premier preset).

**Alternatives vérifiées** (même serveur / licence / format ; toutes HTTP 200 +
en-tête PCM lu) :

| URL (sous `…/resolve/main/`) | Durée | Taille |
| --- | --- | --- |
| `wavs/part1/neut_parl_s05_0468.wav` | 5,11 s | 450 828 o |
| `wavs/part1/neut_parl_s02_0586.wav` | 5,30 s | 467 586 o |

**Candidats écartés :**

| Candidat | Motif (vérifié) |
| --- | --- |
| Piper `fr_FR-gilles-low` — `…/fr/fr_FR/gilles/low/samples/speaker_0.mp3` | **HTTP 200**, 60 381 o, **MP3** 16 kHz ~4,2 s ⇒ conversion `ffmpeg` **et** synthétique (dataset **CC0**) |
| Piper `fr_FR-mls-medium` / `fr_FR-siwis-medium` (samples) | **HTTP 200**, **MP3** ~3,9 / ~4,0 s ⇒ conversion ; **CC-BY-4.0** ; synthétiques |
| FLEURS `google/fleurs` (`fr_fr`) | audio WAV **16 kHz** mais servi par des URLs **signées/expirantes** (`datasets-server.huggingface.co/cached-assets/…?Expires=…`) ; clips parfois > 10 s ⇒ URL **non stable** |
| Common Voice (`fixie-ai/common_voice_17_0`, `fr`) | **MP3** ⇒ conversion |
| VoxPopuli (`facebook/voxpopuli`, `fr`) | parquet (FLAC) ⇒ décodage ⇒ conversion |
| `psdn-ai/french-speech-samples` | dataset **gated** (accès restreint) ; licence « other » |
| WAV `audio.cpp` (`b.wav`, `a.wav`, `c.wav`, `demo_*`) | **anglais/chinois** ⇒ accent transféré |
| `rhasspy/piper-voices` — dossier `samples/` | **0 `.wav`** (288 `.mp3`), vérifié par l'API HF `…/tree/main?recursive=true` |

> ⚠️ **Miroir communautaire.** Le miroir HF SIWIS n'est **pas** la source
> officielle. La référence canonique est
> `https://datashare.is.ed.ac.uk/handle/10283/2353` (archive `.tar.gz`, pas un
> WAV unitaire). Vérifier le **SHA-256** ci-dessus après téléchargement ; en cas
> de disparition du miroir, tout WAV SIWIS `neut_*` de ce dossier convient.

### 11.13 Défaut corrigé — la voix par défaut n'était JAMAIS appliquée (D39)

> **Ajout du 2026-09-21 (soir, correctif).** Moteur opérationnel (`task: clon`
> accepté), registre contenant **un preset** (`voix-fr`), mais **toute**
> synthèse échoue avec `Chatterbox prepare requires speaker reference audio`.

**Constat.** Le moteur exige un locuteur (`session.cpp:410-412`). Yuki
n'envoyait **aucun** `voice_ref` : `toAudioCppRequest` omet les clés de voix
quand `voice === null` (`src/tts/audio-cpp.ts`, bloc `if (voice) { … }`). Or le
`voice` transmis était **toujours `null`** avec un `tts.voice` vide (le défaut),
de **trois** façons cumulées :

| # | Point fautif (avant correctif) | Effet |
| --- | --- | --- |
| 1 | `src/tts/pipeline.ts` (`resolveVoice`) : `if (id.length === 0) return null;` **avant** l'appel au résolveur | un `tts.voice` vide court-circuite **avant** toute résolution |
| 2 | `src/gateway/routes/tts.ts` (`handleTest`) : `const voice = id.length === 0 ? null : input.deps.voices.get(id);` | même court-circuit sur `POST /api/tts/test` |
| 3 | `src/index.ts` : résolveurs injectés = `(id) => voiceStore.get(id) ?? null` (pipeline **et** test) | `defaultVoice()` n'est **jamais** appliqué ; un id inconnu ne retombe pas non plus |

**Le bon comportement existait déjà, mais n'était pas câblé.**
`VoiceStore.resolveVoice` applique `defaultVoice()` pour un id vide **ou**
inconnu (`src/tts/voices-store.ts`, méthode `resolveVoice`), et `defaultVoice()`
retourne le premier preset. Ce résolveur n'était utilisé **que par les tests**
(`tests/tts/voices-store.test.ts`, `voiceRefOf` via `store.resolveVoice`), jamais
par le chemin de production — d'où des tests verts et un moteur qui refuse.

**Hypothèses écartées (avec la raison).**

| Hypothèse | Verdict | Raison (preuve) |
| --- | --- | --- |
| Le registre est **mis en cache** au démarrage (`voices:0` initial) | **FAUSSE** | `VoiceStore.read()` relit `voices.json` **à chaque appel** (`existsSync` + `readFileSync`, `src/tts/voices-store.ts`) ; aucun cache. Le `voices:0` est un **log ponctuel** de démarrage. Test : « aucun cache : un registre ajouté APRÈS l'init est vu » (`tests/tts/voices-store.test.ts`). |
| Le fichier `presets/<id>.wav` **manque** sur le volume | **Cas distinct, désormais explicite** | Possible, mais ce n'était pas la cause du registre non utilisé. Un `refAudio` absent produit maintenant `voice_ref_missing` (422) **sans** appeler le moteur. |
| `voiceBaseDir`/montage divergent (C24) | **Écartée ici** | Les deux variantes Compose montent `/voices` ; le chemin `/voices/presets/voix-fr.wav` est bien formé. |

**Correctif.**

- `src/index.ts` : les deux résolveurs deviennent `(id) => voiceStore.resolveVoice(id).voice`.
- `src/tts/pipeline.ts` : `resolveVoice()` **délègue toujours** (id vide inclus) ;
  journalise `tts.voice.unresolved` seulement quand **aucune** voix n'existe.
- `src/gateway/routes/tts.ts` : l'id brut (même vide) est transmis au résolveur ;
  en-tête `x-yuki-tts-voice-ref` ajouté (chemin `voice_ref` réellement envoyé).
- `src/tts/voices-store.ts` : `samplePathOf` (test d'existence sans relire le
  registre) + `assertSample` → `VoiceReferenceError` (`voice_ref_missing`, 422),
  appelé avant l'appel moteur (aperçu, test, pipeline).
- `public/ui/tts-assistant.js` : affiche « Fichier de référence envoyé au
  moteur : `<chemin>` » quand l'en-tête est présent.

**Corps JSON exacts envoyés à `POST /v1/audio/speech`** (mêmes clés que
`AUDIO_CPP_KEYS`) :

| Cas | Clés de voix |
| --- | --- |
| registre **vide** (`tts.voice` vide) | *aucune* : `{model,input,language,response_format,exaggeration,cfg}` |
| **preset** + `tts.voice` vide | `"voice":"voix-fr"`, `"voice_ref":"/voices/presets/voix-fr.wav"`, `"reference_text":"…"` |
| voix **explicite** connue | idem, avec l'id et le chemin de **cette** voix |
| id **inconnu** + preset existe | idem « preset » (repli sur la voix par défaut) |
| `refAudio` **absent** du volume | **aucun appel** : `422 voice_ref_missing` côté Yuki |

**Tests.** `tests/integration/tts-voice-resolution.test.ts` (chaîne
config→store→pipeline→adaptateur, cas vide/connu/inconnu/absent/ajout
post-init, cohérence pipeline↔test), plus des cas ajoutés dans
`tests/tts/voices-store.test.ts`, `tests/integration/tts-diagnostics.test.ts` et
`tests/integration/voices-api.test.ts`. L'E2E headless affiche et vérifie le
chemin de référence (`_tools/e2e-tts-ui.mjs`).

> ⚠️ **Reste non vérifiable ici** : la disparition **réelle** du message moteur
> et la qualité acoustique. ✅ **Validé en réel par l'utilisateur (2026-09-22)** :
> le TTS fonctionne (la voix parle) ⇒ **C26 clos**.

---

### 11.14 Débit (`tts.speed`) — verdict : sans effet pour Chatterbox ; échec d'enregistrement à préciser

> **Ajout du 2026-09-21 (soir, tranché sur le code du runtime — commit `f7f5dd1`).**
> L'utilisateur observe « échec de l'enregistrement » en changeant `tts.speed`
> dans `/config`, **et** « aucun effet » sur la synthèse.

**1. Chatterbox applique-t-il le débit ? NON.** Chaîne de preuves :

| Maillon | Fait | Preuve |
| --- | --- | --- |
| Spec `chatterbox` | **legacy** : `model_specs/chatterbox.json` n'a **ni `schema_version` ni bloc `options`** | `model_specs/chatterbox.json` |
| `request_option_keys` | **inexistant** ⇒ `model_contract()` renvoie `nullopt` (spec sans `schema_version`) | `src/framework/model_spec/metadata.cpp:299-310` |
| `accepts_speed` | **`true`** : contrat absent ⇒ `model_accepts_request_option` **suppose** le support | `app/server/runtime.cpp:95-115`, `:1303-1320` |
| Traitement du champ | la valeur est rangée dans `options["speed"]` (`runtime.cpp:2119`) — **sans rejet** | `app/server/runtime.cpp:2112-2124` |
| Lecture par Chatterbox | **AUCUNE**, sur les **deux** chemins : `make_voice_clone_config` lit `exaggeration`, `guidance_scale`, `s3gen_cfg_rate`, `temperature`, … **jamais `speed`** ; et la session ne lit que `request.voice->speaker` — **pas `request.voice->style->speaking_rate`** (pourtant posé par le serveur, `runtime.cpp:2123`) ⇒ **ignoré** | `src/models/chatterbox/session.cpp:43-76`, `:410-535` (grep `style` : aucun) |
| Modèles à **contrat v1** sans débit (`qwen3-tts`, `cosyvoice3`) | **rejet** HTTP 500 « speed is not supported by this model » | `app/server/runtime.cpp:2116-2118` + `app/server/http.cpp:824-829` |

⇒ **« Aucun effet » est ATTENDU pour Chatterbox : ce n'est PAS un bug de Yuki.**
Le contrat public le dit (« Models without speed control **reject the field** »,
`app/server/README.md:5`), mais le **code** ne rejette que les modèles à contrat
schema-v1 ; pour un modèle **legacy** (Chatterbox), il suppose le support puis la
session ignore le champ. L'une ou l'autre branche rend le réglage **sans effet**
(cas legacy) ou **cassant** (cas contrat v1).

**2. Correctif (adaptateur, `src/tts/audio-cpp.ts`).** `toAudioCppRequest`
n'émet `speed` (`speed/100`, UI en %) **que** pour les moteurs qui l'appliquent,
vía `engineSupportsSpeed` / `SPEED_CAPABLE_ENGINES` :

| Moteur (`tts.engine`) | `speed` envoyé ? | Effet moteur |
| --- | --- | --- |
| `kokoro` | **oui** | appliqué (`runtime.cpp:2119`) |
| `sanotts` | **oui** | appliqué comme `speaking_rate` (`runtime.cpp:2121-2123`) |
| `chatterbox` | **non** | (aurait été **ignoré**) |
| `qwen3-tts`, `cosyvoice3` | **non** | évite le **rejet HTTP 500** |
| inconnu | **non** | omission prudente (jamais de rejet dur) |

Le **schéma de config est inchangé** (`tts.speed` reste `int` 50–200 ; ni
booléen ni flottant) ; seule l'émission côté adaptateur change.

**3. Décision structurante — UI — IMPLÉMENTÉE (D42, §11.16).** Pour Chatterbox
(moteur **par défaut**), le contrôle « Débit (%) » **n'agit pas**. Le choix retenu
combine (a) **désactiver** le contrôle **et** (c) afficher une note explicite
« **Sans effet avec ce moteur.** » ; il **suit le changement de moteur** (voir
§11.16). Les réglages d'émotion sont grisés pour tout moteur ≠ `chatterbox`.

**4. Échec de l'enregistrement — ✅ cause identifiée (C28 clos) : valeur sous le minimum.**
Mécanismes **vérifiés** :

- **Verrou d'environnement** (`YUKI_TTS_SPEED` défini **et non vide**) : le champ
  passe en `origin: "env"` et un `PUT` le visant échoue **400 `locked_by_env`**
  → « Champ verrouillé par l'environnement (YUKI_TTS_SPEED). »
  (`src/config/env.ts:127`, `src/config/runtime.ts:307-342`,
  `src/gateway/routes/config.ts:194-206`). **MAIS** l'UI **saute** déjà les champs
  verrouillés dans le patch (`public/ui/config.js:580`) et les **désactive** avec
  un badge (`:269`, `:401`). ⇒ un verrou d'env produit « **aucun effet** » (la
  valeur d'env gagne), **pas** un échec d'enregistrement (avec l'UI actuelle).
- **Patch global** : l'UI n'envoie **que les champs modifiés** — mais **tous**.
  Si **un** champ modifié est invalide (nombre vidé, hors bornes…), le `PUT`
  entier échoue **400 `invalid_config`** et l'UI affiche « Échec de
  l'enregistrement. » (`public/ui/config.js:633-661`). Un `tts.speed` hors
  `[50,200]` donne « Valeur trop grande (maximum 200). ».
- **Store non inscriptible** (volume `state` ro / disque plein) ⇒ **500
  `config_store_unwritable`** (`src/gateway/routes/config.ts:210-227`).
- **Origine refusée** derrière un proxy mal configuré ⇒ **403 `bad_origin`**
  (`src/gateway/routes/config.ts:117-135`).

**Établi en environnement propre** : `PUT /api/config { "tts.speed": 150 }` →
**200**, valeur persistée, `applied.hot=["tts.speed"]` (harnais
`tests/gateway/config-api.test.ts`). ⇒ **le chemin de code d'enregistrement de
`tts.speed` fonctionne** ; l'échec observé dépend de l'environnement/UI réels.

**À demander à l'utilisateur (2-3 questions) :**

1. le **message exact** affiché (sous le champ « Débit » et/ou près du bouton
   « Enregistrer ») — c'est lui qui tranche entre `locked_by_env`,
   `invalid_config`, `bad_origin`, `config_store_unwritable` ou un simple
   échec réseau ;
2. la **valeur saisie** (ex. `150`) et si le champ était **grisé** (badge
   « verrouillé ») ;
3. les variables **`YUKI_TTS_*`** (surtout `YUKI_TTS_SPEED`) et
   `YUKI_COMPAT_MODE` présentes dans le `.env` du gateway
   (`docker compose config | grep YUKI_` ou `docker exec yuki-gateway env | grep YUKI_`).

**MAJ (2026-09-22, par l'utilisateur)** : **cause trouvée** ⇒ la valeur saisie
était **sous le minimum `50`** de `tts.speed` (bornes **50–200**,
`src/config/schema.ts`) ⇒ `400 invalid_config`. Le chemin de code est sain
(D41) ; **C28 est clos**.

---

### 11.15 Soupçon « patch mal typé » → **FAUX** ; l'UI affiche désormais la cause réelle (D41)

> **Ajout du 2026-09-22.** Vérification ciblée du soupçon principal : le bouton
> « Enregistrer » enverrait les champs numériques en **chaîne** (un `<input>`
> renvoie toujours du texte), ce qui ferait rejeter tout le `PUT` en 400.

**1. Le soupçon est FAUX.** Le schéma **coerce les chaînes numériques** :
`validateDescriptor` accepte `typeof raw === "string"` dès que la valeur matche
`/^-?\d+$/` pour un champ `int` (`src/config/schema.ts:370-379`). Preuve

d'exécution :

| Corps du `PUT /api/config` | Statut | Résultat |
| --- | --- | --- |
| `{ "tts.speed": "150" }` (chaîne, ancien `buildPatch`) | **200** | persisté, `origin:"store"`, `value:150` |
| `{ "tts.speed": 150 }` (nombre) | **200** | idem |

⇒ Une valeur **numérique en chaîne n'échoue pas**. Ce n'est donc pas la cause du
« échec de l'enregistrement » observé (cause exacte toujours **indéterminée**
sans le message réel ni le `.env`).

**2. Correctif de robustesse (`buildPatch`)** — `public/ui/config-patch.js`,
`coerceFieldValue` : les champs `number`/`range` sont désormais envoyés en
**entiers** (`speed/100` reste calculé côté adaptateur, schéma inchangé) ; un
contenu vide ou non entier est laissé tel quel pour que le serveur rende l'erreur
précise (`invalid_int`, bornes). Les `text`/`select`/`textarea` restent des
chaînes, les resets `null`, les secrets chaîne ou `null`.

**3. Correctif du message d'erreur (le vrai défaut).** `save()` affichait un
statut générique « Échec de l'enregistrement. ». Il affiche maintenant
`presentConfigSaveError()` : **code + message réels** du serveur, **nom du champ**
fautif (via `LABELS`) et explication française par code
(`locked_by_env`, `invalid_config`, `bad_origin`, `config_store_unwritable`,
`missing_config_header`, `invalid_json`/`invalid_body`, `internal_error`) — sans
jamais inventer de cause : le message brut du serveur reste prioritaire.

Fichiers : `public/ui/config-patch.js` (module pur, testable), `public/ui/config.js`
(import + `save()`). Tests : `tests/ui/config-patch.test.ts`,
`tests/gateway/config-api.test.ts`. E2E : `_tools/e2e-tts-ui.mjs` enregistre un
« Débit » numérique par le **vrai bouton** et vérifie la persistance sans erreur.

**Chiffres réels** : `npm test` = **505 passed / 4 skipped** (48 fichiers) ;
`npm run typecheck` OK ; `npm run build` OK ; `node --check` OK ; E2E =
**41/41**, **CSP = 0**.

**Reste à confirmer (2-3 questions) :**

1. le **message exact** affiché près du bouton (ou sous « Débit ») lors de
   l'échec — il tranche entre `locked_by_env`, `invalid_config`, `bad_origin`,
   `config_store_unwritable` ou un échec réseau ;
2. le champ était-il **grisé** (badge « verrouillé ») et quelle **valeur** a été
   saisie ?
3. `docker exec yuki-gateway env | grep YUKI_` (variables réellement vues par le
   gateway, au-delà du seul `.env`).

**MAJ (2026-09-22, par l'utilisateur)** : cause identifiée ⇒ la valeur saisie
était **sous le minimum `50`** de `tts.speed` (bornes 50–200) ⇒ `400
invalid_config`. **C28 est clos** ; aucun défaut de code côté Yuki.

---

### 11.16 Émotion réellement appliquée (`options`) + honnêteté UI sur le débit (D42)

> **Ajout du 2026-09-22.** Preuve dans la **copie locale du code source d'`audio.cpp`**
> (`/tmp/audiocpp`, `src/models/chatterbox/session.cpp`). Deux correctifs validés :
> ① brancher les réglages d'émotion là où le moteur les lit réellement ;
> ② ne plus laisser croire que le débit agit pour un moteur qui ne l'applique pas.

**1. Noms de clés et échelle — PROUVÉS (pas de supposition).**

| Fait | Valeur | Preuve (`audio.cpp`) |
| --- | --- | --- |
| Lecture de l'émotion | `make_voice_clone_config(options)` lit **`exaggeration`**, **`guidance_scale`**, `s3gen_cfg_rate`, `temperature`, `repetition_penalty`, `min_p`, `top_p`, `max_tokens`, `seed`, `do_sample`, `stop_on_eos`, `greedy` | `src/models/chatterbox/session.cpp:42-79` |
| Clé « cfg » de Chatterbox (le `tts.cfg` de Yuki) | **`guidance_scale`** (le CFG du **T3** = `cfg_weight` de l'API Python ; **PAS** `cfg`, **PAS** `s3gen_cfg_rate`) | `src/models/chatterbox/session.cpp:47-48`, `src/models/chatterbox/t3_component.cpp:615` (`logits = cond + guidance_scale·(cond−uncond)`) |
| Clé `s3gen_cfg_rate` | CFG du **flux S3Gen** (`(1+cfg_rate)·cond − cfg_rate·uncond`), **autre étage** — équivalent de `model.s3gen.flow.inference_cfg_rate` côté Python ; **non piloté par Yuki** | `src/models/chatterbox/s3gen_flow.cpp:2026-2027`, `tests/chatterbox/chatterbox_python_warm_bench.py:109` |
| Type / échelle | `float` ; **aucune borne** (`parse_float_option` ne clampe pas) ; usage réel | `include/engine/framework/runtime/options.h:36`, `src/models/chatterbox/conditionals.cpp:149` (`emotion_adv = {exaggeration}`) |
| Défauts moteur | `exaggeration = 0.5`, **`guidance_scale = 0.5`**, `s3gen_cfg_rate = 0.7` | `include/engine/models/chatterbox/tts.h:19-32` |
| Clé absente | la valeur par défaut de la struct est conservée (`value_or(config.…)`) | `src/models/chatterbox/session.cpp:45-60` |
| Niveau d'envoi | **OBLIGATOIREMENT dans `options`** : le serveur ne copie au top-level qu'une liste fixe (`seed`, `temperature`, `top_k`, `top_p`, `max_tokens`, `max_steps`, `repetition_penalty`, `guidance_scale`, `num_inference_steps`, `instructions`) puis `request.options = options_from_object(body.options)` | `app/server/runtime.cpp:1994-2006` |

⇒ **Yuki envoie `exaggeration` + `guidance_scale` DANS `options`** (pour-mille →
réel, `/1000`). Le `cfg` top-level (ancien code) était **ignoré** (absent de la
liste fixe). **L'émotion est spécifique à Chatterbox** : aucune autre famille
`tts.engine` (`qwen3-tts`, `cosyvoice3`, `kokoro`, `sanotts`) ne lit ces clés ;
le mode **Turbo** (`chatterbox_turbo`) est une famille **séparée** qui les
**ignore** (`include/engine/community_models/chatterbox_turbo/tts.h:24`).

**2. Traitement du défaut.** Le moteur n'oppose **aucun rejet** à une valeur
(parse float, pas de clamp) : envoyer `exaggeration=0.5` **et**
`guidance_scale=0.5` (les défauts de Yuki = ceux du moteur) est un **no-op** —
le comportement par défaut est **préservé**. (`s3gen_cfg_rate`, non émis, reste au
défaut moteur **0.7**.) Le choix de mapper `tts.cfg` sur `guidance_scale` est ce
qui garantit cette **égalité de défauts** ; le mapper sur `s3gen_cfg_rate`
(défaut 0.7) aurait, lui, **changé** le son par défaut — c'est un argument
décisif du choix.

**3. Comportement par moteur (émis / non émis).**

| Moteur (`tts.engine`) | Débit (`speed`) | Émotion (`options.exaggeration`/`guidance_scale`) | Pourquoi |
| --- | --- | --- | --- |
| `kokoro` | **émis** (`speed`, `runtime.cpp:2119`) | **non émis** | applique la vitesse ; ne lit pas l'émotion |
| `sanotts` | **émis** (appliqué comme `speaking_rate`, `runtime.cpp:2121-2123`) | **non émis** | idem |
| `chatterbox` | **non émis** | **émis (dans `options`)** | ignore `speed` ; **lit** l'émotion |
| `qwen3-tts` | **non émis** | **non émis** | rejetterait `speed` (HTTP 500) ; ne lit pas l'émotion |
| `cosyvoice3` | **non émis** | **non émis** | idem |
| inconnu | **non émis** | **non émis** | omission prudente |

**4. Ce qui est corrigé.**

- **Adaptateur** (`src/tts/audio-cpp.ts`) : `AUDIO_CPP_KEYS.options` (=`"options"`),
  `exaggeration`, `guidanceScale` (=`"guidance_scale"`) ; `engineSupportsEmotion` /
  `EMOTION_CAPABLE_ENGINES` ; l'objet `options` d'émotion n'est posé que pour
  Chatterbox. Export dans `src/tts/index.ts`.
- **UI** (`public/ui/config-patch.js`) : `engineFieldState(path, engine)` (pur) +
  `engineSupportsSpeed` / `engineSupportsEmotion` (miroir de l'adaptateur) ; note
  `ENGINE_UNSUPPORTED_NOTE = "Sans effet avec ce moteur."`.
- **UI** (`public/ui/config.js`) : `refreshEngineFields()` (désactive + note,
  **suit** `tts.engine`, **respecte** `lockedByEnv`) appelé au rendu et à chaque
  `input`. Le champ grisé **n'est PAS retiré** du patch : l'enregistrement reste
  possible (testé).
- **Assistant** (`public/ui/tts-assistant.js`) : bloc « Ce qui reste à faire à la
  main » **corrigé** (service démarré avec la pile ; commande de copie de volume
  nommé remplacée par un dépôt **par bind mount** dans le dossier monté sur
  `/models`, **sans** affirmer de chemin hôte).

**5. Tests.** `tests/tts/audio-cpp.test.ts` (présence/absence par moteur, nom
`options`/`guidance_scale` et absence de `s3gen_cfg_rate`, échelle
`0/500/1000/1500`‰) ;
`tests/ui/config-patch.test.ts` (`engineFieldState`, patch non bloqué, **table UI
synchronisée avec l'adaptateur**) ; E2E `_tools/e2e-tts-ui.mjs` (état du champ
selon le moteur + 0 violation CSP).

---

## 12. Renvois

- [`docs/lot7.md`](lot7.md) — spécification TTS de référence (moteur, pipeline, voix, licences).
- [`docs/runbook.md`](runbook.md) — exploitation, GPU, volumes, dépannage hôte.
- [`docs/architecture.md`](architecture.md) — vue d'ensemble et carte des lots.
- [`docs/lot11.md`](lot11.md) — table `CONFIG_SCHEMA`, page `/config`.
