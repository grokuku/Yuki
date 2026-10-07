package agent

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grokuku/yuki/agent/internal/exec"
	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/transport"
)

/* ─── Collecte des réponses (thread-safe) ──────────────────────────────────── */

type replyCollector struct {
	mu       sync.Mutex
	messages []proto.Message
}

func (c *replyCollector) reply(m proto.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messages = append(c.messages, m)
	return nil
}

func (c *replyCollector) all() []proto.Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]proto.Message(nil), c.messages...)
}

func (c *replyCollector) first(kind proto.MessageType) proto.Message {
	for _, m := range c.all() {
		if m.Type() == kind {
			return m
		}
	}
	return nil
}

// waitReply attend qu'une réponse d'un type donné soit émise (l'exécution est
// asynchrone : l'accusé est synchrone, le résultat ne l'est pas).
func waitReply(t *testing.T, c *replyCollector, kind proto.MessageType) proto.Message {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if m := c.first(kind); m != nil {
			return m
		}
		if time.Now().After(deadline) {
			t.Fatalf("aucune réponse %q reçue", kind)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

/* ─── Journal capturé ──────────────────────────────────────────────────────── */

type captureLogger struct {
	mu    sync.Mutex
	lines []string
}

func (l *captureLogger) append(message string, fields map[string]any) {
	record := map[string]any{"msg": message}
	for k, v := range fields {
		record[k] = v
	}
	data, _ := json.Marshal(record)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, string(data))
}

func (l *captureLogger) Debug(message string, fields map[string]any) { l.append(message, fields) }
func (l *captureLogger) Info(message string, fields map[string]any)  { l.append(message, fields) }
func (l *captureLogger) Warn(message string, fields map[string]any)  { l.append(message, fields) }
func (l *captureLogger) Error(message string, fields map[string]any) { l.append(message, fields) }

func (l *captureLogger) has(substr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, substr) {
			return true
		}
	}
	return false
}

func newTestRuntime(t *testing.T, logger transport.Logger) (*Runtime, *exec.Supervisor) {
	t.Helper()
	cfg := &Config{}
	cfg.ApplyDefaults()
	sup := exec.NewSupervisor(exec.New(exec.Options{}))
	return NewRuntime(cfg, sup, logger), sup
}

/* ─── Tests du gestionnaire (sans réseau) ──────────────────────────────────── */

func TestHandleCmdAckEtResult(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	replies := &replyCollector{}

	cmd := &proto.Cmd{CmdID: "c-1", Command: "printf bonjour"}
	if err := rt.HandleMessage(context.Background(), cmd, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}

	ack := replies.first(proto.TypeAck)
	if ack == nil || ack.(*proto.Ack).CmdID != "c-1" {
		t.Fatalf("ack absent ou incorrect : %+v", ack)
	}
	result := waitReply(t, replies, proto.TypeResult)
	if result == nil {
		t.Fatal("result absent")
	}
	res := result.(*proto.Result)
	if res.CmdID != "c-1" {
		t.Fatalf("cmd_id = %q", res.CmdID)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit_code = %d", res.ExitCode)
	}
	if res.Stdout != "bonjour" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
	if res.StartedAt == "" || res.EndedAt == "" {
		t.Fatal("started_at/ended_at absents")
	}
	if res.DurationMs < 0 {
		t.Fatalf("duration_ms = %d", res.DurationMs)
	}
	// L'ack doit précéder le résultat (l'accusé part AVANT l'exécution).
	all := replies.all()
	if all[0].Type() != proto.TypeAck {
		t.Fatalf("première réponse = %s, attendu ack", all[0].Type())
	}
}

func TestHandleCmdCodeSortieEtStderr(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	replies := &replyCollector{}

	cmd := &proto.Cmd{CmdID: "c-2", Command: "printf err >&2; exit 3"}
	if err := rt.HandleMessage(context.Background(), cmd, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	res := waitReply(t, replies, proto.TypeResult).(*proto.Result)
	if res.ExitCode != 3 {
		t.Fatalf("exit_code = %d, attendu 3", res.ExitCode)
	}
	if res.Stderr != "err" {
		t.Fatalf("stderr = %q", res.Stderr)
	}
}

func TestHandleCmdDivergenceJournaliseeSansBlocage(t *testing.T) {
	logger := &captureLogger{}
	rt, _ := newTestRuntime(t, logger)
	replies := &replyCollector{}

	// Yuki annonce « destructeur » alors que le matcher local ne voit rien.
	yuki := true
	cmd := &proto.Cmd{CmdID: "c-3", Command: "printf bonjour", Destructive: &yuki}
	if err := rt.HandleMessage(context.Background(), cmd, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}

	if !logger.has("agent.classement.divergence") {
		t.Fatalf("divergence non journalisée : %v", logger.lines)
	}
	// ⚠️ Non bloquant : l'exécution a bien eu lieu et le résultat est renvoyé.
	if waitReply(t, replies, proto.TypeResult) == nil {
		t.Fatal("la divergence a bloqué l'exécution (aucun result)")
	}
}

func TestHandleCmdConcordanceSansDivergence(t *testing.T) {
	logger := &captureLogger{}
	rt, _ := newTestRuntime(t, logger)
	replies := &replyCollector{}

	yuki := false
	cmd := &proto.Cmd{CmdID: "c-4", Command: "printf bonjour", Destructive: &yuki}
	if err := rt.HandleMessage(context.Background(), cmd, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	if logger.has("agent.classement.divergence") {
		t.Fatal("divergence signalée à tort")
	}
	if !logger.has("agent.classement.local") {
		t.Fatal("classification locale non journalisée")
	}
}

func TestHandlePingRepondPong(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	replies := &replyCollector{}
	if err := rt.HandleMessage(context.Background(), &proto.Ping{T: 123}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	pong, ok := replies.first(proto.TypePong).(*proto.Pong)
	if !ok || pong.T != 123 {
		t.Fatalf("pong = %+v", replies.messages)
	}
}

func TestHandleCmdApresArretRefuse(t *testing.T) {
	rt, sup := newTestRuntime(t, &captureLogger{})
	sup.Shutdown(0) // arrêt immédiat : plus aucune commande acceptée.

	replies := &replyCollector{}
	cmd := &proto.Cmd{CmdID: "c-5", Command: "printf bonjour"}
	if err := rt.HandleMessage(context.Background(), cmd, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	// L'accusé part quand même, mais l'exécution est refusée par une trame error.
	if replies.first(proto.TypeAck) == nil {
		t.Fatal("ack absent")
	}
	errMsg, ok := waitReply(t, replies, proto.TypeError).(*proto.Error)
	if !ok {
		t.Fatalf("aucune trame error : %+v", replies.messages)
	}
	if errMsg.Ref != "c-5" {
		t.Fatalf("ref = %q", errMsg.Ref)
	}
}

/* ─── D124 : la déconnexion n'interrompt pas la commande ───────────────────── */

func TestHandleCmdSurvitAnnulationConnexion(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	replies := &replyCollector{}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- rt.HandleMessage(ctx, &proto.Cmd{
			CmdID:   "c-d124",
			Command: "sleep 0.3; printf fini",
		}, replies.reply)
	}()
	// La connexion « tombe » pendant l'exécution.
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("HandleMessage : %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("la commande n'est pas allée à son terme après annulation de la connexion")
	}
	res, ok := waitReply(t, replies, proto.TypeResult).(*proto.Result)
	if !ok {
		t.Fatalf("aucun résultat : %+v", replies.messages)
	}
	if res.ExitCode != 0 || res.Stdout != "fini" {
		t.Fatalf("la commande a été interrompue : %+v", res)
	}
}

/* ─── Serveur WebSocket de test (TLS) ──────────────────────────────────────── */

type wsTestConn struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
	mu   sync.Mutex
}

func (c *wsTestConn) readMessage() (byte, []byte, error) {
	var messageOpcode byte
	var assembled []byte
	started := false
	for {
		fin, opcode, payload, err := wsReadFrame(c.br)
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case 0x9: // ping
			_ = c.writeFrame(0xA, payload)
			continue
		case 0xA: // pong
			continue
		case 0x8: // close
			return 0, nil, io.EOF
		case 0x1, 0x2:
			messageOpcode = opcode
			started = true
		case 0x0:
			if !started {
				return 0, nil, io.ErrUnexpectedEOF
			}
		default:
			return 0, nil, io.ErrUnexpectedEOF
		}
		assembled = append(assembled, payload...)
		if fin {
			return messageOpcode, assembled, nil
		}
	}
}

func (c *wsTestConn) writeFrame(opcode byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return wsWriteFrame(c.conn, opcode, payload)
}

func (c *wsTestConn) writeMessage(m proto.Message) error {
	data, err := proto.Encode(m)
	if err != nil {
		return err
	}
	return c.writeFrame(0x1, data)
}

func (c *wsTestConn) readProto() (proto.Message, error) {
	op, payload, err := c.readMessage()
	if err != nil {
		return nil, err
	}
	if op != 0x1 {
		return nil, io.ErrUnexpectedEOF
	}
	return proto.Decode(payload)
}

// wsReadFrame lit une trame d'un client (masquée).
func wsReadFrame(br *bufio.Reader) (bool, byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(br, head[:]); err != nil {
		return false, 0, nil, err
	}
	fin := head[0]&0x80 != 0
	opcode := head[0] & 0x0F
	masked := head[1]&0x80 != 0
	length := uint64(head[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	var key [4]byte
	if masked {
		if _, err := io.ReadFull(br, key[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= key[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// wsWriteFrame écrit une trame serveur non masquée.
func wsWriteFrame(w io.Writer, opcode byte, payload []byte) error {
	first := opcode | 0x80
	buf := []byte{first}
	length := len(payload)
	switch {
	case length <= 125:
		buf = append(buf, byte(length))
	case length <= 65535:
		buf = append(buf, 126, 0, 0)
		binary.BigEndian.PutUint16(buf[len(buf)-2:], uint16(length))
	default:
		buf = append(buf, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		buf = append(buf, ext[:]...)
	}
	buf = append(buf, payload...)
	_, err := w.Write(buf)
	return err
}

func wsAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// newWSServer démarre un serveur WebSocket TLS de test et renvoie son URL
// `wss://` et le certificat serveur (auto-signé) en PEM.
func newWSServer(t *testing.T, serve func(*wsTestConn)) (string, []byte) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "hijack indisponible", http.StatusInternalServerError)
			return
		}
		netConn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}
		_ = netConn.SetDeadline(time.Time{})
		response := "HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + wsAcceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n"
		if _, err := rw.WriteString(response); err != nil {
			netConn.Close()
			return
		}
		if err := rw.Flush(); err != nil {
			netConn.Close()
			return
		}
		conn := &wsTestConn{t: t, conn: netConn, br: rw.Reader}
		defer netConn.Close()
		serve(conn)
	}))
	t.Cleanup(srv.Close)

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	return "wss://" + srv.Listener.Addr().String() + "/ws", certPEM
}

// generateClientMaterial génère un couple certificat/clé auto-signé pour le
// client mTLS de test.
func generateClientMaterial(t *testing.T) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("génération de clé : %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "agent-de-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"agent-de-test"},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("création du certificat : %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("encodage de la clé : %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if condition() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("délai dépassé : %s", message)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

/* ─── Test d'intégration : câblage complet (WS + TLS) ──────────────────────── */

func TestRunCableWebSocket(t *testing.T) {
	type observation struct {
		hello    *proto.Hello
		ackCmdID string
		result   *proto.Result
	}
	observed := make(chan observation, 1)

	url, serverCertPEM := newWSServer(t, func(sc *wsTestConn) {
		msg, err := sc.readProto()
		if err != nil {
			return
		}
		hello, ok := msg.(*proto.Hello)
		if !ok {
			return
		}
		// Yuki envoie une commande NON destructrice et l'annonce telle quelle.
		notDestructive := false
		if err := sc.writeMessage(&proto.Cmd{
			CmdID: "c-100", Command: "printf 'coucou-agent'", Destructive: &notDestructive,
		}); err != nil {
			return
		}
		ackMsg, err := sc.readProto()
		if err != nil {
			return
		}
		ack, ok := ackMsg.(*proto.Ack)
		if !ok {
			return
		}
		resultMsg, err := sc.readProto()
		if err != nil {
			// Le résultat peut mettre un instant : nouvelle tentative.
			return
		}
		result, ok := resultMsg.(*proto.Result)
		if !ok {
			return
		}
		observed <- observation{hello: hello, ackCmdID: ack.CmdID, result: result}
		// Maintient la connexion pour les pings.
		time.Sleep(200 * time.Millisecond)
	})

	clientCertPEM, clientKeyPEM := generateClientMaterial(t)
	cfg := pairedTestConfig(t, url, serverCertPEM, clientCertPEM, clientKeyPEM)

	logger := &captureLogger{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, "0.0.0-test", logger) }()

	select {
	case obs := <-observed:
		if obs.hello == nil {
			t.Fatal("hello non reçu")
		}
		if obs.hello.AgentID != cfg.AgentID {
			t.Fatalf("hello.agent_id = %q", obs.hello.AgentID)
		}
		if obs.hello.OS == "" || obs.hello.Arch == "" {
			t.Fatalf("hello os/arch = %q/%q", obs.hello.OS, obs.hello.Arch)
		}
		if obs.hello.AgentVersion != "0.0.0-test" {
			t.Fatalf("hello.agent_version = %q", obs.hello.AgentVersion)
		}
		if obs.ackCmdID != "c-100" {
			t.Fatalf("ack cmd_id = %q", obs.ackCmdID)
		}
		if obs.result == nil {
			t.Fatal("result non reçu")
		}
		if obs.result.ExitCode != 0 || obs.result.Stdout != "coucou-agent" {
			t.Fatalf("result = %+v", obs.result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("aucune observation reçue du serveur de test")
	}

	// Arrêt propre : l'annulation rend la main.
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run ne s'est pas arrêté à l'annulation")
	}
}

// TestRunDivergenceMatcherJournalisee : sur le VRAI câblage (WS/TLS), une
// divergence entre la classification locale et l'annonce de Yuki est
// journalisée — et l'exécution a bien lieu (l'agent ne bloque pas).
func TestRunDivergenceMatcherJournalisee(t *testing.T) {
	resultSeen := make(chan *proto.Result, 1)
	url, serverCertPEM := newWSServer(t, func(sc *wsTestConn) {
		if _, err := sc.readProto(); err != nil { // hello
			return
		}
		// Yuki annonce « destructeur » alors que la commande ne l'est pas.
		destructive := true
		if err := sc.writeMessage(&proto.Cmd{
			CmdID: "c-div", Command: "printf bonjour", Destructive: &destructive,
		}); err != nil {
			return
		}
		if _, err := sc.readProto(); err != nil { // ack
			return
		}
		msg, err := sc.readProto()
		if err != nil {
			return
		}
		if result, ok := msg.(*proto.Result); ok {
			resultSeen <- result
		}
		time.Sleep(150 * time.Millisecond)
	})

	clientCertPEM, clientKeyPEM := generateClientMaterial(t)
	cfg := pairedTestConfig(t, url, serverCertPEM, clientCertPEM, clientKeyPEM)
	logger := &captureLogger{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, "0.0.0-test", logger) }()

	select {
	case result := <-resultSeen:
		if result.ExitCode != 0 || result.Stdout != "bonjour" {
			t.Fatalf("la divergence a bloqué/modifié l'exécution : %+v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("résultat non reçu")
	}
	waitForCondition(t, 2*time.Second, func() bool {
		return logger.has("agent.classement.divergence")
	}, "divergence non journalisée par le câblage réel")

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run ne s'est pas arrêté")
	}
}

// pairedTestConfig prépare une configuration appairée pointant sur un serveur
// TLS de test (CA auto-signé épinglé).
func pairedTestConfig(t *testing.T, url string, caPEM, clientCertPEM, clientKeyPEM []byte) *Config {
	t.Helper()
	dir := t.TempDir()
	cfg := &Config{
		YukiURL:  url,
		AgentID:  "agent-de-test",
		StateDir: dir,
	}
	cfg.ApplyDefaults()

	write := func(path string, data []byte, perm uint32) {
		if err := os.WriteFile(path, data, os.FileMode(perm)); err != nil {
			t.Fatalf("écriture de %s : %v", path, err)
		}
	}
	write(cfg.CAFile, caPEM, 0o644)
	write(cfg.CertFile, clientCertPEM, 0o644)
	write(cfg.KeyFile, clientKeyPEM, 0o600)
	return cfg
}
