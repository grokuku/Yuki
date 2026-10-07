//go:build !windows

package main

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// TestWithSignalsAnnuleSurSigterm prouve que SIGTERM déclenche bien l'annulation
// du contexte, point de départ de l'arrêt PROPRE (grâce aux commandes en cours,
// puis arrêt des arbres de processus).
//
// ⚠️ `signal.NotifyContext` installe son gestionnaire de façon SYNCHRONE : le
// signal envoyé ici est capté par l'agent de test et n'achève pas le processus.
func TestWithSignalsAnnuleSurSigterm(t *testing.T) {
	ctx, stop := withSignals()
	defer stop()

	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("envoi de SIGTERM : %v", err)
	}
	select {
	case <-ctx.Done():
		// Arrêt amorcé : comportement attendu.
	case <-time.After(2 * time.Second):
		t.Fatal("SIGTERM n'a pas annulé le contexte")
	}
}
