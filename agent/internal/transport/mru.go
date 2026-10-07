package transport

import "sync"

// DefaultDedupeLimit : taille de la mémoire MRU des identifiants de commande
// (actée : 1024). Un identifiant déjà vu est un REJEU et la commande est
// ignorée (idempotence) — aucune seconde exécution.
const DefaultDedupeLimit = 1024

// MRU est un ensemble « Most Recently Used » borné : au plus `limit`
// identifiants. Il sert à ignorer un rejeu de commande sans mémoriser
// indéfiniment.
//
// ⚠️ Au-delà de `limit` identifiants, le plus ANCIEN est oublié : un rejeu très
// tardif (après 1024 commandes) n'est plus détecté. C'est le compromis acté.
type MRU struct {
	mu    sync.Mutex
	limit int
	items []string
	set   map[string]struct{}
	next  int
}

// NewMRU construit un MRU de taille `limit` (`<= 0` ⇒ `DefaultDedupeLimit`).
func NewMRU(limit int) *MRU {
	if limit <= 0 {
		limit = DefaultDedupeLimit
	}
	return &MRU{
		limit: limit,
		items: make([]string, 0, limit),
		set:   make(map[string]struct{}, limit),
	}
}

// Observe enregistre `id`. Renvoie `true` si `id` était DÉJÀ présent (rejeu) —
// auquel cas il n'est pas ré-enregistré. Un identifiant vide est ignoré (jamais
// « rejeu »).
func (m *MRU) Observe(id string) bool {
	if id == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.set[id]; ok {
		return true
	}
	if len(m.items) < m.limit {
		m.items = append(m.items, id)
	} else {
		evicted := m.items[m.next]
		delete(m.set, evicted)
		m.items[m.next] = id
		m.next = (m.next + 1) % m.limit
	}
	m.set[id] = struct{}{}
	return false
}

// Contains indique si `id` est encore mémorisé.
func (m *MRU) Contains(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.set[id]
	return ok
}

// Len renvoie le nombre d'identifiants mémorisés.
func (m *MRU) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.items)
}
