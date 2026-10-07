//go:build linux

package exec

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestSupervisorArretPropreApresGrace : une commande brève se termine pendant la
// grâce ; une commande longue est interrompue au terme de la grâce.
func TestSupervisorArretPropreApresGrace(t *testing.T) {
	sup := NewSupervisor(New(Options{DefaultTimeout: 30 * time.Second, TermGrace: 300 * time.Millisecond}))

	done := make(chan *Result, 1)
	go func() {
		res, err := sup.Run(context.Background(), Request{ID: "long", Command: "sleep 30"})
		if err != nil {
			done <- nil
			return
		}
		done <- res
	}()

	// Laisse la commande démarrer.
	deadline := time.Now().Add(2 * time.Second)
	for sup.Running() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sup.Running() != 1 {
		t.Fatalf("commande non enregistrée : running=%d", sup.Running())
	}

	start := time.Now()
	sup.Shutdown(200 * time.Millisecond)
	elapsed := time.Since(start)
	if elapsed < 200*time.Millisecond {
		t.Fatalf("la grâce n'a pas été respectée : %s", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("arrêt trop long : %s", elapsed)
	}

	select {
	case res := <-done:
		if res == nil {
			t.Fatal("Run a renvoyé une erreur inattendue")
		}
		if !res.TimedOut {
			t.Fatal("la commande longue aurait dû être interrompue")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run n'est pas revenu après l'arrêt")
	}

	// Plus aucune nouvelle commande.
	if _, err := sup.Run(context.Background(), Request{Command: "true"}); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("nouvelle commande acceptée après arrêt : %v", err)
	}
	// Second arrêt : sans effet.
	sup.Shutdown(10 * time.Millisecond)
}

// TestSupervisorGraceSuffisante : une commande qui finit DANS la grâce n'est pas
// interrompue.
func TestSupervisorGraceSuffisante(t *testing.T) {
	sup := NewSupervisor(New(Options{}))
	done := make(chan *Result, 1)
	go func() {
		res, err := sup.Run(context.Background(), Request{Command: "sleep 0.1; echo fin"})
		if err != nil {
			done <- nil
			return
		}
		done <- res
	}()
	deadline := time.Now().Add(2 * time.Second)
	for sup.Running() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	sup.Shutdown(5 * time.Second)

	select {
	case res := <-done:
		if res == nil || res.TimedOut {
			t.Fatalf("commande interrompue alors qu'elle tenait dans la grâce : %+v", res)
		}
		if res.ExitCode != 0 {
			t.Fatalf("ExitCode = %d", res.ExitCode)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run n'est pas revenu")
	}
}
