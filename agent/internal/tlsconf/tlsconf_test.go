package tlsconf

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"
)

/* ─── PKI de test ────────────────────────────────────────────────────────── */

type testPKI struct {
	caPEM     []byte
	caFP      string
	otherCA   []byte
	otherCAFP string
	srvCert   []byte
	srvKey    []byte
	cliCert   []byte
	cliKey    []byte
}

func newLeaf(t *testing.T, caCert *x509.Certificate, caKey *ecdsa.PrivateKey, server bool) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("clé feuille : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "leaf"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	if server {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		tmpl.DNSNames = []string{"localhost"}
		tmpl.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	} else {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("signature feuille : %v", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("clé PKCS8 : %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func newCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("clé CA : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("certificat CA : %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("relecture CA : %v", err)
	}
	return cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	caCert, caKey, caPEM := newCA(t)
	caFP, err := FingerprintPEM(caPEM)
	if err != nil {
		t.Fatalf("empreinte CA : %v", err)
	}
	_, _, otherCA := newCA(t)
	otherFP, _ := FingerprintPEM(otherCA)
	srvCert, srvKey := newLeaf(t, caCert, caKey, true)
	cliCert, cliKey := newLeaf(t, caCert, caKey, false)
	return &testPKI{
		caPEM: caPEM, caFP: caFP,
		otherCA: otherCA, otherCAFP: otherFP,
		srvCert: srvCert, srvKey: srvKey,
		cliCert: cliCert, cliKey: cliKey,
	}
}

/* ─── Poignée de main sur net.Pipe ───────────────────────────────────────── */

func handshake(clientCfg, serverCfg *tls.Config) (clientErr, serverErr error) {
	c, s := net.Pipe()
	defer c.Close()
	defer s.Close()
	deadline := time.Now().Add(5 * time.Second)
	_ = c.SetDeadline(deadline)
	_ = s.SetDeadline(deadline)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := tls.Client(c, clientCfg).Handshake(); err != nil {
			clientErr = err
		}
	}()
	go func() {
		defer wg.Done()
		if err := tls.Server(s, serverCfg).Handshake(); err != nil {
			serverErr = err
		}
	}()
	wg.Wait()
	return clientErr, serverErr
}

/* ─── Tests ──────────────────────────────────────────────────────────────── */

func TestHandshakePinnedNominal(t *testing.T) {
	pki := newTestPKI(t)
	clientCfg, err := ClientConfig(Options{
		CertPEM: pki.cliCert, KeyPEM: pki.cliKey,
		CAPEM: pki.caPEM, PinnedFingerprint: pki.caFP,
		ServerName: "localhost",
	})
	if err != nil {
		t.Fatalf("ClientConfig : %v", err)
	}
	serverCfg, err := ServerConfig(Options{
		CertPEM: pki.srvCert, KeyPEM: pki.srvKey,
		CAPEM: pki.caPEM, PinnedFingerprint: pki.caFP,
	})
	if err != nil {
		t.Fatalf("ServerConfig : %v", err)
	}
	ce, se := handshake(clientCfg, serverCfg)
	if ce != nil || se != nil {
		t.Fatalf("poignée de main nominale échouée : client=%v serveur=%v", ce, se)
	}
	if clientCfg.MinVersion != tls.VersionTLS13 {
		t.Fatalf("MinVersion = %x", clientCfg.MinVersion)
	}
}

func TestHandshakeRejectsWrongCA(t *testing.T) {
	pki := newTestPKI(t)
	clientCfg, err := ClientConfig(Options{
		CertPEM: pki.cliCert, KeyPEM: pki.cliKey,
		CAPEM: pki.otherCA, PinnedFingerprint: pki.otherCAFP,
		ServerName: "localhost",
	})
	if err != nil {
		t.Fatalf("ClientConfig : %v", err)
	}
	serverCfg, err := ServerConfig(Options{
		CertPEM: pki.srvCert, KeyPEM: pki.srvKey,
		CAPEM: pki.caPEM, PinnedFingerprint: pki.caFP,
	})
	if err != nil {
		t.Fatalf("ServerConfig : %v", err)
	}
	ce, se := handshake(clientCfg, serverCfg)
	if ce == nil && se == nil {
		t.Fatal("une chaîne hors CA épinglée a été acceptée")
	}
}

func TestHandshakeFirstContactCapturesFingerprint(t *testing.T) {
	pki := newTestPKI(t)
	var serverObserved string
	var clientObserved string

	clientCfg, err := ClientConfig(Options{
		CertPEM: pki.cliCert, KeyPEM: pki.cliKey,
		AllowFirstContact: true,
		OnFirstContact:    func(fp string) { clientObserved = fp },
	})
	if err != nil {
		t.Fatalf("ClientConfig : %v", err)
	}
	if !clientCfg.InsecureSkipVerify {
		t.Fatal("premier contact : InsecureSkipVerify attendu")
	}
	serverCfg, err := ServerConfig(Options{
		CertPEM: pki.srvCert, KeyPEM: pki.srvKey,
		AllowFirstContact: true,
		OnFirstContact:    func(fp string) { serverObserved = fp },
	})
	if err != nil {
		t.Fatalf("ServerConfig : %v", err)
	}
	ce, se := handshake(clientCfg, serverCfg)
	if ce != nil || se != nil {
		t.Fatalf("premier contact échoué : client=%v serveur=%v", ce, se)
	}
	// L'agent a observé l'empreinte du cert SERVEUR (feuille), le serveur celle
	// du cert CLIENT. Toutes deux non vides, et c'est le cert feuille.
	srvLeafFP, _ := FingerprintPEM(pki.srvCert)
	cliLeafFP, _ := FingerprintPEM(pki.cliCert)
	if clientObserved != srvLeafFP {
		t.Fatalf("empreinte serveur observée = %q, attendue %q", clientObserved, srvLeafFP)
	}
	if serverObserved != cliLeafFP {
		t.Fatalf("empreinte client observée = %q, attendue %q", serverObserved, cliLeafFP)
	}
}

func TestConfigRequiresTrustAnchor(t *testing.T) {
	if _, err := ClientConfig(Options{}); err == nil {
		t.Fatal("client sans ancre de confiance accepté")
	}
	if _, err := ServerConfig(Options{CertPEM: []byte("x"), KeyPEM: []byte("y")}); err == nil {
		t.Fatal("serveur sans ancre de confiance accepté")
	}
}

func TestServerRequiresCertificate(t *testing.T) {
	pki := newTestPKI(t)
	if _, err := ServerConfig(Options{CAPEM: pki.caPEM}); err == nil {
		t.Fatal("serveur sans certificat accepté")
	}
}

func TestCertPoolAndFingerprint(t *testing.T) {
	pki := newTestPKI(t)
	pool, err := CertPoolFromPEM(pki.caPEM)
	if err != nil || pool == nil {
		t.Fatalf("CertPoolFromPEM : %v", err)
	}
	if _, err := CertPoolFromPEM([]byte("pas un pem")); err == nil {
		t.Fatal("PEM invalide accepté")
	}
	if _, err := CertPoolFromPEM(nil); err == nil {
		t.Fatal("PEM vide accepté")
	}
	cert, err := ParseCertificatePEM(pki.caPEM)
	if err != nil {
		t.Fatalf("ParseCertificatePEM : %v", err)
	}
	if Fingerprint(cert) != pki.caFP {
		t.Fatal("Fingerprint incohérent avec FingerprintPEM")
	}
	if _, err := ParseCertificatePEM([]byte("pas un pem")); err == nil {
		t.Fatal("PEM sans bloc accepté")
	}
	// Bloc PEM d'un mauvais type.
	badType := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("x")})
	if _, err := ParseCertificatePEM(badType); err == nil {
		t.Fatal("bloc PEM de type non CERTIFICATE accepté")
	}
}

func TestLoadKeyPairErrors(t *testing.T) {
	if _, err := LoadKeyPair(nil, nil); err == nil {
		t.Fatal("couple vide accepté")
	}
	pki := newTestPKI(t)
	if _, err := LoadKeyPair(pki.cliCert, pki.cliCert); err == nil {
		t.Fatal("clé invalide acceptée")
	}
	if _, err := LoadKeyPair(pki.cliCert, pki.cliKey); err != nil {
		t.Fatalf("couple valide refusé : %v", err)
	}
}

func TestPinOnlyWithoutCAPEM(t *testing.T) {
	// Un pin seul (sans CAPEM) est une ancre de confiance valide pour la
	// validation, mais sans pool la chaîne n'est pas vérifiée ici : la
	// configuration doit au moins se construire.
	cfg, err := ClientConfig(Options{PinnedFingerprint: "abcd", AllowFirstContact: false})
	if err != nil {
		t.Fatalf("ClientConfig : %v", err)
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("validateur d'empreinte absent")
	}
}
