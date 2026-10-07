// Package exec — exécution de commandes par l'agent (Lot 4, A4) et
// classification des commandes destructrices (A5).
//
// ⚠️ Ce paquet est PORTABLE en lecture (matcher + types) ; l'EXÉCUTION réelle
// est assurée sous Linux (`proc_linux.go`, groupes POSIX) et sous Windows
// (`proc_windows.go`, job object). Les autres plateformes compilent mais `Run`
// renvoie une erreur explicite (`ErrUnsupported`) : aucune exécution n'est
// simulée en silence.
package exec

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sync"
)

// destructivePatternsJSON est la SOURCE UNIQUE des motifs, embarquée dans le
// binaire au moment de la compilation (`//go:embed`). ⚠️ Le côté TypeScript lit
// EXACTEMENT le même fichier à l'exécution
// (`src/agents/destructive.ts`) ; l'identité des deux sources est prouvée par
// l'empreinte SHA-256 exposée via `DestructivePatternsSHA256` et vérifiée par
// le test croisé `tests/agents/destructive-cross.test.ts`.
//
//go:embed destructive_patterns.json
var destructivePatternsJSON []byte

// DestructivePattern est un motif de classification, tel que déclaré dans le
// JSON. `Flags` est un sous-ensemble de `i` (insensible à la casse) ; il est
// traduit en `(?i)` côté Go et en second argument de `RegExp` côté JavaScript.
type DestructivePattern struct {
	// ID : identifiant stable et unique du motif (utilisé par les tests et les
	// journaux de divergence).
	ID string `json:"id"`
	// Label : description lisible en français.
	Label string `json:"label"`
	// Regex : expression régulière compatible RE2 et RegExp.
	Regex string `json:"regex"`
	// Flags : modificateurs (seul `i` est utilisé).
	Flags string `json:"flags"`
}

// DestructivePatterns est le document JSON complet.
type DestructivePatterns struct {
	Version     int                  `json:"version"`
	Description string               `json:"description"`
	Limites     []string             `json:"limites"`
	Patterns    []DestructivePattern `json:"patterns"`
}

// Match décrit la classification d'une commande.
type Match struct {
	// Destructive : `true` si AU MOINS un motif correspond.
	Destructive bool `json:"destructive"`
	// IDs : identifiants des motifs correspondants, dans l'ordre du fichier.
	IDs []string `json:"ids"`
}

// compiledPattern est un motif compilé avec ses métadonnées.
type compiledPattern struct {
	id      string
	label   string
	re      *regexp.Regexp
	rawText string
}

var (
	compiledOnce sync.Once
	compiled     []compiledPattern
	compiledErr  error
	docOnce      sync.Once
	doc          *DestructivePatterns
	docErr       error
)

// DestructivePatternsJSON renvoie une COPIE des octets embarqués du fichier de
// motifs (source unique). Sert notamment à prouver, côté test, que Go et TS
// lisent des octets identiques.
func DestructivePatternsJSON() []byte {
	out := make([]byte, len(destructivePatternsJSON))
	copy(out, destructivePatternsJSON)
	return out
}

// DestructivePatternsSHA256 renvoie l'empreinte SHA-256 (hex minuscule) des
// octets embarqués. C'est le sceau qui permet de comparer la source Go et la
// source lue par TypeScript.
func DestructivePatternsSHA256() string {
	sum := sha256.Sum256(destructivePatternsJSON)
	return hex.EncodeToString(sum[:])
}

// ParseDestructivePatterns analyse un document de motifs (utilisé par les tests
// et par la vérification d'intégrité).
func ParseDestructivePatterns(data []byte) (*DestructivePatterns, error) {
	var p DestructivePatterns
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("exec : motifs illisibles : %w", err)
	}
	if len(p.Patterns) == 0 {
		return nil, fmt.Errorf("exec : aucun motif déclaré")
	}
	seen := make(map[string]struct{}, len(p.Patterns))
	for _, pat := range p.Patterns {
		if pat.ID == "" {
			return nil, fmt.Errorf("exec : motif sans identifiant")
		}
		if _, dup := seen[pat.ID]; dup {
			return nil, fmt.Errorf("exec : identifiant de motif dupliqué %q", pat.ID)
		}
		seen[pat.ID] = struct{}{}
	}
	return &p, nil
}

// LoadDestructivePatterns renvoie le document embarqué (analysé une seule fois).
func LoadDestructivePatterns() (*DestructivePatterns, error) {
	docOnce.Do(func() {
		doc, docErr = ParseDestructivePatterns(destructivePatternsJSON)
	})
	return doc, docErr
}

// compile transforme un motif JSON en `*regexp.Regexp`, en traduisant les
// `flags` en préfixe `(?i)` (RE2 refuse les flags en second argument).
func compile(p DestructivePattern) (*regexp.Regexp, error) {
	expr := p.Regex
	if len(p.Flags) > 0 {
		prefix := ""
		for _, f := range p.Flags {
			switch f {
			case 'i':
				prefix += "i"
			default:
				return nil, fmt.Errorf("exec : motif %q : drapeau inconnu %q", p.ID, string(f))
			}
		}
		expr = "(?" + prefix + ")" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("exec : motif %q : expression invalide : %w", p.ID, err)
	}
	return re, nil
}

// compiledPatterns compile (une seule fois) l'ensemble des motifs embarqués.
func compiledPatterns() ([]compiledPattern, error) {
	compiledOnce.Do(func() {
		document, err := LoadDestructivePatterns()
		if err != nil {
			compiledErr = err
			return
		}
		out := make([]compiledPattern, 0, len(document.Patterns))
		for _, p := range document.Patterns {
			re, err := compile(p)
			if err != nil {
				compiledErr = err
				return
			}
			out = append(out, compiledPattern{id: p.ID, label: p.Label, re: re, rawText: p.Regex})
		}
		compiled = out
	})
	return compiled, compiledErr
}

// Classify évalue une commande contre TOUS les motifs embarqués et renvoie la
// classification correspondante. C'est une fonction PURE (aucun effet de bord,
// aucun accès disque) : le résultat ne dépend que de l'entrée et du fichier
// embarqué.
//
// Sémantique (identique côté TS) : `Destructive` = vrai si AU MOINS un motif
// correspond ; `IDs` liste les motifs correspondants, dans l'ordre du fichier.
func Classify(command string) Match {
	pats, err := compiledPatterns()
	if err != nil {
		// Les motifs sont embarqués à la compilation : une erreur ici est un
		// défaut de build, pas une entrée utilisateur.
		panic(fmt.Sprintf("exec : motifs destructeurs invalides : %v", err))
	}
	ids := make([]string, 0, 2)
	for _, p := range pats {
		if p.re.MatchString(command) {
			ids = append(ids, p.id)
		}
	}
	return Match{Destructive: len(ids) > 0, IDs: ids}
}

// IsDestructive est un raccourci booléen de `Classify`.
func IsDestructive(command string) bool {
	return Classify(command).Destructive
}

// DestructivePatternIDs renvoie les identifiants des motifs, dans l'ordre du
// fichier (utile aux tests croisés et à la journalisation).
func DestructivePatternIDs() []string {
	pats, err := compiledPatterns()
	if err != nil {
		panic(fmt.Sprintf("exec : motifs destructeurs invalides : %v", err))
	}
	ids := make([]string, 0, len(pats))
	for _, p := range pats {
		ids = append(ids, p.id)
	}
	return ids
}
