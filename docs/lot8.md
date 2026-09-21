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
| **C18** | **Contrat HTTP réel d'`audio.cpp`** : clé de sélection de voix ✅ **levée** (`voice`/`voice_ref`/`reference_text`, §11.5) ; ⚠️ **restent non attestés** : clé de langue HTTP et exposition d'`exaggeration`/`cfg` ; **si le moteur ignore ces clés, l'UI ne peut pas le détecter** | §11, test réel §6, `src/tts/audio-cpp.ts:1-35` |
| **C19** | **`default_voice_preset`** du moteur : existe-t-il, et quelle voix produit-il avec un registre vide ? | §2.5, §6 |
| **C20** | **Heuristique `modelMatchesEngine`** (id de `/v1/models` ↔ nom de moteur) : à valider sur la vraie liste | `src/gateway/routes/tts.ts:316-323` |
| **C21** | ✅ **LEVÉ (2026-09-21, par EXÉCUTION RÉELLE)** — **CLI/port exacts** du service `tts` : l'ENTRYPOINT de l'image est un **dispatcher à sous-commandes** (`cli`/`server`/`model-manager`/`perf`) → `server --config /app/server.json` ; hôte/port sont des **clés de config** (`host`/`port`), pas des flags. Voir §11.4 | §11, `docs/lot7.md` C14 |
| **C22** | **`503` « Insufficient Memory » indiscernable du `BusyGuard`** : confirmer qu'aucun champ ne les distingue | §3.5, `docs/lot7.md` |
| **C23** | **Fichier de modèle requis** : nom exact du GGUF et variante (Q8/…) selon la cible — ⚠️ **non attesté** (l'archive donne `Chatterbox-GGUF` F16+Q8 et la licence MIT, pas les noms de fichiers). Voir §11.7 | §4.2, `docs/lot7.md` §11.6 |

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
| `audio-cpp` | « \| **chatterbox** \| TTS, Clone, VC \| ar, da, de, el, en, es, fi, fr, hi, it, ko, ms, nl, no, pl, pt, sv, sw, tr \| » | **`fr` est une langue supportée** par la famille `chatterbox` |
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
      "task": "tts",
      "mode": "offline"
    }
  ]
}
```

- **`id` = `chatterbox`** est **impératif** : c'est le nom que Yuki envoie (`model: "chatterbox"`) et que `GET /v1/models` renverra.
- **`host: "0.0.0.0"`** pour que le gateway joigne `http://tts:8081` sur `yuki-net` ; `port: 8081` aligné sur le défaut `tts.baseUrl`.
- **`ui_enabled: false`** : pas de WebUI ⇒ aucune écriture liée à l'UI (compatible `read_only: true`).
- **`<fichier-exact>`** : **non attesté** (§11.7) — voir le nom réel dans l'arbre HF `audio.cpp-gguf/Chatterbox-GGUF`.
- **Clé de langue** : **non attestée** comme clé de requête (§11.6). Si l'on veut forcer `fr` au chargement, le **nom de champ** `load_options` / `session_options` / `default_request_options` est attesté, mais la **valeur `language` pour `chatterbox`** ne l'est pas. À défaut, partir du défaut du modèle.

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
| `speed` / `speaking_rate` | **attestée** | « top-level `speed` (or `speaking_rate`) » |
| `voice_ref` | **attestée** | chemin (`"voices/alice.wav"`) **ou** `{ "type": "path", "path": … }` **ou** `{ "type": "base64", "data": … }` (≤ 5 MiB) |
| `voice` | **attestée** | preset configuré, sinon basename `voice_dir/<name>.wav`, sinon id de voix natif |
| `reference_text` | **attestée** | transcrit fourni avec `voice_ref` |
| `options` (objet) | **attestée** (l'**objet**), clés internes non | ex. `"options": { "retry_badcase": false }` |
| `stream_format` | **attestée** | `sse` / `audio` (modèles `streaming`) |
| `seed`, `max_tokens` | **attestées** | exemples README |
| `busy_timeout_ms` | **attestée** | borne d'attente par requête |
| **`language`** (top-level) | **non attestée** | le nom de champ existe pour `load_options`/`session_options` (ex. `"language": "english"`), **pas** démontré top-level de `/v1/audio/speech` |
| **`language_id`** | **non attestée côté HTTP** | attestée **uniquement** dans la lib Python (`generate(..., language_id="fr")`) |
| **`exaggeration`** / **`cfg`** | **non attestées côté HTTP** | documentées **uniquement** pour `chatterbox-tts` (Python) ; **aucune** occurrence dans `audio-cpp-server`/`audio-cpp-http-server`. Indice : la ligne `chatterbox` d'`audio-cpp` **n'a pas** le tag `Ctrl` (contrôle émotion) |

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

**Débit** : `"speed": 1.1` (ou `"speaking_rate": 1.1`) — **attesté top-level**.
**Émotion** : `exaggeration` / `cfg` — **non attestés côté HTTP** (§11.5).

### 11.7 Ce qui reste NON attesté

| Point | Pourquoi |
| --- | --- |
| **Clé de langue HTTP** (`language` vs `language_id`, top-level vs `options`) | seule la lib Python montre `language_id` ; le serveur ne documente `language` que comme `load_options`/`session_options` |
| **Exposition `exaggeration` / `cfg`** par le serveur | aucune occurrence dans les archives serveur ; tag `Ctrl` absent pour `chatterbox` |
| **Nom exact du fichier GGUF** dans `Chatterbox-GGUF` | l'archive donne le **dossier** + variantes **F16 + Q8**, pas les noms de fichiers |
| **Chemin du fichier de config DANS le conteneur** (`/app/server.json` ?) | **non attesté** : ni le WORKDIR ni le `CMD`/les chemins de l'image ne sont documentés. À confirmer en réel (C14). |
| **Sous-commandes du dispatcher** (`server`/`cli`/`model-manager`/`perf`) | **non documentées par les archives** : connues **uniquement** par l'**exécution réelle** (logs `Unknown command: --config`). |
| **Tags `full-cuda13`/`full-cuda12`** | non présents dans les archives (lien vers `docs/docker.md` seulement) |
| **Écritures éventuelles au démarrage** | aucune mentionnée ⇒ `read_only` + `tmpfs /tmp` raisonnable, non garanti par un extrait |

### 11.8 Impact sur les points ouverts

- **C1 — levé pour les voix** : `voice`, `voice_ref` (chemin **ou** base64), `reference_text`, `voice_presets`, `default_voice_preset`, `voice_dir` sont **attestés** ; le mode **par requête** est donc viable (l'hypothèse A↔B se tranche en faveur de **B disponible**). Reste **ouvert** : clé de langue HTTP et émotion (§11.7).
- **C2 — partiellement levé** : `fr` est listé comme langue de la famille `chatterbox` (`audio-cpp`). La **version V3** du checkpoint n'est **pas** attestée dans les archives (la variante s'appelle `Chatterbox-GGUF`, sans « V3 »).
- **C14 — levé (par EXÉCUTION RÉELLE)** : `command: ["server", "--config", "/app/server.json"]`. L'ENTRYPOINT est un **dispatcher à sous-commandes** (`Unknown command: --config`) : c'est une **preuve d'exécution**, pas une déduction d'archive. L'hypothèse `--server --host 0.0.0.0 --port 8081` est **invalidée** : `--host`/`--port`/`--server` n'apparaissent **ni** dans les archives **ni** dans les logs ; hôte/port sont des **clés de config**. ⚠️ Le **chemin** `/app/server.json` **reste à confirmer** (WORKDIR de l'image non attesté).
- **C21 (lot 8)** — levé (hérite C14).
- **C18 (lot 8)** — partiellement levé : clés de voix attestées ; langue/émotion restent à confirmer.
- **C23 (lot 8)** — reste ouvert : nom exact du GGUF.

---

## 12. Renvois

- [`docs/lot7.md`](lot7.md) — spécification TTS de référence (moteur, pipeline, voix, licences).
- [`docs/runbook.md`](runbook.md) — exploitation, GPU, volumes, dépannage hôte.
- [`docs/architecture.md`](architecture.md) — vue d'ensemble et carte des lots.
- [`docs/lot11.md`](lot11.md) — table `CONFIG_SCHEMA`, page `/config`.
