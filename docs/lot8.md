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
Le service `tts` est de surcroît derrière un **profil Compose opt-in**
(`docker-compose.yml:161-162` : `container_name: yuki-tts`, `profiles: ["tts"]`)
— il n'est donc **pas** démarré par un `docker compose up -d` nu.

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

---

## 3. Design retenu

### 3.1 Un composant UI autonome, monté par `id`

L'assistant est un module ES isolé, **jamais dupliqué** :

```
public/ui/tts-assistant.js:443   # initTtsAssistant(root, deps)
public/ui/tts-assistant.js:444   # root = élément OU id
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
| `unreachable` | Non démarré | accent | Réessayer + action manuelle n°1 |
| `starting` | Démarrage en cours | accent | relance auto discrète |
| `ready` | Prêt | OK | — (« Moteur prêt (N modèles) ») |
| `error` | Erreur | danger | Réessayer + détails techniques |
| *(absence)* | État inconnu | neutre | Réessayer |

Preuves : `public/ui/tts-assistant.js:89-185` ; tests
`tests/tts/ui-assistant.test.ts:51-115`.

### 3.5 Messages d'erreur

`describeTestError()` (`public/ui/tts-assistant.js:213`) mappe le corps d'erreur
du test vers : **message + que faire + détail technique + Réessayer**.

| Cas | Message clé |
| --- | --- |
| moteur absent (`tts_unavailable`) | « Le moteur TTS n'est pas disponible côté gateway. » |
| pas de GPU / injoignable (`unreachable`) | causes **possibles** : conteneur non démarré, profil Compose non activé, **GPU non réservé** (§3.4) |
| aucun modèle installé (`modelsDir.fileCount = 0`) | « Aucun modèle de voix n'est installé. » + chemin + action **hors Yuki** |
| `503 server_busy` | « occupé **OU** manque de mémoire » (jamais tranché) |
| `504 timeout` | « n'a pas répondu dans le délai imparti (tts.timeoutMs). » |
| `502` / `http_error` / `synthesis_failed` | « Le moteur a renvoyé une erreur. » + corps brut |
| `400 text_too_long` | « 500 caractères maximum. » |
| réseau (statut 0) | « La requête n'a pas abouti. » |

Preuves : `public/ui/tts-assistant.js:213-299` ; tests
`tests/tts/ui-assistant.test.ts:139-184`.

---

## 4. Les 2 actions hors interface (et options écartées)

### 4.1 Démarrer le conteneur `tts`

- **Pourquoi hors UI** : le gateway n'a **aucun** accès Docker (§2.1).
- **Action hôte** : `docker compose --profile tts up -d` (à la racine du dépôt
  Yuki, GPU NVIDIA disponible). Le profil est `["tts"]`
  (`docker-compose.yml:162`).

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

1. **Démarrer le moteur** (sur l'hôte, racine du dépôt) :
   `docker compose --profile tts up -d`.
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
| Badge « Non démarré » | conteneur `tts` non démarré / profil non activé | action manuelle n°1, puis « Vérifier le moteur » |
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

`tests/tts/ui-assistant.test.ts` (26 tests) : bornes du texte, mapping des 5
états + inconnu, mapping des erreurs (dont le `503` ambigu), diagnostic disque et
moteur, format des tailles.

### Test d'intégration

`tests/integration/static-ui.test.ts` — bloc « Assistant de mise en route du TTS
(Lot 8) » (`:334`) : assets servis, conteneur de montage, lien CSS, absence de
style inline, routeur du gateway uniquement, pas de `window.confirm`/`innerHTML`.

### E2E headless

`_tools/e2e-tts-ui.mjs` (+ `_tools/e2e-tts-serve.ts`), **hors du dossier du
dépôt mais suivis par git**. Le moteur est **simulé** via un fichier d'état
(`_tools/e2e-tts-serve.ts:134`, `:155`), ce qui exerce les **5 états** de la
carte. Le parcours assistant (`_tools/e2e-tts-ui.mjs:484`) vérifie : les 5
badges, le modèle disque, la liste moteur, le bloc manuel, les boutons, le test
de synthèse, le refus > 500 caractères, la confirmation d'activation (annulée),
et **0 violation CSP**.

### Chiffres réels

| Mesure | Avant | Après |
| --- | --- | --- |
| `npm test` | **403 passed / 4 skipped** (45 fichiers) | **432 passed / 4 skipped** (46 fichiers) |
| E2E assistant | — | **37/37 vérifications OK, violations CSP = 0** |
| `npm run typecheck` | OK | OK |
| `npm run build` | OK | OK |
| `node --check` (JS UI) | OK | OK |

### Captures (thèmes variés, `_tools/shots/`)

`config-assistant-ready.png`, `config-assistant-starting.png`,
`config-assistant-error.png`, `config-assistant-unreachable.png`,
`config-assistant-off.png`, `config-assistant-test.png`,
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
| **D26** | **L'assistant TTS est un composant autonome monté par `id`** (`initTtsAssistant(root, deps)`), **jamais dupliqué** ; son emplacement ne tient qu'à une ligne | `public/ui/tts-assistant.js:443`, `public/ui/config.js:892`, `public/ui/config.html:142` |
| **D27** | **Tout passe par les routes du gateway** (`/api/tts/*`, `/api/config`, `/api/admin/restart`) — **aucun** accès direct au moteur, **aucun** socket Docker | `src/gateway/routes/tts.ts:721-747`, `tests/integration/static-ui.test.ts:364-376` |
| **D28** | **Carte d'état dérivée de la sonde** ; « prêt » **seulement** sur preuve positive ; état inconnu si pas de rapport | `src/gateway/routes/tts.ts:296-303`, `public/ui/tts-assistant.js:89-185` |
| **D29** | **Test par texte libre** (≤ 500 caractères, phrase par défaut en placeholder) ; lecture **Web Audio** (`<audio>` interdit) | `src/gateway/routes/tts.ts:47`, `:673`, `public/ui/tts-assistant.js:29-31` |
| **D30** | **« Activer la voix » = `PUT /api/config` (`tts.enabled=on`) + redémarrage délégué** à la logique existante de `config.js`, avec confirmation HolafModal | `src/config/schema.ts:217-218`, `public/ui/config.js:745`, `public/ui/tts-assistant.js:884` |
| **D31** | **`503` honnête : « occupé OU mémoire insuffisante »** — jamais tranché (contrat non discriminant) | `public/ui/tts-assistant.js:213-299`, `src/tts/audio-cpp.ts:24-27` |
| **D32** | **Les 2 actions hors UI sont documentées dans l'assistant** (démarrage conteneur, dépôt modèle) avec commandes exactes | `public/ui/tts-assistant.js:928-983` |
| **D33** | **Option C (presets générés) écartée en v1** ; le **clonage par upload** est le chemin praticable | §7, `docs/lot7.md` §10 |

### À confirmer (non vérifiable sans GPU / Docker / moteur)

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C18** | **Contrat HTTP réel d'`audio.cpp`** : clé de sélection de voix, clé de langue, exposition d'`exaggeration`/`cfg` ; **si le moteur ignore ces clés, l'UI ne peut pas le détecter** | test réel §6, `src/tts/audio-cpp.ts:1-35` |
| **C19** | **`default_voice_preset`** du moteur : existe-t-il, et quelle voix produit-il avec un registre vide ? | §2.5, §6 |
| **C20** | **Heuristique `modelMatchesEngine`** (id de `/v1/models` ↔ nom de moteur) : à valider sur la vraie liste | `src/gateway/routes/tts.ts:316-323` |
| **C21** | **CLI/port exacts** du service `tts` (hérite `C14`) | `docker-compose.yml:157-165` |
| **C22** | **`503` « Insufficient Memory » indiscernable du `BusyGuard`** : confirmer qu'aucun champ ne les distingue | §3.5, `docs/lot7.md` |
| **C23** | **Fichier de modèle requis** : nom exact du GGUF et variante (Q8/…) selon la cible | §4.2, `docs/lot7.md` §11.6 |

---

## 11. Renvois

- [`docs/lot7.md`](lot7.md) — spécification TTS de référence (moteur, pipeline, voix, licences).
- [`docs/runbook.md`](runbook.md) — exploitation, GPU, volumes, dépannage hôte.
- [`docs/architecture.md`](architecture.md) — vue d'ensemble et carte des lots.
- [`docs/lot11.md`](lot11.md) — table `CONFIG_SCHEMA`, page `/config`.
