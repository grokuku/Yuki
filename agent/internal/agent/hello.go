package agent

import (
	"os"
	"runtime"

	"github.com/grokuku/yuki/agent/internal/proto"
)

// Capabilities déclarées par l'agent au `hello`.
var capabilities = []string{
	"exec",     // exécution de commandes
	"shell",    // shell complet (D123)
	"classify", // classification locale des commandes destructrices (A5)
}

// BuildHello construit la trame de présentation envoyée à CHAQUE connexion,
// à partir de l'OS réel de la machine :
//
//   - `host` : nom d'hôte (`os.Hostname`, vide si indisponible) ;
//   - `os`/`arch` : `runtime.GOOS`/`runtime.GOARCH` ;
//   - `euid` : identifiant d'utilisateur effectif (`-1` sous Windows) — permet
//     à Yuki de comparer le privilège EFFECTIF au privilège configuré (D120) ;
//   - `caps` : capacités de l'agent.
//
// ⚠️ `agent_version` est la version PROPRE de l'agent (`agent/VERSION`),
// indépendante de la version de Yuki.
func BuildHello(cfg *Config, version string) *proto.Hello {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	return &proto.Hello{
		AgentID:      cfg.AgentID,
		AgentVersion: version,
		Host:         host,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		EUID:         effectiveUID(),
		Caps:         append([]string(nil), capabilities...),
	}
}
