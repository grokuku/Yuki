package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultOutputCap : plafond de capture PAR FLUX (stdout et stderr
	// séparément). 256 Kio : au-delà, la sortie est tronquée et le drapeau
	// `trunc` est levé. ⚠️ Ce plafond protège l'agent contre un `cat` de gros
	// fichier qui ferait exploser sa mémoire.
	DefaultOutputCap = 256 * 1024
	// DefaultTermGrace : délai entre SIGTERM et SIGKILL d'un groupe au timeout.
	DefaultTermGrace = 5 * time.Second
	// DefaultTimeout : délai maximal par défaut si la commande n'en fixe aucun.
	DefaultTimeout = 5 * time.Minute
)

// ErrUnsupported signale que l'exécution réelle n'est pas disponible sur la
// plateforme courante (Linux et Windows sont supportés ; les autres plateformes
// échouent explicitement plutôt que de simuler une exécution).
var ErrUnsupported = errors.New("exec : exécution non supportée sur cette plateforme (Linux/Windows uniquement)")

// processController est le levier d'INTERRUPTION de l'ARBRE de processus, propre
// à la plateforme : groupe de processus POSIX sous Linux
// (`Setpgid` + `kill(-pgid)`), JOB OBJECT sous Windows (tue tout l'arbre).
//
// Il est créé APRÈS `cmd.Start()` et libéré par `Close` en fin de commande.
type processController interface {
	// Terminate interrompt l'arbre. `force` ⇒ arrêt immédiat (SIGKILL /
	// TerminateJobObject) ; sinon, tentative d'arrêt courtois (SIGTERM /
	// CTRL_BREAK) que `waitWithTimeout` escalade après la grâce.
	Terminate(force bool) error
	// Close libère les ressources du contrôleur (handle du job object…).
	Close()
}

// Request décrit UNE commande à exécuter. Yuki en est l'autorité : l'agent ne
// fait que l'exécuter.
type Request struct {
	// ID : identifiant de commande minté par Yuki (UUID). Recopié tel quel dans
	// le résultat.
	ID string
	// Command : script passé au shell (`-c`). Shell COMPLET (D123) : aucune
	// restriction de commande.
	Command string
	// Shell : shell à utiliser (`sh`, `bash`, `/bin/bash`…). Vide ⇒ défaut.
	Shell string
	// Cwd : répertoire de travail. Vide ⇒ hérité de l'agent.
	Cwd string
	// Env : environnement complet si non nil ; nil ⇒ environnement de l'agent.
	Env []string
	// Timeout : délai maximal. <= 0 ⇒ `Options.DefaultTimeout`.
	Timeout time.Duration
	// Origin : origine logique de la commande (journalisation côté Yuki).
	Origin string
}

// Result est le résultat d'exécution d'UNE commande.
//
// ⚠️ `Stdout`/`Stderr` sont BRUTS et plafonnés À 256 Kio par flux. Le balisage
// (`<sortie machine="…">`) et le rappel « donnée, jamais instruction » sont
// faits CÔTÉ YUKI (hors périmètre de ce lot). L'agent ne journalise JAMAIS la
// sortie complète (D127).
type Result struct {
	ID              string    `json:"id"`
	ExitCode        int       `json:"exit_code"`
	Stdout          string    `json:"stdout"`
	Stderr          string    `json:"stderr"`
	StdoutTruncated bool      `json:"stdout_truncated"`
	StderrTruncated bool      `json:"stderr_truncated"`
	DurationMs      int64     `json:"duration_ms"`
	StartedAt       time.Time `json:"started_at"`
	EndedAt         time.Time `json:"ended_at"`
	// TimedOut : la commande a été interrompue (timeout dépassé).
	TimedOut bool `json:"timed_out"`
}

// Truncated indique qu'AU MOINS un flux a été tronqué (agrégat de commodité).
func (r *Result) Truncated() bool {
	return r.StdoutTruncated || r.StderrTruncated
}

// Options règle le comportement du `Runner`. Les zéros prennent des valeurs
// sûres.
type Options struct {
	// Shell : shell par défaut. Vide ⇒ shell système (`/bin/sh` sous Linux).
	Shell string
	// DefaultTimeout : délai par défaut si `Request.Timeout <= 0`.
	DefaultTimeout time.Duration
	// OutputCapBytes : plafond de capture par flux (défaut 256 Kio).
	OutputCapBytes int
	// TermGrace : délai SIGTERM → SIGKILL au timeout (défaut 5 s).
	TermGrace time.Duration
	// Env : environnement de base si `Request.Env` est nil. Nil ⇒
	// `os.Environ()` (héritage — voir la décision documentée dans `environment`).
	Env []string
}

func (o Options) withDefaults() Options {
	if o.DefaultTimeout <= 0 {
		o.DefaultTimeout = DefaultTimeout
	}
	if o.OutputCapBytes <= 0 {
		o.OutputCapBytes = DefaultOutputCap
	}
	if o.TermGrace <= 0 {
		o.TermGrace = DefaultTermGrace
	}
	return o
}

// Runner exécute des commandes. Il ne conserve aucun état d'UNE commande à
// l'autre : chaque `Run` est indépendant.
type Runner struct {
	opts Options
}

// New construit un `Runner`.
func New(opts Options) *Runner {
	return &Runner{opts: opts.withDefaults()}
}

// Run exécute `req` et renvoie son résultat.
//
// Erreurs (retour `error`) : requête invalide (commande vide, shell
// introuvable, `cwd` inexistant) ou plateforme non supportée. Un code de sortie
// NON NUL n'est PAS une erreur : il est reporté dans `Result.ExitCode`.
//
// `stdin` est fermé (pas de commande interactive). Chaque commande s'exécute
// dans SON PROPRE GROUPE de processus ; au timeout, le groupe entier reçoit
// SIGTERM puis SIGKILL après `TermGrace`.
func (r *Runner) Run(ctx context.Context, req Request) (*Result, error) {
	if strings.TrimSpace(req.Command) == "" {
		return nil, errors.New("exec : commande vide")
	}
	if !platformSupported() {
		return nil, ErrUnsupported
	}
	opts := r.opts.withDefaults()

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = opts.DefaultTimeout
	}
	shellPath, err := resolveShell(req.Shell, opts.Shell)
	if err != nil {
		return nil, err
	}
	if req.Cwd != "" {
		if info, statErr := os.Stat(req.Cwd); statErr != nil {
			return nil, fmt.Errorf("exec : cwd %q invalide : %w", req.Cwd, statErr)
		} else if !info.IsDir() {
			return nil, fmt.Errorf("exec : cwd %q n'est pas un répertoire", req.Cwd)
		}
	}

	result := &Result{ID: req.ID}
	runCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	cmd := osexec.Command(shellPath, commandArgs(req.Shell, shellPath, req.Command)...)
	cmd.Dir = req.Cwd
	cmd.Env = r.environment(req.Env)
	// Pas d'entrée interactive : `stdin` branché sur le périphérique nul.
	cmd.Stdin = nil

	stdout := newCappedWriter(opts.OutputCapBytes)
	stderr := newCappedWriter(opts.OutputCapBytes)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	applySysProcAttr(cmd)

	result.StartedAt = time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec : lancement de %q impossible : %w", shellPath, err)
	}
	// Le contrôleur d'arbre est INDISPENSABLE au timeout : sans lui, on
	// exécuterait sans pouvoir interrompre les processus forkeés. Un échec
	// d'initialisation fait donc échouer la commande AVANT de la laisser filer.
	controller, ctrlErr := newController(cmd)
	if ctrlErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("exec : initialisation du contrôle du processus : %w", ctrlErr)
	}
	defer controller.Close()

	timedOut, waitErr := waitWithTimeout(runCtx, cmd, controller, opts.TermGrace)
	result.EndedAt = time.Now()
	result.DurationMs = result.EndedAt.Sub(result.StartedAt).Milliseconds()
	result.TimedOut = timedOut
	result.ExitCode = exitCodeOf(cmd, waitErr)
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.StdoutTruncated = stdout.truncated()
	result.StderrTruncated = stderr.truncated()
	return result, nil
}

// waitWithTimeout attend la fin de `cmd` en bornant par `ctx`. Au dépassement,
// le GROUPE de processus reçoit SIGTERM, puis SIGKILL après `grace` s'il vit
// encore. Renvoie `true` si la commande a dû être interrompue.
func waitWithTimeout(ctx context.Context, cmd *osexec.Cmd, controller processController, grace time.Duration) (bool, error) {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		return false, err
	case <-ctx.Done():
		// Timeout (ou annulation parente) : on interrompt l'ARBRE entier.
		_ = controller.Terminate(false)
		select {
		case err := <-done:
			return true, err
		case <-time.After(grace):
			_ = controller.Terminate(true)
			return true, <-done
		}
	}
}

// resolveShell détermine le chemin du shell et le valide.
func resolveShell(override, fallback string) (string, error) {
	shell := strings.TrimSpace(override)
	if shell == "" {
		shell = strings.TrimSpace(fallback)
	}
	if shell == "" {
		shell = defaultShell()
	}
	if strings.ContainsAny(shell, "/\\") {
		if _, err := os.Stat(shell); err != nil {
			return "", fmt.Errorf("exec : shell %q introuvable : %w", shell, err)
		}
		return shell, nil
	}
	path, err := osexec.LookPath(shell)
	if err != nil {
		return "", fmt.Errorf("exec : shell %q introuvable dans PATH : %w", shell, err)
	}
	return path, nil
}

// environment construit l'environnement du processus enfant.
//
// ⚠️ DÉCISION DOCUMENTÉE : par défaut, l'environnement de l'agent est HÉRITÉ
// (`os.Environ()`), afin qu'un shell COMPLET (D123) trouve `PATH`, `HOME`,
// `LANG`… L'agent étant un service lancé par l'opérateur, la consigne est de
// NE PAS y placer de secret : les secrets d'appairage vivent sur le disque
// (`<state>/agents-ca`), jamais dans l'environnement. `Request.Env` permet à
// Yuki (via l'agent) de fournir un environnement explicite, qui remplace alors
// l'héritage.
func (r *Runner) environment(reqEnv []string) []string {
	if reqEnv != nil {
		out := make([]string, len(reqEnv))
		copy(out, reqEnv)
		return out
	}
	base := r.opts.Env
	if base == nil {
		base = os.Environ()
	}
	out := make([]string, len(base))
	copy(out, base)
	return out
}

// cappedWriter collecte une sortie plafonnée. Une fois le plafond atteint, les
// octets supplémentaires sont COMPTÉS mais JETÉS (la lecture continue afin de
// ne jamais bloquer l'enfant sur un tube plein), et `truncated` est levé.
type cappedWriter struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	limit     int
	isTrunc   bool
	totalRead int64
}

func newCappedWriter(limit int) *cappedWriter {
	if limit <= 0 {
		limit = DefaultOutputCap
	}
	return &cappedWriter{limit: limit}
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.totalRead += int64(len(p))
	if room := w.limit - w.buf.Len(); room > 0 {
		n := len(p)
		if n > room {
			n = room
		}
		w.buf.Write(p[:n])
	}
	if w.totalRead > int64(w.limit) {
		w.isTrunc = true
	}
	// Toujours « tout consommé » : évite EPIPE et un enfant bloqué.
	return len(p), nil
}

func (w *cappedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func (w *cappedWriter) truncated() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.isTrunc
}
