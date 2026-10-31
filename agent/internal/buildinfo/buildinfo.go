// Package buildinfo porte la version de l'agent d'exécution.
//
// ⚠️ SOURCE UNIQUE DE VÉRITÉ : `version.txt` à la RACINE du dépôt — le MÊME
// numéro que l'image du gateway (`ghcr.io/grokuku/yuki:<version>`). Il n'existe
// plus de fichier `VERSION` sous `agent/` : deux sources = divergence garantie.
//
// La valeur par défaut ci-dessous n'est PAS un numéro de version : elle dit
// explicitement que le binaire n'a pas été construit par la CI. La vraie valeur
// est INJECTÉE à la compilation (`-X`), depuis `version.txt` :
//
//	cd agent && go build -ldflags "-s -w -X github.com/grokuku/yuki/agent/internal/buildinfo.Version=$(tr -d '[:space:]' < ../version.txt)" ./cmd/yuki-agent
//
// C'est exactement ce que font la CI des binaires (`.github/workflows/agent.yml`,
// job `agent-build`) et la publication unifiée (`.github/workflows/release.yml`).
// `buildinfo_test.go` verrouille ce contrat (aucun `VERSION` sous `agent/`, `dev` par
// défaut, `version.txt` au format MAJOR.MINOR.PATCH).
package buildinfo

// Version est la version de l'agent d'exécution, DÉFINIE À LA COMPILATION.
//
// ⚠️ Ne jamais écrire un numéro de version ici : le bump de `version.txt` est
// fait par le workflow de publication, et une valeur codée en dur deviendrait
// fausse (donc mensongère dans `yuki-agent version` et dans le `hello` envoyé à
// Yuki) au premier bump.
var Version = "dev"
