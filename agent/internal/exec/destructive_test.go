package exec

import (
	"reflect"
	"testing"
)

// TestDocumentEmbarqueValide vérifie que la source embarquée est cohérente :
// version renseignée, identifiants uniques, motifs compilables.
func TestDocumentEmbarqueValide(t *testing.T) {
	doc, err := ParseDestructivePatterns(DestructivePatternsJSON())
	if err != nil {
		t.Fatalf("motifs embarqués invalides : %v", err)
	}
	if doc.Version <= 0 {
		t.Fatalf("version de motifs absente : %d", doc.Version)
	}
	if len(doc.Patterns) < 8 {
		t.Fatalf("trop peu de motifs : %d", len(doc.Patterns))
	}
	if _, err := compiledPatterns(); err != nil {
		t.Fatalf("compilation des motifs : %v", err)
	}
	if DestructivePatternsSHA256() == "" {
		t.Fatal("empreinte des motifs vide")
	}
	// L'empreinte doit être stable (mêmes octets ⇒ même empreinte).
	if DestructivePatternsSHA256() != DestructivePatternsSHA256() {
		t.Fatal("empreinte instable")
	}
	// La copie exposée ne doit pas être modifiable depuis l'extérieur.
	a := DestructivePatternsJSON()
	a[0] = 'X'
	if b := DestructivePatternsJSON(); b[0] == 'X' {
		t.Fatal("DestructivePatternsJSON expose les octets internes")
	}
}

func TestParseDestructivePatternsRejette(t *testing.T) {
	cases := map[string]string{
		"json invalide": "{",
		"aucun motif":   `{"version":1,"patterns":[]}`,
		"id manquant":   `{"version":1,"patterns":[{"regex":"x"}]}`,
		"id dupliqué":   `{"version":1,"patterns":[{"id":"a","regex":"x"},{"id":"a","regex":"y"}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseDestructivePatterns([]byte(raw)); err == nil {
				t.Fatalf("document accepté à tort : %s", raw)
			}
		})
	}
}

// TestClassifyBatterie couvre des commandes DESTRUCTRICES et des commandes
// ANODINES (faux positifs à éviter), avec les identifiants attendus.
func TestClassifyBatterie(t *testing.T) {
	cases := []struct {
		command string
		ids     []string
	}{
		// Destructrices.
		{"rm -rf /tmp/x", []string{"rm"}},
		{"sudo rm -rf /", []string{"rm"}},
		{"cd /tmp && rm -rf build", []string{"rm"}},
		{"dd if=/dev/zero of=/dev/sda bs=1M", []string{"dd"}},
		{"mkfs.ext4 /dev/sdb1", []string{"mkfs"}},
		{"sudo mkfs /dev/sdc", []string{"mkfs"}},
		{"shutdown -h now", []string{"shutdown"}},
		{"sudo reboot", []string{"shutdown"}},
		{"systemctl stop nginx", []string{"systemctl"}},
		{"systemctl disable foo", []string{"systemctl"}},
		{"systemctl mask foo", []string{"systemctl"}},
		{"echo hi > /etc/passwd", []string{"redirect-system"}},
		{"echo hi >> /boot/x", []string{"redirect-system"}},
		{"chmod 777 /etc/passwd", []string{"chmod-system"}},
		{"docker compose down", []string{"docker"}},
		{"docker rm -f abc", []string{"docker"}},
		{"docker volume rm x", []string{"docker"}},
		{":(){ :|:& };:", []string{"fork-bomb"}},
		{"shred -u /dev/sda", []string{"wipe"}},
		{"echo x > /dev/sda", []string{"raw-device"}},
		{"git reset --hard HEAD~1", []string{"git-destructive"}},
		{"git push --force origin main", []string{"git-destructive"}},
		{"mkswap /dev/sdb1", []string{"swap"}},
		{"swapoff -a", []string{"swap"}},
		// Anodines (aucun motif).
		{"ls -la", nil},
		{"echo bonjour", nil},
		{"cat /tmp/x", nil},
		{"grep rm fichier.txt", nil},
		{`echo "rm -rf /"`, nil},
		{"echo ok > /tmp/x", nil},
		{"docker ps", nil},
		{"git status", nil},
		{"pwd", nil},
		{"sudo ls /etc", nil},
		{"command -v rm", nil},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.command, func(t *testing.T) {
			got := Classify(tc.command)
			want := tc.ids
			if want == nil {
				want = []string{}
			}
			if !reflect.DeepEqual(got.IDs, want) {
				t.Fatalf("Classify(%q) = %v, attendu %v", tc.command, got.IDs, want)
			}
			if got.Destructive != (len(want) > 0) {
				t.Fatalf("Classify(%q).Destructive = %v", tc.command, got.Destructive)
			}
			if IsDestructive(tc.command) != got.Destructive {
				t.Fatalf("IsDestructive(%q) incohérent", tc.command)
			}
		})
	}
}

// TestClassifyPurSansEffetDeBord : appeler deux fois la même entrée donne le
// même résultat, et l'ordre des identifiants suit le fichier.
func TestClassifyPurSansEffetDeBord(t *testing.T) {
	first := Classify("rm -rf / && reboot")
	second := Classify("rm -rf / && reboot")
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("Classify non déterministe : %v vs %v", first, second)
	}
	if len(first.IDs) < 2 {
		t.Fatalf("attendu plusieurs motifs sur une commande composée, obtenu %v", first.IDs)
	}
	// L'ordre suit le fichier : `rm` (index 0) avant `shutdown` (index 3).
	if first.IDs[0] != "rm" {
		t.Fatalf("ordre des identifiants inattendu : %v", first.IDs)
	}
}
