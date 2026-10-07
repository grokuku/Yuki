package pair

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math"
	"math/big"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/grokuku/yuki/agent/internal/proto"
)

/* ─── Outils de test ─────────────────────────────────────────────────────── */

var canonicalRe = regexp.MustCompile(`^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$`)

// fakeClock est une horloge contrôlée.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)}
}

// testCAPEM génère un CA ECDSA P-256 de test et renvoie son PEM + son empreinte.
func testCAPEM(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("génération clé CA : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Yuki Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("création certificat CA : %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("relecture certificat CA : %v", err)
	}
	sum := sha256.Sum256(cert.Raw)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return string(pemBytes), hex.EncodeToString(sum[:])
}

// testMaterial construit un contenu d'appairage réaliste (CA de test).
func testMaterial(t *testing.T) *Payload {
	t.Helper()
	caPEM, fp := testCAPEM(t)
	return &Payload{
		CACert:        caPEM,
		ClientCert:    "-----BEGIN CERTIFICATE-----\nMIIB...CLIENT\n-----END CERTIFICATE-----\n",
		ClientKey:     "-----BEGIN PRIVATE KEY-----\nMIIE...KEY\n-----END PRIVATE KEY-----\n",
		AgentID:       "11111111-2222-3333-4444-555555555555",
		CAFingerprint: fp,
	}
}

func errCode(t *testing.T, err error) proto.ErrorCode {
	t.Helper()
	if err == nil {
		t.Fatal("erreur attendue, obtenue nil")
	}
	return proto.CodeOf(err)
}

/* ─── Code d'appairage ───────────────────────────────────────────────────── */

func TestGenerateCodeFormat(t *testing.T) {
	for i := 0; i < 100; i++ {
		code, err := GenerateCode(nil)
		if err != nil {
			t.Fatalf("GenerateCode : %v", err)
		}
		if !canonicalRe.MatchString(code) {
			t.Fatalf("format non canonique : %q", code)
		}
	}
}

func TestGenerateCodeDeterministicReader(t *testing.T) {
	zeros := bytes.NewReader(make([]byte, CodeBytes))
	code, err := GenerateCode(zeros)
	if err != nil {
		t.Fatalf("GenerateCode : %v", err)
	}
	// 60 bits nuls ⇒ tout premier symbole (index 0) de l'alphabet.
	if code != "2222-2222-2222" {
		t.Fatalf("code déterministe attendu 2222-2222-2222, obtenu %q", code)
	}
}

func TestNormalizeCode(t *testing.T) {
	valid := "ABCD-2345-6789"
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"ABCD-2345-6789", valid, false},
		{"abcd 2345 6789", valid, false},
		{"  abcd23456789\t", valid, false},
		{"ABCD23456789", valid, false},
		// Caractères ambigus explicitement rejetés.
		{"ABCD-2345-678O", "", true},
		{"ABCD-2345-6780", "", true},
		{"ABCD-2345-678I", "", true},
		{"ABCD-2345-678L", "", true},
		{"ABCD-2345-678U", "", true},
		{"ABCD-2345-6781", "", true},
		// Longueurs invalides.
		{"ABCD-2345", "", true},
		{"ABCD-2345-6789A", "", true},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := NormalizeCode(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("NormalizeCode(%q) aurait dû échouer, obtenu %q", tc.in, got)
			}
			if proto.CodeOf(err) != proto.CodeInvalidCode {
				t.Fatalf("NormalizeCode(%q) : code %q, attendu %q", tc.in, proto.CodeOf(err), proto.CodeInvalidCode)
			}
			continue
		}
		if err != nil {
			t.Fatalf("NormalizeCode(%q) : %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("NormalizeCode(%q) = %q, attendu %q", tc.in, got, tc.want)
		}
	}
}

func TestCodeKey(t *testing.T) {
	a, err := CodeKey("2222-2222-2222")
	if err != nil {
		t.Fatalf("CodeKey : %v", err)
	}
	if len(a) != CodeBytes || !bytes.Equal(a, make([]byte, CodeBytes)) {
		t.Fatalf("CodeKey du code minimal : %v", a)
	}
	b, _ := CodeKey("2222-2222-2223")
	if bytes.Equal(a, b) {
		t.Fatal("deux codes distincts ne doivent pas donner la même clé")
	}
	// Déterministe et insensible à la casse/aux tirets.
	c, _ := CodeKey("22222222 2223")
	if !bytes.Equal(b, c) {
		t.Fatal("CodeKey doit être déterministe")
	}
	if _, err := CodeKey("nope"); proto.CodeOf(err) != proto.CodeInvalidCode {
		t.Fatalf("CodeKey invalide : %v", err)
	}
}

// TestCodeEntropy : preuve statistique simple de l'entropie du code.
// 20 000 tirages doivent être TOUS distincts, et chaque position doit couvrir
// les 32 symboles de l'alphabet.
func TestCodeEntropy(t *testing.T) {
	const samples = 20000
	seen := make(map[string]struct{}, samples)
	var perPos [CodeLength][len(Alphabet)]int
	for i := 0; i < samples; i++ {
		code, err := GenerateCode(rand.Reader)
		if err != nil {
			t.Fatalf("GenerateCode : %v", err)
		}
		if _, dup := seen[code]; dup {
			t.Fatalf("collision de code après %d tirages (%d bits attendus) : %s", i, CodeBits, code)
		}
		seen[code] = struct{}{}
		raw := strings.ReplaceAll(code, "-", "")
		for pos := 0; pos < CodeLength; pos++ {
			idx := strings.IndexByte(Alphabet, raw[pos])
			if idx < 0 {
				t.Fatalf("symbole hors alphabet : %q", raw[pos])
			}
			perPos[pos][idx]++
		}
	}
	for pos := 0; pos < CodeLength; pos++ {
		for sym := 0; sym < len(Alphabet); sym++ {
			if perPos[pos][sym] == 0 {
				t.Fatalf("position %d : symbole %q jamais tiré (distribution appauvrie)", pos, Alphabet[sym])
			}
		}
	}
}

// TestAlphabetEtEntropie documente l'écart assumé : 30 symboles ⇒ ~58,9 bits.
func TestAlphabetEtEntropie(t *testing.T) {
	if len(Alphabet) != 30 {
		t.Fatalf("alphabet de %d symboles (30 attendus)", len(Alphabet))
	}
	for _, ambiguous := range []byte{'0', '1', 'I', 'L', 'O', 'U'} {
		if strings.IndexByte(Alphabet, ambiguous) >= 0 {
			t.Fatalf("symbole ambigu %q présent dans l'alphabet", ambiguous)
		}
	}
	exact := float64(CodeLength) * math.Log2(float64(len(Alphabet)))
	if math.Abs(exact-58.88) > 0.05 {
		t.Fatalf("entropie exacte inattendue : %.2f bits", exact)
	}
}

/* ─── Preuve, dérivation, chiffrement ────────────────────────────────────── */

func TestProofAndVerify(t *testing.T) {
	code, _ := CodeKey("ABCD-2345-6789")
	nonce := bytes.Repeat([]byte{7}, NonceSize)
	fp := []byte("aabbccdd")

	proof := Proof(code, fp, nonce)
	if len(proof) != sha256.Size {
		t.Fatalf("taille de preuve : %d", len(proof))
	}
	if !VerifyProof(code, fp, nonce, proof) {
		t.Fatal("preuve valide refusée")
	}
	if VerifyProof(code, []byte("other"), nonce, proof) {
		t.Fatal("preuve acceptée avec une empreinte différente")
	}
	if VerifyProof(code, fp, bytes.Repeat([]byte{8}, NonceSize), proof) {
		t.Fatal("preuve acceptée avec un nonce différent")
	}
	other, _ := CodeKey("ABCD-2345-6798")
	if VerifyProof(other, fp, nonce, proof) {
		t.Fatal("preuve acceptée avec un mauvais code")
	}
	tampered := append([]byte(nil), proof...)
	tampered[0] ^= 0x01
	if VerifyProof(code, fp, nonce, tampered) {
		t.Fatal("preuve altérée acceptée")
	}
}

func TestDeriveKey(t *testing.T) {
	code, _ := CodeKey("ABCD-2345-6789")
	an := bytes.Repeat([]byte{1}, NonceSize)
	yn := bytes.Repeat([]byte{2}, NonceSize)

	k1, err := DeriveKey(code, an, yn)
	if err != nil {
		t.Fatalf("DeriveKey : %v", err)
	}
	if len(k1) != KeySize {
		t.Fatalf("taille de clé : %d", len(k1))
	}
	k2, _ := DeriveKey(code, an, yn)
	if !bytes.Equal(k1, k2) {
		t.Fatal("dérivation non déterministe")
	}
	k3, _ := DeriveKey(code, an, bytes.Repeat([]byte{3}, NonceSize))
	if bytes.Equal(k1, k3) {
		t.Fatal("un yuki_nonce différent doit changer la clé")
	}
	other, _ := CodeKey("ABCD-2345-6798")
	k4, _ := DeriveKey(other, an, yn)
	if bytes.Equal(k1, k4) {
		t.Fatal("un code différent doit changer la clé")
	}
	if _, err := DeriveKey(nil, an, yn); err == nil {
		t.Fatal("code vide accepté")
	}
}

func TestSealOpen(t *testing.T) {
	key := bytes.Repeat([]byte{5}, KeySize)
	aad := []byte("aad")
	msg := []byte("contenu secret")

	sealed, err := Seal(key, msg, aad)
	if err != nil {
		t.Fatalf("Seal : %v", err)
	}
	plain, err := Open(key, sealed, aad)
	if err != nil {
		t.Fatalf("Open : %v", err)
	}
	if !bytes.Equal(plain, msg) {
		t.Fatalf("aller-retour : %q", plain)
	}
	// Altération d'un bit : refus.
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0x80
	if _, err := Open(key, tampered, aad); proto.CodeOf(err) != proto.CodeDecryptFailed {
		t.Fatalf("blob altéré accepté : %v", err)
	}
	// Mauvaise clé : refus.
	badKey := bytes.Repeat([]byte{6}, KeySize)
	if _, err := Open(badKey, sealed, aad); proto.CodeOf(err) != proto.CodeDecryptFailed {
		t.Fatalf("mauvaise clé acceptée : %v", err)
	}
	// AAD différente : refus.
	if _, err := Open(key, sealed, []byte("other")); proto.CodeOf(err) != proto.CodeDecryptFailed {
		t.Fatalf("AAD différente acceptée : %v", err)
	}
	// Blob tronqué.
	if _, err := Open(key, sealed[:3], aad); err == nil {
		t.Fatal("blob tronqué accepté")
	}
}

/* ─── Appairage : nominal ────────────────────────────────────────────────── */

func TestPairingNominal(t *testing.T) {
	clock := newClock()
	code := "ABCD-2345-6789"
	material := testMaterial(t)

	client, err := NewClient(code, Options{Now: clock.now})
	if err != nil {
		t.Fatalf("NewClient : %v", err)
	}
	session, err := NewSession(code, Options{Now: clock.now})
	if err != nil {
		t.Fatalf("NewSession : %v", err)
	}

	pb := client.Begin("")
	ok, err := session.Authorize(pb, material)
	if err != nil {
		t.Fatalf("Authorize : %v", err)
	}
	got, err := client.Accept(pb, ok)
	if err != nil {
		t.Fatalf("Accept : %v", err)
	}
	if got.AgentID != material.AgentID || got.CAFingerprint != material.CAFingerprint {
		t.Fatalf("contenu altéré : %#v", got)
	}
	if got.CACert != material.CACert {
		t.Fatal("CA de test non transmis")
	}
	if !session.Used() {
		t.Fatal("le code doit être consommé après appairage")
	}
}

// Appairage avec un CA revendiqué (re-pairing) : le CA reçu correspond.
func TestPairingWithClaimedCA(t *testing.T) {
	code := "ABCD-2345-6789"
	material := testMaterial(t)
	client, _ := NewClient(code, Options{})
	session, _ := NewSession(code, Options{})

	pb := client.Begin(material.CAFingerprint)
	ok, err := session.Authorize(pb, material)
	if err != nil {
		t.Fatalf("Authorize : %v", err)
	}
	if _, err := client.Accept(pb, ok); err != nil {
		t.Fatalf("Accept : %v", err)
	}
}

/* ─── Appairage : attaques (chacune DOIT échouer) ────────────────────────── */

// (1) Faux code : l'agent emploie un `C` différent ⇒ preuve refusée.
func TestAttackWrongCode(t *testing.T) {
	session, _ := NewSession("ABCD-2345-6789", Options{})
	client, _ := NewClient("ABCD-2345-6798", Options{})

	pb := client.Begin("")
	if _, err := session.Authorize(pb, testMaterial(t)); errCode(t, err) != proto.CodeProofInvalid {
		t.Fatalf("mauvais code accepté : %v", err)
	}
}

// (2) Faux serveur : sans `C`, aucun `pair_ok` n'est déchiffrable par l'agent.
func TestAttackFakeServer(t *testing.T) {
	client, _ := NewClient("ABCD-2345-6789", Options{})
	pb := client.Begin("")

	fakeNonce := bytes.Repeat([]byte{9}, NonceSize)
	fakeBlob := bytes.Repeat([]byte{0xAB}, 64)
	_, err := client.Accept(pb, &proto.PairOK{YukiNonce: fakeNonce, Blob: fakeBlob})
	if errCode(t, err) != proto.CodeDecryptFailed {
		t.Fatalf("faux serveur accepté : %v", err)
	}
}

// (2bis) Faux serveur avec une `pair_ok` chiffrée sous un AUTRE code.
func TestAttackFakeServerWrongKey(t *testing.T) {
	// Le « faux serveur » connaît un code erroné et tente un appairage complet.
	fakeSession, err := NewSession("ZZZZ-ZZZZ-ZZZZ", Options{})
	if err != nil {
		t.Fatalf("NewSession : %v", err)
	}
	// L'agent, lui, a le bon code ; le faux serveur fabrique sa paire à part.
	client, _ := NewClient("ABCD-2345-6789", Options{})
	pb := client.Begin("")

	// Le faux serveur construit une pair_ok pour SON couple d'aléas.
	fakeClient, _ := NewClient("ZZZZ-ZZZZ-ZZZZ", Options{})
	fakePB := fakeClient.Begin("")
	fakeOK, err := fakeSession.Authorize(fakePB, testMaterial(t))
	if err != nil {
		t.Fatalf("Authorize faux serveur : %v", err)
	}
	// L'agent refuse : la pair_ok ne correspond pas à son agent_nonce.
	if _, err := client.Accept(pb, fakeOK); err == nil {
		t.Fatal("pair_ok d'un faux serveur acceptée")
	}
}

// (2ter) Le serveur renvoie un CA différent de l'empreinte revendiquée.
func TestAttackWrongClaimedCA(t *testing.T) {
	code := "ABCD-2345-6789"
	client, _ := NewClient(code, Options{})
	session, _ := NewSession(code, Options{})
	material := testMaterial(t)

	claimed := strings.Repeat("ff", 32) // empreinte revendiquée ≠ CA réel
	pb := client.Begin(claimed)
	ok, err := session.Authorize(pb, material)
	if err != nil {
		t.Fatalf("Authorize : %v", err)
	}
	if _, err := client.Accept(pb, ok); errCode(t, err) != proto.CodeDecryptFailed {
		t.Fatalf("CA non conforme accepté : %v", err)
	}
}

// (3) Rejeu : la MÊME `pair_begin` rejouée est refusée.
func TestAttackReplay(t *testing.T) {
	code := "ABCD-2345-6789"
	client, _ := NewClient(code, Options{})
	session, _ := NewSession(code, Options{})
	pb := client.Begin("")

	if _, err := session.Authorize(pb, testMaterial(t)); err != nil {
		t.Fatalf("première Authorize : %v", err)
	}
	if _, err := session.Authorize(pb, testMaterial(t)); errCode(t, err) != proto.CodeReplay {
		t.Fatalf("rejeu accepté : %v", err)
	}
}

// (4) Altération : un bit modifié dans le blob chiffré ⇒ refus.
func TestAttackTamperedBlob(t *testing.T) {
	code := "ABCD-2345-6789"
	client, _ := NewClient(code, Options{})
	session, _ := NewSession(code, Options{})
	pb := client.Begin("")
	ok, err := session.Authorize(pb, testMaterial(t))
	if err != nil {
		t.Fatalf("Authorize : %v", err)
	}
	ok.Blob[len(ok.Blob)/2] ^= 0x01
	if _, err := client.Accept(pb, ok); errCode(t, err) != proto.CodeDecryptFailed {
		t.Fatalf("blob altéré accepté : %v", err)
	}
}

// (5) Nonce réutilisé : le même `agent_nonce` rejoué (preuve recalculée) ⇒ refus.
func TestAttackNonceReuse(t *testing.T) {
	code := "ABCD-2345-6789"
	session, _ := NewSession(code, Options{})
	key, _ := CodeKey(code)

	nonce := bytes.Repeat([]byte{4}, NonceSize)
	pb1 := &proto.PairBegin{
		AgentNonce:    nonce,
		YukiFPClaimed: "aa",
		Proof:         Proof(key, []byte("aa"), nonce),
	}
	pb2 := &proto.PairBegin{
		AgentNonce:    nonce, // MÊME nonce, revendication différente
		YukiFPClaimed: "bb",
		Proof:         Proof(key, []byte("bb"), nonce),
	}
	if _, err := session.Authorize(pb1, testMaterial(t)); err != nil {
		t.Fatalf("première Authorize : %v", err)
	}
	if _, err := session.Authorize(pb2, testMaterial(t)); errCode(t, err) != proto.CodeReplay {
		t.Fatalf("réutilisation de nonce acceptée : %v", err)
	}
}

/* ─── Rate-limit, expiration, usage unique ───────────────────────────────── */

func TestRateLimit(t *testing.T) {
	code := "ABCD-2345-6789"
	session, _ := NewSession(code, Options{})
	key, _ := CodeKey(code)
	material := testMaterial(t)

	// 5 tentatives avec de mauvaises preuves (nonces distincts).
	for i := 0; i < DefaultMaxAttempts; i++ {
		nonce := bytes.Repeat([]byte{byte(i + 1)}, NonceSize)
		pb := &proto.PairBegin{
			AgentNonce: nonce,
			Proof:      bytes.Repeat([]byte{0}, sha256.Size), // fausse
		}
		if _, err := session.Authorize(pb, material); errCode(t, err) != proto.CodeProofInvalid {
			t.Fatalf("tentative %d : code %q, attendu proof_invalid (%v)", i+1, proto.CodeOf(err), err)
		}
	}
	if !session.Invalidated() {
		t.Fatal("le code devait être invalidé après 5 tentatives")
	}
	if session.Attempts() != DefaultMaxAttempts {
		t.Fatalf("tentatives comptées : %d", session.Attempts())
	}

	// Tentative suivante : rate-limited, même avec un bon code.
	nonce := bytes.Repeat([]byte{0x7F}, NonceSize)
	pb := &proto.PairBegin{
		AgentNonce: nonce,
		Proof:      Proof(key, nil, nonce),
	}
	if _, err := session.Authorize(pb, material); errCode(t, err) != proto.CodeRateLimited {
		t.Fatalf("après invalidation : %v", err)
	}
}

func TestExpiration(t *testing.T) {
	clock := newClock()
	code := "ABCD-2345-6789"
	client, _ := NewClient(code, Options{Now: clock.now})
	session, _ := NewSession(code, Options{Now: clock.now})

	clock.advance(DefaultTTL + time.Second)
	pb := client.Begin("")
	if _, err := session.Authorize(pb, testMaterial(t)); errCode(t, err) != proto.CodeCodeExpired {
		t.Fatalf("code périmé accepté : %v", err)
	}
}

func TestSingleUse(t *testing.T) {
	code := "ABCD-2345-6789"
	session, _ := NewSession(code, Options{})

	// Premier appairage réussi.
	c1, _ := NewClient(code, Options{})
	pb1 := c1.Begin("")
	if _, err := session.Authorize(pb1, testMaterial(t)); err != nil {
		t.Fatalf("premier appairage : %v", err)
	}
	// Second appairage, aléa neuf et preuve valide ⇒ code déjà consommé.
	c2, _ := NewClient(code, Options{})
	pb2 := c2.Begin("")
	if _, err := session.Authorize(pb2, testMaterial(t)); errCode(t, err) != proto.CodeCodeUsed {
		t.Fatalf("second usage accepté : %v", err)
	}
}

/* ─── Cas limites ────────────────────────────────────────────────────────── */

func TestAuthorizeRejectsBadNonceSize(t *testing.T) {
	session, _ := NewSession("ABCD-2345-6789", Options{})
	pb := &proto.PairBegin{AgentNonce: []byte{1, 2, 3}, Proof: []byte{0}}
	if _, err := session.Authorize(pb, testMaterial(t)); errCode(t, err) != proto.CodeMalformedMessage {
		t.Fatalf("nonce court accepté : %v", err)
	}
}

func TestAuthorizeNil(t *testing.T) {
	session, _ := NewSession("ABCD-2345-6789", Options{})
	if _, err := session.Authorize(nil, testMaterial(t)); errCode(t, err) != proto.CodeMalformedMessage {
		t.Fatalf("nil accepté : %v", err)
	}
	if _, err := session.Authorize(&proto.PairBegin{AgentNonce: make([]byte, NonceSize)}, nil); errCode(t, err) != proto.CodeInternal {
		t.Fatalf("matériel nil accepté : %v", err)
	}
}

func TestSessionBadCode(t *testing.T) {
	if _, err := NewSession("nope", Options{}); errCode(t, err) != proto.CodeInvalidCode {
		t.Fatalf("code invalide accepté")
	}
	if _, err := NewClient("nope", Options{}); errCode(t, err) != proto.CodeInvalidCode {
		t.Fatalf("code invalide accepté (client)")
	}
}

func TestPayloadRoundTrip(t *testing.T) {
	p := testMaterial(t)
	data, err := p.Marshal()
	if err != nil {
		t.Fatalf("Marshal : %v", err)
	}
	got, err := ParsePayload(data)
	if err != nil {
		t.Fatalf("ParsePayload : %v", err)
	}
	if *got != *p {
		t.Fatalf("contenu altéré : %#v", got)
	}
	if _, err := ParsePayload([]byte("{")); errCode(t, err) != proto.CodePayloadMalformed {
		t.Fatalf("JSON invalide accepté")
	}
	if _, err := ParsePayload([]byte(`{"ca_cert":"x"}`)); errCode(t, err) != proto.CodePayloadMalformed {
		t.Fatalf("champs manquants acceptés")
	}
}
