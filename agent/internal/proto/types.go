// Package proto définit le protocole filaire entre Yuki (orchestrateur) et
// l'agent d'exécution (Lot 4).
//
// # Principes
//
//   - Transport : JSON, une trame = un objet JSON. Aucune dépendance externe.
//   - Version : chaque trame porte `proto_version`. Un agent et Yuki ne se
//     parlent que si les versions correspondent (`Version`).
//   - Enveloppe d'erreur alignée sur l'existant Yuki
//     (`src/gateway/routes/tts.ts`, `{ error, code, message }`).
//   - Union de messages FERMÉE : le type `Message` possède une méthode
//     non exportée (`header`), donc seul ce package peut définir des trames.
//
// Les champs binaires (nonces, clés, blobs) sont de type `[]byte` : `encoding/json`
// les code/décode automatiquement en base64 standard (RFC 4648).
package proto

// Version est la version courante du protocole filaire.
//
// Règle : une trame dont `proto_version` ne vaut pas exactement `Version` est
// refusée (`CodeUnsupportedVersion`). Aucune négociation n'est prévue pour
// l'instant ; une évolution incrémentera cette constante.
const Version = 1

// MessageType est le discriminant de trame.
type MessageType string

const (
	// TypeHello : agent → Yuki, présentation après établissement du canal.
	TypeHello MessageType = "hello"
	// TypeAck : Yuki → agent, accusé de réception d'une commande.
	TypeAck MessageType = "ack"
	// TypeResult : agent → Yuki, résultat d'exécution (métadonnées + sortie).
	TypeResult MessageType = "result"
	// TypeState : agent → Yuki, changement d'état de l'agent.
	TypeState MessageType = "state"
	// TypePong : réponse à `ping`.
	TypePong MessageType = "pong"
	// TypeError : erreur applicative, enveloppe `{ error, code, message }`.
	TypeError MessageType = "error"
	// TypeCmd : Yuki → agent, demande d'exécution.
	TypeCmd MessageType = "cmd"
	// TypeCancel : Yuki → agent, annulation d'une commande en cours.
	TypeCancel MessageType = "cancel"
	// TypeConfig : Yuki → agent, configuration poussée (niveau, privilège).
	TypeConfig MessageType = "config"
	// TypePing : sonde de vivacité (Yuki → agent ou agent → Yuki).
	TypePing MessageType = "ping"
	// TypeScreenshot : Yuki → agent, demande de capture d'écran.
	TypeScreenshot MessageType = "screenshot"
	// TypeScreenshotData : agent → Yuki, image capturée (JPEG, base64).
	TypeScreenshotData MessageType = "screenshot_data"
	// TypePairBegin : agent → Yuki, première moitié de l'appairage.
	TypePairBegin MessageType = "pair_begin"
	// TypePairOK : Yuki → agent, seconde moitié chiffrée de l'appairage.
	TypePairOK MessageType = "pair_ok"
)

// Header est l'en-tête commun à TOUTE trame.
//
// Il est embarqué par chaque message : ses champs sont ainsi sérialisés à la
// racine de l'objet JSON.
type Header struct {
	Type         MessageType `json:"type"`
	ProtoVersion int         `json:"proto_version"`
}

// Message est l'union fermée des trames du protocole.
//
// La méthode non exportée `header` interdit toute implémentation hors de ce
// package : l'union est FERMÉE par construction.
type Message interface {
	Type() MessageType
	header() *Header
}

// Hello : présentation de l'agent auprès de Yuki (envoyé à chaque connexion).
//
// `EUID` et `Caps` ont été ajoutés au lot A3 : `EUID` permet à Yuki de
// comparer le privilège EFFECTIF de l'agent au privilège configuré (D120) ;
// `Caps` déclare les capacités de l'agent.
type Hello struct {
	Header
	AgentID      string `json:"agent_id"`
	AgentVersion string `json:"agent_version"`
	Host         string `json:"host,omitempty"`
	OS           string `json:"os,omitempty"`
	Arch         string `json:"arch,omitempty"`
	// EUID : identifiant d'utilisateur effectif du processus agent (`-1` si non
	// pertinent, ex. Windows).
	EUID int `json:"euid"`
	// Caps : capacités déclarées par l'agent (ex. `exec`, `shell`).
	Caps []string `json:"caps,omitempty"`
}

// Ack : accusé de réception d'une commande par l'agent.
type Ack struct {
	Header
	CmdID string `json:"cmd_id"`
}

// Result : résultat d'exécution d'une commande.
//
// ⚠️ `Stdout`/`Stderr` ne sont JAMAIS journalisés en intégralité côté Yuki
// (D127) : ils peuvent contenir des secrets. Ce type décrit le fil, pas le
// journal d'audit.
type Result struct {
	Header
	CmdID    string `json:"cmd_id"`
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	// Truncated est l'agrégat (stdout OU stderr tronqué) ; les drapeaux par flux
	// permettent un diagnostic précis.
	Truncated   bool   `json:"truncated,omitempty"`
	StdoutTrunc bool   `json:"stdout_trunc,omitempty"`
	StderrTrunc bool   `json:"stderr_trunc,omitempty"`
	DurationMs  int64  `json:"duration_ms,omitempty"`
	StartedAt   string `json:"started_at,omitempty"`
	EndedAt     string `json:"ended_at,omitempty"`
	TimedOut    bool   `json:"timed_out,omitempty"`
}

// State : état de l'agent (`idle`, `busy`, `offline`…).
type State struct {
	Header
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// Pong : réponse à un `ping` (le champ `T` est réémis tel quel).
type Pong struct {
	Header
	T  int64  `json:"t"`
	Ts string `json:"ts,omitempty"`
}

// Error : erreur applicative. Reprend l'enveloppe Yuki `{ error, code, message }`.
type Error struct {
	Header
	// Error est un code machine court (identique à `Code` par compatibilité
	// avec l'existant Yuki, qui expose `error` ET `code`).
	Error   string    `json:"error"`
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
	// Ref : identifiant de la trame concernée (ex. `cmd_id`), si applicable.
	Ref string `json:"ref,omitempty"`
}

// Cmd : demande d'exécution (Yuki → agent).
type Cmd struct {
	Header
	CmdID   string `json:"cmd_id"`
	Command string `json:"command"`
	// Shell : shell à utiliser (`sh`, `bash`, `/bin/bash`…). Vide ⇒ `/bin/sh`.
	// ⚠️ Shell COMPLET : ce champ choisit l'interpréteur, il ne restreint RIEN.
	Shell string `json:"shell,omitempty"`
	// Cwd : répertoire de travail. Vide ⇒ hérité de l'agent.
	Cwd       string `json:"cwd,omitempty"`
	TimeoutMs int64  `json:"timeout_ms,omitempty"`
	Origin    string `json:"origin,omitempty"`
	// Destructive : décision de Yuki (orchestrateur) sur le caractère
	// destructeur de `Command`. Pointeur pour distinguer « non annoncé » (`nil`)
	// de « annoncé faux ». ⚠️ L'agent ne s'en sert QUE pour JOURNALISER une
	// divergence avec sa classification locale (`internal/exec`) : la décision
	// appartient à Yuki (D118/D126), l'agent n'exécute pas moins pour autant.
	Destructive *bool `json:"destructive,omitempty"`
}

// Cancel : demande d'annulation d'une commande.
type Cancel struct {
	Header
	CmdID  string `json:"cmd_id"`
	Reason string `json:"reason,omitempty"`
}

// Config : configuration poussée à l'agent (niveau de garde-fou + privilège).
type Config struct {
	Header
	Level     string `json:"level"`
	Privilege string `json:"privilege"`
}

// Ping : sonde de vivacité.
type Ping struct {
	Header
	T int64 `json:"t"`
}

// Screenshot : demande de capture d'écran (Yuki → agent).
//
// ⚠️ L'agent ne décide RIEN : il capture si — et seulement si — il a déclaré la
// capacité `screenshot` dans son `hello`. Sinon il refuse honnêtement.
type Screenshot struct {
	Header
	CmdID string `json:"cmd_id"`
	// TimeoutMs : délai maximal de la capture (ms). 0 ⇒ défaut de l'agent.
	TimeoutMs int64 `json:"timeout_ms,omitempty"`
	// MaxEdge : côté long maximal de l'image (px). 0 ⇒ défaut de l'agent.
	MaxEdge int `json:"max_edge,omitempty"`
	// Quality : qualité JPEG (1..100). 0 ⇒ défaut de l'agent.
	Quality int `json:"quality,omitempty"`
}

// ScreenshotData : capture d'écran renvoyée par l'agent (agent → Yuki).
//
// ⚠️ `Data` est du base64 STANDARD (sans préfixe `data:`), borné par le plafond
// DUR de 256 Kio côté agent. C'est une image ÉPHÉMÈRE : elle n'entre jamais dans
// le transcript, le snapshot ou la mémoire de Yuki, et n'est jamais écrite sur
// disque.
type ScreenshotData struct {
	Header
	CmdID string `json:"cmd_id"`
	// Format : format de l'image, toujours `jpeg` à ce jour.
	Format string `json:"format"`
	// Width / Height : dimensions de l'image transmise.
	Width  int `json:"width"`
	Height int `json:"height"`
	// Bytes : taille BINAIRE de l'image (avant base64).
	Bytes int `json:"bytes"`
	// Data : image encodée en base64 standard.
	Data string `json:"data"`
	// DurationMs : durée de la capture (ms).
	DurationMs int64 `json:"duration_ms,omitempty"`
}

// PairBegin : première moitié de l'appairage (agent → Yuki).
//
// `Proof = HMAC-SHA256(C, concat(yuki_fp_claimed, agent_nonce))` : elle prouve
// que l'agent connaît le code `C` (preuve de possession, D119).
type PairBegin struct {
	Header
	// AgentNonce : aléa de 32 octets choisi par l'agent.
	AgentNonce []byte `json:"agent_nonce"`
	// AgentPubkey : clé publique de l'agent (ECDH P-256, format non compressé).
	AgentPubkey []byte `json:"agent_pubkey,omitempty"`
	// YukiFPClaimed : empreinte du CA que l'agent CROIT être celui de Yuki
	// (chaîne hexadécimale minuscule, SHA-256). Vide au tout premier contact.
	YukiFPClaimed string `json:"yuki_fp_claimed,omitempty"`
	// Proof : HMAC-SHA256 sous `C` (voir `internal/pair`).
	Proof []byte `json:"proof"`
}

// PairOK : seconde moitié de l'appairage (Yuki → agent).
//
// `Blob` est un message AES-256-GCM chiffré sous
// `K = HKDF-SHA256(C, concat(agent_nonce, yuki_nonce))` et contenant le
// `pair.Payload` : CA, certificat client, clé privée client, identifiant.
type PairOK struct {
	Header
	// YukiNonce : aléa de 32 octets choisi par Yuki (nécessaire pour dériver K).
	YukiNonce []byte `json:"yuki_nonce"`
	// Blob : nonce GCM || ciphertext || tag.
	Blob []byte `json:"blob"`
}

/* ─── Implémentations du contrat `Message` ──────────────────────────────────── */

func (m *Hello) header() *Header      { return &m.Header }
func (m *Ack) header() *Header        { return &m.Header }
func (m *Result) header() *Header     { return &m.Header }
func (m *State) header() *Header      { return &m.Header }
func (m *Pong) header() *Header       { return &m.Header }
func (m *Error) header() *Header      { return &m.Header }
func (m *Cmd) header() *Header        { return &m.Header }
func (m *Cancel) header() *Header     { return &m.Header }
func (m *Config) header() *Header     { return &m.Header }
func (m *Ping) header() *Header       { return &m.Header }
func (m *Screenshot) header() *Header { return &m.Header }
func (m *ScreenshotData) header() *Header {
	return &m.Header
}
func (m *PairBegin) header() *Header { return &m.Header }
func (m *PairOK) header() *Header    { return &m.Header }

func (m *Hello) Type() MessageType  { return TypeHello }
func (m *Ack) Type() MessageType    { return TypeAck }
func (m *Result) Type() MessageType { return TypeResult }
func (m *State) Type() MessageType  { return TypeState }
func (m *Pong) Type() MessageType   { return TypePong }
func (m *Error) Type() MessageType  { return TypeError }
func (m *Cmd) Type() MessageType    { return TypeCmd }
func (m *Cancel) Type() MessageType { return TypeCancel }
func (m *Config) Type() MessageType { return TypeConfig }
func (m *Ping) Type() MessageType   { return TypePing }
func (m *Screenshot) Type() MessageType {
	return TypeScreenshot
}
func (m *ScreenshotData) Type() MessageType { return TypeScreenshotData }
func (m *PairBegin) Type() MessageType      { return TypePairBegin }
func (m *PairOK) Type() MessageType         { return TypePairOK }
