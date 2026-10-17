//go:build linux

package exec

import (
	"context"
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

// TestEnfantRecoitVraimentLeSecret est la PREUVE MAILLON ④ : on lance un VRAI
// processus (`/bin/sh`) par `Runner.Run` avec un `EnvOverlay` et on lit ce que
// le shell a réellement développé. Le test ÉCHOUE si le câblage
// `request.EnvOverlay → cmd.Env` est coupé (c'était le bug initial).
//
// ⚠️ Ce test-ci ne peut pas passer par lecture : il exige une exécution réelle.
func TestEnfantRecoitVraimentLeSecret(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(), Request{
		ID:      "env-reel",
		Command: `printf '%s' "$YUKI_SECRET_NAS"`,
		EnvOverlay: map[string]string{
			"YUKI_SECRET_NAS": "s3cr3t-value",
		},
	})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, stderr = %q", res.ExitCode, res.Stderr)
	}
	if res.Stdout != "s3cr3t-value" {
		t.Fatalf("le processus enfant n'a PAS reçu la variable : stdout = %q", res.Stdout)
	}
}

// TestEnfantGardePathAvecOverlay prouve que l'overlay n'ÉCRASE pas
// l'environnement : `PATH` reste exploitable (shell complet, D123) en présence
// d'un secret. Sans cela, une commande référençant un secret perdrait `PATH` et
// échouerait de façon déroutante.
func TestEnfantGardePathAvecOverlay(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(), Request{
		Command:    `printf '%s' "$YUKI_SECRET_NAS"; command -v sh >/dev/null && printf '|path-ok'`,
		EnvOverlay: map[string]string{"YUKI_SECRET_NAS": "v"},
	})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if res.Stdout != "v|path-ok" {
		t.Fatalf("stdout = %q (secret et/ou PATH perdus)", res.Stdout)
	}
}
