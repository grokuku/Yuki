package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/grokuku/yuki/agent/internal/pair"
	"github.com/grokuku/yuki/agent/internal/proto"
)

// fauxYuki simule le port d'appairage de Yuki pour l'agent.
type fauxYuki struct {
	session   *pair.Session
	material  *pair.Payload
	immediate bool

	mu     sync.Mutex
	stored *proto.PairOK
}

func newFauxYuki(t *testing.T, immediate bool) (*fauxYuki, string) {
	t.Helper()
	code, err := pair.GenerateCode(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateCode : %v", err)
	}
	session, err := pair.NewSession(code, pair.Options{})
	if err != nil {
		t.Fatalf("NewSession : %v", err)
	}
	fy := &fauxYuki{
		session:   session,
		immediate: immediate,
		material: &pair.Payload{
			CACert:        "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
			ClientCert:    "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----\n",
			ClientKey:     "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
			AgentID:       "agent-uuid-1",
			CAFingerprint: "abc123",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pair", fy.handleBegin)
	mux.HandleFunc("/api/pair/p1", fy.handlePoll)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return fy, srv.URL
}

func (fy *fauxYuki) handleBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "méthode", http.StatusMethodNotAllowed)
		return
	}
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(r.Body)
	msg, err := proto.Decode(buf.Bytes())
	if err != nil {
		writePairError(w, http.StatusBadRequest, "malformed_message", err.Error())
		return
	}
	begin, ok := msg.(*proto.PairBegin)
	if !ok {
		writePairError(w, http.StatusBadRequest, "malformed_message", "trame inattendue")
		return
	}
	okMsg, err := fy.session.Authorize(begin, fy.material)
	if err != nil {
		writePairError(w, http.StatusUnauthorized, string(proto.CodeOf(err)), err.Error())
		return
	}
	if fy.immediate {
		writePairOK(w, http.StatusOK, okMsg)
		return
	}
	fy.mu.Lock()
	fy.stored = okMsg
	fy.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending", "pair_id": "p1"})
}

func (fy *fauxYuki) handlePoll(w http.ResponseWriter, _ *http.Request) {
	fy.mu.Lock()
	stored := fy.stored
	fy.mu.Unlock()
	if stored == nil {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending"})
		return
	}
	writePairOK(w, http.StatusOK, stored)
}

func writePairOK(w http.ResponseWriter, status int, ok *proto.PairOK) {
	data, _ := proto.Encode(ok)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writePairError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "code": code, "message": message})
}

func TestPerformPairingImmediat(t *testing.T) {
	fy, url := newFauxYuki(t, true)
	payload, err := PerformPairing(context.Background(), url, fy.session.Display(), "")
	if err != nil {
		t.Fatalf("PerformPairing : %v", err)
	}
	if payload.AgentID != "agent-uuid-1" {
		t.Fatalf("agent_id = %q", payload.AgentID)
	}
	if payload.CAFingerprint != "abc123" {
		t.Fatalf("ca_fingerprint = %q", payload.CAFingerprint)
	}
}

func TestPerformPairingDiffere(t *testing.T) {
	fy, url := newFauxYuki(t, false)
	payload, err := PerformPairing(context.Background(), url, fy.session.Display(), "")
	if err != nil {
		t.Fatalf("PerformPairing : %v", err)
	}
	if payload.AgentID != "agent-uuid-1" {
		t.Fatalf("agent_id = %q", payload.AgentID)
	}
}

func TestPerformPairingMauvaisCode(t *testing.T) {
	_, url := newFauxYuki(t, true)
	// Un code valide en FORME mais faux doit être refusé.
	badCode := "2345-6789-ABCD"
	if _, err := PerformPairing(context.Background(), url, badCode, ""); err == nil {
		t.Fatal("appairage accepté avec un mauvais code")
	}
}

func TestWriteMaterialPermissions(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{StateDir: dir}
	cfg.ApplyDefaults()
	payload := &pair.Payload{
		CACert:     "ca",
		ClientCert: "cert",
		ClientKey:  "secret-key",
		AgentID:    "a-1",
	}
	if err := WriteMaterial(cfg, payload); err != nil {
		t.Fatalf("WriteMaterial : %v", err)
	}
	if runtime.GOOS != "windows" {
		keyInfo, err := os.Stat(cfg.KeyFile)
		if err != nil {
			t.Fatalf("stat clé : %v", err)
		}
		if keyInfo.Mode().Perm() != 0o600 {
			t.Fatalf("permissions clé = %v, attendu 0600", keyInfo.Mode().Perm())
		}
		dirInfo, _ := os.Stat(dir)
		if dirInfo.Mode().Perm() != 0o700 {
			t.Fatalf("permissions répertoire = %v, attendu 0700", dirInfo.Mode().Perm())
		}
	}
	data, err := os.ReadFile(cfg.KeyFile)
	if err != nil || strings.TrimSpace(string(data)) != "secret-key" {
		t.Fatalf("contenu de la clé = %q (%v)", string(data), err)
	}
}
