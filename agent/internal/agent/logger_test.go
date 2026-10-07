package agent

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestParseLevel(t *testing.T) {
	cases := map[string]LogLevel{
		"":      LevelInfo,
		"info":  LevelInfo,
		"debug": LevelDebug,
		"warn":  LevelWarn,
		"error": LevelError,
	}
	for input, want := range cases {
		got, err := ParseLevel(input)
		if err != nil {
			t.Fatalf("ParseLevel(%q) : %v", input, err)
		}
		if got != want {
			t.Errorf("ParseLevel(%q) = %v, attendu %v", input, got, want)
		}
	}
	if _, err := ParseLevel("bavard"); err == nil {
		t.Fatal("niveau inconnu accepté")
	}
}

func TestJSONLoggerFormat(t *testing.T) {
	var buf bytes.Buffer
	logger := NewJSONLogger(&buf, LevelInfo)
	logger.Info("agent.exemple", map[string]any{"cmd_id": "c-1", "exit_code": 0})

	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record); err != nil {
		t.Fatalf("ligne non JSON : %v (%q)", err, buf.String())
	}
	if record["msg"] != "agent.exemple" {
		t.Fatalf("msg = %v", record["msg"])
	}
	if record["level"] != "info" {
		t.Fatalf("level = %v", record["level"])
	}
	if record["cmd_id"] != "c-1" {
		t.Fatalf("cmd_id = %v", record["cmd_id"])
	}
	if record["ts"] == nil {
		t.Fatal("ts absent")
	}
}

func TestJSONLoggerFiltreNiveaux(t *testing.T) {
	var buf bytes.Buffer
	logger := NewJSONLogger(&buf, LevelWarn)
	logger.Debug("debug", nil)
	logger.Info("info", nil)
	logger.Warn("warn", nil)
	lines := bytes.Count(bytes.TrimSpace(buf.Bytes()), []byte("\n")) + 1
	if lines != 1 {
		t.Fatalf("lignes émises = %d, attendu 1 (seul warn)", lines)
	}
	if !bytes.Contains(buf.Bytes(), []byte("warn")) {
		t.Fatalf("ligne warn absente : %q", buf.String())
	}
}

func TestJSONLoggerMasqueSecrets(t *testing.T) {
	var buf bytes.Buffer
	logger := NewJSONLogger(&buf, LevelInfo)
	logger.Info("agent.exemple", map[string]any{"client_key": "valeur-secrete", "cmd_id": "c-1"})

	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record); err != nil {
		t.Fatalf("ligne non JSON : %v", err)
	}
	if record["client_key"] != "[REDACTED]" {
		t.Fatalf("client_key = %v, attendu [REDACTED]", record["client_key"])
	}
	if bytes.Contains(buf.Bytes(), []byte("valeur-secrete")) {
		t.Fatal("valeur secrète présente dans le journal")
	}
}
