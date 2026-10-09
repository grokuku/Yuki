package agent

import (
	"os"
	"runtime"
	"testing"

	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/screen"
)

func TestBuildHelloDepuisOS(t *testing.T) {
	cfg := &Config{AgentID: "agent-1"}
	cfg.ApplyDefaults()
	hello := BuildHello(cfg, "9.9.9")

	if hello.AgentID != "agent-1" {
		t.Fatalf("agent_id = %q", hello.AgentID)
	}
	if hello.AgentVersion != "9.9.9" {
		t.Fatalf("agent_version = %q", hello.AgentVersion)
	}
	if hello.OS != runtime.GOOS {
		t.Fatalf("os = %q, attendu %q", hello.OS, runtime.GOOS)
	}
	if hello.Arch != runtime.GOARCH {
		t.Fatalf("arch = %q, attendu %q", hello.Arch, runtime.GOARCH)
	}
	host, _ := os.Hostname()
	if hello.Host != host {
		t.Fatalf("host = %q, attendu %q", hello.Host, host)
	}
	if runtime.GOOS != "windows" && hello.EUID < 0 {
		t.Fatalf("euid = %d, attendu ≥ 0 sur Unix", hello.EUID)
	}
	if len(hello.Caps) == 0 {
		t.Fatal("caps vide")
	}
	// `exec` est TOUJOURS déclarée (capacité du binaire, pas de l'écran).
	if !contains(hello.Caps, "exec") {
		t.Fatalf("caps = %v, `exec` attendue", hello.Caps)
	}
	// La trame doit être encodable avec le type et la version du protocole.
	data, err := proto.Encode(hello)
	if err != nil {
		t.Fatalf("Encode(hello) : %v", err)
	}
	decoded, err := proto.Decode(data)
	if err != nil {
		t.Fatalf("Decode(hello) : %v", err)
	}
	if _, ok := decoded.(*proto.Hello); !ok {
		t.Fatalf("trame décodée = %T", decoded)
	}
}

func contains(caps []string, want string) bool {
	for _, cap := range caps {
		if cap == want {
			return true
		}
	}
	return false
}

func envOf(values map[string]string) screen.GetenvFunc {
	return func(key string) string { return values[key] }
}

func lookPathOf(found ...string) screen.LookPathFunc {
	set := make(map[string]bool, len(found))
	for _, name := range found {
		set[name] = true
	}
	return func(file string) (string, error) {
		if set[file] {
			return "/usr/bin/" + file, nil
		}
		return "", os.ErrNotExist
	}
}

func TestCapabilitiesSansEcranSansScreenshot(t *testing.T) {
	caps := capabilitiesFor("linux", envOf(nil), lookPathOf("scrot", "grim"))
	if contains(caps, "screenshot") {
		t.Fatalf("`screenshot` déclarée sans écran : %v", caps)
	}
}

func TestCapabilitiesSansOutilSansScreenshot(t *testing.T) {
	caps := capabilitiesFor("linux", envOf(map[string]string{"DISPLAY": ":0"}), lookPathOf())
	if contains(caps, "screenshot") {
		t.Fatalf("`screenshot` déclarée sans outil : %v", caps)
	}
}

func TestCapabilitiesAvecEcranEtOutil(t *testing.T) {
	caps := capabilitiesFor("linux", envOf(map[string]string{"DISPLAY": ":0"}), lookPathOf("scrot"))
	if !contains(caps, "screenshot") {
		t.Fatalf("`screenshot` absente alors qu'écran + outil sont présents : %v", caps)
	}
	if !contains(caps, "exec") || !contains(caps, "shell") || !contains(caps, "classify") {
		t.Fatalf("capacités de base manquantes : %v", caps)
	}
}
