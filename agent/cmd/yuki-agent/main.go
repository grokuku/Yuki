// Command yuki-agent — binaire de l'« agent d'exécution » Yuki (Lot 4, A6).
//
// C'est le programme que l'on INSTALLE sur une machine pour qu'elle exécute les
// commandes décidées par Yuki :
//
//	yuki-agent pair      → appaire la machine (récupère CA + certificats)
//	yuki-agent run       → service : connexion mTLS et boucle cmd → result
//	yuki-agent install   → installe l'agent comme service système
//	yuki-agent uninstall → retire le service
//	yuki-agent status    → état de la configuration et du service
//	yuki-agent version   → version de l'agent
//
// ⚠️ L'agent est un EXÉCUTANT BÊTE : Yuki décide, l'agent exécute. Il journalise
// toute divergence entre sa classification locale et la décision de Yuki, sans
// jamais bloquer (D118/D126).
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/grokuku/yuki/agent/internal/buildinfo"
)

// usageText est l'aide en français (⚠️ messages utilisateur en français).
func usageText() string {
	return `yuki-agent — agent d'exécution Yuki (` + buildinfo.Version + `)

Usage :
  yuki-agent <commande> [options]

Commandes :
  pair        Appaire cette machine auprès de Yuki et enregistre les certificats
  run         Se connecte à Yuki et exécute les commandes reçues (mode service)
  install     Installe l'agent comme service système (systemd / SCM Windows)
  uninstall   Retire le service système
  status      Affiche l'état de la configuration, de l'appairage et du service
  version     Affiche la version de l'agent
  help        Affiche cette aide

Options communes :
  --config <chemin>   Fichier de configuration (défaut : variable
                      YUKI_AGENT_CONFIG, sinon /etc/yuki-agent/agent.json)

Exemples :
  yuki-agent pair --yuki-url wss://yuki.example.org:8765/ws
  yuki-agent run --config /etc/yuki-agent/agent.json
  yuki-agent install --account 'NT AUTHORITY\LocalService'
`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run est le point d'entrée TESTABLE : il renvoie un code de sortie et écrit
// sur les flux fournis.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usageText())
		return 2
	}
	command, rest := args[0], args[1:]
	switch command {
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usageText())
		return 0
	case "version", "-v", "--version":
		fmt.Fprintf(stdout, "yuki-agent %s\n", buildinfo.Version)
		return 0
	case "pair":
		return cmdPair(rest, stdin, stdout, stderr)
	case "run":
		return cmdRun(rest, stdout, stderr)
	case "install":
		return cmdInstall(rest, stdout, stderr)
	case "uninstall":
		return cmdUninstall(rest, stdout, stderr)
	case "status":
		return cmdStatus(rest, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "yuki-agent : commande inconnue %q\n\n", command)
		fmt.Fprint(stderr, usageText())
		return 2
	}
}

// fail écrit un message d'erreur préfixé et renvoie un code de sortie.
func fail(stderr io.Writer, format string, args ...any) int {
	fmt.Fprintf(stderr, "yuki-agent : "+format+"\n", args...)
	return 1
}
