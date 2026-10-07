package buildinfo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVersionSynchroniseeAvecFichier garantit que la valeur par défaut codée en
// dur reste alignée sur `agent/VERSION` (source de vérité). Si ce test casse,
// mettez à jour `buildinfo.Version` OU passez `-ldflags -X`.
func TestVersionSynchroniseeAvecFichier(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "VERSION"))
	if err != nil {
		t.Fatalf("lecture de agent/VERSION : %v", err)
	}
	want := strings.TrimSpace(string(data))
	if want == "" {
		t.Fatal("agent/VERSION est vide")
	}
	if Version != want {
		t.Fatalf("buildinfo.Version = %q, agent/VERSION = %q", Version, want)
	}
}
