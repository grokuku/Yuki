package transport

import (
	"strconv"
	"testing"
)

func TestMRURejeuEtEviction(t *testing.T) {
	m := NewMRU(3)
	for _, id := range []string{"a", "b", "c"} {
		if m.Observe(id) {
			t.Fatalf("%q signalé comme rejeu à la première vue", id)
		}
	}
	if !m.Observe("a") {
		t.Fatal("rejeu de a non détecté")
	}
	if m.Len() != 3 {
		t.Fatalf("Len = %d", m.Len())
	}
	// `d` évince le plus ancien (`a`).
	if m.Observe("d") {
		t.Fatal("d signalé comme rejeu")
	}
	if m.Contains("a") {
		t.Fatal("le plus ancien (a) aurait dû être évincé")
	}
	if m.Observe("a") {
		t.Fatal("a re-observé devrait être neuf après éviction")
	}
}

func TestMRUIdentifiantVide(t *testing.T) {
	m := NewMRU(2)
	if m.Observe("") || m.Observe("") {
		t.Fatal("un identifiant vide ne doit jamais être « rejeu »")
	}
	if m.Len() != 0 {
		t.Fatalf("Len = %d", m.Len())
	}
}

func TestMRULimiteParDefaut1024(t *testing.T) {
	m := NewMRU(0)
	if m.limit != DefaultDedupeLimit {
		t.Fatalf("limite = %d, attendu %d", m.limit, DefaultDedupeLimit)
	}
	for i := 0; i < DefaultDedupeLimit; i++ {
		if m.Observe(strconv.Itoa(i)) {
			t.Fatalf("identifiant %d signalé comme rejeu", i)
		}
	}
	if !m.Observe("500") {
		t.Fatal("identifiant récent (500) devrait être un rejeu")
	}
	// Un identifiant de plus évince 0.
	if m.Observe("99999") {
		t.Fatal("nouvel identifiant signalé comme rejeu")
	}
	if m.Contains("0") {
		t.Fatal("0 aurait dû être évincé après 1024 entrées")
	}
	if m.Len() != DefaultDedupeLimit {
		t.Fatalf("Len = %d", m.Len())
	}
}
