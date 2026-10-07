// Package transport — transport d'exécution de l'agent (Lot 4, A3).
//
// L'agent **initie** la connexion sortante vers le port « machines » de Yuki
// (mTLS, chemin `/ws` — voir `src/agents/server.ts`). Ce paquet fournit :
//
//   - un client WebSocket MINIMAL, sans dépendance externe (RFC 6455, cadre
//     client masqué, trames de contrôle ping/pong/close, fragmentation) ;
//   - une boucle de connexion permanente : reconnexion à backoff exponentiel
//     `1s → 60s` avec jitter, SANS plafond de tentatives ;
//   - un heartbeat APPLICATIF ping/pong toutes les 15 s, considéré **hors ligne
//     après 45 s** sans pong ;
//   - une idempotence par MRU de 1024 identifiants de commande (rejeu ignoré) ;
//   - une livraison **au plus une fois**, SANS file (D124) : aucune commande
//     n'est mémorisée ni rejouée hors ligne.
//
// ⚠️ Ce paquet ne DÉCIDE pas : l'autorité (niveau de garde-fou, exécution) reste
// Yuki. L'agent exécute ce qu'on lui envoie et classe les commandes (A5).
package transport

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Opcodes de trame WebSocket (RFC 6455 §5.2).
const (
	opContinuation byte = 0x0
	opText         byte = 0x1
	opBinary       byte = 0x2
	opClose        byte = 0x8
	opPing         byte = 0x9
	opPong         byte = 0xA
)

// wsGUID est la constante magique de la poignée de main WebSocket (RFC 6455).
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// ErrClosed signale une connexion WebSocket fermée (trame close ou fermeture).
var ErrClosed = errors.New("transport : connexion WebSocket fermée")

// DialOptions règle l'ouverture d'une connexion WebSocket.
type DialOptions struct {
	// TLSConfig : obligatoire pour `wss://` (mTLS avec le CA épinglé).
	TLSConfig *tls.Config
	// HandshakeTimeout : délai maximal d'établissement (défaut 10 s).
	HandshakeTimeout time.Duration
	// WriteTimeout : délai maximal d'écriture d'une trame (défaut 10 s).
	WriteTimeout time.Duration
	// Rand : source d'aléa pour la clé de poignée de main et le masquage
	// (défaut `crypto/rand.Reader`).
	Rand io.Reader
}

func (o DialOptions) withDefaults() DialOptions {
	if o.HandshakeTimeout <= 0 {
		o.HandshakeTimeout = 10 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 10 * time.Second
	}
	if o.Rand == nil {
		o.Rand = rand.Reader
	}
	return o
}

// secWebSocketAccept calcule la valeur attendue de `Sec-WebSocket-Accept`.
func secWebSocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// Conn est une connexion WebSocket cliente (l'agent est TOUJOURS le client,
// donc toutes ses trames sont masquées).
type Conn struct {
	netConn      net.Conn
	br           *bufio.Reader
	writeTimeout time.Duration
	rnd          io.Reader

	wmu       sync.Mutex
	closeOnce sync.Once
	closed    atomic.Bool

	// OnPong est appelé à la réception d'une trame de contrôle `pong`
	// (liveness au niveau WebSocket). Optionnel.
	OnPong func()
}

// Dial ouvre une connexion WebSocket vers `rawURL` (`ws://` ou `wss://`).
//
// En `wss://`, `opts.TLSConfig` est OBLIGATOIRE : il porte le certificat client
// obtenu à l'appairage et l'épinglage du CA de Yuki.
func Dial(ctx context.Context, rawURL string, opts DialOptions) (*Conn, error) {
	opts = opts.withDefaults()
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("transport : URL invalide %q : %w", rawURL, err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "ws" && scheme != "wss" {
		return nil, fmt.Errorf("transport : schéma %q non supporté (ws/wss attendus)", u.Scheme)
	}
	host := u.Host
	if u.Port() == "" {
		if scheme == "wss" {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}

	dialer := &net.Dialer{Timeout: opts.HandshakeTimeout}
	netConn, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("transport : connexion TCP %q : %w", host, err)
	}

	if scheme == "wss" {
		if opts.TLSConfig == nil {
			netConn.Close()
			return nil, errors.New("transport : TLSConfig requis pour wss://")
		}
		tlsCfg := opts.TLSConfig.Clone()
		if tlsCfg.ServerName == "" {
			tlsCfg.ServerName = u.Hostname()
		}
		tlsConn := tls.Client(netConn, tlsCfg)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			netConn.Close()
			return nil, fmt.Errorf("transport : poignée de main TLS : %w", err)
		}
		netConn = tlsConn
	}

	// Clé de poignée de main (16 octets aléatoires, base64).
	keyBytes := make([]byte, 16)
	if _, err := io.ReadFull(opts.Rand, keyBytes); err != nil {
		netConn.Close()
		return nil, fmt.Errorf("transport : tirage de la clé de poignée de main : %w", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	target := u.RequestURI()
	if target == "" {
		target = "/"
	}
	_ = netConn.SetDeadline(time.Now().Add(opts.HandshakeTimeout))
	request := "GET " + target + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(netConn, request); err != nil {
		netConn.Close()
		return nil, fmt.Errorf("transport : envoi de la poignée de main : %w", err)
	}

	br := bufio.NewReader(netConn)
	if err := verifyHandshakeResponse(br, key); err != nil {
		netConn.Close()
		return nil, err
	}
	// La poignée de main est terminée : les délais d'établissement sont levés.
	_ = netConn.SetDeadline(time.Time{})

	return &Conn{
		netConn:      netConn,
		br:           br,
		writeTimeout: opts.WriteTimeout,
		rnd:          opts.Rand,
	}, nil
}

// verifyHandshakeResponse lit l'en-tête HTTP/1.1 et valide l'acceptation de
// l'upgrade (statut 101 + `Sec-WebSocket-Accept` attendu).
func verifyHandshakeResponse(br *bufio.Reader, key string) error {
	tp := textproto.NewReader(br)
	statusLine, err := tp.ReadLine()
	if err != nil {
		return fmt.Errorf("transport : lecture de la réponse de poignée de main : %w", err)
	}
	fields := strings.SplitN(statusLine, " ", 3)
	if len(fields) < 2 || fields[1] != "101" {
		return fmt.Errorf("transport : upgrade refusé (%q)", statusLine)
	}
	header, err := tp.ReadMIMEHeader()
	if err != nil {
		return fmt.Errorf("transport : en-têtes de poignée de main illisibles : %w", err)
	}
	if !strings.EqualFold(header.Get("Upgrade"), "websocket") {
		return fmt.Errorf("transport : en-tête Upgrade invalide (%q)", header.Get("Upgrade"))
	}
	if !headerContainsToken(header.Get("Connection"), "upgrade") {
		return fmt.Errorf("transport : en-tête Connection invalide (%q)", header.Get("Connection"))
	}
	if got := header.Get("Sec-WebSocket-Accept"); got != secWebSocketAccept(key) {
		return errors.New("transport : Sec-WebSocket-Accept invalide")
	}
	return nil
}

func headerContainsToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// WriteText écrit une trame texte (masquée). Sûr en accès concurrent.
func (c *Conn) WriteText(ctx context.Context, payload []byte) error {
	return c.writeData(ctx, opText, payload)
}

// WriteBinary écrit une trame binaire (masquée). Sûr en accès concurrent.
func (c *Conn) WriteBinary(ctx context.Context, payload []byte) error {
	return c.writeData(ctx, opBinary, payload)
}

func (c *Conn) writeData(ctx context.Context, opcode byte, payload []byte) error {
	if c.closed.Load() {
		return ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed.Load() {
		return ErrClosed
	}
	_ = c.netConn.SetWriteDeadline(time.Now().Add(c.writeTimeout))
	if err := writeFrame(c.netConn, true, opcode, payload, true, c.rnd); err != nil {
		return fmt.Errorf("transport : écriture de trame : %w", err)
	}
	return nil
}

// WritePong répond à une trame de contrôle `ping` (le contrôle peut être émis
// pendant la lecture : il n'utilise pas le verrou de haut niveau).
func (c *Conn) WritePong(ctx context.Context, payload []byte) error {
	return c.writeControl(opPong, payload)
}

// WritePing émet une trame de contrôle `ping` (liveness WebSocket).
func (c *Conn) WritePing(ctx context.Context, payload []byte) error {
	return c.writeControl(opPing, payload)
}

func (c *Conn) writeControl(opcode byte, payload []byte) error {
	if c.closed.Load() {
		return ErrClosed
	}
	if len(payload) > 125 {
		payload = payload[:125]
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed.Load() {
		return ErrClosed
	}
	_ = c.netConn.SetWriteDeadline(time.Now().Add(c.writeTimeout))
	return writeFrame(c.netConn, true, opcode, payload, true, c.rnd)
}

// WriteClose envoie une trame de fermeture (au plus une fois).
func (c *Conn) WriteClose(code uint16, reason string) error {
	var payload []byte
	if code != 0 {
		payload = make([]byte, 2+len(reason))
		binary.BigEndian.PutUint16(payload[:2], code)
		copy(payload[2:], reason)
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed.Load() {
		return nil
	}
	_ = c.netConn.SetWriteDeadline(time.Now().Add(c.writeTimeout))
	return writeFrame(c.netConn, true, opClose, payload, true, c.rnd)
}

// SetReadDeadline fixe l'échéance de lecture (utilisée pour la détection hors
// ligne : une lecture sans trame pendant 45 s échoue et force la reconnexion).
func (c *Conn) SetReadDeadline(t time.Time) error {
	return c.netConn.SetReadDeadline(t)
}

// RemoteAddr renvoie l'adresse du pair.
func (c *Conn) RemoteAddr() net.Addr { return c.netConn.RemoteAddr() }

// Close ferme la connexion sous-jacente (idempotent).
func (c *Conn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		err = c.netConn.Close()
	})
	return err
}

// ReadMessage lit le PROCHAIN message applicatif complet (texte ou binaire).
//
// Les trames de contrôle sont traitées en interne : `ping` ⇒ réponse `pong`,
// `pong` ⇒ `OnPong`, `close` ⇒ `ErrClosed`. La fragmentation (trames
// `continuation`) est réassemblée.
func (c *Conn) ReadMessage(ctx context.Context) (byte, []byte, error) {
	var messageOpcode byte
	var assembled []byte
	started := false
	for {
		if err := ctx.Err(); err != nil {
			return 0, nil, err
		}
		fin, opcode, payload, err := readFrame(c.br)
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case opPing:
			_ = c.WritePong(ctx, payload)
			continue
		case opPong:
			if c.OnPong != nil {
				c.OnPong()
			}
			continue
		case opClose:
			_ = c.WriteClose(1000, "")
			_ = c.Close()
			return 0, nil, ErrClosed
		case opText, opBinary:
			if started {
				return 0, nil, errors.New("transport : nouvelle trame de données avant fin du message")
			}
			messageOpcode = opcode
			started = true
		case opContinuation:
			if !started {
				return 0, nil, errors.New("transport : trame de continuation sans message")
			}
		default:
			return 0, nil, fmt.Errorf("transport : opcode inattendu 0x%x", opcode)
		}
		assembled = append(assembled, payload...)
		if fin {
			return messageOpcode, assembled, nil
		}
	}
}

/* ─── Cadres (frames) — partagés avec les tests serveur ─────────────────────── */

// readFrame lit une trame WebSocket. Un client reçoit des trames NON masquées ;
// un serveur de test reçoit des trames masquées : le masque est appliqué dans
// les deux cas s'il est présent.
func readFrame(br *bufio.Reader) (fin bool, opcode byte, payload []byte, err error) {
	var head [2]byte
	if _, err = io.ReadFull(br, head[:]); err != nil {
		return false, 0, nil, err
	}
	fin = head[0]&0x80 != 0
	if head[0]&0x70 != 0 {
		return false, 0, nil, errors.New("transport : extensions RSV non supportées")
	}
	opcode = head[0] & 0x0F
	masked := head[1]&0x80 != 0
	length := uint64(head[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if opcode >= 0x8 {
		if !fin {
			return false, 0, nil, errors.New("transport : trame de contrôle fragmentée")
		}
		if length > 125 {
			return false, 0, nil, errors.New("transport : trame de contrôle trop longue")
		}
	}
	if length > maxFrameBytes {
		return false, 0, nil, fmt.Errorf("transport : trame de %d octets (limite %d)", length, maxFrameBytes)
	}
	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// maxFrameBytes borne la taille d'une trame acceptée (garde-fou mémoire côté
// agent ; les commandes et résultats restent bien en deçà).
const maxFrameBytes = 8 * 1024 * 1024

// writeFrame écrit une trame WebSocket complète (en-tête + charge). Le masque
// est appliqué si `mask` est vrai (obligatoire pour un client).
func writeFrame(w io.Writer, fin bool, opcode byte, payload []byte, mask bool, rnd io.Reader) error {
	first := opcode
	if fin {
		first |= 0x80
	}
	length := len(payload)
	maxHeader := 2 + 8 + 4
	buf := make([]byte, 0, maxHeader+length)
	buf = append(buf, first)

	maskBit := byte(0)
	if mask {
		maskBit = 0x80
	}
	switch {
	case length <= 125:
		buf = append(buf, maskBit|byte(length))
	case length <= 65535:
		buf = append(buf, maskBit|126, 0, 0)
		binary.BigEndian.PutUint16(buf[len(buf)-2:], uint16(length))
	default:
		buf = append(buf, maskBit|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		buf = append(buf, ext[:]...)
	}

	data := payload
	if mask {
		var key [4]byte
		if _, err := io.ReadFull(rnd, key[:]); err != nil {
			return fmt.Errorf("transport : tirage du masque : %w", err)
		}
		buf = append(buf, key[:]...)
		data = make([]byte, length)
		for i := 0; i < length; i++ {
			data[i] = payload[i] ^ key[i%4]
		}
	}
	buf = append(buf, data...)
	_, err := w.Write(buf)
	return err
}
