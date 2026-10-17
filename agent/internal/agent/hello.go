package agent

import (
	"os"
	"runtime"

	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/screen"
)

// Capabilities déclarées par l'agent au `hello`.
//
// ⚠️ `exec`, `shell`, `classify` et `env` sont TOUJOURS déclarées (elles
// décrivent des capacités compilées dans le binaire). `screenshot` est
// CONDITIONNELLE : elle n'est ajoutée que si un écran ET un outil de capture
// sont réellement présents (capacitésFor → screen.Detect). Annoncer une
// capacité à tort ferait échouer Yuki sans explication.
//
// ⚠️ `env` = « sait recevoir des SECRETS par variable d'environnement » :
// l'agent DÉCODE `Cmd.Env`, l'APPLIQUE en sur-ensemble de l'environnement de
// l'enfant, et REFUSE une commande qui référence une variable réservée
// (`YUKI_SECRET_…`) sans valeur fournie. C'est ce que Yuki vérifie AVANT
// d'envoyer une commande porteuse d'un secret (`src/agents/execution.ts`).
// Un agent ANTÉRIEUR à cette capacité ne la déclare pas ⇒ Yuki refuse
// l'envoi au lieu de laisser le shell développer la variable en chaîne vide
// (potentiellement destructeur).
var capabilities = []string{
	"exec",     // exécution de commandes
	"shell",    // shell complet (D123)
	"classify", // classification locale des commandes destructrices (A5)
	"env",      // secrets reçus par variable d'environnement (Cmd.Env → enfant)
}

// capabilitiesFor renvoie les capacités à déclarer, en ajoutant `screenshot`
// UNIQUEMENT si la détection réussit. `getenv`/`lookPath` sont injectables
// (tests) ; nuls ⇒ `os.Getenv`/`os/exec.LookPath`.
func capabilitiesFor(goos string, getenv screen.GetenvFunc, lookPath screen.LookPathFunc) []string {
	caps := append([]string(nil), capabilities...)
	if _, ok := screen.Detect(goos, getenv, lookPath); ok {
		caps = append(caps, "screenshot")
	}
	return caps
}

// BuildHello construit la trame de présentation envoyée à CHAQUE connexion,
// à partir de l'OS réel de la machine :
//
//   - `host` : nom d'hôte (`os.Hostname`, vide si indisponible) ;
//   - `os`/`arch` : `runtime.GOOS`/`runtime.GOARCH` ;
//   - `euid` : identifiant d'utilisateur effectif (`-1` sous Windows) — permet
//     à Yuki de comparer le privilège EFFECTIF au privilège configuré (D120) ;
//   - `caps` : capacités de l'agent, dont `screenshot` seulement si elle est
//     réelle (écran + outil de capture détectés).
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
		Caps:         capabilitiesFor(runtime.GOOS, os.Getenv, nil),
	}
}
