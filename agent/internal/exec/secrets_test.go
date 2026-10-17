//go:build linux

package exec

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	osexec "os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestExtractSecretReferences vérifie le motif EXACT (miroir de
// `src/secrets/references.ts`) : seules les variables au préfixe RÉSERVÉ sont
// reconnues, dans l'ordre de première apparition et sans doublon.
func TestExtractSecretReferences(t *testing.T) {
	cases := []struct {
		name    string
		command string
		want    []string
	}{
		{"aucune", "echo bonjour", nil},
		{"variable ordinaire ignorée", "echo $PATH $HOME", nil},
		{"positionnels ignorés", "echo $1 $? $@ ${2}", nil},
		{"forme courte", "sshpass -p $YUKI_SECRET_NAS ssh h", []string{"YUKI_SECRET_NAS"}},
		{"forme accolades", "sshpass -p ${YUKI_SECRET_NAS} ssh h", []string{"YUKI_SECRET_NAS"}},
		{
			"mélange et doublon",
			"echo $PATH $YUKI_SECRET_A ${YUKI_SECRET_B} $YUKI_SECRET_A",
			[]string{"YUKI_SECRET_A", "YUKI_SECRET_B"},
		},
		{"préfixe incomplet", "echo $YUKI_SECRET", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractSecretReferences(tc.command)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ExtractSecretReferences(%q) = %v, attendu %v", tc.command, got, tc.want)
			}
		})
	}
}

// TestMissingSecretEnv vérifie qu'une valeur ABSENTE **ou VIDE** est refusée :
// une valeur vide est le cas dangereux (le shell la développerait en chaîne
// vide).
func TestMissingSecretEnv(t *testing.T) {
	cases := []struct {
		name    string
		command string
		overlay map[string]string
		want    []string
	}{
		{"overlay nil", "echo $YUKI_SECRET_A", nil, []string{"YUKI_SECRET_A"}},
		{"overlay vide", "echo $YUKI_SECRET_A", map[string]string{}, []string{"YUKI_SECRET_A"}},
		{
			"valeur vide traitée comme absente",
			"echo $YUKI_SECRET_A",
			map[string]string{"YUKI_SECRET_A": ""},
			[]string{"YUKI_SECRET_A"},
		},
		{
			"fournie ⇒ rien de manquant",
			"echo $YUKI_SECRET_A",
			map[string]string{"YUKI_SECRET_A": "v"},
			nil,
		},
		{
			"seule la manquante est listée",
			"echo $YUKI_SECRET_A $YUKI_SECRET_B",
			map[string]string{"YUKI_SECRET_A": "v"},
			[]string{"YUKI_SECRET_B"},
		},
		{"sans référence ⇒ rien", "echo $PATH", nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MissingSecretEnv(tc.command, tc.overlay)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("MissingSecretEnv(%q) = %v, attendu %v", tc.command, got, tc.want)
			}
		})
	}
}

// TestRunRefuseSecretManquant prouve le REFUS SÉCURISÉ de bout en bout :
//   - `Run` renvoie `ErrSecretEnvMissing` (jamais un résultat d'exécution) ;
//   - AUCUN processus n'est lancé — prouvé par un EFFET DE BORD OBSERVABLE : la
//     commande créerait un fichier AVANT d'utiliser la variable ; le fichier
//     NE DOIT PAS exister.
//
// ⚠️ C'est LE test du risque le plus grave : `rm -rf /$YUKI_SECRET_DIR`
// deviendrait `rm -rf /` si l'on exécutait avec une variable vide.
func TestRunRefuseSecretManquant(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "execute.txt")
	// Le `touch` est en TÊTE : s'il s'exécutait, la preuve serait là.
	command := "touch " + marker + "; echo $YUKI_SECRET_DIR"

	runner := New(Options{})
	res, err := runner.Run(context.Background(), Request{ID: "refus", Command: command})
	if err == nil {
		t.Fatalf("Run a exécuté une commande à secret vide : res=%+v", res)
	}
	if !errors.Is(err, ErrSecretEnvMissing) {
		t.Fatalf("erreur = %v, attendu ErrSecretEnvMissing", err)
	}
	if res != nil {
		t.Fatalf("résultat non nil pour un refus : %+v", res)
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatal("la commande a été EXÉCUTÉE malgré le refus (fichier créé)")
	}
}

// TestRunRefuseValeurVide prouve que la garde couvre aussi le cas « clé
// présente mais valeur vide » (le pire cas : le shell la développe en vide).
func TestRunRefuseValeurVide(t *testing.T) {
	_, err := New(Options{}).Run(context.Background(), Request{
		Command:    "echo $YUKI_SECRET_DIR",
		EnvOverlay: map[string]string{"YUKI_SECRET_DIR": ""},
	})
	if !errors.Is(err, ErrSecretEnvMissing) {
		t.Fatalf("erreur = %v, attendu ErrSecretEnvMissing", err)
	}
}

// TestRunSansReferenceNonConcerne vérifie qu'une commande ORDINAIRE (aucune
// variable réservée) n'est jamais impactée par la garde.
func TestRunSansReferenceNonConcerne(t *testing.T) {
	res, err := New(Options{}).Run(context.Background(), Request{
		Command:    "echo $PATH >/dev/null; echo ok",
		EnvOverlay: nil,
	})
	if err != nil {
		t.Fatalf("Run : %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("ExitCode = %d", res.ExitCode)
	}
}

// legacyCmd reproduit le type `Cmd` d'un agent ANTÉRIEUR au support de
// l'environnement : le champ `env` N'EXISTE PAS dans sa définition.
type legacyCmd struct {
	Type         string `json:"type"`
	ProtoVersion int    `json:"proto_version"`
	CmdID        string `json:"cmd_id"`
	Command      string `json:"command"`
}

// TestAncienBinaireIgnoreEnvEnSilence REPRODUIT le problème signalé, en trois
// temps :
//
//	① un binaire ANCIEN accepte la trame sans la moindre erreur — `encoding/json`
//	   ignore les champs inconnus, donc `env` est perdu EN SILENCE ;
//	② conséquence prouvée par une exécution shell RÉELLE : la variable réservée
//	   se développe en CHAÎNE VIDE (le cas dangereux) ;
//	③ le binaire ACTUEL refuse cette même trame (`ErrSecretEnvMissing`).
func TestAncienBinaireIgnoreEnvEnSilence(t *testing.T) {
	raw := []byte(`{"type":"cmd","proto_version":1,"cmd_id":"c-legacy",` +
		`"command":"printf '%s|' \"$YUKI_SECRET_DIR\"",` +
		`"env":{"YUKI_SECRET_DIR":"/sauvegardes"}}`)

	// ① Décodage par le type ANCIEN : aucune erreur, aucune trace d'`env`.
	var legacy legacyCmd
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatalf("un binaire ancien REJETTERAIT la trame (%v) — or il l'ignore", err)
	}
	if legacy.CmdID != "c-legacy" || legacy.Command == "" {
		t.Fatalf("trame illisible par le type ancien : %+v", legacy)
	}

	// ② Conséquence : sans la variable, le shell écrit du VIDE.
	out, err := osexec.Command("/bin/sh", "-c", legacy.Command).Output()
	if err != nil {
		t.Fatalf("exécution de démonstration : %v", err)
	}
	if strings.TrimSpace(string(out)) != "|" {
		t.Fatalf("démonstration inattendue : stdout = %q", string(out))
	}

	// ③ Le binaire actuel REFUSE la même trame, sans rien lancer.
	_, err = New(Options{}).Run(context.Background(), Request{
		ID:      legacy.CmdID,
		Command: legacy.Command,
	})
	if !errors.Is(err, ErrSecretEnvMissing) {
		t.Fatalf("erreur = %v, attendu ErrSecretEnvMissing", err)
	}
}
