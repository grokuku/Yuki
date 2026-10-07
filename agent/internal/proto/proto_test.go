package proto

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// allMessages : une instance renseignée de CHAQUE trame du protocole.
func allMessages() []Message {
	return []Message{
		&Hello{AgentID: "a-1", AgentVersion: "0.1.0", Host: "nuc", OS: "linux", Arch: "amd64", EUID: 1000, Caps: []string{"exec"}},
		&Ack{CmdID: "c-1"},
		&Result{CmdID: "c-1", ExitCode: 2, Stdout: "out", Stderr: "err", Truncated: true, StdoutTrunc: true, DurationMs: 42, StartedAt: "2026-01-01T00:00:00Z", EndedAt: "2026-01-01T00:00:01Z", TimedOut: true},
		&State{State: "busy", Detail: "exécution"},
		&Pong{T: 1234, Ts: "2026-01-01T00:00:00Z"},
		&Error{Error: "proof_invalid", Code: CodeProofInvalid, Message: "preuve invalide", Ref: "c-1"},
		&Cmd{CmdID: "c-1", Command: "uname -a", Shell: "bash", Cwd: "/tmp", TimeoutMs: 5000, Origin: "user"},
		&Cancel{CmdID: "c-1", Reason: "annulé"},
		&Config{Level: "destructive", Privilege: "normal"},
		&Ping{T: 99},
		&PairBegin{
			AgentNonce:    []byte("01234567890123456789012345678901"),
			AgentPubkey:   []byte{4, 1, 2, 3},
			YukiFPClaimed: strings.Repeat("ab", 32),
			Proof:         []byte{1, 2, 3, 4},
		},
		&PairOK{
			YukiNonce: []byte("abcdefghijklmnopqrstuvwxyz012345"),
			Blob:      []byte{9, 8, 7, 6},
		},
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	for _, original := range allMessages() {
		original := original
		t.Run(string(original.Type()), func(t *testing.T) {
			data, err := Encode(original)
			if err != nil {
				t.Fatalf("Encode : %v", err)
			}
			decoded, err := Decode(data)
			if err != nil {
				t.Fatalf("Decode : %v", err)
			}
			if decoded.Type() != original.Type() {
				t.Fatalf("type : obtenu %q, attendu %q", decoded.Type(), original.Type())
			}
			if !reflect.DeepEqual(decoded, original) {
				t.Fatalf("aller-retour non fidèle :\n obtenu  %#v\n attendu %#v", decoded, original)
			}
		})
	}
}

func TestEncodeSetsHeader(t *testing.T) {
	data, err := Encode(&Ping{T: 7})
	if err != nil {
		t.Fatalf("Encode : %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("JSON : %v", err)
	}
	if raw["type"] != string(TypePing) {
		t.Fatalf("type absent/faux : %v", raw["type"])
	}
	// proto_version DOIT être présent à la racine.
	v, ok := raw["proto_version"]
	if !ok {
		t.Fatalf("proto_version absent de la trame encodée")
	}
	if v.(float64) != float64(Version) {
		t.Fatalf("proto_version = %v, attendu %d", v, Version)
	}
}

func TestEncodeNil(t *testing.T) {
	if _, err := Encode(nil); err == nil {
		t.Fatal("Encode(nil) aurait dû échouer")
	}
}

func TestDecodeRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		code ErrorCode
	}{
		{"json invalide", "{", CodeInvalidJSON},
		{"non-objet", `[1,2,3]`, CodeInvalidJSON},
		{"type absent", `{"proto_version":1}`, CodeMalformedMessage},
		{"version absente", `{"type":"ping","t":1}`, CodeUnsupportedVersion},
		{"version future", `{"type":"ping","proto_version":2,"t":1}`, CodeUnsupportedVersion},
		{"type inconnu", `{"type":"nope","proto_version":1}`, CodeUnknownType},
		{"champ de mauvais type", `{"type":"ping","proto_version":1,"t":"pas un nombre"}`, CodeMalformedMessage},
		{"base64 invalide", `{"type":"pair_begin","proto_version":1,"agent_nonce":"!!!","proof":"AAAA"}`, CodeMalformedMessage},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			_, err := Decode([]byte(tc.raw))
			if err == nil {
				t.Fatalf("Decode aurait dû échouer")
			}
			if got := CodeOf(err); got != tc.code {
				t.Fatalf("code = %q, attendu %q (%v)", got, tc.code, err)
			}
			var pe *ProtocolError
			if !errors.As(err, &pe) {
				t.Fatalf("erreur non typée : %T", err)
			}
		})
	}
}

func TestDecodeAcceptsUnknownOptionalField(t *testing.T) {
	// Un champ optionnel ajouté par une version mineure ne doit pas casser le
	// décodage d'un type connu.
	m, err := Decode([]byte(`{"type":"ping","proto_version":1,"t":5,"future_field":true}`))
	if err != nil {
		t.Fatalf("Decode : %v", err)
	}
	ping, ok := m.(*Ping)
	if !ok || ping.T != 5 {
		t.Fatalf("trame ping incorrecte : %#v", m)
	}
}

func TestBinaryFieldsAreBase64(t *testing.T) {
	data, err := Encode(&PairOK{YukiNonce: []byte{0, 1, 2, 250, 255}, Blob: []byte("blob")})
	if err != nil {
		t.Fatalf("Encode : %v", err)
	}
	if !strings.Contains(string(data), `"yuki_nonce":"AAEC+v8="`) {
		t.Fatalf("nonce non encodé en base64 standard : %s", data)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode : %v", err)
	}
	ok := decoded.(*PairOK)
	if !reflect.DeepEqual(ok.YukiNonce, []byte{0, 1, 2, 250, 255}) {
		t.Fatalf("nonce altéré : %v", ok.YukiNonce)
	}
}

func TestCodeOf(t *testing.T) {
	if CodeOf(nil) != "" {
		t.Fatal("CodeOf(nil) doit être vide")
	}
	if CodeOf(errors.New("x")) != CodeInternal {
		t.Fatal("erreur non typée ⇒ CodeInternal")
	}
	if CodeOf(NewError(CodeReplay, "x")) != CodeReplay {
		t.Fatal("extraction du code")
	}
}
