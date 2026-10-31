package buildinfo

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// racine est la racine du dépôt vue depuis ce package (`agent/internal/buildinfo`).
const racine = "../../.."

// semver est le format imposé par les workflows (`MAJOR.MINOR.PATCH`).
var semver = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// TestVersionUnique verrouille la règle « UN SEUL numéro de version » :
// `version.txt` à la racine, et plus AUCUN `VERSION` sous `agent/` (la seconde source de
// vérité qui a produit 0.1.0 côté image et 0.2.0 côté agent).
func TestVersionUnique(t *testing.T) {
	legacy := filepath.Join("..", "..", "VERSION")
	if _, err := os.Stat(legacy); err == nil {
		t.Fatalf("le fichier VERSION sous agent/ existe encore : la version doit venir de version.txt (racine) uniquement")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stat du fichier VERSION sous agent/ : %v", err)
	}

	data, err := os.ReadFile(filepath.Join(racine, "version.txt"))
	if err != nil {
		t.Fatalf("lecture de version.txt (racine du dépôt) : %v", err)
	}
	v := strings.TrimSpace(string(data))
	if v == "" {
		t.Fatal("version.txt est vide")
	}
	if !semver.MatchString(v) {
		t.Fatalf("version.txt = %q : format MAJOR.MINOR.PATCH attendu", v)
	}
}

// TestVersionParDefautNeMentPas garantit que la valeur par défaut n'est PAS un
// numéro de version : le bump automatisé de `version.txt` ne doit jamais rendre
// ce fichier faux. Un binaire non injecté (`dev`) se reconnaît immédiatement.
func TestVersionParDefautNeMentPas(t *testing.T) {
	if Version != "dev" {
		t.Fatalf("buildinfo.Version = %q : la valeur par défaut doit rester %q (la version réelle est injectée par -ldflags -X depuis version.txt)", Version, "dev")
	}
	if semver.MatchString(Version) {
		t.Fatalf("buildinfo.Version = %q : un numéro de version codé en dur deviendra faux au prochain bump de version.txt", Version)
	}
}
