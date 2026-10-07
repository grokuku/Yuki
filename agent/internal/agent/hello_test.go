package agent

import (
	"os"
	"runtime"
	"testing"

	"github.com/grokuku/yuki/agent/internal/proto"
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
