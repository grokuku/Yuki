package proto

import "fmt"

// ErrorCode est un code d'erreur MACHINE du protocole.
//
// Les codes sont stables et destinés au code appelant (jamais à l'affichage
// brut). Ils sont alignés, par leur style, sur les codes d'erreur de Yuki
// (`invalid_json`, `unknown_field`, …).
type ErrorCode string

const (
	// CodeInvalidJSON : la trame n'est pas un objet JSON valide.
	CodeInvalidJSON ErrorCode = "invalid_json"
	// CodeMalformedMessage : objet JSON valide, mais message incomplet/invalide.
	CodeMalformedMessage ErrorCode = "malformed_message"
	// CodeUnknownType : discriminant `type` inconnu.
	CodeUnknownType ErrorCode = "unknown_type"
	// CodeUnsupportedVersion : `proto_version` absent ou différent de `Version`.
	CodeUnsupportedVersion ErrorCode = "unsupported_version"
	// CodeInternal : erreur interne inattendue.
	CodeInternal ErrorCode = "internal_error"

	// --- Appairage (internal/pair) -------------------------------------------
	// CodeProofInvalid : preuve HMAC absente ou fausse (mauvais code `C`).
	CodeProofInvalid ErrorCode = "proof_invalid"
	// CodeCodeExpired : code d'appairage périmé.
	CodeCodeExpired ErrorCode = "pair_code_expired"
	// CodeCodeUsed : code d'appairage déjà consommé (usage unique).
	CodeCodeUsed ErrorCode = "pair_code_used"
	// CodeRateLimited : trop de tentatives, code invalidé.
	CodeRateLimited ErrorCode = "pair_rate_limited"
	// CodeReplay : `pair_begin` rejouée (nonce agent déjà vu).
	CodeReplay ErrorCode = "pair_replay"
	// CodeDecryptFailed : `pair_ok` indéchiffrable (blob altéré ou clé fausse).
	CodeDecryptFailed ErrorCode = "pair_decrypt_failed"
	// CodePayloadMalformed : `pair_ok` déchiffré mais contenu illisible.
	CodePayloadMalformed ErrorCode = "pair_payload_malformed"
	// CodeInvalidCode : format du code d'appairage invalide.
	CodeInvalidCode ErrorCode = "pair_code_invalid"
)

// ProtocolError est l'erreur renvoyée par `Decode` et par les helpers de ce
// package. Elle porte toujours un `Code` stable.
type ProtocolError struct {
	Code    ErrorCode
	Message string
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("proto: %s: %s", e.Code, e.Message)
}

// NewError construit une `ProtocolError` ponctuée.
func NewError(code ErrorCode, message string) *ProtocolError {
	return &ProtocolError{Code: code, Message: message}
}

// CodeOf extrait le `ErrorCode` d'une erreur, ou `CodeInternal` si l'erreur
// n'est pas une `ProtocolError`. `nil` ⇒ chaîne vide.
func CodeOf(err error) ErrorCode {
	if err == nil {
		return ""
	}
	if pe, ok := err.(*ProtocolError); ok {
		return pe.Code
	}
	return CodeInternal
}
