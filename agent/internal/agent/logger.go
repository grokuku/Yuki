// Package agent câble le BINAIRE d'exécution `yuki-agent` (Lot 4, A6) : lecture
// de la configuration, présentation (`hello`) construite depuis l'OS, boucle
// `cmd → ack → classification → exécution → result`, journal structuré et
// arrêt propre.
//
// ⚠️ L'autorité reste dans Yuki. Ce paquet ne décide de RIEN : il exécute ce
// que Yuki envoie, en journalisant toute divergence entre la classification
// locale (`internal/exec`) et la décision annoncée par Yuki — SANS bloquer
// (D118/D126).
package agent

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"sync"
	"time"
)

// LogLevel est le niveau de verbosité du journal.
type LogLevel int

const (
	// LevelDebug : tout, y compris les traces internes.
	LevelDebug LogLevel = iota
	// LevelInfo : démarrages, connexions, exécutions (défaut).
	LevelInfo
	// LevelWarn : anomalies non bloquantes (reconnexions, divergences).
	LevelWarn
	// LevelError : échecs de traitement.
	LevelError
)

// ParseLevel traduit un libellé de configuration en niveau. Vide ⇒ `LevelInfo`.
func ParseLevel(value string) (LogLevel, error) {
	switch value {
	case "", "info":
		return LevelInfo, nil
	case "debug":
		return LevelDebug, nil
	case "warn", "warning":
		return LevelWarn, nil
	case "error":
		return LevelError, nil
	default:
		return LevelInfo, fmt.Errorf("agent : niveau de journal inconnu %q (debug|info|warn|error)", value)
	}
}

func (l LogLevel) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// secretKeyPattern repère les clés de champ ressemblant à un secret : leur
// valeur est alors masquée. ⚠️ L'agent ne journalise JAMAIS la sortie complète
// d'une commande (D127) ; cette redaction est une ceinture supplémentaire.
var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|password|passwd|credential|authorization|bearer|(^|_)key$)`)

// JSONLogger écrit une ligne JSON par entrée sur un flux (⚠️ `stderr` en
// production : `stdout` reste réservé à la sortie console de `pair`/`version`).
// Il implémente `transport.Logger` et est sûr en accès concurrent.
type JSONLogger struct {
	mu    sync.Mutex
	w     io.Writer
	level LogLevel
	now   func() time.Time
}

// NewJSONLogger construit un journal JSON sur `w` (nil ⇒ `os.Stderr`).
func NewJSONLogger(w io.Writer, level LogLevel) *JSONLogger {
	if w == nil {
		w = os.Stderr
	}
	return &JSONLogger{w: w, level: level, now: time.Now}
}

// Debug journalise au niveau debug.
func (l *JSONLogger) Debug(message string, fields map[string]any) {
	l.emit(LevelDebug, message, fields)
}

// Info journalise au niveau info.
func (l *JSONLogger) Info(message string, fields map[string]any) {
	l.emit(LevelInfo, message, fields)
}

// Warn journalise au niveau warn.
func (l *JSONLogger) Warn(message string, fields map[string]any) {
	l.emit(LevelWarn, message, fields)
}

// Error journalise au niveau error.
func (l *JSONLogger) Error(message string, fields map[string]any) {
	l.emit(LevelError, message, fields)
}

func (l *JSONLogger) emit(level LogLevel, message string, fields map[string]any) {
	if level < l.level {
		return
	}
	record := map[string]any{
		"ts":    l.now().Format(time.RFC3339Nano),
		"level": level.String(),
		"msg":   message,
	}
	for key, value := range fields {
		if secretKeyPattern.MatchString(key) {
			record[key] = redactedValue(value)
			continue
		}
		record[key] = value
	}
	data, err := json.Marshal(record)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(append(data, '\n'))
}

// redactedValue masque une valeur sensible sans la laisser fuiter (même vide,
// la présence de la clé est signalée par `[REDACTED]`).
func redactedValue(value any) any {
	if value == nil {
		return nil
	}
	return "[REDACTED]"
}
