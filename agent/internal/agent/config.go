package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Valeurs par défaut EXPLICITES de la configuration locale (A6).
const (
	// DefaultPingIntervalMS : heartbeat applicatif (15 s).
	DefaultPingIntervalMS = 15000
	// DefaultOfflineAfterMS : déclaration hors ligne (45 s sans pong).
	DefaultOfflineAfterMS = 45000
	// DefaultTimeoutMS : délai maximal par commande si Yuki n'en fixe aucun
	// (5 min).
	DefaultTimeoutMS = 300000
	// DefaultOutputCapBytes : plafond de capture PAR FLUX (256 Kio).
	DefaultOutputCapBytes = 256 * 1024
	// DefaultLogLevel : verbosité du journal structuré.
	DefaultLogLevel = "info"
)

// Fichiers d'état de l'agent (sous `StateDir`).
const (
	caFileName   = "ca.pem"
	certFileName = "client.pem"
	keyFileName  = "client.key"
)

// Config est la configuration locale de l'agent, sérialisable en JSON
// (`agent/config/agent.example.json`). Les chemins absents sont dérivés de
// `StateDir` par `ApplyDefaults`.
type Config struct {
	// YukiURL : URL WebSocket du port machines (`wss://hôte:port/ws`).
	YukiURL string `json:"yuki_url"`
	// PairURL : base HTTPS d'appairage. Vide ⇒ dérivée de `YukiURL`
	// (`wss://hôte:port/ws` ⇒ `https://hôte:port`).
	PairURL string `json:"pair_url,omitempty"`
	// AgentID : identifiant renvoyé par Yuki à l'appairage (renseigné par
	// `pair`). Vide avant le premier appairage.
	AgentID string `json:"agent_id,omitempty"`
	// StateDir : répertoire d'état (configuration + certificats). Défaut :
	// `/etc/yuki-agent` (Linux) ou `%ProgramData%\yuki-agent` (Windows).
	StateDir string `json:"state_dir,omitempty"`
	// CAFile / CertFile / KeyFile : chemins PEM. Défaut : `<StateDir>/ca.pem`,
	// `client.pem`, `client.key`.
	CAFile   string `json:"ca_file,omitempty"`
	CertFile string `json:"cert_file,omitempty"`
	KeyFile  string `json:"key_file,omitempty"`
	// Shell : shell par défaut (`sh`, `bash`, `powershell`…). Vide ⇒ shell
	// système (`/bin/sh` sous Linux, `cmd.exe` sous Windows).
	Shell string `json:"shell,omitempty"`
	// DefaultTimeoutMS : délai par défaut par commande (ms).
	DefaultTimeoutMS int64 `json:"default_timeout_ms,omitempty"`
	// OutputCapBytes : plafond de capture par flux (octets).
	OutputCapBytes int `json:"output_cap_bytes,omitempty"`
	// PingIntervalMS / OfflineAfterMS : heartbeat applicatif.
	PingIntervalMS int64 `json:"ping_interval_ms,omitempty"`
	OfflineAfterMS int64 `json:"offline_after_ms,omitempty"`
	// LogLevel : `debug`, `info`, `warn`, `error`.
	LogLevel string `json:"log_level,omitempty"`
}

// DefaultStateDir renvoie le répertoire d'état par défaut de la plateforme.
func DefaultStateDir() string {
	if runtime.GOOS == "windows" {
		if programData := os.Getenv("ProgramData"); programData != "" {
			return filepath.Join(programData, "yuki-agent")
		}
		return `C:\ProgramData\yuki-agent`
	}
	return "/etc/yuki-agent"
}

// DefaultConfigPath renvoie le chemin par défaut du fichier de configuration.
func DefaultConfigPath() string {
	return filepath.Join(DefaultStateDir(), "agent.json")
}

// ResolveConfigPath applique la précédence : `--config` explicite, puis
// `YUKI_AGENT_CONFIG`, puis le chemin par défaut de la plateforme.
func ResolveConfigPath(explicit string) string {
	if strings.TrimSpace(explicit) != "" {
		return explicit
	}
	if env := strings.TrimSpace(os.Getenv("YUKI_AGENT_CONFIG")); env != "" {
		return env
	}
	return DefaultConfigPath()
}

// ApplyDefaults renseigne les valeurs par défaut explicites et dérive les
// chemins manquants. Idempotent.
func (c *Config) ApplyDefaults() {
	if strings.TrimSpace(c.StateDir) == "" {
		c.StateDir = DefaultStateDir()
	}
	if strings.TrimSpace(c.CAFile) == "" {
		c.CAFile = filepath.Join(c.StateDir, caFileName)
	}
	if strings.TrimSpace(c.CertFile) == "" {
		c.CertFile = filepath.Join(c.StateDir, certFileName)
	}
	if strings.TrimSpace(c.KeyFile) == "" {
		c.KeyFile = filepath.Join(c.StateDir, keyFileName)
	}
	if c.DefaultTimeoutMS <= 0 {
		c.DefaultTimeoutMS = DefaultTimeoutMS
	}
	if c.OutputCapBytes <= 0 {
		c.OutputCapBytes = DefaultOutputCapBytes
	}
	if c.PingIntervalMS <= 0 {
		c.PingIntervalMS = DefaultPingIntervalMS
	}
	if c.OfflineAfterMS <= 0 {
		c.OfflineAfterMS = DefaultOfflineAfterMS
	}
	if strings.TrimSpace(c.LogLevel) == "" {
		c.LogLevel = DefaultLogLevel
	}
	if strings.TrimSpace(c.PairURL) == "" && strings.TrimSpace(c.YukiURL) != "" {
		c.PairURL = DerivePairURL(c.YukiURL)
	}
}

// DerivePairURL transforme une URL WebSocket de Yuki en base HTTPS d'appairage.
// `wss://hôte:port/ws` ⇒ `https://hôte:port` ; `ws://…` ⇒ `http://…`. Renvoie
// la chaîne vide si l'URL est illisible.
func DerivePairURL(yukiURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(yukiURL))
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := "https"
	switch strings.ToLower(parsed.Scheme) {
	case "ws", "http":
		scheme = "http"
	case "wss", "https":
		scheme = "https"
	default:
		return ""
	}
	return scheme + "://" + parsed.Host
}

// Validate vérifie la cohérence de la configuration (après `ApplyDefaults`).
func (c *Config) Validate() error {
	if strings.TrimSpace(c.YukiURL) == "" {
		return errors.New("agent : `yuki_url` requis (adresse de Yuki)")
	}
	parsed, err := url.Parse(c.YukiURL)
	if err != nil {
		return fmt.Errorf("agent : `yuki_url` invalide : %w", err)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "ws", "wss":
	default:
		return fmt.Errorf("agent : `yuki_url` doit être une URL WebSocket (ws/wss), reçu %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return errors.New("agent : `yuki_url` sans hôte")
	}
	if strings.TrimSpace(c.PairURL) != "" {
		pair, err := url.Parse(c.PairURL)
		if err != nil || pair.Host == "" {
			return fmt.Errorf("agent : `pair_url` invalide : %q", c.PairURL)
		}
	}
	return nil
}

// Load lit un fichier de configuration JSON et applique les défauts.
//
// Un chemin EXPLICITE introuvable est une erreur ; le chemin par DÉFAUT
// introuvable renvoie une configuration vide (défauts seuls), afin que la CLI
// puisse fonctionner avec de simples options.
func Load(path string, explicit bool) (*Config, error) {
	cfg := &Config{}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("agent : configuration %q illisible : %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist) && !explicit:
		// Aucun fichier : on part des défauts.
	default:
		return nil, fmt.Errorf("agent : lecture de %q : %w", path, err)
	}
	cfg.ApplyDefaults()
	return cfg, nil
}

// Save écrit la configuration en JSON indenté, avec des permissions
// restrictives (`0600`) et un répertoire parent `0700`.
func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("agent : création de %q : %w", filepath.Dir(path), err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("agent : encodage de la configuration : %w", err)
	}
	data = append(data, '\n')
	// Écriture atomique via fichier temporaire + renommage.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("agent : écriture de %q : %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("agent : renommage de %q : %w", path, err)
	}
	return nil
}

// Paired indique que le matériel d'appairage est présent (CA + cert + clé).
func (c *Config) Paired() bool {
	for _, path := range []string{c.CAFile, c.CertFile, c.KeyFile} {
		if _, err := os.Stat(path); err != nil {
			return false
		}
	}
	return true
}
