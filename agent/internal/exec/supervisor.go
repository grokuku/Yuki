package exec

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrShuttingDown : l'agent est en cours d'arrêt, aucune nouvelle commande n'est
// acceptée.
var ErrShuttingDown = errors.New("exec : agent en cours d'arrêt, commande refusée")

// Supervisor enveloppe un `Runner` et porte l'ARRÊT PROPRE de l'agent :
//
//   - dès l'arrêt amorcé, plus AUCUNE nouvelle commande n'est acceptée ;
//   - les commandes EN COURS disposent d'une GRÂCE (`Shutdown`) pour se
//     terminer naturellement (une déconnexion de Yuki, elle, ne les interrompt
//     pas : leur résultat est simplement perdu, cf. D124) ;
//   - au terme de la grâce, les commandes restantes sont interrompues (leur
//     groupe est tué par `Runner` : SIGTERM puis SIGKILL).
//
// ⚠️ `Supervisor` ne dépend pas de la plateforme : c'est `Runner.Run` qui
// refuse l'exécution hors Linux/Windows (`ErrUnsupported`).
type Supervisor struct {
	runner *Runner

	mu      sync.Mutex
	closed  bool
	running map[int64]context.CancelFunc
	next    int64
	wg      sync.WaitGroup
}

// NewSupervisor construit un superviseur autour de `runner` (nil ⇒ `New(Options{})`).
func NewSupervisor(runner *Runner) *Supervisor {
	if runner == nil {
		runner = New(Options{})
	}
	return &Supervisor{runner: runner, running: make(map[int64]context.CancelFunc)}
}

// Run exécute une commande, en refusant si l'arrêt est amorcé.
func (s *Supervisor) Run(ctx context.Context, req Request) (*Result, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrShuttingDown
	}
	id := s.next
	s.next++
	cmdCtx, cancel := context.WithCancel(ctx)
	s.running[id] = cancel
	s.wg.Add(1)
	s.mu.Unlock()

	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
		s.wg.Done()
	}()

	return s.runner.Run(cmdCtx, req)
}

// Shutdown amorce l'arrêt : refuse les nouvelles commandes, laisse `grace` aux
// commandes en cours, puis interrompt celles qui restent et attend leur fin.
//
// Un second appel est sans effet. `grace <= 0` interrompt immédiatement.
func (s *Supervisor) Shutdown(grace time.Duration) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()

	if grace > 0 && s.wait(s.wg.Wait, grace) {
		return // tout s'est terminé dans la grâce
	}
	// Interrompt les commandes restantes (Runner applique la grâce SIGTERM →
	// SIGKILL par groupe).
	s.mu.Lock()
	for _, cancel := range s.running {
		cancel()
	}
	s.mu.Unlock()
	// Attend la fin effective des processus (bornée : SIGKILL après TermGrace).
	_ = s.wait(s.wg.Wait, DefaultTermGrace+5*time.Second)
}

// Running renvoie le nombre de commandes en cours.
func (s *Supervisor) Running() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.running)
}

// wait exécute `fn` (bloquant) et renvoie `true` s'il s'est terminé avant
// `timeout`.
func (s *Supervisor) wait(fn func(), timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}
