//go:build windows

package service

import (
	"context"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Install crée le service Windows (démarrage automatique), configure la
// relance après échec (`RestartSec=5` côté SCM), puis le démarre.
//
// ⚠️ Nécessite des privilèges administrateur.
func Install(opts InstallOptions) error {
	if opts.BinaryPath == "" {
		return errors.New("service : chemin du binaire requis")
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service : connexion au SCM : %w", err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(Name); err == nil {
		existing.Close()
		return fmt.Errorf("service %q déjà installé (désinstallez-le d'abord)", Name)
	}

	cfg := mgr.Config{
		DisplayName:      DisplayName,
		Description:      Description,
		StartType:        mgr.StartAutomatic,
		ServiceStartName: opts.Account,
	}
	s, err := m.CreateService(Name, opts.BinaryPath, cfg, opts.Arguments...)
	if err != nil {
		return fmt.Errorf("service : création de %q : %w", Name, err)
	}
	defer s.Close()

	// Relance après échec (équivalent SCM de `Restart=always, RestartSec=5`).
	if err := setFailureActions(s.Handle); err != nil {
		// Non bloquant : le service reste installable, on le signale.
		return fmt.Errorf("service : service créé mais relance non configurée : %w", err)
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("service : démarrage de %q : %w", Name, err)
	}
	return nil
}

// setFailureActions configure 3 relances à 5 s d'intervalle (reset 24 h) et
// active la relance même pour une sortie « propre ».
func setFailureActions(handle windows.Handle) error {
	actions := []windows.SC_ACTION{
		{Type: windows.SC_ACTION_RESTART, Delay: 5000},
		{Type: windows.SC_ACTION_RESTART, Delay: 5000},
		{Type: windows.SC_ACTION_RESTART, Delay: 5000},
	}
	failure := windows.SERVICE_FAILURE_ACTIONS{
		ResetPeriod:  86400,
		Actions:      &actions[0],
		ActionsCount: uint32(len(actions)),
	}
	if err := windows.ChangeServiceConfig2(
		handle,
		windows.SERVICE_CONFIG_FAILURE_ACTIONS,
		(*byte)(unsafe.Pointer(&failure)),
	); err != nil {
		return err
	}
	flag := windows.SERVICE_FAILURE_ACTIONS_FLAG{FailureActionsOnNonCrashFailures: 1}
	return windows.ChangeServiceConfig2(
		handle,
		windows.SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
		(*byte)(unsafe.Pointer(&flag)),
	)
}

// Uninstall arrête puis supprime le service.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service : connexion au SCM : %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(Name)
	if err != nil {
		return fmt.Errorf("service %q introuvable : %w", Name, err)
	}
	defer s.Close()

	if status, qerr := s.Query(); qerr == nil && status.State != svc.Stopped {
		if _, cerr := s.Control(svc.Stop); cerr != nil {
			return fmt.Errorf("service : arrêt de %q : %w", Name, cerr)
		}
	}
	if err := s.Delete(); err != nil {
		return fmt.Errorf("service : suppression de %q : %w", Name, err)
	}
	return nil
}

// Run exécute `execute` en PREMIER PLAN, ou comme SERVICE piloté par le SCM si
// le processus a été lancé par celui-ci. Un arrêt du SCM annule le contexte.
func Run(ctx context.Context, execute func(context.Context) error) error {
	isSvc, err := svc.IsWindowsService()
	if err != nil {
		return fmt.Errorf("service : détection du mode service : %w", err)
	}
	if !isSvc {
		return execute(ctx)
	}
	return svc.Run(Name, &handler{parent: ctx, execute: execute})
}

// Status décrit l'état du service pour la sous-commande `status`.
func Status() (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", fmt.Errorf("service : connexion au SCM : %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return "non installé", nil
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return "", fmt.Errorf("service : interrogation de %q : %w", Name, err)
	}
	switch status.State {
	case svc.Running:
		return "en cours d'exécution", nil
	case svc.Stopped:
		return "arrêté", nil
	case svc.StartPending:
		return "démarrage en cours", nil
	case svc.StopPending:
		return "arrêt en cours", nil
	default:
		return fmt.Sprintf("état %d", status.State), nil
	}
}

// handler implémente `svc.Handler` : il publie l'état au SCM et annule le
// contexte de travail sur demande d'arrêt (Stop/Shutdown).
type handler struct {
	parent  context.Context
	execute func(context.Context) error
}

// Execute est appelé par le SCM au démarrage du service.
func (h *handler) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	accepted := svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(h.parent)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.execute(ctx) }()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	for {
		select {
		case <-done:
			changes <- svc.Status{State: svc.StopPending}
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
