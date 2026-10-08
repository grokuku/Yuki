package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

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

// setCode remplace la session courante par celle d'un code donné. Utilisé par
// les tests où c'est l'AGENT qui GÉNÈRE le code (via `PairingCallbacks.OnCode`),
// conformément à D119 — le serveur apprend alors le code de l'agent.
func (fy *fauxYuki) setCode(t *testing.T, code string) {
	t.Helper()
	session, err := pair.NewSession(code, pair.Options{})
	if err != nil {
		t.Fatalf("NewSession : %v", err)
	}
	fy.mu.Lock()
	fy.session = session
	fy.mu.Unlock()
}

// sessionCode lit la session courante sous verrou (le serveur de test et le
// test peuvent l'accéder depuis des goroutines différentes).
func (fy *fauxYuki) sessionCode() *pair.Session {
	fy.mu.Lock()
	defer fy.mu.Unlock()
	return fy.session
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
	okMsg, err := fy.sessionCode().Authorize(begin, fy.material)
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

func TestPairWithCodesGenereEtAfficheLeCode(t *testing.T) {
	fy, url := newFauxYuki(t, true)
	var codes []string
	attempt := 0
	payload, err := PairWithCodes(context.Background(), url, "", PairingPolicy{},
		PairingCallbacks{
			OnCode: func(code string, expiresAt time.Time, n int) {
				codes = append(codes, code)
				attempt = n
				fy.setCode(t, code)
				if !expiresAt.After(time.Now()) {
					t.Errorf("expiration non future : %v", expiresAt)
				}
			},
		})
	if err != nil {
		t.Fatalf("PairWithCodes : %v", err)
	}
	if len(codes) != 1 || attempt != 1 {
		t.Fatalf("codes = %v, attempt = %d", codes, attempt)
	}
	if payload.AgentID != "agent-uuid-1" {
		t.Fatalf("agent_id = %q", payload.AgentID)
	}
	// Le code affiché est canonique (XXXX-XXXX-XXXX) et conforme à l'alphabet.
	canonical, err := pair.NormalizeCode(codes[0])
	if err != nil || canonical != codes[0] {
		t.Fatalf("code affiché non canonique : %q (%v)", codes[0], err)
	}
}

// TestPairWithCodesRegenereSurExpiration : la première demande est élaguée
// côté Yuki (410 `pair_code_expired`) ⇒ l'agent DOIT générer et afficher un
// NOUVEAU code, puis aboutir.
func TestPairWithCodesRegenereSurExpiration(t *testing.T) {
	payloadMaterial := &pair.Payload{
		CACert:        "ca",
		ClientCert:    "cert",
		ClientKey:     "key",
		AgentID:       "agent-uuid-2",
		CAFingerprint: "fp",
	}
	var mu sync.Mutex
	code := ""
	begins := 0

	mux := http.NewServeMux()
	mux.HandleFunc(pairPath, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		msg, err := proto.Decode(body)
		if err != nil {
			writePairError(w, http.StatusBadRequest, "malformed_message", err.Error())
			return
		}
		begin, ok := msg.(*proto.PairBegin)
		if !ok {
			writePairError(w, http.StatusBadRequest, "malformed_message", "trame inattendue")
			return
		}
		mu.Lock()
		begins++
		n := begins
		current := code
		mu.Unlock()
		if n == 1 {
			// Première demande : mise en attente qui sera ÉLAGUÉE (410 au poll).
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending", "pair_id": "gone"})
			return
		}
		session, err := pair.NewSession(current, pair.Options{})
		if err != nil {
			writePairError(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		okMsg, err := session.Authorize(begin, payloadMaterial)
		if err != nil {
			writePairError(w, http.StatusUnauthorized, string(proto.CodeOf(err)), err.Error())
			return
		}
		writePairOK(w, http.StatusOK, okMsg)
	})
	mux.HandleFunc(pairPath+"/gone", func(w http.ResponseWriter, _ *http.Request) {
		writePairError(w, http.StatusGone, "pair_code_expired", "demande d'appairage inconnue ou expirée")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	var codes, expired []string
	result, err := PairWithCodes(context.Background(), srv.URL, "",
		PairingPolicy{PollWait: time.Millisecond},
		PairingCallbacks{
			OnCode: func(c string, _ time.Time, _ int) {
				mu.Lock()
				code = c
				mu.Unlock()
				codes = append(codes, c)
			},
			OnExpired: func(c string, _ int) { expired = append(expired, c) },
		})
	if err != nil {
		t.Fatalf("PairWithCodes : %v", err)
	}
	if len(codes) != 2 {
		t.Fatalf("codes générés = %d, attendu 2 (%v)", len(codes), codes)
	}
	if codes[0] == codes[1] {
		t.Fatalf("le code régénéré est identique au premier : %q", codes[0])
	}
	if len(expired) != 1 || expired[0] != codes[0] {
		t.Fatalf("expiration signalée = %v (premier code %q)", expired, codes[0])
	}
	if result.AgentID != "agent-uuid-2" {
		t.Fatalf("agent_id = %q", result.AgentID)
	}
}

// TestPairWithCodesBorneLesRegenerations : le serveur met TOUJOURS en attente
// puis élague ⇒ l'agent régénère jusqu'à `MaxCodes`, puis abandonne avec une
// erreur d'expiration (jamais une boucle infinie).
func TestPairWithCodesBorneLesRegenerations(t *testing.T) {
	var mu sync.Mutex
	seq := 0
	mux := http.NewServeMux()
	mux.HandleFunc(pairPath, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		seq++
		id := seq
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending", "pair_id": string(rune('a' + id))})
	})
	mux.HandleFunc(pairPath+"/", func(w http.ResponseWriter, _ *http.Request) {
		writePairError(w, http.StatusGone, "pair_code_expired", "expiré")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	var codes []string
	_, err := PairWithCodes(context.Background(), srv.URL, "",
		PairingPolicy{PollWait: time.Millisecond, MaxCodes: 3},
		PairingCallbacks{OnCode: func(c string, _ time.Time, _ int) { codes = append(codes, c) }})
	if err == nil {
		t.Fatal("attendu une erreur après MaxCodes")
	}
	if !IsPairExpired(err) {
		t.Fatalf("erreur non classée comme expiration : %v", err)
	}
	if len(codes) != 3 {
		t.Fatalf("codes générés = %d, attendu 3", len(codes))
	}
}

func TestIsPairExpired(t *testing.T) {
	if IsPairExpired(nil) {
		t.Fatal("nil classé comme expiration")
	}
	if !IsPairExpired(&PairExpiredError{Reason: "x"}) {
		t.Fatal("expiration non reconnue")
	}
	if IsPairExpired(errors.New("autre")) {
		t.Fatal("erreur quelconque classée comme expiration")
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
