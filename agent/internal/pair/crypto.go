package pair

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/grokuku/yuki/agent/internal/proto"
)

const (
	// NonceSize : taille des aléas `agent_nonce` / `yuki_nonce` (32 octets).
	NonceSize = 32
	// KeySize : taille de la clé de session `K` (AES-256).
	KeySize = 32
)

// derivationInfo est l'information de contexte HKDF (séparation de domaine) :
// `K = HKDF-SHA256(secret = C, salt = nonces, info = derivationInfo)`.
const derivationInfo = "yuki-agent-pair-v1"

// domainConcat cadence une concaténation : chaque partie est précédée de sa
// longueur sur 4 octets big-endian. Cela lève toute ambiguïté de découpage
// (cf. en-tête de package).
func domainConcat(parts ...[]byte) []byte {
	var total int
	for _, p := range parts {
		total += 4 + len(p)
	}
	out := make([]byte, 0, total)
	var length [4]byte
	for _, p := range parts {
		binary.BigEndian.PutUint32(length[:], uint32(len(p)))
		out = append(out, length[:]...)
		out = append(out, p...)
	}
	return out
}

// Proof calcule `HMAC-SHA256(C, domainConcat(yukiFP, agentNonce))`.
//
// `code` = matière de clé du code d'appairage (`CodeKey`), `yukiFP` = empreinte
// du CA TELLE QUE RÉCLAMÉE par l'agent (peut être vide au premier contact),
// `agentNonce` = aléa de 32 octets.
func Proof(code, yukiFP, agentNonce []byte) []byte {
	mac := hmac.New(sha256.New, code)
	mac.Write(domainConcat(yukiFP, agentNonce))
	return mac.Sum(nil)
}

// VerifyProof vérifie `proof` à temps constant (`hmac.Equal`).
func VerifyProof(code, yukiFP, agentNonce, proof []byte) bool {
	expected := Proof(code, yukiFP, agentNonce)
	return hmac.Equal(expected, proof)
}

// DeriveKey dérive `K = HKDF-SHA256(secret = C, salt = domainConcat(agentNonce,
// yukiNonce), info = "yuki-agent-pair-v1", 32)`.
func DeriveKey(code, agentNonce, yukiNonce []byte) ([]byte, error) {
	if len(code) == 0 {
		return nil, fmt.Errorf("pair: matière de code vide")
	}
	salt := domainConcat(agentNonce, yukiNonce)
	key, err := hkdf.Key(sha256.New, code, salt, derivationInfo, KeySize)
	if err != nil {
		return nil, fmt.Errorf("pair: dérivation HKDF : %w", err)
	}
	return key, nil
}

// sealAAD construit les données authentifiées additionnelles (AAD) du blob
// `pair_ok` : la concaténation cadencée des deux aléas. Elles lient le
// chiffrement à CET échange précis.
func sealAAD(agentNonce, yukiNonce []byte) []byte {
	return domainConcat(agentNonce, yukiNonce)
}

// Seal chiffre `plaintext` en AES-256-GCM sous `key` et renvoie
// `nonce || ciphertext || tag` (le nonce GCM, 12 octets, est tiré au hasard).
func Seal(key, plaintext, aad []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("pair: tirage du nonce GCM : %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

// Open déchiffre et authentifie un blob produit par `Seal`. Toute altération
// (bit modifié, clé fausse, AAD différente) échoue.
func Open(key, sealed, aad []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, proto.NewError(proto.CodeDecryptFailed, "blob trop court")
	}
	nonce, ciphertext := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, proto.NewError(proto.CodeDecryptFailed, "déchiffrement/authentification échoué")
	}
	return plaintext, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("pair: clé de %d octets (attendu %d)", len(key), KeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("pair: chiffrement AES : %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("pair: mode GCM : %w", err)
	}
	return gcm, nil
}

// randomBytes tire `n` octets depuis `r` (crypto/rand.Reader si `r` est nil).
func randomBytes(r io.Reader, n int) ([]byte, error) {
	if r == nil {
		r = rand.Reader
	}
	out := make([]byte, n)
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, fmt.Errorf("pair: lecture aléatoire : %w", err)
	}
	return out, nil
}
