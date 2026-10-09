package agent

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/grokuku/yuki/agent/internal/exec"
	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/screen"
	"github.com/grokuku/yuki/agent/internal/tlsconf"
	"github.com/grokuku/yuki/agent/internal/transport"
)

// ShutdownGrace : grâce accordée aux commandes EN COURS lors d'un arrêt propre
// (SIGTERM / arrêt de service). Au-delà, les arbres de processus sont tués.
const ShutdownGrace = 10 * time.Second

// Runtime est le gestionnaire de trames de l'agent : il implémente
// `transport.Handler`.
//
// ⚠️ Il ne décide de RIEN. Yuki envoie une commande ; l'agent l'ACCUSE, la
// CLASSE localement, l'EXÉCUTE et renvoie le résultat brut. Toute divergence
// entre la classification locale et la décision annoncée par Yuki est
// JOURNALISÉE sans modifier le comportement (D118/D126).
type Runtime struct {
	cfg *Config
	sup *exec.Supervisor
	log transport.Logger
	now func() time.Time

	// Capture d'écran : capacité CONDITIONNELLE détectée au démarrage (écran +
	// outil). `screenOK` faux ⇒ toute demande est refusée honnêtement.
	screenOK   bool
	screenPlan screen.Plan
	captureFn  func(ctx context.Context, plan screen.Plan, opts screen.Options) (*screen.Shot, error)
}

// NewRuntime construit le gestionnaire. `logger` nil ⇒ `transport.NopLogger`.
//
// La capacité de capture d'écran est détectée ICI (même détection que celle du
// `hello`, `internal/screen`) : l'agent ne peut PAS capturer s'il ne l'a pas
// déclarée.
func NewRuntime(cfg *Config, sup *exec.Supervisor, logger transport.Logger) *Runtime {
	if logger == nil {
		logger = transport.NopLogger{}
	}
	plan, ok := screen.Detect(runtime.GOOS, os.Getenv, nil)
	return &Runtime{
		cfg: cfg, sup: sup, log: logger, now: time.Now,
		screenOK: ok, screenPlan: plan, captureFn: screen.Capture,
	}
}

// Supervisor expose le superviseur sous-jacent (arrêt propre, tests).
func (rt *Runtime) Supervisor() *exec.Supervisor { return rt.sup }

// HandleMessage traite UNE trame applicative reçue de Yuki.
func (rt *Runtime) HandleMessage(ctx context.Context, msg proto.Message, reply transport.ReplyFunc) error {
	switch m := msg.(type) {
	case *proto.Cmd:
		return rt.handleCmd(ctx, m, reply)
	case *proto.Ping:
		// Sonde de vivacité : réponse immédiate (le transport gère en plus le
		// heartbeat sortant ping/pong).
		return reply(&proto.Pong{T: m.T, Ts: rt.now().Format(time.RFC3339Nano)})
	case *proto.Screenshot:
		return rt.handleScreenshot(m, reply)
	case *proto.Config:
		rt.log.Info("agent.config.recue", map[string]any{
			"level": m.Level, "privilege": m.Privilege,
		})
		return nil
	case *proto.Cancel:
		// L'annulation ciblée d'une commande n'est pas câblée dans ce lot :
		// l'agent le signale, la commande va à son terme (résultat perdu si la
		// connexion se ferme — D124).
		rt.log.Warn("agent.annulation.non_supportee", map[string]any{
			"cmd_id": m.CmdID, "reason": m.Reason,
		})
		return nil
	default:
		rt.log.Debug("agent.trame.ignoree", map[string]any{"type": string(m.Type())})
		return nil
	}
}

// handleScreenshot traite une demande de capture d'écran.
//
// ⚠️ Si l'agent n'a PAS déclaré la capacité `screenshot` (aucun écran ou aucun
// outil au démarrage), il refuse HONNÊTEMENT : jamais d'échec silencieux, jamais
// de capture simulée.
func (rt *Runtime) handleScreenshot(shot *proto.Screenshot, reply transport.ReplyFunc) error {
	if strings.TrimSpace(shot.CmdID) == "" {
		rt.log.Warn("agent.capture.sans_id", nil)
	}
	rt.log.Info("agent.capture.recue", map[string]any{
		"cmd_id": shot.CmdID, "max_edge": shot.MaxEdge, "quality": shot.Quality,
	})
	if !rt.screenOK {
		rt.log.Warn("agent.capture.indisponible", map[string]any{"cmd_id": shot.CmdID})
		return reply(&proto.Error{
			Error:   string(proto.CodeUnsupported),
			Code:    proto.CodeUnsupported,
			Message: "capture d'écran indisponible : aucun écran ou outil de capture détecté sur cette machine",
			Ref:     shot.CmdID,
		})
	}
	// La capture peut prendre plusieurs secondes : goroutine (le read loop du
	// transport reste libre).
	go rt.executeScreenshot(shot, reply)
	return nil
}

// executeScreenshot capture, compresse et renvoie l'image (ou une erreur).
func (rt *Runtime) executeScreenshot(req *proto.Screenshot, reply transport.ReplyFunc) {
	opts := screen.Options{}
	if req.MaxEdge > 0 {
		opts.MaxEdge = req.MaxEdge
	}
	if req.Quality > 0 {
		opts.Quality = req.Quality
	}
	if req.TimeoutMs > 0 {
		opts.Timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}

	started := rt.now()
	capture := rt.captureFn
	if capture == nil {
		capture = screen.Capture
	}
	shot, err := capture(context.Background(), rt.screenPlan, opts)
	if err != nil {
		code := proto.CodeInternal
		switch {
		case errors.Is(err, screen.ErrTooLarge):
			code = proto.CodeTooLarge
		case errors.Is(err, screen.ErrUnsupported):
			code = proto.CodeUnsupported
		}
		message := err.Error()
		if code == proto.CodeTooLarge {
			message = "capture trop lourde : impossible de la compresser sous le plafond de 256 Kio"
		}
		rt.log.Error("agent.capture.echec", map[string]any{
			"cmd_id": req.CmdID, "code": string(code), "error": err.Error(),
		})
		if replyErr := reply(&proto.Error{
			Error:   string(code),
			Code:    code,
			Message: message,
			Ref:     req.CmdID,
		}); replyErr != nil {
			rt.log.Warn("agent.capture.envoi_echec", map[string]any{
				"cmd_id": req.CmdID, "error": replyErr.Error(),
			})
		}
		return
	}

	encoded := base64.StdEncoding.EncodeToString(shot.Data)
	// ⚠️ Journalisation des MÉTADONNÉES seulement : jamais le contenu de l'image.
	rt.log.Info("agent.capture.terminee", map[string]any{
		"cmd_id":      req.CmdID,
		"width":       shot.Width,
		"height":      shot.Height,
		"bytes":       shot.Bytes,
		"data_b64":    len(encoded),
		"duration_ms": rt.now().Sub(started).Milliseconds(),
	})
	if replyErr := reply(&proto.ScreenshotData{
		CmdID:      req.CmdID,
		Format:     shot.Format,
		Width:      shot.Width,
		Height:     shot.Height,
		Bytes:      shot.Bytes,
		Data:       encoded,
		DurationMs: rt.now().Sub(started).Milliseconds(),
	}); replyErr != nil {
		rt.log.Warn("agent.capture.envoi_echec", map[string]any{
			"cmd_id": req.CmdID, "error": replyErr.Error(),
		})
	}
}

// handleCmd exécute la séquence `ack → classification → exécution → result`.
//
// ⚠️ L'ACCUSÉ est renvoyé de façon SYNCHRONE (juste après réception), puis
// l'exécution est confiée à une GOROUTINE : le read loop du transport reste
// ainsi libre de traiter le heartbeat et les trames suivantes, même pour une
// commande longue. Le résultat est renvoyé à son rythme via `reply` (sûr en
// accès concurrent).
//
// ⚠️ D124 : l'exécution n'est PAS liée à la connexion — une déconnexion de Yuki
// ne l'interrompt pas (la commande va à son terme, son résultat est perdu).
// Seul `Supervisor.Shutdown` (arrêt propre de l'agent) peut l'interrompre.
func (rt *Runtime) handleCmd(_ context.Context, cmd *proto.Cmd, reply transport.ReplyFunc) error {
	if strings.TrimSpace(cmd.CmdID) == "" {
		rt.log.Warn("agent.commande.sans_id", nil)
	}
	rt.log.Info("agent.commande.recue", map[string]any{
		"cmd_id": cmd.CmdID, "origin": cmd.Origin, "shell": cmd.Shell,
	})

	// 1. Accusé de réception AVANT toute exécution.
	if err := reply(&proto.Ack{CmdID: cmd.CmdID}); err != nil {
		rt.log.Error("agent.ack.echec", map[string]any{"cmd_id": cmd.CmdID, "error": err.Error()})
		return err
	}

	// 2. Classification LOCALE (matcher A5, source unique embarquée) — synchrone,
	// afin qu'elle soit journalisée même si la commande est très longue.
	local := exec.Classify(cmd.Command)
	rt.logClassement(cmd, local)

	// 3. Exécution (goroutine) : l'agent reste un exécutant bête.
	go rt.executeCmd(cmd, reply)
	return nil
}

// executeCmd exécute réellement la commande et renvoie `result` (ou `error`).
func (rt *Runtime) executeCmd(cmd *proto.Cmd, reply transport.ReplyFunc) {
	req := exec.Request{
		ID:      cmd.CmdID,
		Command: cmd.Command,
		Shell:   cmd.Shell,
		Cwd:     cmd.Cwd,
		Origin:  cmd.Origin,
	}
	if cmd.TimeoutMs > 0 {
		req.Timeout = time.Duration(cmd.TimeoutMs) * time.Millisecond
	}

	result, err := rt.sup.Run(context.Background(), req)
	if err != nil {
		code := proto.CodeInternal
		message := err.Error()
		if errors.Is(err, exec.ErrShuttingDown) {
			message = "agent en cours d'arrêt, commande refusée"
		}
		rt.log.Error("agent.commande.echec", map[string]any{
			"cmd_id": cmd.CmdID, "error": err.Error(),
		})
		if replyErr := reply(&proto.Error{
			Error:   string(code),
			Code:    code,
			Message: message,
			Ref:     cmd.CmdID,
		}); replyErr != nil {
			rt.log.Warn("agent.result.envoi_echec", map[string]any{
				"cmd_id": cmd.CmdID, "error": replyErr.Error(),
			})
		}
		return
	}

	// 4. Résultat BRUT (plafonné 256 Kio/flux). Le balisage `<sortie …>` et le
	// rappel « donnée, jamais instruction » sont faits CÔTÉ YUKI.
	rt.log.Info("agent.commande.terminee", map[string]any{
		"cmd_id":       cmd.CmdID,
		"exit_code":    result.ExitCode,
		"duration_ms":  result.DurationMs,
		"timed_out":    result.TimedOut,
		"stdout_trunc": result.StdoutTruncated,
		"stderr_trunc": result.StderrTruncated,
		"stdout_bytes": len(result.Stdout),
		"stderr_bytes": len(result.Stderr),
	})
	if replyErr := reply(&proto.Result{
		CmdID:       cmd.CmdID,
		ExitCode:    result.ExitCode,
		Stdout:      result.Stdout,
		Stderr:      result.Stderr,
		Truncated:   result.Truncated(),
		StdoutTrunc: result.StdoutTruncated,
		StderrTrunc: result.StderrTruncated,
		DurationMs:  result.DurationMs,
		StartedAt:   result.StartedAt.Format(time.RFC3339Nano),
		EndedAt:     result.EndedAt.Format(time.RFC3339Nano),
		TimedOut:    result.TimedOut,
	}); replyErr != nil {
		rt.log.Warn("agent.result.envoi_echec", map[string]any{
			"cmd_id": cmd.CmdID, "error": replyErr.Error(),
		})
	}
}

// logClassement journalise la classification locale et, le cas échéant, la
// DIVERGENCE avec la décision de Yuki. ⚠️ Jamais bloquant : Yuki reste l'autorité.
func (rt *Runtime) logClassement(cmd *proto.Cmd, local exec.Match) {
	fields := map[string]any{
		"cmd_id":      cmd.CmdID,
		"destructive": local.Destructive,
		"patterns":    local.IDs,
	}
	if cmd.Destructive == nil {
		fields["yuki"] = nil
		rt.log.Info("agent.classement.local", fields)
		return
	}
	fields["yuki"] = *cmd.Destructive
	if *cmd.Destructive != local.Destructive {
		rt.log.Warn("agent.classement.divergence", fields)
		return
	}
	rt.log.Info("agent.classement.local", fields)
}

// Run câble le client de transport et le superviseur, puis boucle jusqu'à
// l'annulation de `ctx`. À l'arrêt, l'agent n'accepte plus de commande et
// accorde `ShutdownGrace` aux commandes en cours avant de tuer leur arbre.
func Run(ctx context.Context, cfg *Config, version string, logger transport.Logger) error {
	if logger == nil {
		logger = transport.NopLogger{}
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	tlsCfg, err := ClientTLSConfig(cfg)
	if err != nil {
		return err
	}
	sup := exec.NewSupervisor(exec.New(exec.Options{
		Shell:          cfg.Shell,
		DefaultTimeout: time.Duration(cfg.DefaultTimeoutMS) * time.Millisecond,
		OutputCapBytes: cfg.OutputCapBytes,
	}))
	rt := NewRuntime(cfg, sup, logger)
	client, err := transport.NewClient(transport.Options{
		URL:          cfg.YukiURL,
		TLSConfig:    tlsCfg,
		Hello:        BuildHello(cfg, version),
		Handler:      rt,
		Logger:       logger,
		PingInterval: time.Duration(cfg.PingIntervalMS) * time.Millisecond,
		OfflineAfter: time.Duration(cfg.OfflineAfterMS) * time.Millisecond,
	})
	if err != nil {
		return err
	}
	logger.Info("agent.demarrage", map[string]any{
		"url": cfg.YukiURL, "agent_id": cfg.AgentID, "version": version,
	})
	runErr := client.Run(ctx)
	// Arrêt PROPRE : refuse les nouvelles commandes, laisse la grâce aux
	// commandes en cours, puis tue les arbres restants.
	logger.Info("agent.arret", map[string]any{"grace_ms": ShutdownGrace.Milliseconds()})
	sup.Shutdown(ShutdownGrace)
	return runErr
}

// ClientTLSConfig construit la configuration TLS mTLS de l'agent : CA de Yuki
// ÉPINGLÉ (empreinte) + certificat client d'appairage.
func ClientTLSConfig(cfg *Config) (*tls.Config, error) {
	caPEM, err := os.ReadFile(cfg.CAFile)
	if err != nil {
		return nil, fmt.Errorf("agent : lecture du CA %q : %w", cfg.CAFile, err)
	}
	certPEM, err := os.ReadFile(cfg.CertFile)
	if err != nil {
		return nil, fmt.Errorf("agent : lecture du certificat client %q : %w", cfg.CertFile, err)
	}
	keyPEM, err := os.ReadFile(cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("agent : lecture de la clé client %q : %w", cfg.KeyFile, err)
	}
	fingerprint, err := tlsconf.FingerprintPEM(caPEM)
	if err != nil {
		return nil, fmt.Errorf("agent : empreinte du CA : %w", err)
	}
	cfgTLS, err := tlsconf.ClientConfig(tlsconf.Options{
		CertPEM:           certPEM,
		KeyPEM:            keyPEM,
		CAPEM:             caPEM,
		PinnedFingerprint: fingerprint,
		ServerName:        hostOf(cfg.YukiURL),
	})
	if err != nil {
		return nil, fmt.Errorf("agent : configuration TLS : %w", err)
	}
	return cfgTLS, nil
}

// hostOf extrait l'hôte d'une URL (vide si illisible).
func hostOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}
