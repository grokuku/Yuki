package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/grokuku/yuki/agent/internal/agent"
	"github.com/grokuku/yuki/agent/internal/buildinfo"
	"github.com/grokuku/yuki/agent/internal/service"
	"github.com/grokuku/yuki/agent/internal/tlsconf"
)

// resolveBinary renvoie le chemin ABSOLU du binaire à installer (option, sinon
// binaire courant).
func resolveBinary(explicit string) (string, error) {
	path := strings.TrimSpace(explicit)
	if path == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("chemin du binaire courant : %w", err)
		}
		path = exe
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("chemin absolu de %q : %w", path, err)
	}
	return abs, nil
}

// cmdInstall implémente `yuki-agent install`.
func cmdInstall(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent install",
		"Installe l'agent comme service système.\n"+
			"Sous Windows : crée le service (démarrage automatique, relance 5 s) et le démarre,\n"+
			"puis exécutez cette commande avec des privilèges administrateur.\n"+
			"Sous Linux : utilisez `deploy/install.sh` (systemd).", stderr)
	configPath := fs.String("config", "", "fichier de configuration du service")
	account := fs.String("account", "", "compte de service Windows (défaut : compte système)")
	binaryPath := fs.String("binary", "", "binaire à installer (défaut : binaire courant)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	binary, err := resolveBinary(*binaryPath)
	if err != nil {
		return fail(stderr, "%v", err)
	}
	resolvedConfig := agent.ResolveConfigPath(*configPath)
	opts := service.InstallOptions{
		BinaryPath: binary,
		Arguments:  []string{"run", "--config", resolvedConfig},
		Account:    strings.TrimSpace(*account),
	}
	if err := service.Install(opts); err != nil {
		if errors.Is(err, service.ErrUnsupported) {
			return fail(stderr, "%v", err)
		}
		return fail(stderr, "installation du service : %v", err)
	}
	fmt.Fprintf(stdout, "Service %q installé et démarré.\n", service.Name)
	fmt.Fprintf(stdout, "  binaire     : %s\n", binary)
	fmt.Fprintf(stdout, "  arguments   : run --config %s\n", resolvedConfig)
	if opts.Account != "" {
		fmt.Fprintf(stdout, "  compte      : %s\n", opts.Account)
	}
	return 0
}

// cmdUninstall implémente `yuki-agent uninstall`.
func cmdUninstall(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent uninstall",
		"Retire le service système.\n"+
			"Sous Linux : utilisez `systemctl disable --now yuki-agent`.", stderr)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if err := service.Uninstall(); err != nil {
		if errors.Is(err, service.ErrUnsupported) {
			return fail(stderr, "%v", err)
		}
		return fail(stderr, "désinstallation du service : %v", err)
	}
	fmt.Fprintf(stdout, "Service %q retiré.\n", service.Name)
	return 0
}

// cmdStatus implémente `yuki-agent status`.
func cmdStatus(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("yuki-agent status",
		"Affiche l'état de la configuration, de l'appairage et du service.", stderr)
	configPath := fs.String("config", "", "fichier de configuration")
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

	fmt.Fprintf(stdout, "yuki-agent %s\n", buildinfo.Version)
	fmt.Fprintf(stdout, "  configuration  : %s\n", resolvedPath)
	fmt.Fprintf(stdout, "  répertoire     : %s\n", cfg.StateDir)
	fmt.Fprintf(stdout, "  adresse Yuki   : %s\n", orNone(cfg.YukiURL))
	fmt.Fprintf(stdout, "  base appairage : %s\n", orNone(cfg.PairURL))
	fmt.Fprintf(stdout, "  identifiant    : %s\n", orNone(cfg.AgentID))
	fmt.Fprintf(stdout, "  shell          : %s\n", orDefault(cfg.Shell, "shell système"))

	if !cfg.Paired() {
		fmt.Fprintln(stdout, "  appairage      : NON (lancez `yuki-agent pair`)")
	} else {
		fmt.Fprintln(stdout, "  appairage      : oui")
		if fingerprint := agent.ReadCAFingerprint(cfg); fingerprint != "" {
			fmt.Fprintf(stdout, "  empreinte CA   : %s\n", fingerprint)
		}
		fmt.Fprintf(stdout, "  certificat     : %s\n", describeClientCert(cfg.CertFile))
	}

	status, err := service.Status()
	if err != nil {
		fmt.Fprintf(stdout, "  service        : indisponible (%v)\n", err)
	} else {
		fmt.Fprintf(stdout, "  service        : %s\n", status)
	}
	return 0
}

// describeClientCert résume le certificat client (sujet, échéance).
func describeClientCert(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("illisible (%v)", err)
	}
	cert, err := tlsconf.ParseCertificatePEM(data)
	if err != nil {
		return fmt.Sprintf("illisible (%v)", err)
	}
	days := int(time.Until(cert.NotAfter).Hours() / 24)
	return fmt.Sprintf("%s, expire dans %d jour(s) (%s)", cert.Subject.CommonName, days, cert.NotAfter.Format(time.RFC3339))
}

func orNone(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(non défini)"
	}
	return value
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
