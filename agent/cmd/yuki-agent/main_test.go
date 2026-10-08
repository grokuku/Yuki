package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/grokuku/yuki/agent/internal/agent"
	"github.com/grokuku/yuki/agent/internal/buildinfo"
	"github.com/grokuku/yuki/agent/internal/pair"
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

// failReader signale toute lecture de stdin : `pair` ne doit JAMAIS demander
// le code d'appairage (D119 — c'est l'agent qui l'affiche).
type failReader struct{ read bool }

func (r *failReader) Read([]byte) (int, error) {
	r.read = true
	return 0, errors.New("stdin ne doit pas être lu pour le code")
}

// pairTestConfig crée un fichier de configuration isolé (évite de dépendre de
// `/etc/yuki-agent/agent.json`).
func pairTestConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("écriture config : %v", err)
	}
	return path
}

// TestPairGenereEtAfficheLeCodeSansLeDemander : le serveur d'appairage étant
// injoignable, la CLI échoue APRÈS avoir affiché le code (le code est généré
// et affiché AVANT le `pair_begin`) ; elle ne lit jamais stdin.
func TestPairGenereEtAfficheLeCodeSansLeDemander(t *testing.T) {
	reader := &failReader{}
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"pair",
		"--config", pairTestConfig(t),
		"--yuki-url", "wss://10.10.0.5:19443/ws",
		"--pair-url", "http://127.0.0.1:1",
		"--state-dir", t.TempDir(),
	}, reader, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("code = %d, attendu 1 (serveur d'appairage injoignable)", code)
	}
	if reader.read {
		t.Fatal("`pair` a lu sur stdin : il ne doit jamais demander le code (D119)")
	}
	out := stdout.String()
	if strings.Contains(out, "affiché par Yuki") {
		t.Fatalf("la CLI demande encore un code fourni par Yuki : %q", out)
	}
	// Le code est affiché au format XXXX-XXXX-XXXX : on le capture puis on le
	// valide avec le MÊME normaliseur que le protocole.
	candidate := regexp.MustCompile(`\b[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\b`).FindString(out)
	if candidate == "" {
		t.Fatalf("aucun code XXXX-XXXX-XXXX dans la sortie : %q", out)
	}
	if _, err := pair.NormalizeCode(candidate); err != nil {
		t.Fatalf("code affiché invalide (%q) : %v", candidate, err)
	}
	for _, needle := range []string{"Code d'appairage", "Recopiez le code", "Configuration", "Agents"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("mode d'emploi incomplet : %q absent de %q", needle, out)
		}
	}
}

// TestPairTolereURLSansWs : une `--yuki-url` sans suffixe `/ws` est complétée et
// signalée (le port machines n'écoute que ce chemin).
func TestPairTolereURLSansWs(t *testing.T) {
	reader := &failReader{}
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"pair",
		"--config", pairTestConfig(t),
		"--yuki-url", "wss://10.10.0.5:19443", // sans /ws
		"--pair-url", "http://127.0.0.1:1",
		"--state-dir", t.TempDir(),
	}, reader, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("code = %d, attendu 1", code)
	}
	out := stdout.String()
	if !strings.Contains(out, "wss://10.10.0.5:19443/ws") {
		t.Fatalf("adresse /ws complétée absente : %q", out)
	}
	if !strings.Contains(out, "suffixe « /ws » ajouté") {
		t.Fatalf("complétion non signalée : %q", out)
	}
}

// TestPairNacceptePlusDeCode : l'option `--code` (flux inversé, contraire à
// D119) a été retirée.
func TestPairNacceptePlusDeCode(t *testing.T) {
	code, _, _ := execCLI(t, "pair", "--config", pairTestConfig(t), "--code", "ABCD-2345-6789")
	if code != 2 {
		t.Fatalf("code = %d, attendu 2 (option --code supprimée)", code)
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
	cfg := &agent.Config{YukiURL: "wss://yuki.example.org:9443/ws", StateDir: dir}
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
