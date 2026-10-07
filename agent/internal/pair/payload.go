package pair

import (
	"encoding/json"

	"github.com/grokuku/yuki/agent/internal/proto"
)

// Payload est le contenu EN CLAIR transporté par le blob chiffré de `pair_ok`.
//
// Il matérialise l'appairage côté agent : le CA interne de Yuki (pour épinglage
// ultérieur), le certificat client de l'agent, sa clé privée, et son identité.
type Payload struct {
	// CACert : certificat du CA interne de Yuki (PEM).
	CACert string `json:"ca_cert"`
	// ClientCert : certificat client de l'agent (PEM), signé par le CA.
	ClientCert string `json:"client_cert"`
	// ClientKey : clé privée du certificat client (PEM PKCS#8).
	ClientKey string `json:"client_key"`
	// AgentID : identifiant de l'agent (UUID, également le SAN du certificat).
	AgentID string `json:"agent_id"`
	// CAFingerprint : empreinte SHA-256 du CA (hex minuscule) — sert de PIN.
	CAFingerprint string `json:"ca_fingerprint"`
}

// Marshal sérialise le contenu en JSON (clé d'un blob `pair_ok`).
func (p *Payload) Marshal() ([]byte, error) {
	data, err := json.Marshal(p)
	if err != nil {
		return nil, proto.NewError(proto.CodePayloadMalformed, "sérialisation du contenu impossible")
	}
	return data, nil
}

// ParsePayload analyse le contenu déchiffré.
func ParsePayload(data []byte) (*Payload, error) {
	var p Payload
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, proto.NewError(proto.CodePayloadMalformed, "contenu JSON illisible")
	}
	if p.CACert == "" || p.ClientCert == "" || p.ClientKey == "" || p.AgentID == "" {
		return nil, proto.NewError(proto.CodePayloadMalformed, "champs obligatoires manquants")
	}
	return &p, nil
}
