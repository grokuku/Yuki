// Command paircheck — harnais d'INTEROPÉRABILITÉ Go ↔ TS (Lot 4).
//
// Il sert deux usages, tous deux décrits dans les tests Yuki :
//
//	paircheck vectors <code> <agentNonceHex> <yukiNonceHex> <yukiFp>
//	    imprime en JSON la matière de code, la preuve HMAC et la clé HKDF
//	    (côté GO), pour comparaison avec l'implémentation TS ;
//
//	paircheck pair <baseURL> <code> [yukiFp]
//	    joue un VRAI appairage contre le serveur TS : envoie `pair_begin`
//	    (premier contact), récupère `pair_ok`, déchiffre le contenu, puis
//	    effectue une requête mTLS authentifiée (`/api/agent/whoami`) avec le
//	    certificat client signé par l'autorité interne TS.
//
// ⚠️ Ce programme n'est PAS embarqué dans l'agent de production : c'est un
// outil de vérification, isolé du reste du module.
package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/grokuku/yuki/agent/internal/pair"
	"github.com/grokuku/yuki/agent/internal/proto"
)

func main() {
	if len(os.Args) < 2 {
		fail("usage : paircheck <vectors|pair> …")
	}
	switch os.Args[1] {
	case "vectors":
		runVectors(os.Args[2:])
	case "pair":
		runPair(os.Args[2:])
	default:
		fail("mode inconnu : " + os.Args[1])
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "paircheck : "+message)
	os.Exit(1)
}

func mustHex(value, name string) []byte {
	out, err := hex.DecodeString(value)
	if err != nil {
		fail("argument " + name + " non hexadécimal : " + err.Error())
	}
	return out
}

// runVectors imprime les primitives déterministes calculées par le Go.
func runVectors(args []string) {
	if len(args) != 4 {
		fail("usage : vectors <code> <agentNonceHex> <yukiNonceHex> <yukiFp>")
	}
	code, agentNonceHex, yukiNonceHex, yukiFp := args[0], args[1], args[2], args[3]
	key, err := pair.CodeKey(code)
	if err != nil {
		fail("CodeKey : " + err.Error())
	}
	agentNonce := mustHex(agentNonceHex, "agentNonceHex")
	yukiNonce := mustHex(yukiNonceHex, "yukiNonceHex")
	proof := pair.Proof(key, []byte(yukiFp), agentNonce)
	derived, err := pair.DeriveKey(key, agentNonce, yukiNonce)
	if err != nil {
		fail("DeriveKey : " + err.Error())
	}
	out := map[string]string{
		"code_key": hex.EncodeToString(key),
		"proof":    hex.EncodeToString(proof),
		"key":      hex.EncodeToString(derived),
	}
	printJSON(out)
}

// runPair joue un appairage complet puis une requête mTLS authentifiée.
func runPair(args []string) {
	if len(args) < 2 {
		fail("usage : pair <baseURL> <code> [yukiFp]")
	}
	baseURL := strings.TrimRight(args[0], "/")
	code := args[1]
	yukiFp := ""
	if len(args) >= 3 {
		yukiFp = args[2]
	}

	client, err := pair.NewClient(code, pair.Options{})
	if err != nil {
		fail("NewClient : " + err.Error())
	}
	begin := client.Begin(yukiFp)
	body, err := proto.Encode(begin)
	if err != nil {
		fail("Encode(pair_begin) : " + err.Error())
	}

	insecure := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			// ⚠️ PREMIER CONTACT : l'agent ne connaît pas encore le CA de Yuki.
			// La confiance est portée par la preuve HMAC du code (couche
			// applicative), pas par la chaîne TLS.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13},
		},
	}

	ok, err := postPairBegin(insecure, baseURL+"/api/pair", body)
	if err != nil {
		fail("pair_begin : " + err.Error())
	}
	if ok == nil {
		// 202 : scrutation jusqu'à ce que le code soit saisi côté Yuki.
		pairID, err := requestPairID(insecure, baseURL+"/api/pair", body)
		if err != nil {
			fail("scrutation inutile : " + err.Error())
		}
		ok, err = pollPairOK(insecure, baseURL+"/api/pair/"+pairID)
		if err != nil {
			fail("scrutation : " + err.Error())
		}
	}

	payload, err := client.Accept(begin, ok)
	if err != nil {
		fail("Accept(pair_ok) : " + err.Error())
	}

	// Le certificat client émis par TS DOIT être accepté par le vérificateur
	// x509 STRICT de Go (chaîne, EKU clientAuth, SAN = agent_id).
	if err := verifyClientCert(payload); err != nil {
		fail("vérification du certificat client (Go x509) : " + err.Error())
	}

	// Phase 2 : le certificat client DOIT être accepté en mTLS par le serveur TS.
	whoami, err := whoAmI(baseURL, payload)
	if err != nil {
		fail("mTLS whoami : " + err.Error())
	}

	printJSON(map[string]any{
		"ok":                   true,
		"agent_id":             payload.AgentID,
		"ca_fingerprint":       payload.CAFingerprint,
		"ca_cert_present":      payload.CACert != "",
		"client_cert_present":  payload.ClientCert != "",
		"client_key_present":   payload.ClientKey != "",
		"client_cert_verified": true,
		"whoami_agent_id":      whoami.AgentID,
		"whoami_level":         whoami.Level,
		"whoami_privilege":     whoami.Privilege,
		"whoami_agent_matches": whoami.AgentID == payload.AgentID,
	})
}

// verifyClientCert valide le certificat client avec le vérificateur Go :
// chaîne jusqu'au CA transmis, usage clientAuth, et SAN = agent_id.
func verifyClientCert(p *pair.Payload) error {
	block, _ := pem.Decode([]byte(p.ClientCert))
	if block == nil {
		return fmt.Errorf("certificat client PEM illisible")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("parsing x509 : %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(p.CACert)) {
		return fmt.Errorf("CA transmis illisible")
	}
	if _, err := cert.Verify(x509.VerifyOptions{
		Roots:     pool,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		return fmt.Errorf("chaîne/EKU refusés : %w", err)
	}
	if cert.Subject.CommonName != p.AgentID {
		return fmt.Errorf("CN %q ≠ agent_id %q", cert.Subject.CommonName, p.AgentID)
	}
	if len(cert.DNSNames) != 1 || cert.DNSNames[0] != p.AgentID {
		return fmt.Errorf("SAN %v ≠ agent_id %q", cert.DNSNames, p.AgentID)
	}
	return nil
}

type whoAmIResponse struct {
	AgentID   string `json:"agent_id"`
	Level     string `json:"level"`
	Privilege string `json:"privilege"`
}

// whoAmI ouvre une connexion mTLS épinglée sur le CA interne et interroge
// l'identité de l'agent.
func whoAmI(baseURL string, payload *pair.Payload) (*whoAmIResponse, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	pair, err := tls.X509KeyPair([]byte(payload.ClientCert), []byte(payload.ClientKey))
	if err != nil {
		return nil, fmt.Errorf("couple certificat/clé client : %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(payload.CACert)) {
		return nil, fmt.Errorf("CA reçu illisible")
	}
	httpClient := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:      pool,
				Certificates: []tls.Certificate{pair},
				ServerName:   parsed.Hostname(),
				MinVersion:   tls.VersionTLS13,
			},
		},
	}
	resp, err := httpClient.Get(baseURL + "/api/agent/whoami")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("whoami HTTP %d : %s", resp.StatusCode, string(data))
	}
	var out whoAmIResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func postPairBegin(client *http.Client, endpoint string, body []byte) (*proto.PairOK, error) {
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return decodePairOK(data)
	case http.StatusAccepted:
		return nil, nil
	default:
		return nil, fmt.Errorf("HTTP %d : %s", resp.StatusCode, string(data))
	}
}

func requestPairID(client *http.Client, endpoint string, body []byte) (string, error) {
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusAccepted {
		return "", fmt.Errorf("HTTP %d : %s", resp.StatusCode, string(data))
	}
	var pending struct {
		PairID string `json:"pair_id"`
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return "", err
	}
	if pending.PairID == "" {
		return "", fmt.Errorf("pair_id absent : %s", string(data))
	}
	return pending.PairID, nil
}

func pollPairOK(client *http.Client, endpoint string) (*proto.PairOK, error) {
	deadline := time.Now().Add(8 * time.Second)
	for {
		resp, err := client.Get(endpoint)
		if err != nil {
			return nil, err
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusOK:
			return decodePairOK(data)
		case http.StatusAccepted:
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("délai de scrutation dépassé")
			}
			time.Sleep(100 * time.Millisecond)
		default:
			return nil, fmt.Errorf("HTTP %d : %s", resp.StatusCode, string(data))
		}
	}
}

func decodePairOK(data []byte) (*proto.PairOK, error) {
	message, err := proto.Decode(data)
	if err != nil {
		return nil, err
	}
	ok, isOK := message.(*proto.PairOK)
	if !isOK {
		return nil, fmt.Errorf("trame inattendue : %T", message)
	}
	return ok, nil
}

func printJSON(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		fail("encodage JSON : " + err.Error())
	}
	fmt.Println(string(data))
}
