package transport

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"testing"
)

func TestCadreAllerRetourMasque(t *testing.T) {
	sizes := []int{0, 1, 125, 126, 127, 65535, 65536}
	for _, size := range sizes {
		payload := bytes.Repeat([]byte{0xAB}, size)
		var buf bytes.Buffer
		if err := writeFrame(&buf, true, opText, payload, true, rand.Reader); err != nil {
			t.Fatalf("taille %d : writeFrame : %v", size, err)
		}
		br := bufio.NewReader(&buf)
		fin, opcode, got, err := readFrame(br)
		if err != nil {
			t.Fatalf("taille %d : readFrame : %v", size, err)
		}
		if !fin || opcode != opText {
			t.Fatalf("taille %d : fin=%v opcode=%x", size, fin, opcode)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("taille %d : charge altérée (%d octets)", size, len(got))
		}
	}
}

func TestCadreAllerRetourSansMasque(t *testing.T) {
	payload := []byte("hello")
	var buf bytes.Buffer
	if err := writeFrame(&buf, false, opText, payload, false, nil); err != nil {
		t.Fatalf("writeFrame : %v", err)
	}
	_, _, got, err := readFrame(bufio.NewReader(&buf))
	if err != nil {
		t.Fatalf("readFrame : %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("charge = %q", got)
	}
}

func TestReadFrameRejetteRSV(t *testing.T) {
	// Premier octet avec le bit RSV1 levé.
	raw := []byte{0x80 | 0x40 | opText, 0x00}
	if _, _, _, err := readFrame(bufio.NewReader(bytes.NewReader(raw))); err == nil {
		t.Fatal("RSV non nul accepté")
	}
}

func TestSecWebSocketAcceptRFC6455(t *testing.T) {
	// Exemple officiel de la RFC 6455 (§1.3).
	got := secWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("accept = %q, attendu %q", got, want)
	}
}

func TestHeaderContainsToken(t *testing.T) {
	if !headerContainsToken("keep-alive, Upgrade", "upgrade") {
		t.Fatal("jeton Upgrade non détecté")
	}
	if headerContainsToken("close", "upgrade") {
		t.Fatal("jeton Upgrade détecté à tort")
	}
}
