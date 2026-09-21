# Lot 7 — TTS / barge-in

> **Spécification** du **Lot 7 : synthèse vocale (TTS) et interruption vocale
> (barge-in)**. Ce document est le **document de référence** du lot — le plan
> TTS était jusqu'ici **disséminé** dans `docs/lot1.md`, `docs/architecture.md`,
> `docs/runbook.md` et les JSON de profil GPU, sans doc dédié. Il **complète**
> [`docs/architecture.md`](architecture.md) et [`docs/runbook.md`](runbook.md).
>
> ⚠️ **Ce lot n'est pas encore implémenté.** Le document fixe le périmètre, les
> contrats et les décisions **actées** ; les autres points sont explicitement
> marqués **« à confirmer »** (§14). Il est écrit pour être **directement
> exécutable** par la suite.
>
> **Révision du 2026-09-20.** Trois décisions utilisateur viennent d'être
> intégrées : **moteur = Chatterbox Multilingual V3** (§2), **backend =
> CUDA / NVIDIA uniquement** (§11), **voix = presets + clonage via
> l'interface** (§10, section nouvelle et la plus substantielle de cette
> révision).

## Contexte

Le Lot 0 (socle + porte GPU) et le Lot 1 (noyau texte, façade `PiHost`, WS +
rejeu `seq`, UI, instrumentation) sont **implémentés et validés**. Le Lot 2
(multi-LLM + délégation) et le Lot 11 (paramétrage web) le sont aussi. Le Lot 7
s'appuie **entièrement** sur les briques existantes et **n'en refait aucune** :

- l'**abort** du Lot 1 (`src/pi/host.ts`, `src/gateway/ws/protocol.ts`) est
  **réutilisé tel quel** pour le barge-in (`docs/lot1.md:202`) ;
- les **trames binaires** du WS sont déjà **réservées à l'audio** et
  **ignorées proprement** (`src/gateway/ws/server.ts:323-327`) ;
- la **chaîne ouverte** `stage` de l'instrumentation accueille déjà les étages
  audio (`src/pi/instrumentation.ts:4-5`) ;
- la **table de configuration** (`src/config/schema.ts`) et la page `/config`
  (Lot 11) accueillent les champs `tts.*` **sans refonte**.

**Décisions produit validées par l'utilisateur** :

- **français obligatoire** (il parle principalement français) ;
- **choix dans les voix**, **rapidité**, et **idéalement de l'émotion** ;
- **moteur retenu : Chatterbox Multilingual V3** (Resemble AI) — décidé le
  2026-09-20 (§2) ;
- **backend retenu : CUDA / NVIDIA uniquement** — décidé le 2026-09-20 (§11) ;
- **voix : presets + clonage via l'interface** (« quelques voix prédéfinies +
  la possibilité de cloner ») — décidé le 2026-09-20 (§10) ;
- **non-vocalisation** du canal `thinking` + consigne de **« texte parlé
  simple »** ;
- principe hérité de son autre projet **pithagoras** : la synthèse démarre
  **pendant** le stream de la réponse (jamais après la fin du tour).

---

## 1. Objet et périmètre

### Ce que fait le Lot 7

1. **Synthétiser en français**, à la volée, la réponse du LLM léger, **pendant**
   le stream (`channel:"content"` uniquement).
2. **Segmenter par phrase complète** (pour l'intonation) et **préparer au plus
   deux phrases d'avance** (producteur unique, lecture ordonnée) — le principe
   pithagoras (`VOICE_SENTENCE_CHUNKS` + `VOICE_TTS_PREFETCH`).
3. **Transporter** l'audio serveur → client par **trames binaires sur `/ws`**,
   puis **lire en continu côté navigateur** via **Web Audio**.
4. **Gérer les voix** : sélectionner une **voix prédéfinie** et **cloner** une
   voix depuis l'interface (échantillon de référence fourni par l'utilisateur),
   puis la réutiliser (§10).
5. **Barge-in** : l'utilisateur interrompt → purge de la file de synthèse,
   arrêt du producteur, **vider le buffer client**, réutiliser l'abort existant.
6. **Instrumenter** les étages TTS (`sentence_segmented`, `tts_queued`,
   `tts_requested`, `tts_first_byte`, `playback_started`, …) et enrichir
   `run_summary` (TTFA).

### Hors périmètre

- **ASR / PTT / entrée micro** → **Lot 6** (non implémenté).
- **Enregistrement micro pour le clonage** → **écarté définitivement**
  (**D18**, 2026-09-20). L'échantillon de référence est **fourni par upload de
  fichier audio**, jamais capté au micro (`getUserMedia`) : la capture micro
  suppose le Lot 6, et la décision utilisateur est de **ne pas** la prévoir
  pour le clonage.
- **Retour proactif** du modèle → Lot 8.
- **Voix distante / cloud** (ElevenLabs, OpenAI TTS) : hors périmètre
  (privacy + licence + coût).
- **Gestion native des modèles par `audio.cpp`** (installateur embarqué,
  `--ui-management`) : hors périmètre v1 — le modèle est **pré-déposé** dans le
  volume `/models` (lecture seule, §11.6).
- **Authentification / TLS** du service `tts` → Lot 9 (réseau interne
  `yuki-net`, non exposé).

> **Changement de périmètre (2026-09-20).** La version antérieure de cette spec
> plaçait le **clonage depuis l'UI** hors périmètre v1. Il est désormais
> **dedans** : c'est l'objet de la §10.

---

## 2. Moteur retenu

> ✅ **DÉCIDÉ (2026-09-20) : le moteur du Lot 7 est Chatterbox Multilingual V3
> (famille `chatterbox` d'`audio.cpp`).** Qwen3-TTS reste **plan B**,
> Kokoro/sanotts **plan C**. La matrice ci-dessous est conservée comme trace du
> raisonnement.

### 2.1 Méthode et sources

Les agents **n'ont pas d'accès web** : toute affirmation est adossée soit au
dépôt (`fichier:ligne`), soit aux **archives locales** du libraire
(`/app/.data/docs/tools/*.json`, champ `rawContent`). Archives utilisées :

| Archive (fichier) | Contenu utile |
| --- | --- |
| `chatterbox-tts` | Fiche modèle Resemble AI (langues, clonage, émotion, MIT). |
| `tts-opensource-comparison-2026` | Comparatif 5 modèles (langues, licences, VRAM, streaming). |
| `audio-cpp-model-families` | Catalogue des familles de modèles d'`audio.cpp`. |
| `audio-cpp` | README d'`audio.cpp` (tables cœur + communauté, release 0.8.0). |
| `audio-cpp-http-server` | Serveur HTTP (`/v1/audio/speech`, `voice_dir`, presets, streaming, 503). |
| `breeze-tts2-output-format` | Formats de sortie Breeze (24 kHz natif) — sert de **preuve de principe** sur le non-rééchantillonnage. |
| `pithagoras-voice-comparison` | Pipeline vocal pithagoras (segmentation, prefetch). |
| `pithagoras-voice-profiling` | Étages profilés (TTFA, `tts_first_byte`, Web Audio). |

Toute case **non sourcée** est marquée **« non vérifié »**. Aucune source
fournie ne documente la licence de Breeze TTS 2, sanotts ou Kokoro → ces cases
restent **à confirmer**.

### 2.2 Matrice de comparaison

| candidat | statut | français | choix de voix (clonage ? presets ?) | émotion / expressivité | latence / streaming | licence | supporté par `audio.cpp` ? | taille / VRAM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Chatterbox Multilingual V3** | ✅ **RETENU** | **oui** — fiche modèle (« supporting **Arabic, … French** … 23 languages ») et README `audio.cpp` (langue `fr` listée). ⚠️ écart catalogue 18 vs fiche 23 (§2.4) | **clonage zero-shot** (`audio_prompt_path`, réf. ~5 s) ; pas de presets documentés | **oui** — `exaggeration` + `cfg` (défaut `0.5`/`0.5` ; `exaggeration ≈ 0.7` pour le dramatique) | **non documenté** ; pas de tag `Stream` dans la table cœur `audio.cpp` → **synthèse par phrase** (non par token). RTF mesuré **0.252** one-shot, **0.150** long-form (CUDA), ≈ **3.97×** / **6.68×** temps réel (`audio-cpp`) | **MIT** (fiche modèle + comparatif) | **oui** — famille `chatterbox`, `GGUF 16/Q8` | **0.5B** ; ~**4–8 Go** fp16/Q8 (comparatif FAQ ; Q8 −30–37 % VRAM) |
| **Qwen3-TTS** | 🔶 plan B | **oui** — comparatif (« French ») et README `audio.cpp` (langue `fr`) | **clonage zero-shot** (~3 s) **+ 9 presets `CustomVoice` + `VoiceDesign`** ; ⚠️ clonage **et** émotion **non simultanés** | **oui** — instructions en langage naturel (mode non-clone) | **streaming** first-audio ~**97 ms** (implémentation de référence) ; pas de tag `Stream` dans la table cœur → **à vérifier via `audio.cpp`** | **Apache-2.0** (code + poids) | **oui** — `qwen3_tts` 0.6B/1.7B (Base/CustomVoice/VoiceDesign), `GGUF 16/Q8` | 0.6B ~4–8 Go ; **1.7B bf16 ~8–12 Go** |
| **sanotts** | 🔷 plan C | **oui** — README `audio.cpp` (`en, vi, …, **fr**, …`) | **presets uniquement** — 18 voix de **294k à 2,27 M** paramètres ; clonage **non documenté** | **non documenté** | natif **offline** (pas de tag `Stream`) ; très léger → rapide probable (**non vérifié**) | **non documentée dans les archives** — à confirmer | **oui** (communauté) — `sanotts`, `GGUF FP32`, phonémiseur eSpeak-ng | **< 3 M** par voix → VRAM négligeable |
| **Breeze TTS 2** | ❌ écarté | **NON** — README `audio.cpp` : langues `zh, en` **seulement** | clonage prompt-audio | `Ctrl` (instruction-conditionné) **mais pas en français** | 24 kHz natif, streaming supporté | **non documentée dans les archives** ; réputée **recherche / non commerciale** → **à confirmer** | **oui** — `breeze_tts` (ajouté en 0.8.0) | BF16/Q8 |
| **Kokoro 82M** | 🔷 plan C | **oui** — README `audio.cpp` (`en-us, en-gb, es, **fr**, hi, it, ja, pt-br, zh`) | **54 presets**, **pas** de clonage | **non documenté** | 82 M → rapide probable (pas de tag `Stream`), **non vérifié** | **non documentée dans les archives** ; à confirmer | **oui** — famille cœur `kokoro_tts` (Safetensors / GGUF BF16/Q8) ⚠️ **contredit** l'idée reçue « Kokoro n'est pas une famille `audio.cpp` » (elle l'est depuis la 0.8.0) | **82 M** → VRAM très faible |
| **CosyVoice 3.0** | — | **oui** — README `audio.cpp` (`… **fr** …`) et comparatif | clonage **cross-lingue** zero-shot | émotion **par clonage** (héritée de la référence), pas d'instruction | comparatif : streaming oui ; `audio.cpp` pas de tag `Stream` | **Apache-2.0** | **oui** — `cosyvoice3`, `GGUF F32/Q8` | ~0.5B |
| **Sopro V2 Turbo** | — | **oui** — README `audio.cpp` (`en, pt, **fr**, de`) | **clonage zero-shot** | non documenté | **tag `Stream`** (seule famille de clonage marquée *streaming* ici) | **non documentée dans les archives** — à confirmer | **oui** (communauté) — `sopro_tts`, 24 kHz | **120 M** → VRAM faible |
| **XTTS v2** | ❌ | oui (réputé) | excellent clonage | — | — | **non commerciale** | **non** (absent des archives `audio.cpp`, hors périmètre) | — |
| **Fish Speech S2 Pro** | ❌ | couverture large | clonage | tags d'émotion inline | — | **complexe** (Fish Audio Research License / CC-BY-NC-SA-4.0 selon version) | **oui** — `fish_audio`, mais licence à risque | 4B |
| **IndexTTS2** | ❌ | anglais/chinois surtout | clonage | émotion + durée | — | **Apache-2.0 + restriction** (« must not be used to improve other AI models ») | **oui** — `index_tts2` | ~0.5B |

> **Autres familles `audio.cpp` en français** (README 0.8.0) : `outetts`
> (23 langues dont fr), `supertonic` (fr), `voxcpm2` (fr, 48 kHz), `magpie_tts`
> (fr), `confucius4_tts` (fr), `audio8_tts` (fr, communauté, `Stream`),
> `fireredtts3` (24 langues). Elles ne sont pas retenues ici (licence non
> documentée dans les archives, ou pas de clonage **et** émotion en français
> simultanément).

### 2.3 Lecture de la matrice

- **Le français est atteignable** chez plusieurs familles `audio.cpp`, mais
  **Breeze TTS 2 ne le fait pas** (`zh, en`) → le moteur cité dans
  `docs/architecture.md:158-159` (Breeze TTS 2) **est inadapté** et cette
  référence devra être corrigée vers `chatterbox` (hors de ce document, §15).
- **Clonage + émotion + français + licence permissive** ne se réunissent que
  chez **Chatterbox Multilingual V3** (MIT) ; chez **Qwen3-TTS** ils sont
  **mutuellement exclusifs** (clone **ou** émotion) ; chez **CosyVoice 3.0**
  l'émotion est **clonée**, pas dirigée.
- **Kokoro** et **sanotts** sont de très bons candidats **sans clonage**
  (presets) et à **empreinte mémoire minuscule** — utiles en **repli**.
- **Sopro V2 Turbo** est le seul petit modèle de **clonage** marqué `Stream`.

### 2.4 Écart documenté : « 18 langues (catalogue `audio.cpp`) vs 23 (fiche modèle) »

**Constat sourcé** :

- Fiche modèle (`chatterbox-tts`) : « Chatterbox Multilingual supports **… 23
  languages out of the box** » et le tableau du Model Zoo indique
  `Chatterbox Multilingual V3 | 500M | **23+**`.
- Catalogue `audio-cpp-model-families` : « `chatterbox` … **multilingual (18
  languages)** » (ligne du tableau cœur) et, dans *Language and Locale Support*,
  « **chatterbox: 18 languages** for TTS and voice cloning ».
- README `audio-cpp` (table cœur) : la ligne `chatterbox` liste
  **19** langues (`ar, da, de, el, en, es, fi, fr, hi, it, ko, ms, nl, no, pl,
  pt, sv, sw, tr`) — **dont `fr`**.

**Analyse.** Les trois sources divergent (18 / 19 / 23) : les 4 langues
présentes dans la fiche modèle et **absentes** de la liste `audio.cpp` sont
**hébreu, japonais, russe, chinois**. **Le français, lui, est explicitement
listé par `audio.cpp`.** L'écart porte donc sur la **couverture**, pas sur le
français.

**Risque à documenter.** L'implémentation `chatterbox` d'`audio.cpp` (port
GGUF, `docs/tts.md 69-98` cité par le catalogue) peut viser un **checkpoint
multilingue plus ancien (V2)** ou **ne pas exposer le `language_id`** attendu, en
plus du **libellé « 18 »**. Rien dans les archives ne prouve que l'`audio.cpp`
actuel charge le **V3** ni qu'il honore un tag `fr`.

⇒ **Le français via `audio.cpp`/`chatterbox` est PLAUSIBLE mais NON PROUVÉ :
à vérifier en réel avant de figer le déploiement (§13, étape 1).**

### 2.5 Décision : Chatterbox Multilingual V3 (retenu)

**Retenu le 2026-09-20 : Chatterbox Multilingual V3** (`chatterbox` dans
`audio.cpp`).

Justification :

1. **Français** (fiche modèle + langue `fr` listée par `audio.cpp`).
2. **Choix dans les voix par clonage zero-shot** (réf. ~5 s) — exactement la
   demande « du choix dans les voix ».
3. **Émotion** (`exaggeration` / `cfg`) — la seule qui coche **français +
   clonage + émotion** simultanément.
4. **Licence MIT** — conforme à la politique MIT de l'utilisateur.
5. **Supporté par `audio.cpp`** (`GGUF 16/Q8`, 0.5B → tient sur toutes les
   cibles GPU NVIDIA, y compris la Quadro RTX 4000 8 Go).
6. **Débit prouvé** : RTF **0.252** one-shot et **0.150** long-form sur CUDA
   (`audio-cpp`, tables de benchmarks) → nettement plus rapide que le temps réel.

**Plan B : Qwen3-TTS 0.6B (`qwen3_tts`).** Français + clonage + émotion
**séparés**, **Apache-2.0**, VRAM confortable, et **streaming natif ~97 ms** (si
le port `audio.cpp` l'expose). À basculer **si Chatterbox déçoit en français
réel** (l'écart 18/23 §2.4 est le principal risque).

**Plan C (repli léger / faible VRAM) : Kokoro 82M** (presets, pas de clonage) ou
**sanotts** (presets, < 3 M par voix). **Sans émotion pilotée**, mais rapides et
quasi sans VRAM.

> Les **plans B et C restent documentés** : ils seront utiles si la vérification
> réelle du français (§13, étape 1) échoue, ou pour un profil « repli » à VRAM
> très contrainte.

### 2.6 Écarté

- **Breeze TTS 2** : pas de français (`zh, en`).
- **XTTS v2** : licence **non commerciale**.
- **Fish Speech / IndexTTS2 / mira_tts / audio8_asr** : licences complexes ou
  non commerciales (`CC-BY-NC-SA-4.0`, restriction d'usage).
- **Voix cloud** : hors périmètre.

---

## 3. Architecture

### Pipeline complet (principe pithagoras)

```
  SSDK Pi embarqué            gateway (node:http)                         service tts (audio.cpp)
  ─────────────────           ─────────────────────                      ──────────────────────
  run_started
  delta(content) ─────────►  buffer de phrase (par run)
  delta(content)              │
  delta(content)              ├─ découpe sur fin de phrase (§5)
  …                           ▼
                        [file de synthèse bornée]                        POST /v1/audio/speech
                              │  producteur UNIQUE                       ┌──────────────────────┐
                              │  au plus 2 phrases d'avance   ───HTTP──►│  chatterbox (Q8)     │
                              │  ordre garanti (index)                   │  sortie PCM16 mono   │
                              │  ← PCM16 mono s16le ─────────────────────│  (fréquence native)  │
                              ▼                                          └──────────────────────┘
                        enveloppe binaire WS (§4)
                              │  trame BINAIRE (pas le flux JSON `seq`)
                              ▼
  navigateur ──────────────────────────────────────────────────────────────────────────────────
  public/ui/app.js  →  Web Audio : schedule des blocs PCM en continu
                        (AudioContext + AudioBufferSourceNode.start(when))
                        file d'attente locale + `nextStartTime`
  barge-in : abort (Lot 1) → purge file serveur + stop producteur + flush buffer client
```

> **Fréquence native.** Le pipeline ne fixe **pas** le taux : il transporte le
> taux **déclaré par le service `tts`** dans l'en-tête de trame (§4.2). La
> fréquence native de **Chatterbox** n'est pas documentée dans les archives et
> devra être **relevée en réel** (§13, C3).

### Où vit chaque étage, et pourquoi

| Étage | Où | Pourquoi |
| --- | --- | --- |
| **Capture du `channel:"content"`** | **gateway**, au-dessus du PiHost | Le gateway voit déjà chaque `delta` (`src/gateway/ws/server.ts`) ; il peut **filtrer `thinking`** et découper sans toucher au SDK. |
| **Buffer + segmentation par phrase** | **gateway**, **par `runId`** | Le buffer de phrase est **propre au run** : un nouvel envoi / un abort doit jeter le résidu. Le gateway connaît `runId`/`sessionId`. |
| **File + prefetch (producteur unique)** | **gateway** | Contrainte pithagoras : **un seul producteur**, **au plus 2 phrases d'avance**, **ordre garanti**. Le producteur doit être **annulable** (barge-in) → côté serveur, près de l'abort. |
| **Synthèse** | **service `tts`** (`audio.cpp`) | Processus séparé : CRASH / OOM éventuel **n'abat pas** le gateway ; peut utiliser **une image CUDA dédiée** ; le modèle vit dans **son** espace mémoire. Communication **HTTP** (`POST /v1/audio/speech`). |
| **Gestion des voix (registre, clonage)** | **gateway** (API + UI), fichiers dans un volume, modèle dans le service `tts` | C'est une **fonctionnalité Yuki** (registre, validation, UI) ; le service `tts` ne fait que **consommer** la référence (§10). |
| **Trames binaires** | **gateway → navigateur** sur `/ws` | Déjà « réservées à l'audio » et ignorées proprement (`src/gateway/ws/server.ts:323-327`). |
| **Lecture PCM** | **navigateur** (**Web Audio**) | La **CSP interdit `<audio src>`** (§4) : seul Web Audio peut lire des trames WS. Il possède l'horloge de sortie (`AudioContext.currentTime`). |

> **Pourquoi pas de synthèse dans le gateway ?** Le gateway est Node, mono-
> thread, avec rootfs `read_only` ; embarquer un runtime d'inférence natif y est
> impossible et contraire à l'invariant « aucune dépendance native ». Le service
> `tts` séparé absorbe les pics et les plantages.

> **Pourquoi un producteur unique ?** L'API `audio.cpp` **sérialise déjà par
> modèle** via un `BusyGuard` (renvoie **HTTP 503** si le modèle est occupé,
> `audio-cpp-http-server`). Lancer plusieurs synthèses en parallèle ne ferait
> que **provoquer des 503** : mieux vaut **une** file ordonnée côté gateway.

---

## 4. Transport & format

### 4.1 Trames binaires sur `/ws`

Les trames serveur → client sont **binaires** (`Buffer`/`Blob` côté navigateur).
Elles **ne passent pas** par le flux JSON à `seq` : l'UI actuelle les ignore
déjà (`public/ui/app.js:286` : `if (typeof event.data !== "string") return;`).

**Conséquences de conception** (à acter) :

- **Les trames audio ne sont PAS rejouables.** Le buffer de rejeu
  (`src/gateway/ws/session-stream.ts`) ne stocke que le JSON ; après une
  reconnexion, l'audio déjà émis est **perdu**. Le client **repart de `idle`**
  pour le son : il cesse d'attendre les segments manquants et le gateway peut
  **re-synthétiser** la phrase en cours si le run est encore actif (au plus 2).
- **Ordre propre** : chaque trame porte un **`segmentIndex` monotone par
  `runId`** (0, 1, 2…), **indépendant** du `seq` JSON. Le client lit **dans
  l'ordre** ; un index manquant n'est **pas** attendu indéfiniment (il est
  considéré perdu → trou de lecture toléré, journalisé).

### 4.2 En-tête applicatif proposé

Un **en-tête JSON** (métadonnées) suivi du **payload PCM brut** :

```
┌──────────┬────────────────┬─────────────────────────────┬─────────────────────┐
│ magic(4) │ headerLen(4)   │ header JSON (UTF-8)         │ payload PCM (n octets)│
│ "YTA1"   │ big-endian u32 │ { …métadonnées… }           │ s16le, mono          │
└──────────┴────────────────┴─────────────────────────────┴─────────────────────┘
```

En-tête JSON proposé (sérialisable, versionné) :

```jsonc
{
  "v": 1,
  "type": "tts_audio",
  "sessionId": "…",
  "runId": "…",
  "segmentIndex": 3,      // monotone par runId, ordonne la lecture
  "codec": "pcm_s16le",   // PCM signé 16 bits little-endian
  "sampleRate": 24000,    // fréquence NATIVE du modèle (pas de rééchantillonnage)
                          // ⚠️ valeur Chatterbox à confirmer en réel (§13, C3)
  "channels": 1,
  "byteLength": 4800,     // octets de payload PCM
  "final": false          // true = dernier segment du run
}
```

**Pourquoi un en-tête ?** Sans lui, le client est aveugle sur le format, le taux,
la longueur et l'ordre. Un **magic** permet de rejeter proprement une trame
inattendue ; `headerLen` rend le parsing **robuste** sans deviner un séparateur
(le PCM peut contenir n'importe quel octet).

### 4.3 Format recommandé : **PCM s16le mono à la fréquence NATIVE**

- **PCM signé 16 bits little-endian, mono.**
- **Fréquence native du modèle** — **ne PAS rééchantillonner en 48 kHz**.

**Pourquoi ne pas rééchantillonner en 48 kHz** (demande initiale de l'utilisateur,
motivée par un rendu « numérique ») : `breeze-tts2-output-format` est explicite —
« Breeze generates native 24000 Hz audio. A profile that names a higher sample
rate **resamples that output** … **It does not add acoustic bandwidth or improve
the source quality.** » Ce constat vaut **par principe** pour tout moteur : la
**naturalité** vient du **modèle**, de la **voix** et de la **prosodie**, **pas**
de la fréquence. Rééchantillonner ne ferait que **gonfler la bande passante**
(×2 d'octets) et **ajouter de la latence**. La **fréquence native exacte de
Chatterbox** reste à relever (§13, C3) — c'est une valeur d'en-tête, pas un choix
de conception.

### 4.4 CSP : `<audio src>` interdit ⇒ **Web Audio obligatoire**

La CSP servie par le gateway est
(`src/gateway/routes/static.ts:46`) :

```
default-src 'none'; script-src 'self'; style-src 'self';
connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

Il n'y a **aucun `media-src`** → une balise `<audio src="…">` (ou un `Blob` URL
chargé par un média) est **bloquée**. En revanche `connect-src` autorise **`ws:`**
→ **les trames binaires du WebSocket passent**, et **`'self'`** → un `fetch`
interne (utile pour les extraits de démonstration de voix, §10.5). Côté client,
on construit donc un `AudioBuffer` **à la main** :

1. décoder le payload (`Int16Array` → `Float32Array`, `sample /= 32768`) ;
2. `audioCtx.createBuffer(1, frames, sampleRate)` + `copyToChannel` ;
3. `AudioBufferSourceNode` planifié avec `start(when)` sur une horloge
   `nextStartTime = max(currentTime, nextStartTime)` (lecture **continue**, pas
   de « blanc » entre phrases).

**Important** : ne pas utiliser `audioContext.decodeAudioData()` sur le **PCM
brut** (il exige un conteneur WAV/MP3). Pour un **extrait de démonstration**
(§10.5), le service renvoie un **WAV encodé** (`encode_pcm16_wav`,
`audio-cpp-http-server`), lui **décodable** par `decodeAudioData` — c'est le seul
cas où on l'emploie.

**Autoplay** : le `AudioContext` démarre `suspended` tant qu'aucun geste
utilisateur n'a eu lieu ; on le `resume()` au premier `message` (l'utilisateur a
forcément cliqué « Envoyer »).

**Barge-in côté client** : `sourceNode.stop()` sur **tous** les nœuds planifiés,
puis `nextStartTime = 0` (voir §7).

### 4.5 Contrat de trame binaire — **IMPLÉMENTÉ (Lot B)**

> Cette section **gèle** le contrat. Elle **précise** l'en-tête proposé en §4.2
> (les trames sont émises en binaire par `src/tts/framing.ts`).

**Format** (octets) :

```
┌────────────┬──────────────────┬─────────────────────────┬────────────────────────┐
│ magic (4)  │ headerLen (4)    │ header JSON (UTF-8)     │ payload PCM (n octets) │
│ "YTA1"     │ u32 big-endian   │ { …métadonnées… }       │ s16le, mono            │
└────────────┴──────────────────┴─────────────────────────┴────────────────────────┘
```

- `magic` = `YTA1` (ASCII) ; toute trame dont le magic diffère est **ignorée**
  proprement (le serveur ne lève jamais sur une trame inattendue).
- `headerLen` = longueur du JSON en octets (u32 **big-endian**) ; rend le
  parsing **robuste** (le PCM peut contenir n'importe quel octet).
- `payload` = PCM signé 16 bits little-endian, **mono**, à la fréquence
  **native** du moteur (aucun rééchantillonnage, §4.3).

**En-tête JSON** :

```jsonc
{
  "v": 1,
  "type": "tts_audio",   // "tts_audio" | "tts_end" | "tts_cancel"
  "sessionId": "…",
  "runId": "…",
  "segmentIndex": 3,      // monotone par runId → ordonne la lecture
  "chunkIndex": 0,        // index du bloc DANS le segment (concaténation ordonnée)
  "codec": "pcm_s16le",  // PCM signé 16 bits little-endian
  "sampleRate": 24000,    // fréquence NATIVE du moteur (pas de rééchantillonnage)
  "channels": 1,          // 1 = mono
  "byteLength": 4800,     // octets de payload (forcé à la taille réelle à l'encodage)
  "final": false          // true = DERNIER bloc PCM de CE segment
}
```

**Sémantique des types** :

| `type` | Payload | Sens |
| --- | --- | --- |
| `tts_audio` | PCM | Bloc audio. `segmentIndex` ordonne les segments ; `chunkIndex` ordonne les blocs d'un même segment. Le bloc de **clôture de segment** porte `final: true` et un payload **vide**. |
| `tts_end` | vide | **Fin de run** : tous les segments ont été émis ; le client peut clore sa file de lecture. |
| `tts_cancel` | vide | **Purge barge-in** : le client vide **immédiatement** son buffer audio (voir §7). |

> **Écart assumé vs §4.2.** La proposition initiale réservait `final` à
> « dernier segment du run ». Le contrat **implémenté** l'utilise comme
> « dernier bloc du **segment** » (nécessaire en streaming, où l'on ignore si
> le segment courant est le dernier) ; la fin de run est portée par une trame
> dédiée `tts_end`. Cet écart est plus robuste pour le client.

**Articulation avec le rejeu `seq` (§4.1).** Les trames binaires **ne passent
pas** par `SessionStream` : elles ne consomment aucun `seq`, ne sont **pas
bufferisées** et **ne sont pas rejouées** après reconnexion. Un segment audio
perdu à la reconnexion n'est **pas** grave (contrairement au texte, qui reste
rejouable) : le client repart d'un buffer audio vide et le gateway peut
re-synthétiser la suite. **Décision retenue** : ne pas complexifier le rejeu
texte ; l'audio est **best-effort**.

**No-op.** Si `tts.enabled !== "on"`, le pipeline (`src/tts/pipeline.ts`) est un
**no-op total** : aucune trame binaire, aucun `await`, aucune erreur. Un moteur
injoignable ou un segment en échec est **journalisé puis abandonné** (réessai
borné sur `503`/timeout) — la réponse texte n'est jamais affectée.

**Décodage côté client.** Une trame est décodable par `decodeTtsFrame()`
(`src/tts/framing.ts`) : `null` si le magic/JSON/longueur diffère. Le client
lit dans l'ordre `(segmentIndex, chunkIndex)` et peut tolérer un `segmentIndex`
manquant (trou, journalisé).

---

## 5. Segmentation

Segmenter par **phrase complète** (et non par token) : l'intonation d'un modèle
TTS s'effondre sur des fragments. Règles **exactes** proposées :

| Règle | Valeur proposée | Raison |
| --- | --- | --- |
| **Fin de phrase** | sur `.` `!` `?` `…` (et leurs variantes), **suivis d'un blanc ou de la fin** | Ponctuation forte = frontière prosodique naturelle. |
| **Longueur minimale** | **24 caractères** (configurable) | Éviter les énoncés hachés (« Oui. » « Non. ») qui sonnent robotiques. |
| **Longueur maximale** | **240 caractères** (configurable) | Anti-blocage et **anti-« quirk » des longues lectures** (la synthèse d'un très long segment retarde tout le pipeline et rend le barge-in peu réactif). Dépassement → couper à la **virgule** la plus proche, sinon à l'**espace** avant la borne. |
| **Résidu en fin de run** | `flush` systématique sur `run_finished` | Ne jamais perdre la dernière phrase sans ponctuation finale. |
| **Markdown / blocs de code** | **filtrage** : retirer les délimiteurs ` ``` `, `` ` ``, `**`, `*`, `#`, `[]()` | Le TTS ne doit **pas** épeler la syntaxe. **Décision proposée** : le **code** (fence ` ``` `) est **remplacé par une courte annonce** (« Bloc de code omis ») — **à trancher** avec l'utilisateur (§14). |
| **Canal `thinking`** | **JAMAIS** vocalisé | Demande explicite + cohérence Lot 1 (le `thinking` ne figure pas non plus dans le transcript). |
| **Tours `origin:"job_report"`** | vocalisés comme les autres | Ce sont des réponses destinées à l'utilisateur (résumé du worker lourd). |

**Frontière de phrase et état du stream.** Un delta peut couper au milieu d'une
phrase : on ne synthétise qu'une fois la **ponctuation + blanc** observée (ou la
borne max atteinte). Le buffer de phrase est **vidé** à `run_finished` ou
`abort`.

> **Implémenté (Lot B) — filtrage markdown.** Le filtre
> (`src/tts/markdown.ts`) retire titres, puces, emphases, backticks et réécrit
> les liens `[texte](url)` → `texte`. Les blocs de code clôturés (``` ``` ```)
> sont **ignorés** (défaut retenu pour **C8**) ; un bloc non clôturé est ignoré
> jusqu'au `flush`. Ce choix est **ajustable** : l'option `codeAnnouncement`
> insère une annonce (« Bloc de code omis ») à la place de l'omission
> silencieuse. Limites documentées dans le module (ponctuation dans une
> citation, marqueurs coupés entre deltas).

> **Note pithagoras** : `VOICE_SENTENCE_CHUNKS=true` fait exactement cela
> (« text sentences are submitted during LLM generation, each complete sentence
> audio plays before the next sentence is synthesized ») et
> `VOICE_TTS_PREFETCH=true` ajoute « a single TTS producer alongside ordered
> playback, with at most **two** fully prepared phrases queued ahead ». On
> **reprend ces deux invariants**.

---

## 6. Consigne de voix

**Le texte destiné à l'oreille n'est pas le texte destiné à l'écran.** Pithagoras
utilise `VOICE_RESPONSE_INSTRUCTIONS` : « brief plain-text speech, canvas-first
detailed reports, pre-tool spoken announcements and emotion-cue guidance », et
**supprime** les annonces `thinking`/`compaction` (`VOICE_STATUS_SPEECH=false`,
`VOICE_SKIP_FIRST_THINKING`, suppression du remplissage
thinking/compaction — `pithagoras-voice-comparison`).

Le prompt système actuel (`config/pi/system-prompt.md`) **n'évoque pas** la
voix. Le prompt du **léger** est le bon endroit : c'est lui qui **parle** au
Lot 7.

**Proposition de rédaction** — ajouter à `config/pi/system-prompt.md` une
section conditionnée à la voix (ou un **prompt dédié** si l'on préfère ne pas
alourdir le prompt généraliste). Rédaction concrète :

```markdown
## Voix

Quand ta réponse est lue à voix haute :

- Écris un **texte parlé simple** : phrases courtes, ponctuation claire,
  pas de listes à puces, pas de titres markdown, pas de tableaux.
- **Pas de symboles** : ni emoji, ni `*`, ni `#`, ni liens bruts, ni blocs de
  code. Décris brièvement ce que ferait un bloc de code au lieu de le citer.
- **Pas de remplissage** (« Bien sûr ! », « Je vais maintenant… », méta-
  commentaires de réflexion).
- Donne les **rapports détaillés à l'écran**, et une **version orale brève**
  (une à trois phrases) — l'écran reste la source complète.
- Ne vocalise **jamais** ta réflexion : seule la réponse finale est lue.
```

- La consigne n'est **pas** un « mode » distinct : elle vit dans le **prompt du
  léger**, comme pithagoras dans `VOICE_RESPONSE_INSTRUCTIONS`.
- En complément, le gateway **ignore** structurellement le `channel:"thinking"`
  (§5) : même si le modèle triche, rien de réflexif n'est vocalisé.

> **À trancher** : prompt modifié **en dur** vs **champ `prompts.light`**
> (déjà présent, `apply: "restart"`). Recommandation : **champ existant** pour
> rester dans la logique Lot 11, avec un **défaut pré-rempli** côté fichier.

---

## 7. Barge-in / interruption

**Réutilisation TEL QUE de l'abort du Lot 1** (`docs/lot1.md:202`). Aucune
nouvelle primitive : le Stop / une nouvelle saisie / (plus tard) la voix
déclenchent la même séquence.

Séquence exacte :

1. **Client → serveur** : `abort { runId? }` (trame WS existante,
   `src/gateway/ws/protocol.ts`).
2. **Gateway** : `host.abort(sessionId, runId)` (abort du run en vol **et** purge
   de la file FIFO de messages, Lot 1).
3. **Gateway (TTS)** : le run concerné passe à l'état `aborting` :
   - **vider la file de synthèse** (les segments non encore synthétisés) ;
   - **arrêter le producteur unique** (annuler l'itération) ;
   - **annuler la requête HTTP en vol** vers le service `tts`
     (`AbortController` côté `fetch`) ;
   - jeter le **buffer de phrase** résiduel ;
   - émettre un **marqueur d'annulation** côté audio : trame binaire `YTA1`
     `{"type":"tts_cancel","runId":…}` (payload vide), §4.5.
4. **Client** : sur `run_finished(reason:"abort")` **ou** sur le marqueur
   d'annulation : `sourceNode.stop()` sur **tous** les nœuds planifiés et
   **vider le buffer d'attente** (`nextStartTime = 0`). Le son s'arrête
   **immédiatement**.
5. **UI** : l'état repasse `idle`, le bouton Stop se désactive (comportement
   Lot 1 inchangé).

> **Implémenté (Lot B).** Le pipeline TTS (`src/tts/pipeline.ts`) est branché sur
> les événements de la façade : l'`abort` client appelle **directement**
> `tts.cancel(sessionId, runId)` (en plus de `host.abort`) ; `run_finished` avec
> une raison ≠ `done`, ou un **nouveau** `run_started`, déclenche
> `cancelRun(...)` : **file vidée**, `AbortController` de la synthèse en vol
> **annulé**, buffer de phrase **jeté**, puis trame `tts_cancel` diffusée. Le
> pipeline ne crée **aucune** primitive d'abort concurrente : il **réutilise**
> celle du Lot 1.

**Points d'attention** :

- Le service `tts` peut être **en cours d'inférence** au moment de l'abort : la
  réponse HTTP abandonnée côté gateway n'arrête **pas** forcément le calcul
  `audio.cpp`. Comme le `BusyGuard` **sérialise**, le prochain segment attendra
  la fin ; c'est acceptable (au plus **une** synthèse « orpheline »).
- Un `abort` en `idle` reste un **no-op idempotent** (Lot 1).

---

## 8. Instrumentation

Aujourd'hui, `tts_first_byte` n'existe qu'en **commentaire**
(`src/pi/instrumentation.ts:4-5`) et **n'est pas** dans la table `PHASE`
(`src/pi/instrumentation.ts:19-38`). Il faut **définir** les étages.

**Forme respectée** (§ alignée sur l'existant) : `stage` = **chaîne ouverte**,
événement `phase { runId, sessionId, stage, at (ISO-8601), sinceT0Ms }` +
ligne JSON-lines `pi.phase`, corrélation `session_id` puis `run_id`.

**Étages TTS proposés** (à ajouter à `PHASE`) :

| Étage | Sémantique | Émetteur |
| --- | --- | --- |
| `sentence_segmented` | une **phrase complète** vient d'être extraite du `content` | gateway |
| `tts_queued` | segment **mis en file** du producteur unique (avec profondeur courante) | gateway |
| `tts_requested` | requête `POST /v1/audio/speech` **émise** vers le service `tts` | gateway |
| `tts_first_byte` | **premier octet PCM** reçu du service `tts` (par segment ; le **premier** du run ≈ TTFA serveur) | gateway |
| `tts_segment_done` | segment **entièrement reçu** | gateway |
| `tts_retry` | **503 server busy** reçu → réessai borné (backoff) | gateway |
| `tts_cancel` | barge-in : file/producteur annulés | gateway |
| `playback_started` | premier bloc **réellement planifié/démarré** côté navigateur (Web Audio `currentTime`) | **client → serveur** |
| `playback_aborted` | arrêt du son côté navigateur | **client → serveur** |

**`playback_started` / `playback_aborted` sont côté client.** Les `phase` sont
aujourd'hui émis **côté serveur**. Proposition : une **trame client → serveur**
`playback { runId, event: "started"|"aborted", at }` que le gateway **ré-émet**
en `phase`. Alternative (plus simple, v1) : mesurer ces deux étages **localement**
dans l'UI (console/`localStorage`) et ne **pas** les faire remonter — **à
trancher** (§14).

> **Implémenté (Lot B).** Les étages serveur (`sentence_segmented`,
> `tts_queued`, `tts_requested`, `tts_first_byte`, `tts_segment_done`,
> `tts_retry`, `tts_cancel`) sont **réellement émis** par le pipeline gateway
> via `host.recordRunStage(...)`, avec la même corrélation/logging que les
> étages texte. Le **point d'émission** `playback` est **préparé** côté contrat
> (`ClientMessage` + `parseClientMessage` + ré-émission en `phase`) mais **aucune
> UI ne l'envoie encore** dans ce lot : `playback_started`/`playback_aborted`
> restent donc **non émis** tant que le lot UI ne les remonte pas.

**`run_summary` enrichi** (champs **optionnels**, rétro-compatibles) :

```jsonc
{
  "type": "run_summary",
  "runId": "…",
  "ttftMs": 420,        // existant (LLM)
  "totalMs": 3100,      // existant
  "tokensIn": 512,      // existant
  "tokensOut": 180,     // existant
  "ttfaMs": 780,        // NOUVEAU : t0 → premier octet PCM du 1er segment
  "ttsSynthMs": 640,    // NOUVEAU : cumul tts_requested → tts_segment_done
  "ttsSegments": 4      // NOUVEAU : nombre de segments synthétisés
}
```

**Alignement pithagoras** (`pithagoras-voice-profiling`) : leur profilage
partitionne le temps en « **sentence accumulation**, **TTS queue**, **TTS
request to first received bytes**, **buffering/decoding**, and playback queue/
output estimate », et la métrique principale va de « last VAD speech to
estimated first generated-reply playback ». On reprend la même **nomenclature
d'étages**, en notant que le **barge-in** remplace le VAD (Lot 6 non
implémenté) : la métrique v1 est **`t0` serveur → `playback_started`**.

**Journalisation** : une ligne `pi.phase` par étage (comme aujourd'hui) ; les
étages TTS utilisent la **même** corrélation. Pas de nouveau logger.

---

## 9. Configuration

### 9.1 Champs `tts.*` dans `src/config/schema.ts`

⚠️ **Contrainte structurelle** : `FieldType = "string" | "int" | "enum"`
(`src/config/schema.ts:19`) — **AUCUN booléen**, **AUCUN flottant**. Les
grandeurs réelles (`exaggeration=0.5`, `cfg=0.5`) deviennent des **entiers en
pour-mille** (0–1500), convertis à la lecture (`value / 1000`).

| Champ | Type | Enum / bornes | Défaut | `apply` | Env |
| --- | --- | --- | --- | --- | --- |
| `tts.enabled` | `enum` | `["off","on"]` | `off` | `restart` | `YUKI_TTS_ENABLED` |
| `tts.engine` | `enum` | `["chatterbox","qwen3-tts","cosyvoice3","kokoro","sanotts"]` | `chatterbox` | `restart` | `YUKI_TTS_ENGINE` |
| `tts.baseUrl` | `string` | — | `http://tts:8081` | `restart` | `YUKI_TTS_BASE_URL` |
| `tts.language` | `enum` | `["fr"]` | `fr` | `restart` | `YUKI_TTS_LANGUAGE` |
| `tts.voice` | `string` | id de voix (§10.1) ; `""` = **voix par défaut** (preset) | `""` | `hot` | `YUKI_TTS_VOICE` |
| `tts.emotion` | `enum` | `["neutre","expressive","dramatique","personnalisee"]` | `neutre` | `hot` | `YUKI_TTS_EMOTION` |
| `tts.speed` | `int` | `min 50`, `max 200` (% du débit) | `100` | `hot` | `YUKI_TTS_SPEED` |
| `tts.exaggeration` | `int` | `min 0`, `max 1500` (pour-mille → `0.0–1.5`) | `500` | `hot` | `YUKI_TTS_EXAGGERATION` |
| `tts.cfg` | `int` | `min 0`, `max 1500` (pour-mille → `0.0–1.5`) | `500` | `hot` | `YUKI_TTS_CFG` |
| `tts.prefetchDepth` | `int` | `min 0`, `max 2` | `2` | `hot` | `YUKI_TTS_PREFETCH` |
| `tts.minSentenceChars` | `int` | `min 8`, `max 500` | `24` | `hot` | `YUKI_TTS_MIN_SENTENCE` |
| `tts.maxSentenceChars` | `int` | `min 40`, `max 2000` | `240` | `hot` | `YUKI_TTS_MAX_SENTENCE` |
| `tts.timeoutMs` | `int` | `min 1000`, `max 120000` | `15000` | `hot` | `YUKI_TTS_TIMEOUT_MS` |
| `tts.volume` | `int` | `min 0`, `max 100` | `100` | `hot` | `YUKI_TTS_VOLUME` |

**`apply`** : `hot` = pris en compte au prochain segment (débit, émotion, voix,
prefetch, bornes) ; `restart` = nécessite un redémarrage (activation, moteur,
URL, langue). **Pourquoi** : changer d'`engine` ou activer le TTS suppose que le
service `tts` soit là → pas de bascule à chaud.

> `tts.voiceRef` (chemin/borné, version antérieure) est **remplacé** par
> `tts.voice` (identifiant de voix du **registre** §10.1). Le chemin physique de
> l'échantillon est une **donnée dérivée**, jamais un champ de config exposé.

> **Activation & profil.** `tts.enabled` **ne remplace pas** la décision de
> profil : en `texte-seul`, le TTS reste **désactivé** quelle que soit la valeur
> (le service n'existe pas). La valeur `on` **ne fait qu'autoriser** le TTS
> quand le profil le permet.

### 9.2 Page `/config` (UI)

La page code ses groupes **en dur** (`public/ui/config.js:72`, `const GROUPS`) :
il faut donc **ajouter** un groupe `tts` (titre « Voix / TTS ») avec les champs
ci-dessus (`kind: "select"` pour les enums, `"number"` pour les entiers,
`kind: "text"` pour `tts.voice`). Ajouter les options d'enum dans `OPTIONS`
(`public/ui/config.js:52`). La **gestion des voix** (liste, clonage) fait l'objet
d'un **bloc dédié** dans cette page — §10.5.

### 9.3 Toggle dans la topbar — **IMPLÉMENTÉ (Lot C)**

La **topbar** de la page chat (`public/ui/index.html`) porte un bouton
**haut-parleur** `#tts-toggle` (icône + `aria-label` + `aria-pressed`, focus
visible, mêmes styles que les contrôles de thème).

**Articulation retenue (D21)** — la plus prévisible, sans état incohérent :

- **Activation serveur** : `tts.enabled` reste piloté **exclusivement** par la
  page `/config`. Il est `apply: "restart"` (`src/config/schema.ts:219`) : le
  faire basculer depuis la topbar serait soit trompeur (valeur stockée mais
  inactive jusqu'au redémarrage), soit lourd. La page chat le **lit** via
  `GET /api/config`.
- **Sourdine locale** : le bouton bascule une préférence **par navigateur**
  (`localStorage["yuki-tts-muted"]`, précédent `yuki-theme`). Couper la voix
  **vide immédiatement** le buffer (`player.stopAll()`), sans aller-retour
  réseau.
- **Cohérence d'affichage** : le bouton reflète l'état **effectif**
  `serveur ∧ non sourd`. Si `tts.enabled !== "on"`, il est présenté comme
  **inactif** (libellé « Voix désactivée (TTS serveur inactif) ») — il ne
  prétend jamais que la voix est active. Si la config est illisible (réseau),
  l'état est traité comme **inconnu/off** plutôt que « on » par défaut.
- **Moteur absent** : le TTS n'expose pas d'état de disponibilité par
  l'API/health ; l'UI détecte le cas « requête TTS émise (`phase tts_requested`)
  mais **aucun premier octet** (`tts_first_byte`/trame) avant `run_finished` »
  et affiche alors un message honnête (`#tts-status`, `role="status"`).

Le serveur produit (s'il est activé), l'UI choisit de lire ou de **jeter** les
trames binaires (sourdine). Aucun champ de config supplémentaire n'est requis.

---

## 10. Gestion des voix (presets + clonage)

> ✅ **DÉCIDÉ (2026-09-20) : l'utilisateur veut « quelques voix prédéfinies + la
> possibilité de cloner ». Cette section conçoit la fonctionnalité.**

C'est une **fonctionnalité visible** : elle touche le registre de voix (serveur),
le stockage (volume), des **endpoints** dédiés, l'**UI** et la **config**. Le
contrat réel d'`audio.cpp` n'est que **partiellement documenté** (§10.2) : les
points non prouvés sont marqués et reportés en « à trancher » (§14).

### 10.1 Modèle de voix (abstraction Yuki)

Une **voix** est une entité **Yuki** (et non un artefact d'`audio.cpp`). Presets
et voix clonées **partagent la même abstraction** ; seule la **provenance**
change. Une voix est une voix.

```
Voix {
  id:         string   // slug stable, unique, URL-safe  ex. "camille", "clone-7f3a2b"
  label:      string   // libellé affiché dans l'UI      ex. "Camille (FR)"
  kind:       "preset" | "cloned"
  lang:       "fr"     // langue de la voix (référence + synthèse)
  refAudio:   string | null  // chemin du WAV de référence DANS le volume voix
                             //   preset  : fourni à l'installation
                             //   cloned  : écrit par l'upload utilisateur
  refText:    string | null  // transcription de l'échantillon (optionnel)
  createdAt:  string   // ISO-8601
  createdBy:  "factory" | "user"
}
```

- **`preset`** : voix fournie avec Yuki (déposée à l'installation, `createdBy:
  "factory"`). Elle correspond à une `VoicePreset` d'`audio.cpp` (`voice_ref`
  vers un WAV, `reference_text` optionnel — §10.2).
- **`cloned`** : voix créée par l'utilisateur via l'**UI** (`createdBy:
  "user"`), à partir d'un échantillon qu'il fournit.
- **`refAudio`** est un chemin **interne** au volume voix (§10.3) ; il n'est
  **jamais** exposé tel quel par l'API (l'API manipule des `id`).
- Le **registre** Yuki (`voices.json`) contient cette liste ; c'est la **source
  de vérité** côté Yuki. Le service `tts` n'en voit que la projection
  (`voice_presets`/`voice_ref` — §10.2).

> **Une seule abstraction ⇒ un seul code d'UI** : la liste, le sélecteur, la
> suppression et l'écoute d'aperçu traitent `preset` et `cloned` de la même
> façon. Seuls l'**origine** (badge « prédéfinie » / « clonée ») et le droit de
> suppression (un preset ne se supprime pas) diffèrent.

### 10.2 Contrat réel d'`audio.cpp` : ce qui est documenté, ce qui ne l'est pas

**Ce que les archives documentent** (source : archive locale
`audio-cpp-http-server`, champ `rawContent`, dossier « HTTP Server
(audiocpp_server) ») :

| Élément | Extrait réel |
| --- | --- |
| **Presets de voix** | `voice_presets` \| `map<string, VoicePreset>` \| « **Named voice presets for speaker cloning** » |
| **Structure `VoicePreset`** | `voice_id` : « Optional **model-internal voice identifier** » ; `voice_ref` : « Optional **filesystem path to reference audio WAV** » ; `reference_text` : « Optional **sample transcript text for cloning** » |
| **Répertoire partagé** | `voice_dir` \| `optional<path>` \| « **Shared voice clone WAV and prompt text directory** » |
| **Preset par défaut** | `default_voice_preset` \| `optional<VoicePreset>` or `string` \| « Default voice preset **inline or by name** » |
| **Options par requête** | `default_request_options` \| `unordered_map<string,string>` \| « Default options applied to **each inference request** » |
| **Flags du contrat modèle** | `accepts_reference_text`, `accepts_language` : « Flags for whether request options are **accepted by the model contract** » |
| **Chargement des presets** | « On model load, voice presets from the config (both default and named) are loaded into runtime audio buffers for cloning. They support **inline WAV references or voice IDs**. » |
| **Upload UI** | `POST /v1/ui/upload` \| « **Temporary file upload for UI** » ; « **Voice preview WAV streaming** » |
| **Modèle Chatterbox** (archive `chatterbox-tts`) | `generate(text, audio_prompt_path="YOUR_FILE.wav")` ; multilingue : `generate(text, language_id="fr")` ; `exaggeration=0.5`, `cfg=0.5` (défauts) |
| **Famille `chatterbox`** (archive `audio-cpp`) | `chatterbox` \| TTS, **Clone**, VC \| `… fr …` \| « Chatterbox with 0.5B backbone » \| `GGUF 16/Q8` |

**Ce que les archives NE documentent PAS** (à ne **pas** inventer) :

1. **Les clés d'options exactes** du corps `POST /v1/audio/speech` pour
   choisir une voix : est-ce `voice` ? `speaker` ? `voice_ref` ? `voice_preset`
   ? Un nom de preset ? — **non prouvé**.
2. **Le mécanisme de clonage par requête** : `voice_ref` est décrit comme un
   **chemin de fichier** ; rien ne dit qu'un **audio inline/base64** est accepté,
   ni qu'un client peut **passer une référence par requête** (par opposition à
   la config de chargement).
3. **L'exposition d'`exaggeration` / `cfg` par le serveur** : ces paramètres
   sont documentés pour la **bibliothèque Python** (`chatterbox-tts`), **pas**
   pour la surface HTTP `audiocpp_server`. Aucune occurrence d'`exaggeration`
   ou `cfg` dans l'archive `audio-cpp-http-server`.
4. **La clé de langue** côté requête : `accepts_language` est un flag, mais le
   **nom d'option** (`language` ? `language_id` ?) n'est pas donné pour HTTP.
5. **Un endpoint de listing des voix** : aucun `GET /v1/voices` n'apparaît ; le
   seul listing documenté est `GET /v1/models`.
6. **Le contrat de `POST /v1/ui/upload`** : format accepté, destination, réponse,
   nettoyage — non documentés.
7. **L'emplacement/l'identité du fichier de config** du serveur (celui qui
   contient `voice_presets`/`voice_dir`) tel qu'il est monté par l'image Docker.

⇒ **Conséquence de conception** : Yuki doit être prêt à **injecter** les voix
dans le service `tts` par **deux voies** (à trancher en réel, §14/C1) :

- **Voie A (config + rechargement)** — Yuki **génère** un fichier de config
  `audio.cpp` contenant `voice_dir` + `voice_presets` (projection du registre),
  le monte dans le conteneur `tts`, et déclenche un **rechargement** du modèle
  (`POST /v1/models/unload` puis `load`, ou redémarrage du service). C'est la
  voie **cohérente avec l'archive** (les presets sont chargés « **on model
  load** »), mais elle suppose que l'on maîtrise le fichier de config (point 7).
- **Voie B (par requête)** — passer la voix dans `default_request_options` /
  options de requête. Plus simple **si** les clés existent (points 1–2), ce qui
  **n'est pas prouvé**.

**Recommandation provisoire** : concevoir le registre Yuki **indépendamment** de
la voie, et **isoler l'adaptateur** (une fonction `toAudioCppRequest(voice)`)
derrière une interface unique — ainsi la bascule A↔B ne touche qu'un point.

### 10.3 Stockage des échantillons de référence

**Contrainte prouvée** : le volume des modèles est monté en **lecture seule** —
`yuki-models` → `/models`, `read_only: true` (`docker-compose.yml:86-89`) ;
`src/config/paths.ts:58-61` déclare le montage `models` en `mode: "ro"`. Un
échantillon **ne peut donc PAS** être écrit dans `/models`.

**Emplacement proposé : un volume nommé dédié `yuki-voices` (`/voices`)**,
**inscriptible** par le gateway, monté **en lecture seule** dans le service
`tts` (qui n'a besoin que de **lire** les WAV) :

```yaml
volumes:
  yuki-voices:
    name: yuki-voices
```

- **Arborescence** :
  ```
  /voices/
    voices.json            # registre Yuki (§10.1) — source de vérité
    presets/<id>.wav       # voix prédéfinies (déposées à l'installation)
    presets/<id>.txt       # réf. textuelle optionnelle
    cloned/<id>.wav        # voix clonées (écrites par l'UI)
    cloned/<id>.txt
  ```
- **Justification du volume dédié** (vs réutiliser `yuki-state` à
  `docker-compose.yml:90-92`) : les échantillons de voix sont des **médias**
  (binaires, quelques centaines de Ko chacun), d'un **cycle de vie** et d'un
  **volume de sauvegarde** différents du JSON de configuration ; les isoler
  rend la rotation/sauvegarde explicite et évite de mélanger du binaire au store
  de config. **Alternative acceptable** (si l'on refuse un 5ᵉ volume) n'est **pas retenue** : **DÉCIDÉ (D19, 2026-09-20)** — le volume
  **dédié `yuki-voices`** (rw gateway, ro `tts`) est retenu (§11.2).

**Nommage** :
- `id` = **slug** dérivé du libellé (minuscules, `[a-z0-9-]`, longueur 1–40),
  **unicité garantie** ; en cas de collision, suffixe aléatoire court.
- Fichier WAV : `<id>.wav` (**jamais** le nom fourni par l'utilisateur → pas de
  traversée de chemin).

**Validation** (à l'upload, §10.4) :
- **Conteneur** : en-tête **RIFF/WAVE** (`RIFF`…`WAVE`), `fmt ` PCM.
- **Format** : PCM signé 16 bits (ou 24/32 rééchantillonnable côté service),
  mono **ou** stéréo ; échantillonnage cohérent avec le champ `fmt `.
- **Durée** : **≤ 10 s** (calculée `dataSize / (blockAlign × sampleRate)`).
- **Taille** : **≤ `MAX_VOICE_BODY_BYTES`** (voir §10.4).
- **Langue** : `lang` déclarée par l'utilisateur ; la référence **devrait**
  être dans cette langue (avertissement `chatterbox` : un clip d'une autre
  langue **transfère son accent** ; remède documenté : `cfg = 0`, archive
  `chatterbox-tts`).
- **Quota global** : nombre de voix clonées borné (proposition : **20**) et
  **somme des octets** bornée (proposition : **50 Mo**) — au-delà, l'API refuse
  (`429`/`400`) avec message explicite.

> **Aucune écriture dans `/models`.** Le **modèle** (GGUF) suit sa propre voie
> (pré-dépôt hors bande, §11.6) ; les **voix** suivent celle-ci. Les deux ne se
> mélangent pas.

### 10.4 Backend : endpoints Yuki à ajouter

Les routes vivent dans `src/gateway/routes/` (motif existant : `config.ts`,
`admin.ts`), montées dans `src/gateway/app.ts` (dispatch par
`isXxxPath(path)`), avec les **mêmes garde-fous** d'écriture que la config :
en-tête **`X-Yuki-Config: 1`** + contrôle **`Origin`/`Host`**
(`requireWriteGuards`, `src/gateway/routes/config.ts:120`, réutilisée telle
quelle depuis `admin.ts`).

| Méthode | Route | Rôle | Corps / réponse |
| --- | --- | --- | --- |
| `GET` | `/api/voices` | **Lister** les voix (presets + clonées) | `{ voices: [ { id, label, kind, lang, createdAt, demoAvailable } ] }` |
| `GET` | `/api/voices/{id}/sample` | Servir l'**échantillon de référence** (écoute) | WAV (`audio/wav`) |
| `POST` | `/api/voices/clone` | **Créer** une voix clonée | corps binaire WAV + métadonnées (voir ci-dessous) |
| `PATCH` | `/api/voices/{id}` | **Renommer** / changer le libellé | `{ label }` |
| `DELETE` | `/api/voices/{id}` | **Supprimer** une voix clonée | — |
| `POST` | `/api/voices/{id}/preview` | **Extrait de démonstration** (appel `tts`) | WAV (`audio/wav`) |

**Création (`POST /api/voices/clone`) — transport.** **DÉCIDÉ (C5,
2026-09-20) : corps binaire** `content-type: audio/wav`, les métadonnées en
**en-têtes** (`X-Voice-Label`, `X-Voice-Lang`, `X-Voice-Ref-Text` optionnel).
Lecture du corps en **`Buffer`** (le `readBody` actuel de
`src/gateway/app.ts:100-113` décode en **UTF-8** et applique
`MAX_CONFIG_BODY_BYTES` — il faut une **variante binaire** et une **limite
dédiée**). L'option JSON + base64 (~33 % de gonflement, encodage client) est
**écartée**.

**Limites de taille.** `MAX_CONFIG_BODY_BYTES = 1_000_000`
(`src/gateway/routes/config.ts:33`), appliquée par `readBody`
(`src/gateway/app.ts:106`). Un échantillon de **10 s en 24 kHz mono 16 bits
≈ 480 Ko** (≈ 640 Ko en base64) **passe** ; mais **10 s en 44,1 kHz mono 16 bits
≈ 882 Ko** (≈ 1,18 Mo en base64) **dépasse**. ⇒ **DÉCIDÉ (D20, 2026-09-20) :
limite dédiée `MAX_VOICE_BODY_BYTES = 3_000_000`** (couvre 10 s jusqu'à
~48 kHz **stéréo** avec marge), **sans** relever `MAX_CONFIG_BODY_BYTES` (la
config n'a pas besoin d'autant).

**Sécurité des routes** (voir aussi §10.8) :
- Garde-fous d'écriture **systématiques** sur `POST`/`PATCH`/`DELETE`
  (`X-Yuki-Config` + `Origin`).
- `id` validé contre le **registre** (sinon `404`) ; **jamais** de chemin
  dérivé directement d'une entrée utilisateur.
- **Un `preset` n'est pas supprimable** (`409`/`403`).
- La création est **atomique** : écrire le WAV **puis** mettre à jour
  `voices.json` (ordre qui laisse au pire un WAV orphelin, jamais une entrée
  pointant vers un fichier absent).

> Le service `tts` (interne, réseau `yuki-net`) n'est **jamais** exposé au
> navigateur : c'est le **gateway** qui l'appelle (`POST /v1/audio/speech`
> pour l'aperçu, §10.5).

### 10.5 Interface (UI) — **IMPLÉMENTÉ (Lot C)**

> ✅ **Livré** (dépôt `Yuki/`, UI vanilla sans build) :
> - `public/ui/tts-frames.js` — décodeur `YTA1` défensif (miroir client de
>   `src/tts/framing.ts` ; renvoie `null`, ne lève jamais) ;
> - `public/ui/tts-player.js` — lecture **Web Audio** avec fabrique
>   `AudioContext` **injectable** : ordre `(segmentIndex, chunkIndex)`,
>   enchaînement sans trou, **coussin de démarrage**, purge `tts_cancel`,
>   volume (`GainNode`), `resume()` sur geste, extraits WAV ;
> - `public/ui/tts-preference.js` — sourdine locale + état d'affichage ;
> - `public/ui/voices-panel.js` — panneau `/config` (liste, sélection, écoute,
>   clonage, renommage, suppression) ;
> - `public/ui/app.js` — réception des trames **binaires**
>   (`socket.binaryType = "arraybuffer"`), remontée `ClientMessage.playback`
>   (`started`/`aborted`), arrêt net sur Stop / nouveau message ;
> - CSS dans `public/ui/styles.css` et `public/ui/config.css` (fichiers servis,
>   **jamais** injectés).
>
> **Placement livré** : tout le **panneau des voix** vit sur `/config`
> (sélecteur `#voices-select`, pas de `#tts-voice` dans la topbar) ; la topbar
> du chat ne porte que le **bouton voix** (§9.3) — pas de sélecteur rapide en
> v1 (sobre). `window.confirm` n'est **jamais** utilisé : les confirmations
> passent par **`HolafModal`** (`injectStyles: false`).
>
> **Parcours livré** : (1) choisir la voix via `<select>` →
> `PUT /api/config { "tts.voice": id }` ; (2) cloner via une modale `HolafModal`
> (fichier WAV, libellé, langue `fr`, `X-Voice-Ref-Text` optionnel, aperçu local
> Web Audio) → `POST /api/voices/clone` ; (3) écouter
> `GET /api/voices/{id}/sample` et `POST /api/voices/{id}/preview` par Web Audio ;
> (4) renommer/supprimer (`PATCH`/`DELETE`, confirmation `HolafModal`) ;
> (5) émotion `tts.emotion` + `tts.speed`, le cran `personnalisee` **révélant**
> les curseurs `tts.exaggeration`/`tts.cfg` (`<input type="range">`).
> Les contraintes ci-dessous (CSP, vanilla, a11y, thèmes) sont respectées.

**Emplacement.** La gestion des voix va dans la page **`/config`**
(`public/ui/config.html` + `config.js`), dans un **groupe « Voix »** ajouté à
`GROUPS` (`public/ui/config.js:72`) — c'est le lieu naturel : la voix **par
défaut**, l'**émotion** et le **débit** y sont déjà (§9.1). La **topbar**
(`public/ui/index.html:12-30`) n'ajoute qu'un **sélecteur rapide de voix** (un
`<select>` à côté du toggle haut-parleur) : « changer de voix en cours de
conversation » sans ouvrir la config.

**Parcours utilisateur** :

1. **Choisir une voix** — `<select id="tts-voice">` listant les voix du registre
   (badge « prédéfinie » / « clonée »), avec « Écouter » à côté.
2. **Cloner une voix** — bouton « Cloner une voix » → **modale**
   (`HolafModal`, déjà employée par la page) contenant :
   - `<input type="file" accept="audio/wav,audio/x-wav,audio/*">` — **upload de
     fichier uniquement** (**D18** : pas d'enregistrement micro, jamais) ;
   - `<input type="text">` pour le **libellé** ;
   - `<select>` pour la **langue** (constante `fr` en v1) ;
   - `<textarea>` optionnel pour la **transcription** de l'échantillon ;
   - un **aperçu local** (le fichier choisi est décodé par **Web Audio** —
     `fetch` sur un `Blob` local ou `decodeAudioData` — **pas** de `<audio src>`,
     CSP oblige) ;
   - « Créer » → `POST /api/voices/clone`.
3. **Renommer / Supprimer** — par ligne de voix (édition du libellé,
   suppression avec **confirmation** `HolafModal`).
4. **Écouter le rendu** (bouton « Écouter ») :
   - **voix** : `GET /api/voices/{id}/sample` → `arrayBuffer` → Web Audio ;
   - **démonstration de synthèse** : `POST /api/voices/{id}/preview` →
     **WAV** → `arrayBuffer` → `decodeAudioData` (conteneur décodable, §4.4).

**Contraintes à respecter** :

- **CSP** (`src/gateway/routes/static.ts:46`) : **aucun `<style>`**, **aucun
  handler inline** (`onclick=`) → `addEventListener` uniquement (comme
  `config.js`) ; **`<audio src>` interdit** → **Web Audio**.
- **Vanilla, sans build** : `type="module"`, `document.createElement` /
  helper `h()` existant (`config.js`). Le CSS va dans `public/ui/config.css`
  (fichier statique), **jamais** injecté par JS.
- **Accessibilité** : chaque contrôle a un `aria-label` ; les retours
  (« clonage en cours », « voix créée », erreur) sont dans un conteneur
  `role="status"`/`aria-live="polite"` ; navigation clavier dans la modale.
- **Thèmes** : réutiliser les classes existantes (`.config-group`, `.config-row`,
  `.button`, `.pill`) — les **5 familles × 2 modes** de `themes.css` sont déjà
  couvertes, aucune couleur en dur.
- **Préférences client** : le sélecteur rapide de la topbar peut persister son
  choix en `localStorage` (précédent : `theme.js`, `localStorage["yuki-theme"]`),
  mais la **voix par défaut** reste la config serveur `tts.voice` (§9.1).

### 10.6 Config liée

Les champs concernés sont ceux de §9.1 : `tts.voice` (id, `string`, `hot`),
`tts.emotion` (enum, `hot`), `tts.exaggeration` / `tts.cfg` (int pour-mille,
`hot`), `tts.speed` (int, `hot`), `tts.language` (enum, `restart`). **Aucun
booléen** (contrainte `FieldType`, `src/config/schema.ts:19`).

- **`tts.voice` est un `string`** (et non un `enum`) : la liste des voix est
  **dynamique** (créée à l'exécution) alors que `CONFIG_SCHEMA` est **statique**.
  La validation « l'id existe-t-il ? » se fait donc **au runtime** (résolution
  à la lecture), pas par le descripteur : id inconnu ⇒ **repli** sur la voix par
  défaut + **avertissement journalisé** (jamais un crash, §10.8).
- Le registre des voix **n'est pas** un champ `tts.*` : c'est une **ressource**
  servie par `/api/voices` (§10.4).

### 10.7 Émotion : deux options d'exposition

Chatterbox expose `exaggeration` et `cfg` (défauts `0.5` / `0.5` ; conseil de la
fiche modèle : « Expressive or Dramatic Speech: lower `cfg` (e.g. `~0.3`) and
increase `exaggeration` to around `0.7` or higher »).

- **Option simple (recommandée)** : un **enum** `tts.emotion` à **3 crans
d'émotion** (plus un cran `personnalisee`), qui fixe un **couple**
  `(exaggeration, cfg)` — l'utilisateur n'a **rien à régler** finement :

  | `tts.emotion` | `exaggeration` | `cfg` | Intention |
  | --- | --- | --- | --- |
  | `neutre` | `0.5` (500) | `0.5` (500) | défauts modèle, lecture posée |
  | `expressive` | `0.7` (700) | `0.4` (400) | plus vivant, débit maîtrisé |
  | `dramatique` | `0.8` (800) | `0.3` (300) | théâtral (récit, jeu) |
  | `personnalisee` | `tts.exaggeration` | `tts.cfg` | curseurs fins |

- **Option fine** : exposer **deux curseurs** (`<input type="range">`)
  `exaggeration` et `cfg` (0–1500 en pour-mille) — plus de contrôle, mais
  **exige de comprendre l'effet** (`exaggeration` élevé **accélère** le débit ;
  `cfg` bas **ralentit**).

**Recommandation** : **option simple par défaut**, avec le cran
`personnalisee` qui **révèle** les deux curseurs fins. On garde ainsi la
simplicité pour l'usage courant et la finesse pour l'exploration.

> **Réserve** : l'exposition d'`exaggeration`/`cfg` par **`audio.cpp`** n'est
> **pas prouvée** (§10.2, point 3). Si elle manque, `tts.emotion` restera
> **inopérant** tant que l'adaptateur ne trouve pas le levier réel — d'où le
> point à trancher C1.

### 10.8 Sécurité et robustesse

- **Validation des uploads** : voir §10.3 (RIFF/WAVE, PCM, ≤ 10 s, ≤ limite,
  quota). Tout refus renvoie un **message explicite** (jamais un 500 muet).
- **Quotas** : nombre de voix clonées et **somme des octets** bornés (§10.3) ;
  au-delà → refus `429`/`400` avec la cause.
- **Chemins** : `id` en **slug** (jamais un chemin utilisateur) ; résolution
  **sous** `/voices` uniquement (garde-fou anti-traversée, même esprit que
  `src/gateway/routes/static.ts`).
- **Absence de voix** : registre vide ou `tts.voice` inconnue → **repli** sur
  la voix par défaut (preset « factory ») ; on **ne synthétise jamais sans
  voix** de repli.
- **Service `tts` absent / occupé** : `audio.cpp` renvoie **503** si le modèle
  est occupé (`BusyGuard`, `audio-cpp-http-server`). L'aperçu et le clonage
  remontent un **503** clair ; la **liste** des voix reste disponible (elle ne
  dépend **pas** du service `tts`). Le TTS n'est **jamais bloquant** pour la
  conversation (§11.7).
- **Voix clonée supprimée alors qu'elle était sélectionnée** : la suppression
  **réinitialise** `tts.voice` à `""` (voix par défaut) via le store de config
  (`PUT /api/config` côté serveur), **journalise** l'événement, et l'UI
  **reflète** immédiatement le nouveau choix. Un run en cours **ne bascule
  pas** au milieu d'une phrase : le changement prend effet au **segment suivant**
  (`apply: "hot"`).
- **Confidentialité** : les échantillons de voix sont des **données
  personnelles**. Ils restent **locaux** (volume `yuki-voices`, réseau
  `yuki-net`), **jamais** envoyés au cloud ; la suppression est **réelle**
  (fichier + entrée de registre).
- **Watermark** : Chatterbox **tatoue** ses sorties (PerTh, « imperceptible
  neural watermarks » — archive `chatterbox-tts`). À **documenter** auprès de
  l'utilisateur (transparence), sans action technique.

### 10.9 Ce qu'il faut vérifier en réel (voix)

1. Le **nom d'option** réel pour choisir une voix par requête (ou la nécessité
   de passer par la config + rechargement) — **C1**.
2. L'**exposition d'`exaggeration`/`cfg`** par le serveur — **C1**.
3. Le **listing** des voix (`GET /v1/voices` ?) et le **contrat de
   `/v1/ui/upload`** — **C17**.
4. L'**emplacement du fichier de config** du serveur `audio.cpp` dans l'image
   Docker (pour la Voie A) — **C14**.

---

## 11. Matériel & déploiement

> ✅ **DÉCIDÉ (2026-09-20) : backend CUDA / NVIDIA uniquement.** L'utilisateur
> ne cible **pas** AMD/Intel. L'image `full-cuda13` (ou `full-cuda12` selon le
> **driver**) reste donc pertinente.

### 11.1 Variantes d'image `audio.cpp`

`docs/docker.md` du dépôt `audio.cpp` (et README 0.8.0, `audio-cpp`) expose des
images `ghcr.io/0xshug0/audio.cpp:full-*` : **`full-cuda12`**, **`full-cuda13`**,
**`full-vulkan`**, **`full-cpu`**. `audio-cpp` précise que « CUDA is the
optimized path … CPU, Vulkan, Metal, and HIP are intended for **portability and
testing** when the binary is built with that backend, but **performance and model
coverage may be lower** ».

| Variante | Matériel | Statut |
| --- | --- | --- |
| **`full-cuda13`** (ou **`full-cuda12`** selon le driver) | NVIDIA seul | ✅ **RETENU** — chemin **optimisé**, cohérent avec le parc NVIDIA de l'utilisateur (hôte CUDA 13.4 / driver 615.71.09, `docs/architecture.md:166`) |
| `full-vulkan` | NVIDIA **+ AMD + Intel** (`/dev/dri`) | ❌ **écarté le 2026-09-20** — backend de **portabilité** ; l'utilisateur cible **NVIDIA uniquement**. *Trace conservée : le multi-vendeur pourra redevenir pertinent si le parc change.* |
| `full-cpu` | CPU | ❌ trop lent pour la conversation (conservé pour CI/diagnostic) |

**Choix cuda12 vs cuda13** : dépend du **driver** de la machine cible ; les deux
sont **NVIDIA-only**. Le `driver.floor` déclaré (driver NVIDIA ≥ 580, CUDA 13.x)
reste l'exigence (§11.4).

### 11.2 Impact sur `docker-compose.yml`

Ajouter un **service `tts`** (le compose actuel n'a **que** `gateway`,
`docker-compose.yml`) et un **volume `yuki-voices`** (§10.3) :

```yaml
  tts:
    image: ghcr.io/0xshug0/audio.cpp:full-cuda13   # ou full-cuda12 selon le driver
    container_name: yuki-tts
    command: ["--server", "--host", "0.0.0.0", "--port", "8081"]  # à ajuster selon le CLI réel
    networks: [yuki-net]
    volumes:
      - type: volume
        source: yuki-models
        target: /models
        read_only: true
      # Voix : le service ne fait que LIRE les échantillons du registre Yuki (§10.3).
      - type: volume
        source: yuki-voices
        target: /voices
        read_only: true
      # Config serveur générée par le gateway (Voie A, §10.2) — à confirmer (C14).
      # - type: bind
      #   source: ./config/audiocpp-server.json
      #   target: /etc/audiocpp/server.json
      #   read_only: true
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    restart: unless-stopped
    read_only: true
    tmpfs: ["/tmp"]
```

Côté **gateway** : injecter `YUKI_TTS_BASE_URL=http://tts:8081` (câblage) **et**
monter `yuki-voices` en **lecture-écriture** (le gateway écrit les échantillons
et le registre) :

```yaml
      - type: volume
        source: yuki-voices
        target: /data/voices      # chemin interne du gateway
```

**Points à figer** : nom/CLI exacts du serveur `audio.cpp` **et** chemin de son
fichier de config (l'archive documente `audiocpp_server` mais **pas** la ligne
de commande Docker complète) → **à vérifier** (§14/C14).

### 11.3 Impact sur `config/gpu-profiles.json`

Les 3 profils GPU non-texte (`confort`, `compact`, `repli`) ont déjà un bloc
`tts` (`config/gpu-profiles.json:30,61,92,122`) avec `status: "to-confirm"` et
des références symboliques `tts.model.default` / `tts.quant.default`. À mettre à
jour :

- `tts.modelRef` → **`chatterbox`** (moteur retenu) ;
- `tts.quantizationRef` → **`q8`** (GGUF Q8 testé, −30–37 % VRAM) ;
- **`repli`** (RTX 4000 8 Go, CC 7.5) : Chatterbox 0.5B Q8 tient, mais garder un
  repli **`kokoro`**/`sanotts` si la VRAM manque ;
- `texte-seul` : `tts.enabled = false` (**déjà** le cas,
  `config/gpu-profiles.json:122-131`) ;
- **`bf16Required`** : voir §11.5.

### 11.4 Impact sur `config/compat-manifest.json`

Le service `tts` déclare
`capabilities: ["gpu.present", "gpu.bf16", "driver.floor"]`
(`config/compat-manifest.json:89-93`). **Depuis la décision CUDA/NVIDIA-only**,
ces capacités sont **sémantiquement cohérentes** : `gpu.bf16`
(`src/gpu/nvidia-smi.ts:118-119`, `deriveBf16(cc >= 8.0)`) et `driver.floor`
(driver **NVIDIA** ≥ 580) sont des notions **NVIDIA**, ce qui correspond
désormais à l'unique cible. **La version antérieure de cette spec proposait de
les retirer au motif d'un parc multi-vendeur : ce motif disparaît.**

⇒ **Décision utilisateur (2026-09-20)** : les exigences `gpu.bf16` et
`driver.floor` **restent valables telles quelles**, **mais sont à re-vérifier**
(§11.5) ; le champ `status: "to-confirm"` **reste** tant que ce n'est pas
confirmé en réel.

### 11.5 Le cas `gpu.bf16` : point à re-vérifier

Le plancher déclaré est la **Quadro RTX 4000 8 Go (Turing, CC 7.5)**, **sans
BF16** (`docs/architecture.md:163`, `config/gpu-profiles.json:70`). Or **Q8 est
une quantification entière**, pas du bfloat16 : **Chatterbox Q8 n'a pas besoin
de BF16**. Maintenir `gpu.bf16` **exclurait** donc le plancher alors que le
modèle y tourne.

⇒ **À re-vérifier (C11)** : soit **conserver** `gpu.bf16` (si le chemin CUDA
retenu exploite réellement BF16), soit **réduire** l'exigence `tts` à
`gpu.present` + `driver.floor` (**Q8 n'exige pas BF16**). La décision CUDA rend
le **sujet** cohérent (NVIDIA), mais **pas encore tranché** sur le **seuil**.

### 11.6 Approvisionnement du modèle

Le volume **`yuki-models` est monté en LECTURE SEULE**
(`docker-compose.yml:86-89`, et `src/config/paths.ts:58-61`) — c'est aussi le
point de montage `/models`. **Conséquence** : l'**installateur de modèles natif**
d'`audio.cpp` (`audiocpp_model_manager`, `audio-cpp-http-server`, « Ensures safe
atomic write of package files ») **ne peut pas écrire** dans `/models`. Deux
options :

1. **Provisionnement hors bande** (recommandé) : télécharger le GGUF
   (`huggingface.co/audio-cpp/audio.cpp-gguf`) **sur l'hôte**, puis le déposer
   dans le volume `yuki-models` **avant** `docker compose up` ; le service lit
   en lecture seule.
2. Ajouter un **volume inscriptible** dédié (ex. `yuki-audio-models`) si l'on
   veut la gestion intégrée — **hors périmètre v1**.

> **Ne pas confondre avec les voix** : le **modèle** va dans `yuki-models` (ro),
> les **voix** dans `yuki-voices` (rw, §10.3).

### 11.7 Fallback sans GPU / profil `texte-seul`

- Profil `texte-seul` → `tts.enabled = false`, **pas** de service `tts`, toggle
  topbar **masqué/désactivé**.
- Si le service `tts` **tombe** (crash) → le gateway **journalise** et continue
  **en texte seul** (`/health` signale `subsystems.tts.status = "error"`).
  Le TTS **n'est jamais bloquant** pour la conversation.

---

## 12. Licences

Politique de l'utilisateur : **MIT**. Point explicite par candidat :

| Candidat | Licence | Conforme à la politique MIT ? |
| --- | --- | --- |
| **Chatterbox Multilingual V3** | **MIT** (fiche modèle : « Licensed under MIT ») | ✅ **oui** — **moteur retenu** |
| **Qwen3-TTS** | **Apache-2.0** (code + poids) | ✅ permissive — **mais pas MIT** (plan B) |
| **CosyVoice 3.0** | **Apache-2.0** | ✅ permissive — **mais pas MIT** |
| **Kokoro 82M** | **non documentée dans les archives** — à confirmer | ⚠️ **à vérifier** (plan C) |
| **sanotts** | **non documentée dans les archives** — à confirmer | ⚠️ **à vérifier** (plan C) |
| **Sopro V2 Turbo** | **non documentée dans les archives** — à confirmer | ⚠️ **à vérifier** |
| **Breeze TTS 2** | **non documentée dans les archives** ; réputée **recherche / non commerciale** | ⚠️ **à confirmer** — de toute façon pas de français |
| **XTTS v2** | **non commerciale** | ❌ |
| **Fish Speech S2 Pro** | **complexe** (Fish Audio Research License / **CC-BY-NC-SA-4.0** selon version) | ❌ risque |
| **IndexTTS2** | **Apache-2.0 + restriction** (« must not be used to improve other AI models ») | ❌ restriction non standard |
| **mira_tts** | **CC-BY-NC-SA-4.0** (poids) | ❌ |
| **audio8_asr** | **CC-BY-NC** | ❌ |

> **Le moteur retenu (Chatterbox) est explicitement MIT.** Les licences des
> modèles des **plans B/C** (Qwen3-TTS, Kokoro, sanotts) **doivent être lues sur
> leur fiche** avant tout déploiement — **non vérifiable depuis les archives
> fournies** pour Kokoro/sanotts.

---

## 13. Vérification

**Les agents n'ont ni GPU ni Docker** : rien d'acoustique n'est vérifiable ici.
Plan de vérification **côté utilisateur** :

### Étape 1 — le français est-il réellement atteignable ? (BLOQUANT)

1. Lancer le service `tts` (`full-cuda13`) et lister les modèles :
   charger `chatterbox`, tenter un appel `POST /v1/audio/speech` avec
   `language=fr` (ou le mécanisme de langue réel) et **écouter**.
2. **Si le français n'est pas bon** → **basculer sur le plan B `qwen3_tts`**
   (langue `fr` documentée) et **rejouer l'étape**.
3. Noter l'écart 18/23 langues : vérifier le **checkpoint** réellement chargé
   (V2/V3) et les tags de langue acceptés.

### Étape 2 — voix, émotion, débit, clonage

- **Contrat de voix** : déterminer le **nom d'option** réel (voix par requête
  ou config + rechargement) et l'**exposition d'`exaggeration`/`cfg`**
  (**C1**) ; relever le **listing** des voix et le contrat de `/v1/ui/upload`
  (**C17**).
- **Clonage** : déposer un extrait, le référencer, **écouter** la similarité ;
  valider le parcours UI de bout en bout (upload → création → sélection →
  aperçu → suppression).
- **Émotion / débit** : écouter `neutre` / `expressive` / `dramatique` et
  vérifier que `exaggeration`/`cfg` **atteignent bien** le modèle.
- **Fréquence native** de Chatterbox : la relever (valeur de l'en-tête, C3).

### Étape 3 — pipeline et latence

- **5–10 tours** représentatifs, **à chaud** et **à froid séparément**
  (méthode `pithagoras-voice-profiling` : « Capture 5–10 representative turns,
  then compare **medians and slow outliers** »).
- Mesurer : **TTFA** (`t0` → `playback_started`), **`tts_first_byte`**,
  `ttsSynthMs`, et le **décrochage** éventuel entre phrases.
- Vérifier le comportement **barge-in** : le son s'arrête **immédiatement**,
  aucune trame résiduelle ne joue après le Stop.
- Vérifier la gestion du **503 server busy** (producteur unique, réessai borné).

### Étape 4 — matériel NVIDIA

- Valider le démarrage `full-cuda13` (ou `cuda12` selon le driver) sur la
  **cible NVIDIA** et la tenue sur **Quadro RTX 4000 8 Go** (Q8, sans BF16 —
  §11.5). **Plus de validation AMD/Intel** (écartées, §11.1).

### Étape 5 — UI (Lot C), vérifiable SANS audio

Ce qui a été **vérifié automatiquement** (tests vitest + E2E Chromium headless,
avec la CSP réelle — voir le rapport de lot) :

- ordonnancement de lecture (ordre, coussin, enchaînement, purge `tts_cancel`,
  contexte suspendu) par doublure d'`AudioContext` ;
- décodeur `YTA1` client défensif ;
- cohérence du bouton voix (serveur ∧ sourdine) et sourdine locale ;
- `PUT /api/config { tts.voice }`, `POST /api/voices/clone` (chemin),
  `GET /api/voices`, révocation des curseurs d'émotion ;
- **0 violation CSP** sur `/` et `/config` (aucun `<style>`/`style=`/`<audio>`).

**NON vérifiable en headless** (à faire par l'utilisateur, avec sortie audio) :
le **son réel** (timbre, français, latence, continuité perceptible), et le
comportement acoustique du barge-in.

### Ce qui reste **non vérifiable ici**

- Qualité acoustique réelle du français par Chatterbox (et par Qwen3-TTS).
- Latence réelle de synthèse / TTFA.
- **Contrat HTTP d'`audio.cpp`** pour voix / clonage / émotion (l'archive
  décrit la **config** et la **lib** , pas les **clés de requête** — §10.2).
- Fréquence native exacte de Chatterbox.
- Licences exactes de Kokoro / sanotts / Sopro (à lire sur les fiches).

---

## 14. Décidé / À confirmer

### Acté (issu du Lot 1, des décisions utilisateur et des sources)

| # | Décision | Preuve |
| --- | --- | --- |
| D1 | **Français obligatoire** | décision utilisateur |
| D2 | **Segmentation par phrase complète** | décision utilisateur + `pithagoras-voice-comparison` (`VOICE_SENTENCE_CHUNKS`) |
| D3 | **Prefetch : producteur unique, ≤ 2 phrases d'avance, ordre garanti** | `pithagoras-voice-comparison` (`VOICE_TTS_PREFETCH`) |
| D4 | **Lecture PCM streamée**, par phrase | décision utilisateur + pithagoras |
| D5 | **Canal `thinking` jamais vocalisé** | décision utilisateur + Lot 1 |
| D6 | **Consigne « texte parlé simple »** (prompt du léger) | décision utilisateur + `VOICE_RESPONSE_INSTRUCTIONS` |
| D7 | **Trames binaires sur `/ws`** | `src/gateway/ws/server.ts:323-327`, `docs/lot1.md:172` |
| D8 | **Web Audio obligatoire** (CSP sans `media-src`) | `src/gateway/routes/static.ts:46` |
| D9 | **Barge-in = abort du Lot 1, tel quel** | `docs/lot1.md:202` |
| D10 | **Pas de rééchantillonnage 48 kHz** (fréquence native) | `breeze-tts2-output-format` (preuve de principe) |
| D11 | **Champs `tts.*` en `enum`/`int`/`string` only** | `src/config/schema.ts:19` |
| D12 | **Écart 18/23 langues** à documenter comme risque | `audio-cpp-model-families` (18) vs `chatterbox-tts` (23) |
| D13 | **Breeze TTS 2 est inadapté au français** ; la référence `architecture.md:158-159` doit être corrigée | README `audio.cpp` (`breeze_tts` : `zh, en`) |
| **D14** | ✅ **Moteur = Chatterbox Multilingual V3** (`chatterbox`) ; plan B Qwen3-TTS, plan C Kokoro/sanotts | **décision utilisateur 2026-09-20** (justifiée §2.5) |
| **D15** | ✅ **Backend = CUDA / NVIDIA uniquement** ; image `full-cuda13` (ou `cuda12` selon le driver) ; **`full-vulkan` écarté** | **décision utilisateur 2026-09-20** (§11.1) |
| **D16** | ✅ **Voix = presets + clonage via l'interface** (upload d'un échantillon, nommage, réutilisation) | **décision utilisateur 2026-09-20** (§10) |
| **D17** | **Une voix = une abstraction unique** (`preset`/`cloned`), le service `tts` n'en voit qu'une projection | conception §10.1 (découle de D16) |
| **D18** | ✅ **Clonage = upload de fichier audio uniquement** (PAS d'enregistrement micro / `getUserMedia`) | **décision utilisateur 2026-09-20** (§10.5, ex-C6) |
| **D19** | ✅ **Stockage des voix = volume dédié `yuki-voices`** (rw gateway, ro `tts`) — et non `yuki-state` partagé | **décision utilisateur 2026-09-20** (§10.3, ex-C4) |
| **D20** | ✅ **`MAX_VOICE_BODY_BYTES = 3_000_000`** et upload en **corps binaire** (`audio/wav` + métadonnées en en-têtes) — pas de base64 | **décision utilisateur 2026-09-20** (§10.4, ex-C5) |
| **D21** | ✅ **Toggle topbar = sourdine locale** (`localStorage`, instantanée) ; l'**activation serveur** `tts.enabled` reste sur `/config` (il est `apply: "restart"`). L'affichage reflète l'état **effectif** (`serveur ∧ non sourd`) → aucun mensonge | **décision utilisateur Lot C** (§9.3, ex-C15) |
| **D22** | ✅ **Émotion = enum simple** (`neutre`/`expressive`/`dramatique`/`personnalisee`) ; le cran `personnalisee` **révèle** les curseurs `tts.exaggeration`/`tts.cfg` | **décision utilisateur Lot C** (§10.7, ex-C7) |
| **D23** | ✅ **`playback_started`/`playback_aborted` remontés par le CLIENT** (`ClientMessage.playback`) au démarrage/interruption de la lecture | **décision utilisateur Lot C** (§8, ex-C9) |
| **D24** | ✅ **Blocs de code markdown ignorés** (défaut `MarkdownSpeechFilter`), option `codeAnnouncement` disponible pour une annonce | **décision utilisateur Lot C** (`src/tts/markdown.ts`, ex-C8) |
| **D25** | ✅ **Voix clonée supprimée alors que sélectionnée : reset auto** de `tts.voice` vers le défaut (serveur), l'UI reflète immédiatement ; pas de refus de suppression | **décision utilisateur Lot C** (§10.8, ex-C16) |

### À confirmer (le document ne tranche pas)

| # | Point ouvert | Impact |
| --- | --- | --- |
| C1 | ✅ **CONFIRMÉ (2026-09-21) pour les voix** : clés `voice` / `voice_ref` (chemin **ou** base64) / `reference_text`, presets `voice_presets`, `default_voice_preset`, `voice_dir` — et le **mode par requête est attesté** (pas seulement la config). ⚠️ **Restent à confirmer** : clé de **langue HTTP** (nom d'option non attesté ; seule la lib Python montre `language_id`) et exposition d'`exaggeration`/`cfg` (non attestée côté serveur). Preuve : `docs/lot8.md` §11 | **bloquant §13 (étape 2) + §10.2** (voix levé) |
| C2 | ⚠️ **PARTIELLEMENT CONFIRMÉ (2026-09-21)** : `fr` est listé comme langue de la famille `chatterbox` (`audio-cpp`) ; la **version V3** du checkpoint n'est **pas** attestée dans les archives (variante `Chatterbox-GGUF`, sans « V3 »). Preuve : `docs/lot8.md` §11.8 | bloquant §13 (étape 1) |
| C3 | **Fréquence native** de sortie Chatterbox (valeur de l'en-tête WS) | transport |
| C10 | **Prompt** : modifier `system-prompt.md` en dur, ou passer par `prompts.light` ? | intégration |
| C11 | **`gpu.bf16`** pour `tts` : **maintenu** (chemin CUDA BF16) ou **réduit** à `gpu.present`+`driver.floor` (Q8 n'exige pas BF16, plancher CC 7.5 sans BF16) ? | porte GPU/§11.5 |
| C12 | **Approvisionnement modèle** : pré-dépôt dans `yuki-models` (ro) vs volume rw dédié | déploiement/§11.6 |
| C13 | **Licences** Kokoro / sanotts / Sopro (non documentées) | juridique (plans B/C) |
| C14 | ✅ **CONFIRMÉ (2026-09-21, par EXÉCUTION RÉELLE)** : l'ENTRYPOINT de l'image est un **dispatcher à sous-commandes** (`cli`, `server`, `model-manager`, `perf`) — preuve : le conteneur lancé avec `command: ["--config", …]` boucle sur « `Unknown command: --config` ». La forme correcte est donc **`server --config /app/server.json`** (1er argument = sous-commande `server`). L'hypothèse `--server --host 0.0.0.0 --port 8081` (bloc §11.2) est **invalidée** : `--host`/`--port`/`--server` n'apparaissent **ni** dans les archives **ni** dans les logs ; hôte/port sont des **clés de config** (`host`/`port`). ⚠️ **Reste à confirmer en réel** : le **chemin** du fichier de config **dans le conteneur** (`/app/server.json` vs autre — WORKDIR de l'image non attesté). Preuve : logs d'exécution utilisateur + `docs/lot8.md` §11.1/§11.4 | déploiement/§11.2 |
| C17 | **Découverte des voix par l'API `audio.cpp`** : endpoint de listing (`GET /v1/voices` ?) et contrat de `/v1/ui/upload` | backend/§10.2 |

---

## 15. Renvois

- [`docs/lot1.md`](lot1.md) — noyau texte, abort, trames binaires, instrumentation.
- [`docs/lot11.md`](lot11.md) — table `CONFIG_SCHEMA`, page `/config`, invalidation.
- [`docs/architecture.md`](architecture.md) — vue d'ensemble, carte des lots.
- [`docs/runbook.md`](runbook.md) — exploitation, dépannage GPU.

---

## 16. Diagnostic — pourquoi le son ne démarrait qu'à la fin (2026-09-21)

> **Symptôme rapporté (exécution réelle).** « Le TTS ne commence que quand le LLM
> a fini de générer », alors que la promesse est de **parler dès la fin de la
> première phrase**. Diagnostic mené de bout en bout, **avec preuves** et
> **mesure** ; conclusion : l'architecture **n'attend pas** la fin du stream, et
> le maillon réellement retardant est le **moteur** (plus un défaut client,
> corrigé).

### 16.1 Ce qui est prouvé (chaîne remontée maillon par maillon)

| Maillon | Verdict | Preuve |
| --- | --- | --- |
| **Alimentation** | branché sur l'événement **`delta`** au fil de l'eau, **canal `content` uniquement** (jamais `message_end`/fin de message) | `src/gateway/ws/server.ts:239-242` (`case "delta"` → `tts.onContent` si `channel === "content"`), `:245` (`run_finished` ne sert qu'au `flush`/métriques) |
| **Segmenteur** | émet dès une **ponctuation forte suivie d'un blanc** (ou fin de flux), longueur ∈ `[min, max]` ; le **premier** segment part **pendant** le stream | `src/tts/segmenter.ts:92-124` (`findSentenceEnd`), `:206-214` (`drain`) |
| **Pipeline** | `onContent` met en file puis `kick` : le producteur démarre **sans attendre** le segment suivant ni la fin du run | `src/tts/pipeline.ts:229-237`, `:286-303` ; `tts_requested` émis **avant** l'`await` moteur (`:329`) |
| **Synthétiseur** | chemin **STREAMING** (`client.synthesize`), **pas** le bufferisé (réservé à l'aperçu) | `src/tts/synthesizer.ts:140-175` ; `synthesizeBuffer` n'est utilisé que par l'aperçu (`src/index.ts:285`) |
| **Transport** | relaie **chaque morceau** PCM dès réception (un `emitAudioFrame` par `data`), aucun accumulateur | `src/tts/pipeline.ts:380-395` (`pump`), `src/gateway/ws/server.ts:188-201` (`broadcastBinary`) |
| **Client (AVANT)** | ❌ **attendait le `final` du segment** avant de planifier le moindre son | ancien `collectSegment` : `if (segment.finalIndex === null) return null;` (`public/ui/tts-player.js`) |
| **Client (APRÈS)** | ✅ planifie le **préfixe contigu** dès qu'il arrive (coussin borné 150 ms) | `public/ui/tts-player.js:199` (`takeContiguousPcm`), `:334` (`drain`), `:25` (`DEFAULT_STARTUP_CUSHION_MS = 150`) |

### 16.2 Mesure — l'appel moteur part AVANT la fin des deltas

Test `tests/integration/ws-tts.test.ts` — « *le premier appel moteur part AVANT
la fin des deltas (première phrase)* » : un faux flux lent (delta 1 = première
phrase complète, deltas 2-3 à `delayMs: 200`) + un moteur qui **horodate** son
premier appel. Assertions (toutes vertes) :

- `premier tts_requested < timestamp du DERNIER delta content` ;
- `tts_first_byte` **et** `tts_segment_done` du 1er segment `< dernier delta` ;
- le 1er texte synthétisé contient la **première phrase** (`"Bonjour…"`).

Mesure de la chaîne complète (test de pipeline, deltas mot à mot à 40 ms,
longueur cible par défaut) :

```text
928 ms  sentence_segmented        ("Bonjour je m'appelle Yuki et je suis ravie de vous aider.")
929 ms  tts_queued
929 ms  tts_requested             ← appel moteur ALORS QUE des deltas restent à venir
930 ms  tts_first_byte
930 ms  tts_segment_done
1372 ms sentence_segmented        (2ᵉ phrase — le LLM générait encore)
1372 ms tts_queued / tts_requested
```

→ L'architecture **ne bloque pas** la synthèse jusqu'à la fin : la 1re requête
part **443 ms avant** le dernier delta. La chaîne texte n'est pas ralentie (test
anti-régression TTFT conservé : `tests/integration/ws-tts.test.ts`, « *la synthèse
ne bloque pas le chemin des deltas* »).

### 16.3 La vraie cause du retard : le moteur ne streame pas la phrase

`tts_first_byte` est mesuré **au premier `data` réellement relayé**
(`src/tts/pipeline.ts:383-386`). Or le moteur cible **Chatterbox** tourne en
**`mode: "offline"`** — **seul mode supporté**, `streaming` serait **refusé**
(`docs/lot8.md` §11.3 : `loader.cpp:134-136`). Le serveur `audio.cpp` ne rend donc
le WAV qu'**après** avoir synthétisé **tout le segment** : `tts_first_byte` ≈
fin de synthèse du **premier segment**, pas un début de flux. À cela s'ajoute que
Chatterbox est **lent** (essai utilisateur > 15 s sur un segment).

Autrement dit, si le LLM a fini de générer avant que le moteur n'ait rendu le
1er segment, **le son semble n'arriver qu'à la fin** — sans qu'aucun maillon
Yuki ne l'ait attendu. Ce point était **déjà documenté** (`mode: offline`) mais
l'impact sur la latence perçue n'était pas explicité : il l'est ici.

### 16.4 Correction apportée (client)

Le seul maillon que Yuki pouvait réellement améliorer était le **client** : il
exigeait le bloc `final` d'un segment avant de planifier le **premier** son, ce
qui contredit la promesse « lecture immédiate dès qu'un morceau est disponible ».

- `public/ui/tts-player.js` planifie désormais le **préfixe contigu** d'un
  segment **dès son arrivée** (`takeContiguousPcm`/`drain`), sans attendre
  `final` ni `tts_end`. Un éventuel **octet impair** (coupe au milieu d'une trame
  `s16le`) est **reporté** au morceau suivant — la trame n'est jamais décalée.
- **Coussin de démarrage conservé et borné** : `DEFAULT_STARTUP_CUSHION_MS = 150`
  (`public/ui/tts-player.js:25`), appliqué **une seule fois** au premier morceau.
- Tests : `tests/tts/ui-audio.test.ts` — « *démarre la lecture dès le PREMIER
  morceau (sans attendre `final` ni la fin du run)* », « *le coussin … borné et
  petit (défaut 150 ms, appliqué une seule fois)* », « *reporte un octet impair…* ».

> Note : avec un moteur **non streaming** (Chatterbox `offline`), cette
> correction ne change **rien** en pratique (tous les morceaux d'un segment
> arrivent ensemble) ; elle est **nécessaire** dès qu'un moteur **streaming**
> (kokoro/qwen3-tts) est utilisé, et elle supprime une attente contraire au
> contrat.

### 16.5 TTFA attendue et leviers (proposés, non imposés)

- **TTFA attendue (mesurable)** : `t0 → tts_first_byte` ≈ **latence de synthèse
du 1er segment** + (réseau + coussin client 150 ms). Les étages
`ttfaMs`/`ttsSynthMs`/`ttsSegments` du `run_summary` (§8) donnent ces valeurs
**par run**, et `playback_started` (remonté par le client, D23) donne `t0 →`
premier son réel. **Non mesurable ici** sans GPU/moteur réel.
- **Levier 1 (✅ implémenté — D44, §16.6)** : viser une **première phrase courte**
en **abaissant ponctuellement** la longueur cible du **premier** segment (le
1er segment part dès la 1re ponctuation, même < `tts.minSentenceChars`), pour
réduire le temps de synthèse du tout premier appel. Le segmenteur fusionnait
une première phrase < 24 caractères (`src/tts/segmenter.ts`), ce qui **allongeait**
le 1er segment. Compromis assumé : une amorce orale plus brève peut paraître
hachée (bornée par le plancher anti-fragment de D44).
- **Levier 2** : `tts.maxSentenceChars` plus petit (bornes plus serrées) réduit
la taille du 1er segment mais augmente le nombre d'appels moteur.
- **Levier 3** : changer de moteur pour un modèle **streaming** (kokoro/qwen3-tts)
ou vérifier si une variante de Chatterbox exposant du streaming existe — hors
périmètre ici (`docs/lot8.md` §11).
- Le **prefetch** (`tts.prefetchDepth`, max 2) améliore la **continuité** entre
phrases, **pas** le TTFA du 1er son.

### 16.6 Règle du PREMIER segment — implémentée (D44)

**Décision.** Le **premier** segment d'un flux est émis **dès la première
ponctuation forte**, même plus court que `tts.minSentenceChars`. Les segments
**suivants** conservent la règle min/max (sinon toute la parole serait hachée).

- **Seuil / plancher anti-fragment** : `FIRST_SEGMENT_FLOOR_CHARS = 8`
  (`src/tts/segmenter.ts`) = **borne basse du schéma** `tts.minSentenceChars`
  (`min 8`, `src/config/schema.ts:289-295`). En dessous de 8 caractères, le
  « segment » est plus probablement une interjection/un fragment (`M.`, `!`)
  qu'une amorce utile. Le plancher est **borné par la config** :
  `effMin = min(8, tts.minSentenceChars)` ⇒ un `tts.minSentenceChars ≤ 8` garde
  l'ancien comportement à l'identique.
- **Portée** : **premier segment du run uniquement**, réarmé par `reset()`
  (`emittedFirst`, `src/tts/segmenter.ts`). Un nouveau run (nouvelle instance dans
  `src/tts/pipeline.ts`) réapplique la règle.
- **Garde-fou de contenu** : un « segment » qui ne contiendrait **que** de la
  ponctuation/blancs est **ignoré** (`requireWordChars` : au moins une lettre ou
  un chiffre) — jamais de segment vide/punctuation envoyé au moteur. Les
  abréviations (`M.`, `Dr.`), guillemets et blocs de code restent gérés comme
  avant.
- **Pourquoi (raison)** : Chatterbox tourne en `mode: "offline"` (seul mode
  supporté, §16.3) et ne rend le WAV qu'après avoir synthétisé le segment
  **entier**. Raccourcir le premier segment est le **seul** levier côté Yuki.
- **Compromis assumé** : l'amorce peut être **brève** (« Bonjour ! »). On ne
  descend pas sous le plancher pour éviter une onction hachée.

**Gain mesuré** (flux lent simulé, `tts.minSentenceChars = 24` ; deltas à
`t ≈ 5 ms` / `305 ms` / `605 ms`) :

```text
AVANT (fusion) : 1er tts_requested ≈ 305 ms  (« Bonjour ! … qui prend du temps. », 79 car.)
APRÈS (D44)    : 1er tts_requested ≈   7 ms  (« Bonjour ! », 9 car.)
```

⇒ ≈ **298 ms** d'avance sur le premier appel moteur et un premier segment
**8,8×** plus court. Le test d'intégration « *un PREMIER segment court part à la
première ponctuation (D44) — gain de TTFA* » (`tests/integration/ws-tts.test.ts`)
mesure `secondDeltaAt − firstCallAt > 150 ms` ; le test « *le premier appel
moteur part AVANT la fin des deltas* » reste **vert**.

**Pas de nouveau champ de config.** Le comportement est le **défaut** du premier
segment : aucun réglage requis. Un champ `string|int|enum` (seuls types
acceptés, D11) n'apporterait qu'un knob de plus pour un gain déjà acquis ; le
plancher dérive de la borne basse existante.

| # | Décision | Preuve |
| --- | --- | --- |
| **D44** | ✅ **Le PREMIER segment d'un flux part dès la 1re ponctuation forte**, même < `tts.minSentenceChars`, sous plancher anti-fragment `min(8, minSentenceChars)` et garde de contenu ; les segments **suivants** gardent min/max ; règle par run, réarmée par `reset()` ; **aucun** champ de config | `src/tts/segmenter.ts` (`FIRST_SEGMENT_FLOOR_CHARS`, `SentenceEndOptions`, `emittedFirst`, `drain`), `tests/tts/segmenter.test.ts`, `tests/integration/ws-tts.test.ts` |
