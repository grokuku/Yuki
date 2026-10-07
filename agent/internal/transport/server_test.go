package transport

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var errServerProtocol = errors.New("serveur de test : trame inattendue")

// serverConn est le pendant SERVEUR minimal utilisé par les tests : il lit des
// trames clientes (masquées) et écrit des trames non masquées.
type serverConn struct {
	t      *testing.T
	conn   net.Conn
	br     *bufio.Reader
	wmu    sync.Mutex
	closed atomic.Bool
}

func (s *serverConn) readMessage() (byte, []byte, error) {
	var dataOpcode byte
	var assembled []byte
	started := false
	for {
		fin, op, payload, err := readFrame(s.br)
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			_ = s.writeFrame(opPong, payload)
			continue
		case opPong:
			continue
		case opClose:
			return 0, nil, ErrClosed
		case opText, opBinary:
			dataOpcode = op
			started = true
		case opContinuation:
			if !started {
				return 0, nil, errServerProtocol
			}
		default:
			return 0, nil, errServerProtocol
		}
		assembled = append(assembled, payload...)
		if fin {
			return dataOpcode, assembled, nil
		}
	}
}

func (s *serverConn) writeText(payload []byte) error {
	return s.writeFrame(opText, payload)
}

func (s *serverConn) writeJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.writeFrame(opText, data)
}

func (s *serverConn) writeFrame(op byte, payload []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if s.closed.Load() {
		return ErrClosed
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return writeFrame(s.conn, true, op, payload, false, nil)
}

func (s *serverConn) close() {
	if s.closed.CompareAndSwap(false, true) {
		_ = s.conn.Close()
	}
}

// newTestServer démarre un serveur WebSocket TLS local (boucle locale, certificat
// `httptest`) et renvoie son URL `wss://`, la configuration TLS cliente qui lui
// fait confiance, et le compteur de connexions acceptées.
func newTestServer(t *testing.T, serve func(*serverConn)) (string, *tls.Config, *atomic.Int64) {
	t.Helper()
	count := &atomic.Int64{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
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
		key := r.Header.Get("Sec-WebSocket-Key")
		response := "HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + secWebSocketAccept(key) + "\r\n\r\n"
		if _, err := rw.WriteString(response); err != nil {
			netConn.Close()
			return
		}
		if err := rw.Flush(); err != nil {
			netConn.Close()
			return
		}
		sc := &serverConn{t: t, conn: netConn, br: rw.Reader}
		defer sc.close()
		serve(sc)
	}))
	t.Cleanup(srv.Close)

	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	clientTLS := &tls.Config{
		RootCAs:    pool,
		ServerName: "127.0.0.1",
		MinVersion: tls.VersionTLS13,
	}
	return "wss://" + srv.Listener.Addr().String() + "/ws", clientTLS, count
}
