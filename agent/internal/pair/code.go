// Package pair implémente le cœur cryptographique de l'appairage Yuki ↔ agent
// (Lot 4, décision D119 : preuve de possession par code).
//
// # Le code d'appairage `C`
//
//   - 12 caractères dans l'alphabet Crockford base32 « sans ambiguïté »
//     (`23456789ABCDEFGHJKMNPQRSTVWXYZ`), format d'affichage `XXXX-XXXX-XXXX` ;
//   - durée de vie 10 minutes ; usage unique ; 5 tentatives puis invalidation.
//
// ⚠️ L'alphabet fourni comporte 30 symboles (Crockford base32 amputé de `0`,
// `1`, `I`, `L`, `O`, `U`). L'espace des codes est donc de 30¹² ≈ 2^58,9, soit
// une entropie de ~58,9 bits — la spec annonce « ~60 bits », écart assumé : le
// tirage est UNIFORME et sans biais (`crypto/rand.Int` sur [0, 30¹²)).
//
// # L'échange (bootstrap de confiance)
//
// Au premier contact, l'agent ne peut rien épingler (il ne connaît pas encore
// le CA de Yuki) : la confiance s'ancre donc au niveau APPLICATIF via `C`.
//
//  1. Agent → `pair_begin { agent_nonce, agent_pubkey, yuki_fp_claimed, proof }`
//     avec `proof = HMAC-SHA256(C, yuki_fp_claimed ‖ agent_nonce)`.
//  2. Yuki (qui détient `C`, saisi par l'utilisateur) VÉRIFIE `proof`
//     ⇒ authentifie l'agent.
//  3. Yuki → `pair_ok { yuki_nonce, blob }` où `blob` est chiffré sous
//     `K = HKDF-SHA256(C, agent_nonce ‖ yuki_nonce)` (AES-256-GCM) et contient
//     `{ ca_cert, client_cert, client_key, agent_id, ca_fingerprint }`.
//     L'agent DÉCHIFFRE ⇒ authentifie Yuki (seul un détenteur de `C` peut
//     produire ce blob) puis épingle le CA obtenu.
//
// # Primitives
//
// Toutes les primitives proviennent de la bibliothèque standard : `crypto/hmac`,
// `crypto/sha256`, `crypto/hkdf`, `crypto/aes`, `crypto/cipher`, `crypto/rand`.
// Aucune primitive n'est réimplémentée à la main.
//
// # Encodage canonique des concaténations (⚠️ précision)
//
// Le protocole s'écrit `HMAC(C, yuki_fp_claimed ‖ agent_nonce)` et
// `HKDF(C, agent_nonce ‖ yuki_nonce)`. Une concaténation nue est AMBIGUË
// (deux découpages différents peuvent produire la même suite d'octets). Cet
// encodage est donc durci par un cadrage de longueur : chaque partie est
// préfixée par sa longueur sur 4 octets big-endian (`domainConcat`). Yuki et
// l'agent DOIVENT employer ce cadrage identique.
package pair

import (
	"crypto/rand"
	"fmt"
	"io"
	"math/big"
	"strings"

	"github.com/grokuku/yuki/agent/internal/proto"
)

// Alphabet est l'alphabet Crockford base32 « sans ambiguïté » : il EXCLUT les
// caractères ambigus que sont `0`, `1`, `I`, `L`, `O` et `U`. Une saisie
// contenant l'un d'eux est REJETÉE (aucune normalisation permissive).
//
// ⚠️ 30 symboles (et non 32) : voir l'en-tête du package.
const Alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

const (
	// CodeLength : nombre de caractères significatifs du code.
	CodeLength = 12
	// CodeBits : entropie NOMINALE visée par la spec (« ~60 bits »).
	// Entropie RÉELLE avec cet alphabet : 12 × log2(30) ≈ 58,9 bits.
	CodeBits = 60
	// CodeBytes : taille de la matière de clé dérivée du code (arrondi à 8 octets).
	CodeBytes = 8
)

// invalidCode construit l'erreur de format de code.
func invalidCode(format string, args ...any) error {
	return proto.NewError(proto.CodeInvalidCode, fmt.Sprintf(format, args...))
}

// codeSpace est le nombre de codes possibles : len(Alphabet)^CodeLength.
func codeSpace() *big.Int {
	return new(big.Int).Exp(
		big.NewInt(int64(len(Alphabet))),
		big.NewInt(int64(CodeLength)),
		nil,
	)
}

// GenerateCode tire un code d'appairage UNIFORMÉMENT depuis `r` et renvoie sa
// forme d'affichage canonique `XXXX-XXXX-XXXX`.
//
// Le tirage passe par `crypto/rand.Int` (rejet, sans biais modulo) sur
// l'intervalle [0, 30¹²).
//
// `r` DOIT être une source cryptographiquement sûre (`crypto/rand.Reader`).
// Passer un lecteur prévisible (tests) rend le code déterministe.
func GenerateCode(r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	value, err := rand.Int(r, codeSpace())
	if err != nil {
		return "", fmt.Errorf("pair: lecture aléatoire : %w", err)
	}
	return formatCode(encodeBase30(value)), nil
}

// NormalizeCode valide une saisie utilisateur et renvoie sa forme canonique
// `XXXX-XXXX-XXXX`.
//
// Tolérance : casse libre et séparateurs `-`/espace/tabulation. Rejet : tout
// caractère hors alphabet (notamment les ambigus `0`, `1`, `I`, `L`, `O`, `U`)
// et toute longueur autre que 12.
func NormalizeCode(input string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(input)) {
		switch r {
		case '-', ' ', '\t', '\r', '\n':
			continue
		}
		if !strings.ContainsRune(Alphabet, r) {
			return "", invalidCode("caractère invalide %q (alphabet Crockford : %s)", r, Alphabet)
		}
		b.WriteRune(r)
	}
	raw := b.String()
	if len(raw) != CodeLength {
		return "", invalidCode("longueur invalide : %d caractères (attendu %d)", len(raw), CodeLength)
	}
	return formatCode(raw), nil
}

// CodeKey décode un code (forme libre ou canonique) en `CodeBytes` octets de
// matière de clé (valeur en big-endian, octets de poids faible nuls).
//
// C'est cette valeur — et non la chaîne d'affichage — qui sert de clé à
// `Proof` et à `DeriveKey`.
func CodeKey(code string) ([]byte, error) {
	canonical, err := NormalizeCode(code)
	if err != nil {
		return nil, err
	}
	raw := strings.ReplaceAll(canonical, "-", "")
	base := big.NewInt(int64(len(Alphabet)))
	value := new(big.Int)
	for i := 0; i < len(raw); i++ {
		index := strings.IndexByte(Alphabet, raw[i])
		value.Mul(value, base)
		value.Add(value, big.NewInt(int64(index)))
	}
	out := make([]byte, CodeBytes)
	bytes := value.Bytes()
	copy(out[CodeBytes-len(bytes):], bytes)
	return out, nil
}

// formatCode insère les tirets d'affichage. `raw` fait exactement 12 caractères.
func formatCode(raw string) string {
	return raw[0:4] + "-" + raw[4:8] + "-" + raw[8:12]
}

// encodeBase30 encode `value` (dans [0, 30¹²)) en 12 caractères, du poids fort
// au poids faible.
func encodeBase30(value *big.Int) string {
	base := big.NewInt(int64(len(Alphabet)))
	remainder := new(big.Int)
	current := new(big.Int).Set(value)
	var out [CodeLength]byte
	for i := CodeLength - 1; i >= 0; i-- {
		remainder.Mod(current, base)
		out[i] = Alphabet[remainder.Int64()]
		current.Div(current, base)
	}
	return string(out[:])
}
