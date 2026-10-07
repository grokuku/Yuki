// Package buildinfo porte la version de l'agent, découplée de la version de
// Yuki (`agent/VERSION`).
//
// La constante `Version` peut être remplacée au moment de la compilation :
//
//	go build -ldflags "-X github.com/grokuku/yuki/agent/internal/buildinfo.Version=$(cat agent/VERSION)" ./cmd/yuki-agent
//
// ⚠️ La valeur par défaut DOIT rester synchronisée avec `agent/VERSION` ; un
// test le vérifie (`buildinfo_test.go`).
package buildinfo

// Version est la version de l'agent d'exécution.
var Version = "0.1.0"
