//go:build linux

package exec

import (
	"strings"
	"testing"
)

// envMap convertit une tranche d'environnement en map pour l'assertion.
func envMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, kv := range env {
		key, value, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		out[key] = value
	}
	return out
}

// TestEnvironmentOverlay vérifie que `EnvOverlay` est un SUR-ENSEMBLE appliqué
// clé par clé : il écrase les clés présentes et ajoute les nouvelles, sans
// jamais retirer `PATH`/`HOME` (sinon un shell complet cesserait de marcher).
func TestEnvironmentOverlay(t *testing.T) {
	r := New(Options{Env: []string{"PATH=/bin", "HOME=/root"}})

	t.Run("sur-ensemble", func(t *testing.T) {
		out := envMap(r.environment(nil, map[string]string{
			"YUKI_SECRET_NAS": "s3cr3t-value",
			"PATH":            "/usr/bin",
		}))
		if out["YUKI_SECRET_NAS"] != "s3cr3t-value" {
			t.Fatalf("secret absent : %q", out["YUKI_SECRET_NAS"])
		}
		if out["PATH"] != "/usr/bin" {
			t.Fatalf("PATH non écrasé : %q", out["PATH"])
		}
		if out["HOME"] != "/root" {
			t.Fatalf("HOME perdu : %q", out["HOME"])
		}
	})

	t.Run("sans overlay", func(t *testing.T) {
		out := envMap(r.environment(nil, nil))
		if out["PATH"] != "/bin" || out["HOME"] != "/root" {
			t.Fatalf("environnement de base altéré : %v", out)
		}
	})

	t.Run("reqEnv prime sur les options", func(t *testing.T) {
		out := envMap(r.environment([]string{"PATH=/sbin", "A=1"}, map[string]string{"A": "2"}))
		if out["PATH"] != "/sbin" || out["A"] != "2" {
			t.Fatalf("env explicite mal surchargé : %v", out)
		}
	})
}
