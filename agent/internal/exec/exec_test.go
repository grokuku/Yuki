//go:build linux

package exec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunCommandeSimple(t *testing.T) {
	runner := New(Options{})
	res, err := runner.Run(context.Background(), Request{ID: "c-1", Command: "echo bonjour"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if res.ID != "c-1" {
		t.Fatalf("ID = %q", res.ID)
	}
	if res.ExitCode != 0 {
		t.Fatalf("ExitCode = %d", res.ExitCode)
	}
	if strings.TrimSpace(res.Stdout) != "bonjour" {
		t.Fatalf("Stdout = %q", res.Stdout)
	}
	if res.Stderr != "" {
		t.Fatalf("Stderr = %q", res.Stderr)
	}
	if res.TimedOut {
		t.Fatal("TimedOut inattendu")
	}
	if res.StartedAt.IsZero() || res.EndedAt.IsZero() {
		t.Fatal("horodatages absents")
	}
	if res.DurationMs < 0 {
		t.Fatalf("DurationMs = %d", res.DurationMs)
	}
}

func TestRunExitCodeNonNul(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(), Request{Command: "exit 3"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("ExitCode = %d, attendu 3", res.ExitCode)
	}
	if res.TimedOut {
		t.Fatal("TimedOut inattendu")
	}
}

func TestRunStderrSepare(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(),
		Request{Command: "echo sortie; echo erreur >&2; exit 1"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if strings.TrimSpace(res.Stdout) != "sortie" {
		t.Fatalf("Stdout = %q", res.Stdout)
	}
	if strings.TrimSpace(res.Stderr) != "erreur" {
		t.Fatalf("Stderr = %q", res.Stderr)
	}
	if res.ExitCode != 1 {
		t.Fatalf("ExitCode = %d", res.ExitCode)
	}
}

// TestRunTimeoutTueLaCommande prouve un TIMEOUT RÉEL : un `sleep` long est
// interrompu bien avant sa fin naturelle.
func TestRunTimeoutTueLaCommande(t *testing.T) {
	runner := New(Options{DefaultTimeout: 300 * time.Millisecond, TermGrace: 500 * time.Millisecond})
	start := time.Now()
	res, err := runner.Run(context.Background(), Request{ID: "t", Command: "sleep 30"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	elapsed := time.Since(start)
	if !res.TimedOut {
		t.Fatal("TimedOut devrait être vrai")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("le timeout n'a pas été respecté : %s", elapsed)
	}
	if res.ExitCode < 128 {
		t.Fatalf("ExitCode = %d (signal attendu ≥ 128)", res.ExitCode)
	}
}

// TestRunTueToutLeGroupe prouve que le GROUPE de processus est tué : un enfant
// forke en arrière-plan survit au signal s'il n'est pas dans le même groupe.
func TestRunTueToutLeGroupe(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "enfant.pid")
	script := fmt.Sprintf("sleep 30 & echo $! > %s; wait", pidFile)

	runner := New(Options{DefaultTimeout: 300 * time.Millisecond, TermGrace: 500 * time.Millisecond})
	res, err := runner.Run(context.Background(), Request{ID: "g", Command: script})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if !res.TimedOut {
		t.Fatal("TimedOut devrait être vrai")
	}

	childPID := readPIDFile(t, pidFile)
	if childPID <= 0 {
		t.Fatalf("PID enfant illisible")
	}
	// L'enfant partage le groupe du chef : il DOIT être mort après le timeout.
	waitProcessGone(t, childPID, 5*time.Second)
}

// TestRunCapSortie prouve que la capture est PLAFONNÉE à 256 Kio par flux et
// que le drapeau `trunc` est levé, y compris à la frontière exacte.
func TestRunCapSortie(t *testing.T) {
	runner := New(Options{OutputCapBytes: DefaultOutputCap})

	// Exactement au plafond : PAS de troncature.
	atCap, err := runner.Run(context.Background(),
		Request{Command: fmt.Sprintf("head -c %d /dev/zero", DefaultOutputCap)})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if len(atCap.Stdout) != DefaultOutputCap {
		t.Fatalf("Stdout = %d octets, attendu %d", len(atCap.Stdout), DefaultOutputCap)
	}
	if atCap.StdoutTruncated {
		t.Fatal("trunc levé à la frontière exacte")
	}

	// Un octet de plus : tronqué à 256 Kio, drapeau levé.
	over, err := runner.Run(context.Background(),
		Request{Command: fmt.Sprintf("head -c %d /dev/zero", DefaultOutputCap+1)})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if len(over.Stdout) != DefaultOutputCap {
		t.Fatalf("Stdout = %d octets, attendu %d", len(over.Stdout), DefaultOutputCap)
	}
	if !over.StdoutTruncated {
		t.Fatal("trunc non levé au-delà du plafond")
	}
	if !over.Truncated() {
		t.Fatal("Truncated() agrégé incohérent")
	}

	// Grosse sortie sur stderr.
	big, err := runner.Run(context.Background(),
		Request{Command: "head -c 400000 /dev/zero 1>&2"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if len(big.Stderr) != DefaultOutputCap || !big.StderrTruncated {
		t.Fatalf("stderr : %d octets, trunc=%v", len(big.Stderr), big.StderrTruncated)
	}
	if big.StdoutTruncated {
		t.Fatal("stdout marqué tronqué à tort")
	}
}

func TestRunCwd(t *testing.T) {
	dir := t.TempDir()
	res, err := New(Options{}).Run(context.Background(), Request{Command: "pwd", Cwd: dir})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	got := strings.TrimSpace(res.Stdout)
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks : %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(got); err == nil {
		got = resolved
	}
	if got != want {
		t.Fatalf("cwd = %q, attendu %q", got, want)
	}
}

func TestRunShellOverride(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(),
		Request{Command: "echo ok", Shell: "sh"})
	if err != nil {
		t.Fatalf("shell nommé refusé : %v", err)
	}
	if strings.TrimSpace(res.Stdout) != "ok" {
		t.Fatalf("Stdout = %q", res.Stdout)
	}
}

func TestRunErreurs(t *testing.T) {
	runner := New(Options{})
	if _, err := runner.Run(context.Background(), Request{Command: "   "}); err == nil {
		t.Fatal("commande vide acceptée")
	}
	if _, err := runner.Run(context.Background(),
		Request{Command: "true", Shell: "/n-existe-pas/sh"}); err == nil {
		t.Fatal("shell inexistant accepté")
	}
	if _, err := runner.Run(context.Background(),
		Request{Command: "true", Cwd: "/n-existe-pas/dir"}); err == nil {
		t.Fatal("cwd inexistant accepté")
	}
	if _, err := runner.Run(context.Background(),
		Request{Command: "true", Cwd: "/etc/hostname"}); err == nil {
		t.Fatal("cwd fichier accepté")
	}
}

func TestRunAnnulationParente(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel()
	}()
	res, err := New(Options{DefaultTimeout: 30 * time.Second, TermGrace: 500 * time.Millisecond}).
		Run(ctx, Request{Command: "sleep 30"})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if !res.TimedOut {
		t.Fatal("annulation parente non traitée comme interruption")
	}
}

/* ─── Aides ───────────────────────────────────────────────────────────────── */

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(strings.TrimSpace(string(data))) > 0 {
			pid, convErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if convErr == nil {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("PID enfant non écrit dans %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitProcessGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if processGone(pid) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("le processus %d (groupe de la commande) est encore vivant", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// processGone : un processus tué peut rester en ZOMBIE (non récolté par le
// PID 1 du conteneur) — il n'est pas « vivant » pour autant. On considère
// « mort » tout processus absent de /proc ou à l'état Z (zombie) / X (mort).
func processGone(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return true
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	fields := strings.Fields(string(data))
	if len(fields) >= 3 && (fields[2] == "Z" || fields[2] == "X") {
		return true
	}
	return false
}
