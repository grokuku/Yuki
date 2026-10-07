//go:build !windows

package agent

import "os"

// effectiveUID renvoie l'identifiant d'utilisateur effectif du processus agent.
func effectiveUID() int { return os.Geteuid() }
