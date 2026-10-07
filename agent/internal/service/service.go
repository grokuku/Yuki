// Package service porte l'intégration de `yuki-agent` comme SERVICE SYSTÈME.
//
// Deux plateformes, deux stratégies :
//
//   - LINUX : le cycle de vie est confié à systemd
//     (`deploy/yuki-agent.service` + `deploy/install.sh`). Le binaire se
//     contente d'un mode premier plan (`yuki-agent run`) ; `Install`/`Uninstall`
//     en Go renvoient une erreur explicite pointant vers le script.
//   - WINDOWS : `golang.org/x/sys/windows/svc` pilote le Service Control
//     Manager (SCM) — `install`/`uninstall` créent/suppriment le service,
//     `run` s'enregistre comme point d'entrée de service et réagit aux
//     demandes d'arrêt.
//
// ⚠️ Sur toute plateforme, l'agent expose aussi un mode PREMIER PLAN : le
// service n'est qu'un emballage autour de la même boucle `agent.Run`.
package service

import "errors"

// Name est le nom technique du service (systemd : `yuki-agent` ; SCM : idem).
const Name = "yuki-agent"

// DisplayName et Description sont affichés par le SCM Windows.
const (
	DisplayName = "Yuki — agent d'exécution"
	Description = "Agent d'exécution Yuki : connexion sortante mTLS, exécution des commandes autorisées."
)

// ErrUnsupported signale qu'une opération n'est pas disponible sur la
// plateforme courante (avec un message d'orientation).
var ErrUnsupported = errors.New("service : opération non supportée sur cette plateforme")

// InstallOptions décrit l'installation du service.
type InstallOptions struct {
	// BinaryPath : chemin ABSOLU du binaire `yuki-agent`.
	BinaryPath string
	// Arguments : arguments passés au service (ex. `run --config <chemin>`).
	Arguments []string
	// Account : compte de service (Windows). Vide ⇒ compte système par défaut.
	// C'est CE réglage qui porte le privilège (D120) : un process ne s'élève
	// pas à chaud.
	Account string
}
