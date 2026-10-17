// Références de secrets dans une commande — module PUR (aucun accès disque,
// aucun état), miroir Go de `src/secrets/references.ts`.
//
// ⚠️ PRINCIPE (décision utilisateur n°1) : **PAS de substitution textuelle**.
// Le texte de la commande n'est JAMAIS réécrit ; la valeur du secret voyage
// EXCLUSIVEMENT par l'environnement (`Cmd.Env` → `Request.EnvOverlay`), et
// c'est le shell de l'enfant qui développe `$NOM`.
//
// ⚠️ POURQUOI L'AGENT DOIT VÉRIFIER LUI-MÊME : un shell qui ne trouve pas la
// variable la développe en CHAÎNE VIDE. Une commande comme
// `rm -rf /$YUKI_SECRET_DIR` deviendrait alors `rm -rf /` — DESTRUCTRICE. Un
// agent incapable de fournir la valeur d'une variable RÉSERVÉE doit donc
// REFUSER la commande, jamais l'exécuter avec une variable vide.
package exec

import (
	"regexp"
	"strings"
)

// SecretEnvPrefix est le préfixe RÉSERVÉ des variables d'environnement que Yuki
// injecte pour les secrets du coffre. Aligné sur `SECRET_NAME_PREFIX` côté
// TypeScript : c'est ce préfixe qui distingue une référence de secret d'une
// variable shell ordinaire (`$PATH`, `$HOME`, `$1`…).
const SecretEnvPrefix = "YUKI_SECRET_"

// secretReferencePattern reconnaît `$NOM` et `${NOM}` (nom = identifiant shell :
// lettre ou `_`, puis alphanumériques/`_`). `$1`, `$?`, `$@`… ne matchent donc
// PAS. Le même motif est utilisé côté TypeScript.
var secretReferencePattern = regexp.MustCompile(
	`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`,
)

// ExtractSecretReferences renvoie, dans l'ordre de première apparition et sans
// doublon, les noms de variables RÉSERVÉES (`YUKI_SECRET_…`) référencées dans
// `command` (formes `$NOM` et `${NOM}`). Une variable shell ordinaire est
// ignorée. Ne touche PAS au texte.
func ExtractSecretReferences(command string) []string {
	matches := secretReferencePattern.FindAllStringSubmatch(command, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	var names []string
	for _, match := range matches {
		name := match[1]
		if name == "" {
			name = match[2]
		}
		if !strings.HasPrefix(name, SecretEnvPrefix) {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// MissingSecretEnv renvoie les variables RÉSERVÉES référencées dans `command`
// qui ne sont PAS fournies par `overlay`, ou qui le sont avec une valeur VIDE.
//
// ⚠️ Une valeur VIDE est traitée comme ABSENTE : c'est exactement le cas
// dangereux (le shell développerait `$NOM` en chaîne vide). Un overlay `nil` ne
// fournit rien.
func MissingSecretEnv(command string, overlay map[string]string) []string {
	names := ExtractSecretReferences(command)
	if len(names) == 0 {
		return nil
	}
	var missing []string
	for _, name := range names {
		if value, present := overlay[name]; !present || value == "" {
			missing = append(missing, name)
		}
	}
	return missing
}
