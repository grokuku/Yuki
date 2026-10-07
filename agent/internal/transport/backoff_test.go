package transport

import (
	"testing"
	"time"
)

func TestBackoffExponentielBorne(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second, 0) // sans jitter ⇒ déterministe
	want := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		32 * time.Second,
		60 * time.Second,
		60 * time.Second, // plafonné
		60 * time.Second,
	}
	for i, expected := range want {
		if got := b.Next(); got != expected {
			t.Fatalf("essai %d : délai = %s, attendu %s", i, got, expected)
		}
	}
}

func TestBackoffJitterBorne(t *testing.T) {
	// rand = 0 ⇒ délai minimal = base*(1-jitter).
	low := NewBackoff(time.Second, 60*time.Second, 0.5)
	low.Rand = func() float64 { return 0 }
	if got := low.Next(); got != 500*time.Millisecond {
		t.Fatalf("jitter bas : %s, attendu 500ms", got)
	}
	// rand proche de 1 ⇒ délai maximal = base*(1+jitter).
	high := NewBackoff(time.Second, 60*time.Second, 0.5)
	high.Rand = func() float64 { return 1 }
	if got := high.Next(); got != 1500*time.Millisecond {
		t.Fatalf("jitter haut : %s, attendu 1.5s", got)
	}
}

func TestBackoffSansPlafondDeTentatives(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second, 0.5)
	b.Rand = func() float64 { return 0.5 } // neutre
	max := 60 * time.Second
	for i := 0; i < 50; i++ {
		d := b.Next()
		if d <= 0 {
			t.Fatalf("essai %d : délai non positif (%s)", i, d)
		}
		if d > max {
			t.Fatalf("essai %d : délai %s dépasse le plafond %s", i, d, max)
		}
	}
	if b.Attempts() != 50 {
		t.Fatalf("Attempts = %d", b.Attempts())
	}
	b.Reset()
	if b.Attempts() != 0 {
		t.Fatalf("Reset inopérant : %d", b.Attempts())
	}
}
