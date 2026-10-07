package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/grokuku/yuki/agent/internal/pair"
	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/tlsconf"
)

// pairPath / pairPollPath : routes d'appairage du port machines de Yuki
// (`src/agents/server.ts`).
const (
	pairPath     = "/api/pair"
	pairPollWait = 250 * time.Millisecond
	pairDeadline = 10 * time.Minute
)

// pairErrorBody est l'enveloppe d'erreur renvoyée par Yuki.
type pairErrorBody struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PerformPairing joue l'appairage COMPLET depuis l'agent :
//
//  1. `pair_begin` (preuve HMAC du code) POSTée sur `<pairURL>/api/pair` ;
//  2. réception immédiate du `pair_ok` (200) ou scrutation par `pair_id` (202) ;
//  3. déchiffrement du `pair_ok` (le CA de Yuki EST authentifié par le code).
//
// ⚠️ PREMIER CONTACT : la chaîne TLS n'est pas encore vérifiable (aucun CA
// connu). La confiance est ancrée à l'APPLICATION par le code (D119).
//
// `yukiFPCaimed` : empreinte du CA déjà connu (ré-appairage) ou vide.
func PerformPairing(ctx context.Context, pairURL, code, yukiFPCaimed string) (*pair.Payload, error) {
	client, err := pair.NewClient(code, pair.Options{})
	if err != nil {
		return nil, err
	}
	begin := client.Begin(yukiFPCaimed)
	body, err := proto.Encode(begin)
	if err != nil {
		return nil, err
	}

	base := strings.TrimRight(strings.TrimSpace(pairURL), "/")
	if base == "" {
		return nil, fmt.Errorf("agent : adresse d'appairage de Yuki requise")
	}
	httpClient := firstContactHTTPClient()
	defer httpClient.CloseIdleConnections()

	ok, pairID, err := postPairBegin(ctx, httpClient, base+pairPath, body)
	if err != nil {
		return nil, err
	}
	if ok == nil {
		ok, err = pollPairOK(ctx, httpClient, base+pairPath+"/"+pairID)
		if err != nil {
			return nil, err
		}
	}
	return client.Accept(begin, ok)
}

// firstContactHTTPClient ouvre un client HTTPS qui N'ÉPROUVE PAS la chaîne TLS
// (le CA de Yuki est inconnu avant l'appairage). Cette confiance est compensée
// par la preuve de possession du code au niveau applicatif.
func firstContactHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, // premier contact : cf. commentaire ci-dessus
				MinVersion:         tls.VersionTLS13,
			},
		},
	}
}

// postPairBegin dépose la `pair_begin`. Renvoie soit un `pair_ok` immédiat,
// soit l'identifiant de scrutation (202).
func postPairBegin(ctx context.Context, client *http.Client, endpoint string, body []byte) (*proto.PairOK, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("agent : appairage (pair_begin) : %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, "", fmt.Errorf("agent : lecture de la réponse d'appairage : %w", err)
	}
	switch resp.StatusCode {
	case http.StatusOK:
		ok, err := decodePairOK(data)
		return ok, "", err
	case http.StatusAccepted:
		var pending struct {
			PairID string `json:"pair_id"`
		}
		if err := json.Unmarshal(data, &pending); err != nil {
			return nil, "", fmt.Errorf("agent : réponse d'appairage illisible : %w", err)
		}
		if pending.PairID == "" {
			return nil, "", fmt.Errorf("agent : `pair_id` absent de la réponse")
		}
		return nil, pending.PairID, nil
	default:
		return nil, "", fmt.Errorf("agent : appairage refusé (HTTP %d) : %s", resp.StatusCode, describePairError(data))
	}
}

// pollPairOK scrute la route `/api/pair/<pairId>` jusqu'à obtention du
// `pair_ok` (le code doit être saisi côté Yuki).
func pollPairOK(ctx context.Context, client *http.Client, endpoint string) (*proto.PairOK, error) {
	deadline := time.Now().Add(pairDeadline)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("agent : scrutation d'appairage : %w", err)
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusOK:
			return decodePairOK(data)
		case http.StatusAccepted:
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("agent : délai d'appairage dépassé (le code a-t-il été saisi dans Yuki ?)")
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(pairPollWait):
			}
		default:
			return nil, fmt.Errorf("agent : appairage refusé (HTTP %d) : %s", resp.StatusCode, describePairError(data))
		}
	}
}

// decodePairOK décode une trame `pair_ok`.
func decodePairOK(data []byte) (*proto.PairOK, error) {
	message, err := proto.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("agent : trame d'appairage illisible : %w", err)
	}
	ok, isOK := message.(*proto.PairOK)
	if !isOK {
		return nil, fmt.Errorf("agent : trame inattendue (%T) au lieu de pair_ok", message)
	}
	return ok, nil
}

// describePairError rend lisible une enveloppe d'erreur Yuki `{error, code, message}`.
func describePairError(data []byte) string {
	var body pairErrorBody
	if err := json.Unmarshal(data, &body); err == nil {
		if body.Message != "" {
			return fmt.Sprintf("%s (%s)", body.Message, body.Code)
		}
		if body.Code != "" {
			return body.Code
		}
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "sans détail"
	}
	return text
}

// ReadCAFingerprint renvoie l'empreinte SHA-256 du CA déjà enregistré, ou la
// chaîne vide s'il n'existe pas (premier appairage).
func ReadCAFingerprint(cfg *Config) string {
	data, err := os.ReadFile(cfg.CAFile)
	if err != nil {
		return ""
	}
	fingerprint, err := tlsconf.FingerprintPEM(data)
	if err != nil {
		return ""
	}
	return fingerprint
}

// WriteMaterial écrit le matériel d'appairage (CA, certificat client, clé
// client) dans le répertoire d'état, avec des permissions restrictives :
// répertoire `0700`, clé privée `0600`, CA et certificat `0644`. Écriture
// atomique (fichier temporaire + renommage).
func WriteMaterial(cfg *Config, payload *pair.Payload) error {
	if payload == nil {
		return fmt.Errorf("agent : matériel d'appairage vide")
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return fmt.Errorf("agent : création du répertoire d'état %q : %w", cfg.StateDir, err)
	}
	// Le répertoire contient la clé privée : on resserre ses permissions même
	// s'il préexistait (MkdirAll ne corrige pas un répertoire existant).
	if err := os.Chmod(cfg.StateDir, 0o700); err != nil {
		return fmt.Errorf("agent : permissions du répertoire d'état %q : %w", cfg.StateDir, err)
	}
	files := []struct {
		path string
		data string
		perm os.FileMode
	}{
		{cfg.CAFile, payload.CACert, 0o644},
		{cfg.CertFile, payload.ClientCert, 0o644},
		{cfg.KeyFile, payload.ClientKey, 0o600},
	}
	for _, file := range files {
		if err := writeFileRestricted(file.path, []byte(file.data), file.perm); err != nil {
			return err
		}
	}
	return nil
}

// writeFileRestricted écrit `data` dans `path` avec `perm` (y compris si le
// fichier existait déjà avec des permissions plus larges).
func writeFileRestricted(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return fmt.Errorf("agent : écriture de %q : %w", path, err)
	}
	if err := os.Chmod(tmp, perm); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("agent : permissions de %q : %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("agent : renommage vers %q : %w", path, err)
	}
	return nil
}
