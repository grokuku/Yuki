package agent

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/grokuku/yuki/agent/internal/exec"
	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/screen"
	"github.com/grokuku/yuki/agent/internal/transport"
)

func newScreenshotRuntime(t *testing.T, logger transport.Logger) *Runtime {
	t.Helper()
	cfg := &Config{}
	cfg.ApplyDefaults()
	sup := exec.NewSupervisor(exec.New(exec.Options{}))
	return NewRuntime(cfg, sup, logger)
}

func TestScreenshotRefusSansCapacite(t *testing.T) {
	rt := newScreenshotRuntime(t, transport.NopLogger{})
	// Force l'absence de capacité (environnement de test : aucun écran).
	rt.screenOK = false
	// Un capteur qui échouerait le test s'il était appelé.
	rt.captureFn = func(context.Context, screen.Plan, screen.Options) (*screen.Shot, error) {
		t.Fatal("capture appelée alors que la capacité est absente")
		return nil, nil
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(context.Background(), &proto.Screenshot{CmdID: "s-1"}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	errFrame, _ := replies.first(proto.TypeError).(*proto.Error)
	if errFrame == nil {
		t.Fatalf("aucune trame d'erreur : %v", replies.all())
	}
	if errFrame.Code != proto.CodeUnsupported {
		t.Fatalf("code = %q, attendu %q", errFrame.Code, proto.CodeUnsupported)
	}
	if !strings.Contains(errFrame.Message, "aucun écran") {
		t.Fatalf("message non explicite : %q", errFrame.Message)
	}
	if errFrame.Ref != "s-1" {
		t.Fatalf("ref = %q", errFrame.Ref)
	}
}

func TestScreenshotRenvoieMetadonneesEtBase64(t *testing.T) {
	logger := &captureLogger{}
	rt := newScreenshotRuntime(t, logger)
	rt.screenOK = true
	rt.screenPlan = screen.Plan{Tool: "grim", Env: "WAYLAND_DISPLAY"}
	pixels := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10} // faux JPEG suffisant
	rt.captureFn = func(_ context.Context, plan screen.Plan, opts screen.Options) (*screen.Shot, error) {
		if plan.Tool != "grim" {
			t.Fatalf("plan = %+v", plan)
		}
		if opts.MaxEdge != 1280 || opts.Quality != 65 {
			t.Fatalf("opts = %+v", opts)
		}
		return &screen.Shot{
			Format: "jpeg", Width: 1280, Height: 720, Bytes: len(pixels), Data: pixels,
		}, nil
	}
	replies := &replyCollector{}
	req := &proto.Screenshot{CmdID: "s-2", MaxEdge: 1280, Quality: 65}
	if err := rt.HandleMessage(context.Background(), req, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	frame, _ := waitReply(t, replies, proto.TypeScreenshotData).(*proto.ScreenshotData)
	if frame == nil {
		t.Fatalf("aucune trame screenshot_data : %v", replies.all())
	}
	if frame.CmdID != "s-2" || frame.Format != "jpeg" || frame.Width != 1280 || frame.Height != 720 {
		t.Fatalf("métadonnées = %+v", frame)
	}
	if frame.Bytes != len(pixels) {
		t.Fatalf("bytes = %d, attendu %d", frame.Bytes, len(pixels))
	}
	decoded, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil || string(decoded) != string(pixels) {
		t.Fatalf("payload base64 invalide : %v", err)
	}

	// ⚠️ Anti-exfiltration : le journal de l'agent ne doit JAMAIS contenir les
	// octets de l'image (uniquement des métadonnées).
	for _, line := range logger.lines {
		if strings.Contains(line, string(pixels)) {
			t.Fatalf("contenu d'image journalisé : %s", line)
		}
	}
	if !logger.has("agent.capture.terminee") {
		t.Fatalf("issue non journalisée : %v", logger.lines)
	}
}

func TestScreenshotRefusTropLourde(t *testing.T) {
	rt := newScreenshotRuntime(t, transport.NopLogger{})
	rt.screenOK = true
	rt.captureFn = func(context.Context, screen.Plan, screen.Options) (*screen.Shot, error) {
		return nil, screen.ErrTooLarge
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(context.Background(), &proto.Screenshot{CmdID: "s-3"}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	errFrame, _ := waitReply(t, replies, proto.TypeError).(*proto.Error)
	if errFrame == nil {
		t.Fatalf("aucune trame d'erreur : %v", replies.all())
	}
	if errFrame.Code != proto.CodeTooLarge {
		t.Fatalf("code = %q, attendu %q", errFrame.Code, proto.CodeTooLarge)
	}
	if !strings.Contains(errFrame.Message, "trop lourde") {
		t.Fatalf("message non explicite : %q", errFrame.Message)
	}
}

func TestScreenshotTimeoutTransmis(t *testing.T) {
	rt := newScreenshotRuntime(t, transport.NopLogger{})
	rt.screenOK = true
	got := make(chan time.Duration, 1)
	rt.captureFn = func(_ context.Context, _ screen.Plan, opts screen.Options) (*screen.Shot, error) {
		got <- opts.Timeout
		return &screen.Shot{Format: "jpeg", Width: 10, Height: 10, Bytes: 1, Data: []byte{0}}, nil
	}
	replies := &replyCollector{}
	req := &proto.Screenshot{CmdID: "s-4", TimeoutMs: 5000}
	if err := rt.HandleMessage(context.Background(), req, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	select {
	case d := <-got:
		if d != 5*time.Second {
			t.Fatalf("timeout = %v, attendu 5s", d)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("capture non appelée")
	}
}
