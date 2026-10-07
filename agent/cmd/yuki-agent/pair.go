package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/grokuku/yuki/agent/internal/agent"
	"github.com/grokuku/yuki/agent/internal/pair"
)

// newFlagSet crée un jeu d'options avec une aide française.
func newFlagSet(name, help string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintf(stderr, "%s\n\nOptions :\n", help)
		fs.PrintDefaults()
	}
	return fs
}

// loadConfigFile résout puis charge la configuration. `explicit` vrai si
// `--config` a été fourni (un fichier alors introuvable est une erreur).
func loadConfigFile(explicit string) (*agent.Config, string, error) {
	path := agent.ResolveConfigPath(explicit)
	cfg, err := agent.Load(path, strings.TrimSpace(explicit) != "")
	if err != nil {
		return nil, path, err
	}
	return cfg, path, nil
}

// readLine lit une ligne sur `stdin` (invite incluse côté appelant) et la
// nettoie. Un flux vide renvoie une chaîne vide sans erreur.
func readLine(stdin io.Reader) (string, error) {
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 4096), 1<<20)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", err
		}
		return "", nil
	}
	return strings.TrimSpace(scanner.Text()), nil
}

// cmdPair implémente `yuki-agent pair`.
func cmdPair(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent pair",
		"Appaire cette machine auprès de Yuki et enregistre les certificats.\n"+
			"L'adresse de Yuki peut être passée en option ou saisie au clavier ;\n"+
			"le code d'appairage est celui AFFICHÉ PAR YUKI.", stderr)
	configPath := fs.String("config", "", "fichier de configuration")
	yukiURL := fs.String("yuki-url", "", "adresse de Yuki (wss://hôte:port/ws)")
	pairURL := fs.String("pair-url", "", "base HTTPS d'appairage (défaut : dérivée de yuki-url)")
	code := fs.String("code", "", "code d'appairage (sinon saisie interactive)")
	stateDir := fs.String("state-dir", "", "répertoire d'état (certificats)")
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
	if strings.TrimSpace(*yukiURL) != "" {
		cfg.YukiURL = strings.TrimSpace(*yukiURL)
	}
	if strings.TrimSpace(*pairURL) != "" {
		cfg.PairURL = strings.TrimSpace(*pairURL)
	}
	if strings.TrimSpace(*stateDir) != "" {
		cfg.StateDir = strings.TrimSpace(*stateDir)
	}

	// 1. Adresse de Yuki (option, sinon saisie).
	if strings.TrimSpace(cfg.YukiURL) == "" {
		fmt.Fprint(stdout, "Adresse de Yuki (wss://hôte:port/ws) : ")
		value, err := readLine(stdin)
		if err != nil {
			return fail(stderr, "lecture de l'adresse : %v", err)
		}
		cfg.YukiURL = value
	}
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		return fail(stderr, "%v", err)
	}

	// 2. Code d'appairage (option, sinon saisie), affiché sous forme canonique.
	rawCode := strings.TrimSpace(*code)
	if rawCode == "" {
		fmt.Fprint(stdout, "Code d'appairage (affiché par Yuki) : ")
		value, err := readLine(stdin)
		if err != nil {
			return fail(stderr, "lecture du code : %v", err)
		}
		rawCode = value
	}
	canonical, err := pair.NormalizeCode(rawCode)
	if err != nil {
		return fail(stderr, "code d'appairage invalide : %v", err)
	}
	fmt.Fprintf(stdout, "Code retenu : %s\n", canonical)
	fmt.Fprintf(stdout, "Adresse de Yuki : %s\n", cfg.YukiURL)
	fmt.Fprintf(stdout, "Base d'appairage : %s\n", cfg.PairURL)

	// 3. Appairage (premier contact ; CA authentifié par le code).
	yukiFP := agent.ReadCAFingerprint(cfg)
	if yukiFP != "" {
		fmt.Fprintf(stdout, "CA déjà connu (empreinte %s) : revérifié.\n", shortFP(yukiFP))
	}
	ctx, stop := withSignals()
	defer stop()
	payload, err := agent.PerformPairing(ctx, cfg.PairURL, canonical, yukiFP)
	if err != nil {
		return fail(stderr, "appairage : %v", err)
	}

	// 4. Écriture du matériel (permissions restrictives) + identité.
	if err := agent.WriteMaterial(cfg, payload); err != nil {
		return fail(stderr, "enregistrement du matériel : %v", err)
	}
	cfg.AgentID = payload.AgentID
	if err := cfg.Save(resolvedPath); err != nil {
		return fail(stderr, "enregistrement de la configuration : %v", err)
	}

	fmt.Fprintln(stdout, "Appairage réussi.")
	fmt.Fprintf(stdout, "  identifiant d'agent : %s\n", payload.AgentID)
	fmt.Fprintf(stdout, "  empreinte du CA      : %s\n", payload.CAFingerprint)
	fmt.Fprintf(stdout, "  CA                   : %s\n", cfg.CAFile)
	fmt.Fprintf(stdout, "  certificat client    : %s\n", cfg.CertFile)
	fmt.Fprintf(stdout, "  clé privée client    : %s (0600)\n", cfg.KeyFile)
	fmt.Fprintf(stdout, "  configuration        : %s\n", resolvedPath)
	fmt.Fprintln(stdout, "Lancez désormais : yuki-agent run")
	return 0
}

// shortFP abrège une empreinte hexadécimale pour l'affichage.
func shortFP(fingerprint string) string {
	if len(fingerprint) <= 16 {
		return fingerprint
	}
	return fingerprint[:16] + "…"
}
