package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/grokuku/yuki/agent/internal/agent"
)

// pairExpiryLayout : format d'heure locale affiché à côté du code.
const pairExpiryLayout = "15:04:05"

// waitAnnounceInterval : fréquence du message « toujours en attente ».
const waitAnnounceInterval = 15 * time.Second

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
// nettoie. Un flux vide renvoie une chaîne vide sans erreur. Utilisé UNIQUEMENT
// pour l'adresse de Yuki : le code d'appairage n'est jamais demandé (D119).
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
//
// CONFORME À D119 : c'est CETTE machine qui GÉNÈRE et AFFICHE le code
// d'appairage ; l'utilisateur le recopie ensuite dans Yuki (Configuration →
// Agents) pour prouver qu'il a accès à la machine. La CLI ne demande JAMAIS de
// code et n'en accepte aucun : le seul endroit où le code s'affiche est la
// console de la machine.
func cmdPair(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent pair",
		"Appaire CETTE machine auprès de Yuki et enregistre les certificats.\n"+
			"C'est cette machine qui GÉNÈRE et AFFICHE un code d'appairage : recopiez-le\n"+
			"dans Yuki (onglet Configuration → section Agents) pour prouver que vous\n"+
			"avez accès à la machine. Le code n'est jamais demandé ici.", stderr)
	configPath := fs.String("config", "", "fichier de configuration")
	yukiURL := fs.String("yuki-url", "",
		"adresse de Yuki, p. ex. wss://10.0.0.5:9443/ws (suffixe /ws ajouté s'il manque)")
	pairURL := fs.String("pair-url", "", "base HTTPS d'appairage (défaut : dérivée de yuki-url)")
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
	// ⚠️ Tolérance : le port machines n'écoute QUE `/ws` ; une adresse sans ce
	// suffixe est complétée et signalée, plutôt que d'échouer en silence.
	if normalized, added := agent.NormalizeYukiURL(cfg.YukiURL); normalized != "" {
		cfg.YukiURL = normalized
		if added {
			fmt.Fprintf(stdout, "Adresse complétée : %s (suffixe « /ws » ajouté).\n", normalized)
		}
	}
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		return fail(stderr, "%v", err)
	}

	fmt.Fprintf(stdout, "Adresse de Yuki  : %s\n", cfg.YukiURL)
	fmt.Fprintf(stdout, "Base d'appairage : %s\n", cfg.PairURL)

	yukiFP := agent.ReadCAFingerprint(cfg)
	if yukiFP != "" {
		fmt.Fprintf(stdout, "CA déjà connu (empreinte %s) : revérifié.\n", shortFP(yukiFP))
	}

	// 2. Appairage : l'agent GÉNÈRE le code, l'AFFICHE, l'envoie (`pair_begin`)
	// puis scrute jusqu'à validation dans Yuki. Sur expiration, un nouveau code
	// est généré et affiché (l'utilisateur garde une console à jour).
	ctx, stop := withSignals()
	defer stop()

	payload, err := agent.PairWithCodes(ctx, cfg.PairURL, yukiFP, agent.PairingPolicy{},
		agent.PairingCallbacks{
			OnCode: func(code string, expiresAt time.Time, attempt int) {
				printPairCode(stdout, code, expiresAt, attempt)
			},
			OnExpired: func(code string, _ int) {
				fmt.Fprintf(stdout,
					"\nLe code %s a expiré sans être validé ; génération d'un nouveau code…\n", code)
			},
			OnWaiting: waitAnnouncer(stdout),
		})
	if err != nil {
		if agent.IsPairExpired(err) {
			return fail(stderr,
				"appairage : %v\nRelancez `yuki-agent pair` et recopiez le nouveau code "+
					"dans Yuki (Configuration → Agents).", err)
		}
		return fail(stderr, "appairage : %v", err)
	}

	// 3. Écriture du matériel (permissions restrictives) + identité.
	if err := agent.WriteMaterial(cfg, payload); err != nil {
		return fail(stderr, "enregistrement du matériel : %v", err)
	}
	cfg.AgentID = payload.AgentID
	if err := cfg.Save(resolvedPath); err != nil {
		return fail(stderr, "enregistrement de la configuration : %v", err)
	}

	fmt.Fprintln(stdout, "\nAppairage réussi.")
	fmt.Fprintf(stdout, "  identifiant d'agent : %s\n", payload.AgentID)
	fmt.Fprintf(stdout, "  empreinte du CA      : %s\n", payload.CAFingerprint)
	fmt.Fprintf(stdout, "  CA                   : %s\n", cfg.CAFile)
	fmt.Fprintf(stdout, "  certificat client    : %s\n", cfg.CertFile)
	fmt.Fprintf(stdout, "  clé privée client    : %s (0600)\n", cfg.KeyFile)
	fmt.Fprintf(stdout, "  configuration        : %s\n", resolvedPath)
	fmt.Fprintln(stdout, "Lancez désormais : yuki-agent run")
	return 0
}

// printPairCode affiche le code d'appairage de façon lisible, avec le mode
// d'emploi exact (D119 : c'est l'agent qui l'affiche, l'utilisateur le recopie
// dans Yuki).
func printPairCode(stdout io.Writer, code string, expiresAt time.Time, attempt int) {
	rule := strings.Repeat("─", 60)
	title := "Code d'appairage"
	if attempt > 1 {
		title = fmt.Sprintf("Nouveau code d'appairage (n° %d)", attempt)
	}
	fmt.Fprintf(stdout, "\n%s\n", rule)
	fmt.Fprintf(stdout, "  %s :  %s\n", title, code)
	fmt.Fprintf(stdout, "  Valable jusqu'à %s.\n", expiresAt.Local().Format(pairExpiryLayout))
	fmt.Fprintf(stdout, "%s\n", rule)
	fmt.Fprint(stdout,
		"  1. Ouvrez Yuki → onglet « Configuration » → section « Agents ».\n"+
			"  2. Recopiez le code ci-dessus dans le champ prévu.\n"+
			"  3. Cliquez sur « Appairer ».\n"+
			"Ce code ne s'affiche que sur cette machine : ne le communiquez à personne.\n")
}

// waitAnnouncer renvoie le callback d'attente : il affiche une première ligne
// dès la mise en attente, puis un rappel périodique (sans polluer les sorties
// courtes des tests).
func waitAnnouncer(stdout io.Writer) func(elapsed time.Duration) {
	announced := false
	next := waitAnnounceInterval
	return func(elapsed time.Duration) {
		if !announced {
			announced = true
			fmt.Fprintln(stdout,
				"En attente de la validation dans Yuki (Configuration → Agents)…")
			return
		}
		if elapsed < next {
			return
		}
		next += waitAnnounceInterval
		fmt.Fprintf(stdout, "  … toujours en attente (%s).\n", elapsed.Round(time.Second))
	}
}

// shortFP abrège une empreinte hexadécimale pour l'affichage.
func shortFP(fingerprint string) string {
	if len(fingerprint) <= 16 {
		return fingerprint
	}
	return fingerprint[:16] + "…"
}
