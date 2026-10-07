package transport

import (
	"math"
	"math/rand/v2"
	"time"
)

// DefaultBaseDelay / DefaultMaxDelay / DefaultJitter : paramètres du backoff de
// reconnexion actés pour l'agent (`1s → 60s` avec jitter). La reconnexion est
// SANS PLAFOND (service permanent) : `Next` continue indéfiniment.
const (
	DefaultBaseDelay = 1 * time.Second
	DefaultMaxDelay  = 60 * time.Second
	DefaultJitter    = 0.5
)

// Backoff produit des délais d'attente exponentiels BORNÉS, avec jitter.
//
// `delay_n = min(Max, Base * Factor^n)`, puis multiplié par un facteur aléatoire
// dans `[1-Jitter, 1+Jitter]`. Le jitter évite que plusieurs agents se
// reconnectent en cadence (effet de troupeau). Le délai ne dépasse jamais
// `Max * (1 + Jitter)`.
//
// ⚠️ Le backoff n'est PAS remis à zéro automatiquement : l'appelant appelle
// `Reset` après une connexion RÉUSSIE.
type Backoff struct {
	Base   time.Duration
	Max    time.Duration
	Factor float64
	Jitter float64
	// Rand : source uniforme dans `[0,1)`. Nil ⇒ `rand.Float64`.
	Rand func() float64

	attempt int
}

// NewBackoff construit un backoff avec les paramètres par défaut de l'agent.
func NewBackoff(base, max time.Duration, jitter float64) *Backoff {
	return &Backoff{Base: base, Max: max, Factor: 2, Jitter: jitter}
}

// Next renvoie le prochain délai et avance l'état interne.
func (b *Backoff) Next() time.Duration {
	base := b.Base
	if base <= 0 {
		base = DefaultBaseDelay
	}
	factor := b.Factor
	if factor < 1 {
		factor = 2
	}
	delay := float64(base) * math.Pow(factor, float64(b.attempt))
	max := b.Max
	if max <= 0 {
		max = DefaultMaxDelay
	}
	if delay > float64(max) {
		delay = float64(max)
	}
	b.attempt++

	jitter := b.Jitter
	if jitter > 0 {
		rnd := b.Rand
		if rnd == nil {
			rnd = rand.Float64
		}
		delta := jitter * delay
		delay = delay - delta + 2*delta*rnd()
	}
	if delay < 0 {
		delay = 0
	}
	return time.Duration(delay)
}

// Reset remet le compteur d'essais à zéro (après un succès).
func (b *Backoff) Reset() { b.attempt = 0 }

// Attempts renvoie le nombre de délais déjà produits.
func (b *Backoff) Attempts() int { return b.attempt }
