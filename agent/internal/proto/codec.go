package proto

import (
	"encoding/json"
	"fmt"
)

// Encode sérialise un message en JSON, en renseignant systématiquement
// l'en-tête (`type` + `proto_version`).
//
// Le message doit être un pointeur vers l'une des trames de ce package
// (l'union est fermée). Un message `nil` est refusé.
func Encode(m Message) ([]byte, error) {
	if m == nil {
		return nil, NewError(CodeInternal, "message nil")
	}
	h := m.header()
	h.Type = m.Type()
	h.ProtoVersion = Version
	data, err := json.Marshal(m)
	if err != nil {
		return nil, NewError(CodeInternal, fmt.Sprintf("encodage impossible : %v", err))
	}
	return data, nil
}

// Decode analyse une trame JSON et renvoie le message typé correspondant.
//
// Contrôles, dans l'ordre :
//  1. JSON valide et objet (`invalid_json`) ;
//  2. `type` présent (`malformed_message`) ;
//  3. `proto_version` == `Version` (`unsupported_version`) ;
//  4. `type` connu (`unknown_type`) ;
//  5. champs du message décodables (`malformed_message`).
//
// Les champs INCONNUS sont tolérés (compatibilité ascendante d'un champ
// optionnel ajouté par une version mineure). Les champs requis absents sont
// laissés à la validation de l'appelant (ex. `cmd_id` vide).
func Decode(data []byte) (Message, error) {
	var h Header
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, NewError(CodeInvalidJSON, fmt.Sprintf("JSON invalide : %v", err))
	}
	if h.Type == "" {
		return nil, NewError(CodeMalformedMessage, "champ `type` absent")
	}
	if h.ProtoVersion != Version {
		return nil, NewError(
			CodeUnsupportedVersion,
			fmt.Sprintf("proto_version %d non supportée (attendue %d)", h.ProtoVersion, Version),
		)
	}

	var m Message
	switch h.Type {
	case TypeHello:
		m = &Hello{}
	case TypeAck:
		m = &Ack{}
	case TypeResult:
		m = &Result{}
	case TypeState:
		m = &State{}
	case TypePong:
		m = &Pong{}
	case TypeError:
		m = &Error{}
	case TypeCmd:
		m = &Cmd{}
	case TypeCancel:
		m = &Cancel{}
	case TypeConfig:
		m = &Config{}
	case TypePing:
		m = &Ping{}
	case TypeScreenshot:
		m = &Screenshot{}
	case TypeScreenshotData:
		m = &ScreenshotData{}
	case TypePairBegin:
		m = &PairBegin{}
	case TypePairOK:
		m = &PairOK{}
	default:
		return nil, NewError(CodeUnknownType, fmt.Sprintf("type inconnu : %q", h.Type))
	}

	if err := json.Unmarshal(data, m); err != nil {
		return nil, NewError(
			CodeMalformedMessage,
			fmt.Sprintf("champs de %q invalides : %v", h.Type, err),
		)
	}
	return m, nil
}
