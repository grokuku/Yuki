// Package tlsconf fabrique des `tls.Config` pour le canal « machines »
// (Yuki ↔ agent d'exécution, Lot 4 §5, décision D115).
//
// Trois services :
//
//   - ÉPINGLAGE : la chaîne du pair doit remonter à un CA dont l'empreinte
//     SHA-256 correspond au PIN attendu.
//   - PREMIER CONTACT : au bootstrap, l'agent ne connaît pas encore le CA de
//     Yuki. La vérification de chaîne est alors désactivée AU NIVEAU TLS, la
//     confiance étant ancrée à l'APPLICATION par le code d'appairage
//     (`internal/pair`). L'empreinte observée est exposée pour être épinglée
//     après réception du CA par `pair_ok`.
//   - CHARGEMENT d'un couple certificat/clé client depuis des PEM.
//
// ⚠️ La fabrique est PUREMENT une fabrique de configuration : aucune connexion
// n'est ouverte, ce qui la rend directement testable (y compris par une
// poignée de main TLS réelle sur `net.Pipe`).
package tlsconf

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// minVersionParDefaut : TLS 1.3 (pas de tolérance aux versions dépréciées).
const minVersionParDefaut = tls.VersionTLS13

// Options règle la construction d'un `tls.Config`.
type Options struct {
	// CertPEM / KeyPEM : couple certificat/clé du LOCAL (cert client pour
	// l'agent, cert serveur pour Yuki). Facultatif pour un client sans
	// authentification mutuelle.
	CertPEM []byte
	KeyPEM  []byte
	// CAPEM : certificat du CA à épingler (PEM). Fournit l'ancre de confiance.
	CAPEM []byte
	// PinnedFingerprint : empreinte SHA-256 (hex minuscule) du CA attendu.
	// Alternative ou complément au pool issu de `CAPEM`.
	PinnedFingerprint string
	// AllowFirstContact : désactive la vérification de chaîne (bootstrap). À
	// n'utiliser QUE pour l'appairage initial ; l'empreinte observée est
	// remontée via `OnFirstContact`.
	AllowFirstContact bool
	// OnFirstContact : rappel recevant l'empreinte du certificat pair observé
	// lorsque `AllowFirstContact` est vrai.
	OnFirstContact func(fingerprint string)
	// MinVersion : version TLS minimale (défaut TLS 1.3).
	MinVersion uint16
	// ServerName : nom attendu (SNI / hôte) côté client.
	ServerName string
}

// Fingerprint renvoie l'empreinte SHA-256 (hex minuscule) d'un certificat.
func Fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

// ParseCertificatePEM décode le PREMIER certificat d'un PEM.
func ParseCertificatePEM(pemBytes []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("tlsconf: PEM illisible (bloc absent)")
	}
	if block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("tlsconf: bloc PEM de type %q (attendu CERTIFICATE)", block.Type)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("tlsconf: certificat illisible : %w", err)
	}
	return cert, nil
}

// FingerprintPEM renvoie l'empreinte SHA-256 du PREMIER certificat d'un PEM.
func FingerprintPEM(pemBytes []byte) (string, error) {
	cert, err := ParseCertificatePEM(pemBytes)
	if err != nil {
		return "", err
	}
	return Fingerprint(cert), nil
}

// CertPoolFromPEM construit un pool à partir d'un ou plusieurs certificats PEM.
func CertPoolFromPEM(pemBytes []byte) (*x509.CertPool, error) {
	if len(pemBytes) == 0 {
		return nil, errors.New("tlsconf: PEM de CA vide")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, errors.New("tlsconf: aucun certificat exploitable dans le PEM")
	}
	return pool, nil
}

// LoadKeyPair charge un couple certificat/clé depuis des PEM.
func LoadKeyPair(certPEM, keyPEM []byte) (tls.Certificate, error) {
	if len(certPEM) == 0 || len(keyPEM) == 0 {
		return tls.Certificate{}, errors.New("tlsconf: certificat ou clé vide")
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("tlsconf: couple certificat/clé invalide : %w", err)
	}
	return pair, nil
}

// applyCommon renseigne la version minimale, le certificat local et le SNI.
func applyCommon(cfg *tls.Config, opts Options) error {
	minVersion := opts.MinVersion
	if minVersion == 0 {
		minVersion = minVersionParDefaut
	}
	cfg.MinVersion = minVersion
	if opts.ServerName != "" {
		cfg.ServerName = opts.ServerName
	}
	if len(opts.CertPEM) > 0 || len(opts.KeyPEM) > 0 {
		pair, err := LoadKeyPair(opts.CertPEM, opts.KeyPEM)
		if err != nil {
			return err
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	return nil
}

// validateTrust vérifie qu'une ancre de confiance a bien été fournie (hors
// premier contact).
func validateTrust(opts Options) error {
	if opts.AllowFirstContact {
		return nil
	}
	if len(opts.CAPEM) == 0 && strings.TrimSpace(opts.PinnedFingerprint) == "" {
		return errors.New("tlsconf: ni CA ni empreinte épinglée (premier contact non autorisé)")
	}
	return nil
}

// pinVerifier renvoie un validateur qui n'accepte que si la racine d'une chaîne
// vérifiée porte l'empreinte épinglée.
func pinVerifier(pin string) func([][]byte, [][]*x509.Certificate) error {
	normalized := strings.ToLower(strings.TrimSpace(pin))
	return func(_ [][]byte, verified [][]*x509.Certificate) error {
		for _, chain := range verified {
			if len(chain) == 0 {
				continue
			}
			root := chain[len(chain)-1]
			if Fingerprint(root) == normalized {
				return nil
			}
		}
		return errors.New("tlsconf: empreinte du CA pair non épinglée")
	}
}

// captureVerifier renvoie un validateur qui accepte tout pair et remonte
// l'empreinte observée (bootstrap uniquement).
func captureVerifier(onFirst func(string)) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("tlsconf: aucune chaîne présentée par le pair")
		}
		cert, err := x509.ParseCertificate(rawCerts[0])
		if err != nil {
			return fmt.Errorf("tlsconf: certificat pair illisible : %w", err)
		}
		if onFirst != nil {
			onFirst(Fingerprint(cert))
		}
		return nil
	}
}

// ClientConfig fabrique la configuration CLIENT (agent → Yuki).
func ClientConfig(opts Options) (*tls.Config, error) {
	if err := validateTrust(opts); err != nil {
		return nil, err
	}
	cfg := &tls.Config{}
	if err := applyCommon(cfg, opts); err != nil {
		return nil, err
	}
	if opts.AllowFirstContact {
		// Bootstrap : pas de vérification TLS ; la confiance vient du code.
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = captureVerifier(opts.OnFirstContact)
		return cfg, nil
	}
	if len(opts.CAPEM) > 0 {
		pool, err := CertPoolFromPEM(opts.CAPEM)
		if err != nil {
			return nil, err
		}
		cfg.RootCAs = pool
	}
	if strings.TrimSpace(opts.PinnedFingerprint) != "" {
		cfg.VerifyPeerCertificate = pinVerifier(opts.PinnedFingerprint)
	}
	return cfg, nil
}

// ServerConfig fabrique la configuration SERVEUR (Yuki écoute les agents).
//
// Le certificat local (`CertPEM`/`KeyPEM`) est OBLIGATOIRE côté serveur.
func ServerConfig(opts Options) (*tls.Config, error) {
	if err := validateTrust(opts); err != nil {
		return nil, err
	}
	if len(opts.CertPEM) == 0 || len(opts.KeyPEM) == 0 {
		return nil, errors.New("tlsconf: certificat serveur requis")
	}
	cfg := &tls.Config{}
	if err := applyCommon(cfg, opts); err != nil {
		return nil, err
	}
	if opts.AllowFirstContact {
		// Bootstrap : le client n'a pas encore de certificat signé par Yuki.
		cfg.ClientAuth = tls.RequireAnyClientCert
		cfg.VerifyPeerCertificate = captureVerifier(opts.OnFirstContact)
		return cfg, nil
	}
	pool, err := CertPoolFromPEM(opts.CAPEM)
	if err != nil {
		return nil, err
	}
	cfg.ClientCAs = pool
	cfg.ClientAuth = tls.RequireAndVerifyClientCert
	if strings.TrimSpace(opts.PinnedFingerprint) != "" {
		cfg.VerifyPeerCertificate = pinVerifier(opts.PinnedFingerprint)
	}
	return cfg, nil
}
