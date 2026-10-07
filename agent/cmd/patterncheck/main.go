// Command patterncheck — harnais de VÉRIFICATION CROISÉE Go ↔ TS du classement
// des commandes destructrices (Lot 4, A5).
//
// ⚠️ Le matcher a UNE source unique : `internal/exec/destructive_patterns.json`,
// embarquée côté Go. Ce harnais prouve que Go et TypeScript lisent le MÊME
// fichier et classent IDENTIQUEMENT une batterie de commandes — un désaccord
// silencieux serait un trou de sécurité.
//
// Deux modes :
//
//	patterncheck info
//	    imprime en JSON la version, le nombre de motifs, leurs identifiants et
//	    l'empreinte SHA-256 du fichier embarqué. Le test TS compare cette
//	    empreinte à celle du fichier qu'IL lit : preuve que les octets sont
//	    identiques.
//
//	patterncheck classify
//	    lit sur l'entrée standard un TABLEAU JSON de chaînes (les commandes) et
//	    imprime un TABLEAU JSON de verdicts `{command, destructive, ids}`.
//
// ⚠️ Ce programme n'est PAS l'agent de production : c'est un outil de
// vérification, isolé du reste du module.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/grokuku/yuki/agent/internal/exec"
)

func main() {
	if len(os.Args) < 2 {
		fail("usage : patterncheck <info|classify>")
	}
	switch os.Args[1] {
	case "info":
		runInfo()
	case "classify":
		runClassify()
	default:
		fail("mode inconnu : " + os.Args[1])
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "patterncheck : "+message)
	os.Exit(1)
}

type infoOut struct {
	Version int      `json:"version"`
	Count   int      `json:"count"`
	IDs     []string `json:"ids"`
	SHA256  string   `json:"sha256"`
}

func runInfo() {
	doc, err := exec.LoadDestructivePatterns()
	if err != nil {
		fail("motifs : " + err.Error())
	}
	ids := make([]string, 0, len(doc.Patterns))
	for _, p := range doc.Patterns {
		ids = append(ids, p.ID)
	}
	printJSON(infoOut{
		Version: doc.Version,
		Count:   len(doc.Patterns),
		IDs:     ids,
		SHA256:  exec.DestructivePatternsSHA256(),
	})
}

type verdictOut struct {
	Command     string   `json:"command"`
	Destructive bool     `json:"destructive"`
	IDs         []string `json:"ids"`
}

func runClassify() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail("lecture stdin : " + err.Error())
	}
	var commands []string
	if err := json.Unmarshal(raw, &commands); err != nil {
		fail("entrée non conforme (tableau JSON de chaînes attendu) : " + err.Error())
	}
	out := make([]verdictOut, 0, len(commands))
	for _, command := range commands {
		match := exec.Classify(command)
		ids := match.IDs
		if ids == nil {
			ids = []string{}
		}
		out = append(out, verdictOut{Command: command, Destructive: match.Destructive, IDs: ids})
	}
	printJSON(out)
}

func printJSON(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		fail("encodage JSON : " + err.Error())
	}
	fmt.Println(string(data))
}
