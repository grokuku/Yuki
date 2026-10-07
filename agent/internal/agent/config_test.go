package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestApplyDefaultsRenseigneTout(t *testing.T) {
	cfg := &Config{}
	cfg.ApplyDefaults()

	if cfg.StateDir == "" {
		t.Fatal("StateDir non renseigné")
	}
	if cfg.CAFile != filepath.Join(cfg.StateDir, "ca.pem") {
		t.Fatalf("CAFile = %q", cfg.CAFile)
	}
	if cfg.CertFile != filepath.Join(cfg.StateDir, "client.pem") {
		t.Fatalf("CertFile = %q", cfg.CertFile)
	}
	if cfg.KeyFile != filepath.Join(cfg.StateDir, "client.key") {
		t.Fatalf("KeyFile = %q", cfg.KeyFile)
	}
	if cfg.DefaultTimeoutMS != DefaultTimeoutMS {
		t.Fatalf("DefaultTimeoutMS = %d", cfg.DefaultTimeoutMS)
	}
	if cfg.OutputCapBytes != DefaultOutputCapBytes {
		t.Fatalf("OutputCapBytes = %d", cfg.OutputCapBytes)
	}
	if cfg.PingIntervalMS != DefaultPingIntervalMS || cfg.OfflineAfterMS != DefaultOfflineAfterMS {
		t.Fatalf("heartbeat = %d/%d", cfg.PingIntervalMS, cfg.OfflineAfterMS)
	}
	if cfg.LogLevel != DefaultLogLevel {
		t.Fatalf("LogLevel = %q", cfg.LogLevel)
	}
}

func TestDerivePairURL(t *testing.T) {
	cases := map[string]string{
		"wss://yuki.example.org:8765/ws": "https://yuki.example.org:8765",
		"ws://127.0.0.1:9000/ws":         "http://127.0.0.1:9000",
		"https://yuki.example.org":       "https://yuki.example.org",
		"pas une url":                    "",
		"ftp://yuki":                     "",
	}
	for input, want := range cases {
		if got := DerivePairURL(input); got != want {
			t.Errorf("DerivePairURL(%q) = %q, attendu %q", input, got, want)
		}
	}
}

func TestValidate(t *testing.T) {
	valid := &Config{YukiURL: "wss://yuki:8765/ws"}
	valid.ApplyDefaults()
	if err := valid.Validate(); err != nil {
		t.Fatalf("configuration valide refusée : %v", err)
	}
	if valid.PairURL != "https://yuki:8765" {
		t.Fatalf("PairURL dérivée = %q", valid.PairURL)
	}

	invalid := []*Config{
		{},
		{YukiURL: "http://yuki/ws"},
		{YukiURL: "wss:///ws"},
	}
	for _, cfg := range invalid {
		cfg.ApplyDefaults()
		if err := cfg.Validate(); err == nil {
			t.Errorf("configuration invalide acceptée : %+v", cfg)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.json")
	cfg := &Config{YukiURL: "wss://yuki:8765/ws", AgentID: "agent-42", Shell: "bash"}
	cfg.ApplyDefaults()
	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save : %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat : %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions du fichier = %v, attendu 0600", info.Mode().Perm())
	}

	loaded, err := Load(path, true)
	if err != nil {
		t.Fatalf("Load : %v", err)
	}
	if loaded.AgentID != "agent-42" || loaded.YukiURL != cfg.YukiURL {
		t.Fatalf("rechargement incohérent : %+v", loaded)
	}
	// JSON indenté et lisible.
	data, _ := os.ReadFile(path)
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("JSON invalide : %v", err)
	}
	if decoded["agent_id"] != "agent-42" {
		t.Fatalf("agent_id sérialisé = %v", decoded["agent_id"])
	}
}

func TestLoadFichierExpliciteAbsentEchoue(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "absent.json"), true); err == nil {
		t.Fatal("fichier explicite absent accepté")
	}
	// Chemin par défaut absent : configuration vide, pas d'erreur.
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"), false)
	if err != nil {
		t.Fatalf("défaut absent : %v", err)
	}
	if cfg.StateDir == "" {
		t.Fatal("défauts non appliqués")
	}
}

func TestExempleDeConfigurationValide(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "config", "agent.example.json"))
	if err != nil {
		t.Fatalf("lecture de l'exemple : %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("exemple illisible : %v", err)
	}
	if cfg.YukiURL == "" {
		t.Fatal("`yuki_url` absent de l'exemple")
	}
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("exemple invalide : %v", err)
	}
}

func TestPaired(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{StateDir: dir}
	cfg.ApplyDefaults()
	if cfg.Paired() {
		t.Fatal("agent déclaré appairé sans fichiers")
	}
	for path, content := range map[string]string{
		cfg.CAFile:   "ca",
		cfg.CertFile: "cert",
		cfg.KeyFile:  "key",
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("écriture : %v", err)
		}
	}
	if !cfg.Paired() {
		t.Fatal("agent non déclaré appairé alors que les fichiers existent")
	}
}
