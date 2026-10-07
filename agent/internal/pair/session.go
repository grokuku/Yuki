package pair

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/grokuku/yuki/agent/internal/proto"
)

const (
	// DefaultTTL : durée de vie d'un code d'appairage.
	DefaultTTL = 10 * time.Minute
	// DefaultMaxAttempts : nombre de tentatives avant invalidation du code.
	DefaultMaxAttempts = 5
)

// Options règle le comportement des sessions et des clients d'appairage.
// Les zéros prennent des valeurs sûres (TTL 10 min, 5 tentatives, `time.Now`,
// `crypto/rand.Reader`).
type Options struct {
	TTL         time.Duration
	MaxAttempts int
	Now         func() time.Time
	Rand        io.Reader
}

func (o Options) withDefaults() Options {
	if o.TTL <= 0 {
		o.TTL = DefaultTTL
	}
	if o.MaxAttempts <= 0 {
		o.MaxAttempts = DefaultMaxAttempts
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Rand == nil {
		o.Rand = rand.Reader
	}
	return o
}

// Session porte le cycle de vie d'UN code d'appairage, côté Yuki.
//
// Un code est : à durée de vie limitée, à USAGE UNIQUE, limité à `MaxAttempts`
// tentatives, et protégé du rejeu (un même `agent_nonce` ne peut être traité
// deux fois).
//
// `Session` est sûre en accès concurrent (`sync.Mutex`).
type Session struct {
	mu          sync.Mutex
	display     string
	key         []byte
	createdAt   time.Time
	expiresAt   time.Time
	maxAttempts int
	attempts    int
	used        bool
	invalidated bool
	seen        map[string]struct{}
	now         func() time.Time
	rnd         io.Reader
}

// NewSession crée une session à partir d'un code (forme libre ou canonique).
func NewSession(code string, opts Options) (*Session, error) {
	opts = opts.withDefaults()
	canonical, err := NormalizeCode(code)
	if err != nil {
		return nil, err
	}
	key, err := CodeKey(canonical)
	if err != nil {
		return nil, err
	}
	now := opts.Now()
	return &Session{
		display:     canonical,
		key:         key,
		createdAt:   now,
		expiresAt:   now.Add(opts.TTL),
		maxAttempts: opts.MaxAttempts,
		seen:        make(map[string]struct{}),
		now:         opts.Now,
		rnd:         opts.Rand,
	}, nil
}

// Display renvoie le code sous forme canonique `XXXX-XXXX-XXXX`.
func (s *Session) Display() string { return s.display }

// ExpiresAt est l'instant d'expiration du code.
func (s *Session) ExpiresAt() time.Time { return s.expiresAt }

// Attempts est le nombre de tentatives (échecs) consommées.
func (s *Session) Attempts() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attempts
}

// Used indique que le code a été consommé par un appairage réussi.
func (s *Session) Used() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.used
}

// Invalidated indique que le code a été invalidé (trop de tentatives).
func (s *Session) Invalidated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.invalidated
}

// Expired indique que le code est périmé à l'instant présent.
func (s *Session) Expired() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now().After(s.expiresAt)
}

// Authorize vérifie une `pair_begin` et, si elle est valide, produit un
// `pair_ok` chiffré prêt à être renvoyé à l'agent.
//
// `material` porte le CA, le certificat client, la clé client et l'identifiant
// (générés par Yuki). Seul le détenteur de `C` peut produire une `pair_begin`
// dont la preuve passe.
//
// Erreurs typées (`proto.CodeOf`) :
//   - `CodeMalformedMessage` : `agent_nonce` absent ou de taille incorrecte ;
//   - `CodeReplay` : `agent_nonce` déjà vu sur cette session ;
//   - `CodeCodeUsed` : code déjà consommé ;
//   - `CodeRateLimited` : code invalidé (trop de tentatives) ;
//   - `CodeCodeExpired` : code périmé ;
//   - `CodeProofInvalid` : preuve HMAC fausse (mauvais code `C`).
func (s *Session) Authorize(req *proto.PairBegin, material *Payload) (*proto.PairOK, error) {
	if req == nil {
		return nil, proto.NewError(proto.CodeMalformedMessage, "pair_begin absente")
	}
	if material == nil {
		return nil, proto.NewError(proto.CodeInternal, "matériel d'appairage manquant")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(req.AgentNonce) != NonceSize {
		s.registerFailure()
		return nil, proto.NewError(
			proto.CodeMalformedMessage,
			"agent_nonce de taille invalide (32 octets attendus)",
		)
	}

	nonceHex := hex.EncodeToString(req.AgentNonce)
	if _, dup := s.seen[nonceHex]; dup {
		return nil, proto.NewError(proto.CodeReplay, "pair_begin déjà reçue (nonce agent rejoué)")
	}
	s.seen[nonceHex] = struct{}{}

	if s.used {
		return nil, proto.NewError(proto.CodeCodeUsed, "code déjà utilisé (usage unique)")
	}
	if s.invalidated {
		return nil, proto.NewError(proto.CodeRateLimited, "code invalidé (trop de tentatives)")
	}
	if s.now().After(s.expiresAt) {
		return nil, proto.NewError(proto.CodeCodeExpired, "code d'appairage périmé")
	}
	if s.attempts >= s.maxAttempts {
		s.invalidated = true
		return nil, proto.NewError(proto.CodeRateLimited, "code invalidé (trop de tentatives)")
	}

	if !VerifyProof(s.key, []byte(req.YukiFPClaimed), req.AgentNonce, req.Proof) {
		s.registerFailure()
		return nil, proto.NewError(proto.CodeProofInvalid, "preuve HMAC invalide")
	}

	yukiNonce, err := randomBytes(s.rnd, NonceSize)
	if err != nil {
		return nil, err
	}
	key, err := DeriveKey(s.key, req.AgentNonce, yukiNonce)
	if err != nil {
		return nil, err
	}
	plaintext, err := material.Marshal()
	if err != nil {
		return nil, err
	}
	blob, err := Seal(key, plaintext, sealAAD(req.AgentNonce, yukiNonce))
	if err != nil {
		return nil, err
	}

	s.used = true
	return &proto.PairOK{YukiNonce: yukiNonce, Blob: blob}, nil
}

// registerFailure comptabilise un échec et invalide le code au terme des
// tentatives autorisées. À appeler sous verrou.
func (s *Session) registerFailure() {
	s.attempts++
	if s.attempts >= s.maxAttempts {
		s.invalidated = true
	}
}

// Client est le pendant AGENT de l'appairage : il détient `C`, produit la
// `pair_begin` et déchiffre la `pair_ok` reçue.
type Client struct {
	key        []byte
	display    string
	agentNonce []byte
	pubkey     []byte
	priv       *ecdh.PrivateKey
}

// NewClient crée un client d'appairage. Un couple ECDH P-256 est généré pour
// renseigner `agent_pubkey` sur le fil (réservé à une évolution à secret
// direct : la clé `K` de CE lot est dérivée de `C` et des aléas, pas du ECDH).
func NewClient(code string, opts Options) (*Client, error) {
	opts = opts.withDefaults()
	canonical, err := NormalizeCode(code)
	if err != nil {
		return nil, err
	}
	key, err := CodeKey(canonical)
	if err != nil {
		return nil, err
	}
	nonce, err := randomBytes(opts.Rand, NonceSize)
	if err != nil {
		return nil, err
	}
	priv, err := ecdh.P256().GenerateKey(opts.Rand)
	if err != nil {
		return nil, proto.NewError(proto.CodeInternal, "génération de la clé ECDH impossible")
	}
	return &Client{
		key:        key,
		display:    canonical,
		agentNonce: nonce,
		pubkey:     priv.PublicKey().Bytes(),
		priv:       priv,
	}, nil
}

// Display est la forme canonique du code.
func (c *Client) Display() string { return c.display }

// AgentNonce est l'aléa agent courant (32 octets).
func (c *Client) AgentNonce() []byte { return append([]byte(nil), c.agentNonce...) }

// Begin construit la `pair_begin` à envoyer à Yuki.
//
// `yukiFPClaimed` est l'empreinte du CA que l'agent croit être celui de Yuki
// (chaîne vide au tout premier contact).
func (c *Client) Begin(yukiFPClaimed string) *proto.PairBegin {
	return &proto.PairBegin{
		AgentNonce:    append([]byte(nil), c.agentNonce...),
		AgentPubkey:   append([]byte(nil), c.pubkey...),
		YukiFPClaimed: yukiFPClaimed,
		Proof:         Proof(c.key, []byte(yukiFPClaimed), c.agentNonce),
	}
}

// Accept déchiffre la `pair_ok` reçue et renvoie le contenu d'appairage.
//
// Refuse une `pair_ok` qui ne correspond pas à la `pair_begin` émise (aléa
// différent) ou dont le CA ne correspond pas à l'empreinte revendiquée.
func (c *Client) Accept(pb *proto.PairBegin, ok *proto.PairOK) (*Payload, error) {
	if pb == nil || ok == nil {
		return nil, proto.NewError(proto.CodeMalformedMessage, "pair_begin ou pair_ok absente")
	}
	if len(ok.YukiNonce) != NonceSize {
		return nil, proto.NewError(proto.CodeDecryptFailed, "yuki_nonce de taille invalide")
	}
	if !strings.EqualFold(hex.EncodeToString(pb.AgentNonce), hex.EncodeToString(c.agentNonce)) {
		return nil, proto.NewError(proto.CodeMalformedMessage, "pair_ok pour un autre agent_nonce")
	}
	key, err := DeriveKey(c.key, pb.AgentNonce, ok.YukiNonce)
	if err != nil {
		return nil, err
	}
	plaintext, err := Open(key, ok.Blob, sealAAD(pb.AgentNonce, ok.YukiNonce))
	if err != nil {
		return nil, err
	}
	payload, err := ParsePayload(plaintext)
	if err != nil {
		return nil, err
	}
	if pb.YukiFPClaimed != "" && !strings.EqualFold(payload.CAFingerprint, pb.YukiFPClaimed) {
		return nil, proto.NewError(
			proto.CodeDecryptFailed,
			"le CA reçu ne correspond pas à l'empreinte revendiquée",
		)
	}
	return payload, nil
}
