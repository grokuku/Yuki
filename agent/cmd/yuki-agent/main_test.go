package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/grokuku/yuki/agent/internal/agent"
	"github.com/grokuku/yuki/agent/internal/buildinfo"
)

// execCLI exécute le CLI avec des flux capturés.
func execCLI(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, strings.NewReader(""), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestVersion(t *testing.T) {
	code, stdout, _ := execCLI(t, "version")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stdout, "yuki-agent "+buildinfo.Version) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestAideListeSousCommandes(t *testing.T) {
	for _, flag := range []string{"-h", "--help", "help"} {
		code, stdout, _ := execCLI(t, flag)
		if code != 0 {
			t.Fatalf("%s : code = %d", flag, code)
		}
		for _, command := range []string{"pair", "run", "install", "uninstall", "status", "version"} {
			if !strings.Contains(stdout, command) {
				t.Fatalf("%s : sous-commande %q absente de l'aide", flag, command)
			}
		}
	}
}

func TestCommandeInconnue(t *testing.T) {
	code, _, stderr := execCLI(t, "bidule")
	if code != 2 {
		t.Fatalf("code = %d, attendu 2", code)
	}
	if !strings.Contains(stderr, "commande inconnue") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestAucunArgument(t *testing.T) {
	code, _, stderr := execCLI(t)
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stderr, "Usage") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestPairAide(t *testing.T) {
	code, _, stderr := execCLI(t, "pair", "-h")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stderr, "pair") {
		t.Fatalf("aide pair absente : %q", stderr)
	}
}

func TestPairCodeInvalide(t *testing.T) {
	code, _, stderr := execCLI(t,
		"pair", "--yuki-url", "wss://yuki.example.org:8765/ws", "--code", "O0IL")
	if code != 1 {
		t.Fatalf("code = %d, attendu 1", code)
	}
	if !strings.Contains(stderr, "code d'appairage invalide") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestStatusConfigMinimale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("écriture : %v", err)
	}
	code, stdout, _ := execCLI(t, "status", "--config", path)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stdout, "yuki-agent "+buildinfo.Version) {
		t.Fatalf("stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "appairage      : NON") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunNonAppaire(t *testing.T) {
	dir := t.TempDir()
	cfg := &agent.Config{YukiURL: "wss://yuki.example.org:8765/ws", StateDir: dir}
	cfg.ApplyDefaults()
	path := filepath.Join(dir, "agent.json")
	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save : %v", err)
	}
	code, _, stderr := execCLI(t, "run", "--config", path)
	if code != 1 {
		t.Fatalf("code = %d, attendu 1", code)
	}
	if !strings.Contains(stderr, "agent.non_appaire") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestInstallLinuxOrienteVersScript(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("comportement spécifique à Linux")
	}
	code, _, stderr := execCLI(t, "install")
	if code != 1 {
		t.Fatalf("code = %d, attendu 1 (non supporté sous Linux)", code)
	}
	if !strings.Contains(stderr, "install.sh") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUninstallLinuxOrienteVersSystemctl(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("comportement spécifique à Linux")
	}
	code, _, stderr := execCLI(t, "uninstall")
	if code != 1 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stderr, "systemctl") {
		t.Fatalf("stderr = %q", stderr)
	}
}

// TestMainNePaniquePas : vérifie qu'aucune sous-commande courante ne panique
// sur une entrée vide.
func TestMainNePaniquePas(t *testing.T) {
	_ = os.DevNull
	for _, command := range []string{"version", "help"} {
		if code, _, _ := execCLI(t, command); code != 0 {
			t.Fatalf("%s : code = %d", command, code)
		}
	}
}
