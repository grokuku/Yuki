package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// withSignals renvoie un contexte annulé sur SIGINT (Ctrl+C) ou SIGTERM. C'est
// ce contexte qui déclenche l'arrêt PROPRE de l'agent (grâce aux commandes en
// cours, puis arrêt des arbres de processus).
//
// ⚠️ Sous Windows, SIGTERM n'est pas émis par le SCM : c'est `internal/service`
// qui annule ce même contexte sur demande d'arrêt du service.
func withSignals() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
