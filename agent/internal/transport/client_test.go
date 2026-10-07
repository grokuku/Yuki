package transport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grokuku/yuki/agent/internal/proto"
)

func testHello() *proto.Hello {
	return &proto.Hello{
		AgentID:      "a-1",
		AgentVersion: "0.1.0",
		Host:         "machine-cible",
		OS:           "linux",
		Arch:         "amd64",
		EUID:         1000,
		Caps:         []string{"exec"},
	}
}

func nopHandler() Handler {
	return HandlerFunc(func(context.Context, proto.Message, ReplyFunc) error { return nil })
}

// startClient lance un client en arrière-plan et garantit son arrêt propre.
func startClient(t *testing.T, opts Options) *Client {
	t.Helper()
	client, err := NewClient(opts)
	if err != nil {
		t.Fatalf("NewClient : %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Errorf("le client ne s'est pas arrêté à l'annulation")
		}
	})
	return client
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool, message string) {
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

func baseOptions(url string, tlsCfg *tls.Config) Options {
	return Options{
		URL:          url,
		TLSConfig:    tlsCfg,
		Hello:        testHello(),
		Handler:      nopHandler(),
		BaseDelay:    20 * time.Millisecond,
		MaxDelay:     40 * time.Millisecond,
		PingInterval: 25 * time.Millisecond,
		OfflineAfter: 75 * time.Millisecond,
		// Jitter neutralisé pour des délais déterministes.
		Rand: func() float64 { return 0.5 },
	}
}

func TestClientEnvoieHello(t *testing.T) {
	received := make(chan map[string]any, 1)
	url, tlsCfg, _ := newTestServer(t, func(sc *serverConn) {
		_, payload, err := sc.readMessage()
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(payload, &m) == nil {
			select {
			case received <- m:
			default:
			}
		}
	})
	startClient(t, baseOptions(url, tlsCfg))

	select {
	case m := <-received:
		if m["type"] != "hello" {
			t.Fatalf("type = %v", m["type"])
		}
		if m["agent_id"] != "a-1" {
			t.Fatalf("agent_id = %v", m["agent_id"])
		}
		if m["host"] != "machine-cible" {
			t.Fatalf("host = %v", m["host"])
		}
		if v, _ := m["proto_version"].(float64); int(v) != proto.Version {
			t.Fatalf("proto_version = %v", m["proto_version"])
		}
		if v, _ := m["euid"].(float64); int(v) != 1000 {
			t.Fatalf("euid = %v", m["euid"])
		}
		caps, _ := m["caps"].([]any)
		if len(caps) != 1 || caps[0] != "exec" {
			t.Fatalf("caps = %v", m["caps"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("hello non reçu par le serveur")
	}
}

func TestClientSeReconnecte(t *testing.T) {
	url, tlsCfg, count := newTestServer(t, func(sc *serverConn) {
		_, _, _ = sc.readMessage() // hello
		time.Sleep(10 * time.Millisecond)
		// Retour ⇒ fermeture de la connexion par le harnais de test.
	})
	startClient(t, baseOptions(url, tlsCfg))
	waitFor(t, 3*time.Second, func() bool { return count.Load() >= 3 },
		"le client ne s'est pas reconnecté assez de fois")
}

func TestHeartbeatPongMaintientEnLigne(t *testing.T) {
	var pings atomic.Int64
	url, tlsCfg, count := newTestServer(t, func(sc *serverConn) {
		for {
			op, payload, err := sc.readMessage()
			if err != nil {
				return
			}
			if op != opText {
				continue
			}
			msg, err := proto.Decode(payload)
			if err != nil {
				continue
			}
			if _, ok := msg.(*proto.Ping); ok {
				pings.Add(1)
				pong, _ := proto.Encode(&proto.Pong{T: 1})
				if err := sc.writeText(pong); err != nil {
					return
				}
			}
		}
	})
	startClient(t, baseOptions(url, tlsCfg))

	time.Sleep(400 * time.Millisecond)
	if got := count.Load(); got != 1 {
		t.Fatalf("reconnexions inattendues alors que les pongs arrivent : %d connexions", got)
	}
	if pings.Load() < 3 {
		t.Fatalf("pings insuffisants : %d", pings.Load())
	}
}

func TestHeartbeatSansPongDeconnecte(t *testing.T) {
	url, tlsCfg, count := newTestServer(t, func(sc *serverConn) {
		// Lit mais ne répond JAMAIS : le client doit se déclarer hors ligne.
		for {
			if _, _, err := sc.readMessage(); err != nil {
				return
			}
		}
	})
	startClient(t, baseOptions(url, tlsCfg))
	waitFor(t, 3*time.Second, func() bool { return count.Load() >= 2 },
		"le client aurait dû se reconnecter après absence de pong")
}

func TestIdempotenceRejeuIgnore(t *testing.T) {
	var calls atomic.Int64
	sent := make(chan struct{})
	url, tlsCfg, _ := newTestServer(t, func(sc *serverConn) {
		if _, _, err := sc.readMessage(); err != nil {
			return
		}
		cmd, err := proto.Encode(&proto.Cmd{CmdID: "c-1", Command: "true"})
		if err != nil {
			return
		}
		close(sent)
		for i := 0; i < 3; i++ {
			if err := sc.writeText(cmd); err != nil {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	})
	opts := baseOptions(url, tlsCfg)
	opts.Handler = HandlerFunc(func(context.Context, proto.Message, ReplyFunc) error {
		calls.Add(1)
		return nil
	})
	startClient(t, opts)

	<-sent
	time.Sleep(250 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("la commande a été traitée %d fois (idempotence rompue)", got)
	}
}

func TestClientRepondAuxCommandes(t *testing.T) {
	acks := make(chan string, 1)
	url, tlsCfg, _ := newTestServer(t, func(sc *serverConn) {
		if _, _, err := sc.readMessage(); err != nil {
			return
		}
		cmd, err := proto.Encode(&proto.Cmd{CmdID: "c-7", Command: "uname"})
		if err != nil {
			return
		}
		if err := sc.writeText(cmd); err != nil {
			return
		}
		_, payload, err := sc.readMessage()
		if err != nil {
			return
		}
		msg, err := proto.Decode(payload)
		if err != nil {
			return
		}
		if ack, ok := msg.(*proto.Ack); ok {
			acks <- ack.CmdID
		}
	})
	opts := baseOptions(url, tlsCfg)
	opts.Handler = HandlerFunc(func(_ context.Context, msg proto.Message, reply ReplyFunc) error {
		if cmd, ok := msg.(*proto.Cmd); ok {
			return reply(&proto.Ack{CmdID: cmd.CmdID})
		}
		return nil
	})
	startClient(t, opts)

	select {
	case id := <-acks:
		if id != "c-7" {
			t.Fatalf("cmd_id d'ack = %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("aucun accusé reçu par le serveur")
	}
}

func TestTrameInconnueIgnoreeSansCoupure(t *testing.T) {
	got := make(chan string, 1)
	url, tlsCfg, count := newTestServer(t, func(sc *serverConn) {
		if _, _, err := sc.readMessage(); err != nil {
			return
		}
		// Trame d'un type inconnu (ex. `welcome` d'une version antérieure).
		if err := sc.writeText([]byte(`{"type":"welcome","proto_version":1,"agent_id":"x"}`)); err != nil {
			return
		}
		cmd, err := proto.Encode(&proto.Cmd{CmdID: "c-9", Command: "uname"})
		if err != nil {
			return
		}
		if err := sc.writeText(cmd); err != nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	})
	opts := baseOptions(url, tlsCfg)
	opts.Handler = HandlerFunc(func(_ context.Context, msg proto.Message, _ ReplyFunc) error {
		if cmd, ok := msg.(*proto.Cmd); ok {
			select {
			case got <- cmd.CmdID:
			default:
			}
		}
		return nil
	})
	startClient(t, opts)

	select {
	case id := <-got:
		if id != "c-9" {
			t.Fatalf("cmd_id = %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("la commande après une trame inconnue n'a pas été traitée")
	}
	if count.Load() != 1 {
		t.Fatalf("une trame inconnue a provoqué une reconnexion : %d connexions", count.Load())
	}
}

// TestAucuneFileHorsLigne : quand le serveur est injoignable, l'agent ne
// mémorise AUCUNE commande (livraison au plus une fois, sans file — D124).
func TestAucuneFileHorsLigne(t *testing.T) {
	var calls atomic.Int64
	opts := Options{
		URL:          "ws://127.0.0.1:1/ws",
		Hello:        testHello(),
		Handler:      HandlerFunc(func(context.Context, proto.Message, ReplyFunc) error { calls.Add(1); return nil }),
		BaseDelay:    20 * time.Millisecond,
		MaxDelay:     40 * time.Millisecond,
		PingInterval: 25 * time.Millisecond,
		OfflineAfter: 75 * time.Millisecond,
	}
	startClient(t, opts)
	time.Sleep(300 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatalf("des commandes ont été « rejouées » hors ligne : %d", calls.Load())
	}
}

func TestNewClientValide(t *testing.T) {
	if _, err := NewClient(Options{}); err == nil {
		t.Fatal("URL vide acceptée")
	}
	if _, err := NewClient(Options{URL: "ws://localhost/ws"}); err == nil {
		t.Fatal("Handler absent accepté")
	}
	if _, err := NewClient(Options{
		URL:          "ws://localhost/ws",
		Handler:      nopHandler(),
		PingInterval: 100 * time.Millisecond,
		OfflineAfter: 50 * time.Millisecond,
	}); err == nil {
		t.Fatal("OfflineAfter < PingInterval accepté")
	}
}

func TestNewClientJitterParDefaut(t *testing.T) {
	client, err := NewClient(Options{
		URL:          "ws://localhost/ws",
		Handler:      nopHandler(),
		PingInterval: 100 * time.Millisecond,
		OfflineAfter: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewClient : %v", err)
	}
	// Le jitter est ACTIF par défaut (Options.Jitter == 0 ⇒ DefaultJitter).
	if client.opts.Jitter != DefaultJitter {
		t.Fatalf("Jitter = %v, attendu %v", client.opts.Jitter, DefaultJitter)
	}
	if client.backoff.Jitter != DefaultJitter {
		t.Fatalf("backoff.Jitter = %v", client.backoff.Jitter)
	}
}

func TestDialRejetteSchema(t *testing.T) {
	if _, err := Dial(context.Background(), "http://localhost/ws", DialOptions{}); err == nil {
		t.Fatal("schéma http accepté")
	}
	if _, err := Dial(context.Background(), "wss://127.0.0.1:1/ws", DialOptions{}); err == nil {
		t.Fatal("wss sans TLSConfig accepté")
	}
}
