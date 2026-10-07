package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"strings"

	"github.com/grokuku/yuki/agent/internal/agent"
	"github.com/grokuku/yuki/agent/internal/buildinfo"
	"github.com/grokuku/yuki/agent/internal/service"
)

// cmdRun implémente `yuki-agent run` : service de connexion et d'exécution.
func cmdRun(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent run",
		"Se connecte à Yuki (mTLS) et exécute les commandes reçues.\n"+
			"Sous Linux, ce mode est appelé par systemd ; sous Windows, par le SCM\n"+
			"si l'agent a été installé comme service — sinon il tourne au premier plan.",
		stderr)
	configPath := fs.String("config", "", "fichier de configuration")
	logLevel := fs.String("log-level", "", "niveau de journal (debug|info|warn|error)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	cfg, resolvedPath, err := loadConfigFile(*configPath)
	if err != nil {
		return fail(stderr, "%v", err)
	}
	if strings.TrimSpace(*logLevel) != "" {
		cfg.LogLevel = strings.TrimSpace(*logLevel)
	}
	level, err := agent.ParseLevel(cfg.LogLevel)
	if err != nil {
		return fail(stderr, "%v", err)
	}
	logger := agent.NewJSONLogger(stderr, level)

	if err := cfg.Validate(); err != nil {
		logger.Error("agent.configuration.invalide", map[string]any{"error": err.Error()})
		return 1
	}
	if !cfg.Paired() {
		logger.Error("agent.non_appaire", map[string]any{
			"hint":   "lancez `yuki-agent pair`",
			"ca":     cfg.CAFile,
			"cert":   cfg.CertFile,
			"config": resolvedPath,
		})
		return 1
	}

	ctx, stop := withSignals()
	defer stop()

	err = service.Run(ctx, func(runCtx context.Context) error {
		return agent.Run(runCtx, cfg, buildinfo.Version, logger)
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("agent.arret.anormal", map[string]any{"error": err.Error()})
		return 1
	}
	return 0
}
