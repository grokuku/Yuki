# Lot 29 — Consolidation hebdomadaire de la mémoire durable

Une passe **hebdomadaire** relit toute la mémoire durable avec le **modèle lourd**
et la nettoie : doublons fusionnés, entrées corrigées, transitoire supprimé,
contradictions **signalées** sans modification. Trois amendements utilisateur
structurent le lot : **mesurer avant de découper**, **versionner les archives**,
**planifier à 3 h de Paris**.

## 1. Ce qui est en place

| Élément | Fichier |
| --- | --- |
| Déclencheur (port sur le balayeur existant) | `src/sources/scheduler.ts` (`passeHebdo`) |
| Mesure, lots adaptatifs, prompt, parse strict | `src/memory/weekly.ts` |
| Orchestration, état, verrou, rattrapage | `src/memory/consolidation-hebdo.ts` |
| Versions (archives) | `src/memory/consolidation-archive.ts` |
| API | `src/gateway/routes/memory.ts` |
| UI | `public/ui/personality-panel.js`, `public/ui/config.js` |
| Réglages | `src/config/schema.ts` (`memory.consolidation.*`) |

⚠️ **Aucun second `setInterval`, aucune `SourceRecord`** : la passe est un
rendez-vous planifié décidé par le balayeur unique (30 s), comme les envois
programmés du lot 28.

## 2. Amendement ① — mesurer AVANT de découper

Au début de chaque passe (`src/memory/consolidation-hebdo.ts`) :

1. **mesure** : entrées, caractères (texte + justification), octets du fichier ;
2. **estimation** des tokens : `ceil(caractères / 3,5)` — hypothèse *3,5 car./token
   (français)*, **écrite dans le rapport** (`mesure.hypothese`) ;
3. **contexte du modèle lourd RÉELLEMENT configuré**, **lu** dans
   `config/pi/models.json` (`contexteModeleDepuisFichier`) — jamais un 1 M codé ;
4. **budget** = `min(réglage memory.consolidation.budgetTokens, contexte − marge
   de sortie − prompt fixe)` (marge 8 192, prompt fixe 1 200) ;
5. ⚠️ **tout tient ⇒ UN SEUL LOT** : aucun conflit inter-lots, aucune réduction
   d'information ; sinon des lots dimensionnés par le budget (jamais une taille
   fixe arbitraire) ;
6. **plafond de sécurité** : 20 000 entrées examinées (les plus récentes). Justesse
   du chiffre : 20 000 souvenirs × 600 car. max ≈ 12 M car. ≈ 3,4 M tokens, soit
   des dizaines d'appels lourds (plusieurs heures) pour une qualité dégradée sur
   de très longs contextes. Au-delà, `nonExaminees` le DIT et **rien n'est
   supprimé** du seul fait du plafond.

Le rapport porte : entrées, caractères, tokens estimés, hypothèse, contexte du
modèle, marge, prompt fixe, budget, nombre de lots, % du contexte, non examinées.

## 3. Protocole du modèle

Réponse **JSON strict** :

```json
{"version":1,"lot":1,"operations":[
  {"op":"garder","id":"mem-…"},
  {"op":"corriger","id":"mem-…","text":"…","cat":"fait","why":"…","raison":"…"},
  {"op":"fusionner","ids":["mem-a","mem-b"],"text":"…","cat":"…","why":"…","raison":"…"},
  {"op":"supprimer","id":"mem-…","raison":"…"},
  {"op":"signaler","id":"mem-…","raison":"…"}
]}
```

Garde-fous (`parseReponseHebdo`, `src/memory/weekly.ts`) — **une violation ⇒ refus
TOTAL, aucune modification** (jamais partiel) :

- couverture **exacte** du lot : chaque entrée citée **une seule fois** ;
- `raison` obligatoire pour `fusionner`/`corriger`/`supprimer`/`signaler` ;
- `text` + `why` obligatoires pour `corriger`/`fusionner` ;
- **plafond DUR** de suppressions : `floor(taille_du_lot × 10 %)`, au-delà la
  passe est **ANNULÉE** (⚠️ un lot de moins de 10 entrées n'admet aucune
  suppression) ;
- contradiction : **la plus récente gagne** (`updatedAt ?? at`) ; dates non
  comparables ⇒ l'opération devient `signaler` et **rien n'est touché** ;
- **anti-récursion** : session éphémère **sans aucun outil** (`tools: []`), donc
  aucun `delegate` possible ;
- **verrou** `enCours` : un chevauchement est sauté et journalisé (le verrou
  persisté est ignoré au-delà de 6 h — processus tué).

## 4. Amendement ② — versionning

Chaque passe dépose (avant application) :

```
<state>/memory-archive/consolidation/<AAAA-MM-JJ_HHMM>/
  memory.jsonl      ← état AVANT (restaurable à l'octet)
  operations.json   ← opérations appliquées (ou refus)
  rapport.json      ← mesure + résultat
```

- **rétention** `memory.consolidation.retention` (défaut 12 ≈ 3 mois) : les plus
  anciennes sont purgées, **purge journalisée** (`…version.purged`) ;
- **API** : `GET /api/memory/versions`, `GET …/<nom>/download`,
  `POST …/<nom>/restore` (garde-fous `X-Yuki-Config` + `Origin`) ;
- **UI** : bloc « Versions de la mémoire » (date, compteurs, **Télécharger**,
  **Restaurer** avec confirmation `HolafModal`) ;
- **anti-traversée** : regex stricte à composantes bornées **et** confinement
  (`resolve` + préfixe) ; `../` ⇒ 400, jamais un accès disque.

## 5. Amendement ③ — `3 h de Paris`

`memory.consolidation.timeZone` = **`Europe/Paris`** (défaut), **lu** à chaque
décision (jamais supposé) ; ⚠️ distinct de `ui.timeZone` (UTC) qui reste le
fuseau d'**affichage**. Cron par défaut `0 3 * * 0`. Rattrapage **une seule fois
si le retard ≤ 24 h**, au-delà **sauté et journalisé**.

## 6. Application atomique

Section **entièrement synchrone** : lecture du fichier, ajout des lignes
`update`/`delete` (le journal reste append-only), écriture d'un `tmp` puis
`renameSync`. Ensuite `MemoryStore.reload()` (reprojection) et
`MemoryIndex.rebuild(...)` : **l'index FTS5 est reconstruit**, jamais laissé
dérivé.

## 7. Preuve que les tests échouent sans le code

`HEAD` (2b2b12e) contient les lots antérieurs mais **aucun fichier du lot 29** :
`git show HEAD:src/memory/weekly.ts` répond `fatal: path ... exists on disk, but
not in 'HEAD'` (idem `consolidation-archive.ts`, `consolidation-hebdo.ts`), et la
route `memory.ts` de `HEAD` ne connaît pas `/api/memory/versions`.

Preuve **exécutée** sur une copie `/tmp` (jamais sur l'arbre) : `tar` (rsync
absent) puis suppression des trois modules neufs et remise des deux fichiers UI à
leur version de `HEAD` (`git show HEAD:<fichier> > copie/<fichier>`) :

```bash
mkdir -p /tmp/preuve-lot29
tar -cf - --exclude=node_modules --exclude=.git --exclude=dist . | (cd /tmp/preuve-lot29 && tar -xf -)
rm /tmp/preuve-lot29/src/memory/{weekly,consolidation-archive,consolidation-hebdo}.ts
git show HEAD:public/ui/config.js > /tmp/preuve-lot29/public/ui/config.js
git show HEAD:public/ui/personality-panel.js > /tmp/preuve-lot29/public/ui/personality-panel.js
cd /tmp/preuve-lot29 && npx vitest run \
  tests/memory/weekly.test.ts tests/memory/consolidation-hebdo.test.ts \
  tests/memory/consolidation-hebdo-gardes.test.ts \
  tests/gateway/memory-versions-api.test.ts tests/ui/memoire-versions-page.test.ts
# => 5 fichiers en échec / 5 (« Cannot find module ... » + 5 assertions UI) ; copie supprimée ensuite.
```

## 8. Ce qui reste invérifiable ici

- Le **volume réel de production** (nombre d'entrées et caractères par passe) :
  la mesure est faite à l'exécution, pas dans les tests.
- Le **tokenizer exact** du fournisseur : l'estimation 3,5 car./token est une
  hypothèse (dite dans le rapport), pas une mesure du provider.
- La **qualité** des consolidations produites par le modèle lourd : les tests
  utilisent des doubles ; seule une passe réelle en production la dira.
