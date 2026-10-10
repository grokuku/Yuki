package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
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
	// pairPollMargin : marge laissée au serveur au-delà du TTL affiché d'un code
	// avant que l'agent n'abandonne la scrutation et ne RÉGÉNÈRE un code. Le
	// serveur élague l'entrée en attente à son propre TTL : cette marge lui
	// laisse le temps de répondre `pair_code_expired` plutôt que de faire
	// couper la scrutation par l'agent en premier.
	pairPollMargin = 30 * time.Second
)

// pairErrorBody est l'enveloppe d'erreur renvoyée par Yuki.
type pairErrorBody struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Message string `json:"message"`
	// PairID : renvoyé sur un `pair_code_mismatch` — la trame a MALGRÉ TOUT été
	// mise en attente, l'agent peut poursuivre la scrutation avec cet identifiant.
	PairID string `json:"pair_id"`
}

// PairExpiredError signale qu'une tentative d'appairage n'est plus valable : le
// serveur a élagué l'entrée en attente (« demande d'appairage inconnue ou
// expirée ») ou le délai de scrutation agent est dépassé. L'appelant DOIT alors
// générer un NOUVEAU code et recommencer (D119 : usage unique).
type PairExpiredError struct {
	// Reason : message lisible (jamais une cause inventée).
	Reason string
	err    error
}

func (e *PairExpiredError) Error() string {
	if e.err != nil {
		return fmt.Sprintf("%s : %v", e.Reason, e.err)
	}
	return e.Reason
}

func (e *PairExpiredError) Unwrap() error { return e.err }

// IsPairExpired indique qu'une erreur d'appairage impose de RÉGÉNÉRER un code.
func IsPairExpired(err error) bool {
	var target *PairExpiredError
	return errors.As(err, &target)
}

// PairingPolicy règle la boucle d'appairage orchestrée par l'agent : génération
// du code, intervalle de scrutation et régénération.
type PairingPolicy struct {
	// CodeTTL : durée de vie ANNONCÉE d'un code (défaut pair.DefaultTTL, 10 min).
	CodeTTL time.Duration
	// PollWait : intervalle entre deux scrutations (défaut 250 ms).
	PollWait time.Duration
	// MaxCodes : nombre maximal de codes générés avant abandon (0 = illimité).
	MaxCodes int
	// Rand : source aléatoire du code (défaut : crypto/rand).
	Rand io.Reader
	// Now : horloge injectable (défaut time.Now).
	Now func() time.Time
}

func (p PairingPolicy) withDefaults() PairingPolicy {
	if p.CodeTTL <= 0 {
		p.CodeTTL = pair.DefaultTTL
	}
	if p.PollWait <= 0 {
		p.PollWait = pairPollWait
	}
	if p.Now == nil {
		p.Now = time.Now
	}
	return p
}

// PairingCallbacks reçoit les ÉVÉNEMENTS d'affichage de la boucle d'appairage.
// L'appelant s'en sert pour AFFICHER le code (D119) et rassurer l'utilisateur.
type PairingCallbacks struct {
	// OnCode est appelé dès qu'un code est généré : c'est LUI qu'il faut afficher
	// à l'utilisateur. `attempt` commence à 1.
	OnCode func(code string, expiresAt time.Time, attempt int)
	// OnExpired est appelé quand un code a expiré sans validation, juste avant
	// qu'un NOUVEAU code ne soit généré.
	OnExpired func(code string, attempt int)
	// OnWaiting est appelé à chaque scrutation restée « en attente » (202),
	// avec le temps écoulé depuis la génération du code courant.
	OnWaiting func(elapsed time.Duration)
	// OnNotice signale un AVERTISSEMENT NON FATAL : par exemple
	// `pair_code_mismatch` — le code saisi dans Yuki ne correspond encore à aucun
	// agent, mais la trame reste EN ATTENTE et l'appairage peut aboutir dès la
	// bonne saisie. L'appelant l'affiche ; il ne doit PAS être traité comme un
	// échec.
	OnNotice func(message string)
}

// PairWithCodes joue l'appairage COMPLET côté agent, conforme à D119 : c'est
// l'AGENT qui GÉNÈRE le code (jamais Yuki ni l'utilisateur), l'ANNONCE via
// `cb.OnCode` (l'appelant l'affiche sur la console de la machine), l'envoie à
// Yuki (`pair_begin`, premier contact sans certificat) puis scrute l'entrée en
// attente jusqu'à ce que l'utilisateur ait validé le code dans l'interface. Si
// le code expire, un NOUVEAU code est généré et annoncé (jusqu'à
// `policy.MaxCodes` si > 0).
//
// ⚠️ PREMIER CONTACT : la chaîne TLS n'est pas encore vérifiable (aucun CA
// connu). La confiance est ancrée à l'APPLICATION par le code (D119).
//
// `yukiFPCaimed` : empreinte du CA déjà connu (ré-appairage) ou vide.
func PairWithCodes(
	ctx context.Context,
	pairURL, yukiFPCaimed string,
	policy PairingPolicy,
	cb PairingCallbacks,
) (*pair.Payload, error) {
	policy = policy.withDefaults()
	for attempt := 1; ; attempt++ {
		code, err := pair.GenerateCode(policy.Rand)
		if err != nil {
			return nil, fmt.Errorf("agent : génération du code d'appairage : %w", err)
		}
		if cb.OnCode != nil {
			cb.OnCode(code, policy.Now().Add(policy.CodeTTL), attempt)
		}
		payload, err := performPairingOnce(ctx, pairURL, code, yukiFPCaimed, policy, cb)
		if err == nil {
			return payload, nil
		}
		if !IsPairExpired(err) {
			return nil, err
		}
		if policy.MaxCodes > 0 && attempt >= policy.MaxCodes {
			return nil, err
		}
		if cb.OnExpired != nil {
			cb.OnExpired(code, attempt)
		}
	}
}

// PerformPairing joue UNE tentative d'appairage pour un code DÉJÀ connu (cas
// des tests et des usages programmatiques). L'appelant fournit le code ; la CLI
// `pair`, elle, passe par `PairWithCodes` (génération + affichage + scrutation).
func PerformPairing(ctx context.Context, pairURL, code, yukiFPCaimed string) (*pair.Payload, error) {
	return performPairingOnce(ctx, pairURL, code, yukiFPCaimed, PairingPolicy{}, PairingCallbacks{})
}

// performPairingOnce envoie une `pair_begin` pour `code` puis, si la réponse est
// mise en attente (202), scrute `GET <pairURL>/api/pair/<pairId>` jusqu'au
// `pair_ok` (200). Sur expiration, renvoie un `*PairExpiredError`.
func performPairingOnce(
	ctx context.Context,
	pairURL, code, yukiFPCaimed string,
	policy PairingPolicy,
	cb PairingCallbacks,
) (*pair.Payload, error) {
	policy = policy.withDefaults()
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

	ok, pairID, err := postPairBegin(ctx, httpClient, base+pairPath, body, cb)
	if err != nil {
		return nil, err
	}
	if ok == nil {
		ok, err = pollPairOK(ctx, httpClient, base+pairPath+"/"+pairID, policy, cb)
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
// soit l'identifiant de scrutation (202, ou 409 `pair_code_mismatch` — conflit
// RÉCUPÉRABLE où la trame a tout de même été mise en attente).
func postPairBegin(ctx context.Context, client *http.Client, endpoint string, body []byte, cb PairingCallbacks) (*proto.PairOK, string, error) {
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
		// ⚠️ Conflit RÉCUPÉRABLE : aucune session Yuki ne correspond encore au
		// code de l'agent, mais le serveur a MIS LA TRAME EN ATTENTE et renvoie
		// son `pair_id`. On AVERTIT (sans secret) et on poursuit la scrutation.
		var envelope pairErrorBody
		_ = json.Unmarshal(data, &envelope)
		if envelope.Code == "pair_code_mismatch" && envelope.PairID != "" {
			if cb.OnNotice != nil {
				cb.OnNotice(pairRemedy(envelope.Code))
			}
			return nil, envelope.PairID, nil
		}
		return nil, "", fmt.Errorf("agent : %s", pairErrorMessage(resp.StatusCode, data))
	}
}

// pollPairOK scrute la route `/api/pair/<pairId>` jusqu'à obtention du
// `pair_ok` (le code doit être saisi côté Yuki). Sur expiration (410
// `pair_code_expired` ou délai dépassé), renvoie un `*PairExpiredError` afin que
// l'appelant régénère un code.
func pollPairOK(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	policy PairingPolicy,
	cb PairingCallbacks,
) (*proto.PairOK, error) {
	startedAt := policy.Now()
	deadline := startedAt.Add(policy.CodeTTL + pairPollMargin)
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
			if policy.Now().After(deadline) {
				return nil, &PairExpiredError{
					Reason: "délai d'appairage dépassé (le code n'a pas été validé dans Yuki)",
				}
			}
			if cb.OnWaiting != nil {
				cb.OnWaiting(policy.Now().Sub(startedAt))
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(policy.PollWait):
			}
		default:
			if resp.StatusCode == http.StatusGone || pairErrorCode(data) == "pair_code_expired" {
				return nil, &PairExpiredError{
					Reason: "le code d'appairage n'est plus valable côté Yuki (expiré ou jamais saisi)",
				}
			}
			return nil, fmt.Errorf("agent : %s", pairErrorMessage(resp.StatusCode, data))
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

// pairErrorCode extrait le code d'erreur structuré (`code`) d'une enveloppe
// d'erreur Yuki `{error, code, message}`, ou la chaîne vide.
func pairErrorCode(data []byte) string {
	var body pairErrorBody
	if err := json.Unmarshal(data, &body); err != nil {
		return ""
	}
	return body.Code
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

// pairRemedy associe à un code d'erreur d'appairage une PISTE d'action en
// français, ou la chaîne vide. ⚠️ Elle ne divulgue QUE la cause et le geste à
// faire : jamais le code attendu, jamais un décompte de tentatives.
func pairRemedy(code string) string {
	switch code {
	case "pair_code_mismatch":
		return "le code saisi dans Yuki ne correspond pas à celui de cette machine : " +
			"recopiez le code ACTUELLEMENT affiché (un code périmé est remplacé)."
	case "pair_fp_mismatch":
		return "le CA de Yuki a changé ou l'adresse visée n'est pas la bonne : effacez le " +
			"répertoire d'état de l'agent (--state-dir) puis relancez `yuki-agent pair`."
	case "pair_code_used":
		return "ce code a déjà servi (usage unique) : relancez `yuki-agent pair` pour en générer un nouveau."
	case "pair_code_expired":
		return "ce code a expiré : recopiez le NOUVEAU code affiché par cette machine."
	case "pair_rate_limited":
		return "trop de tentatives : relancez `yuki-agent pair` pour obtenir un nouveau code."
	case "pair_code_invalid":
		return "code au format invalide : recopiez exactement le code affiché (alphabet sans 0, 1, I, L, O, U)."
	default:
		return ""
	}
}

// pairErrorMessage rend lisible le refus d'appairage de Yuki et y joint, quand
// elle est connue, une piste d'action (voir `pairRemedy`).
func pairErrorMessage(status int, data []byte) string {
	message := fmt.Sprintf("appairage refusé (HTTP %d) : %s", status, describePairError(data))
	if remedy := pairRemedy(pairErrorCode(data)); remedy != "" {
		message += " — " + remedy
	}
	return message
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
