package screen

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"os"
	"testing"
)

/* ─── Détection ─────────────────────────────────────────────────────────── */

func envOf(values map[string]string) GetenvFunc {
	return func(key string) string { return values[key] }
}

func lookPathOf(found ...string) LookPathFunc {
	set := make(map[string]bool, len(found))
	for _, name := range found {
		set[name] = true
	}
	return func(file string) (string, error) {
		if set[file] {
			return "/usr/bin/" + file, nil
		}
		return "", errors.New("introuvable")
	}
}

func TestDetectSansEcran(t *testing.T) {
	plan, ok := Detect("linux", envOf(nil), lookPathOf("scrot", "grim"))
	if ok {
		t.Fatalf("capacité déclarée sans écran : %+v", plan)
	}
}

func TestDetectSansOutil(t *testing.T) {
	env := envOf(map[string]string{"DISPLAY": ":0"})
	if _, ok := Detect("linux", env, lookPathOf()); ok {
		t.Fatal("capacité déclarée sans outil de capture")
	}
}

func TestDetectX11(t *testing.T) {
	env := envOf(map[string]string{"DISPLAY": ":0"})
	plan, ok := Detect("linux", env, lookPathOf("scrot"))
	if !ok || plan.Tool != "scrot" || plan.Env != "DISPLAY" {
		t.Fatalf("plan = %+v, ok = %v", plan, ok)
	}
}

func TestDetectWaylandPreereGrim(t *testing.T) {
	// Session Wayland exposant aussi DISPLAY (XWayland) avec les deux outils :
	// grim doit être préféré aux outils X11.
	env := envOf(map[string]string{"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0"})
	plan, ok := Detect("linux", env, lookPathOf("grim", "scrot"))
	if !ok || plan.Tool != "grim" || plan.Env != "WAYLAND_DISPLAY" {
		t.Fatalf("plan = %+v, ok = %v", plan, ok)
	}
}

func TestDetectWaylandRepliX11(t *testing.T) {
	// Wayland annoncé mais grim absent : on retombe sur un outil X11 présent.
	env := envOf(map[string]string{"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0"})
	plan, ok := Detect("linux", env, lookPathOf("import"))
	if !ok || plan.Tool != "import" {
		t.Fatalf("plan = %+v, ok = %v", plan, ok)
	}
}

func TestDetectWindowsSansSession(t *testing.T) {
	if _, ok := Detect("windows", envOf(nil), lookPathOf("powershell")); ok {
		t.Fatal("capacité déclarée sur Windows sans session interactive")
	}
}

func TestDetectWindowsAvecSession(t *testing.T) {
	env := envOf(map[string]string{"SESSIONNAME": "Console"})
	plan, ok := Detect("windows", env, lookPathOf("powershell"))
	if !ok || plan.Tool != "powershell" || plan.Env != "SESSIONNAME" {
		t.Fatalf("plan = %+v, ok = %v", plan, ok)
	}
}

func TestScreenDetected(t *testing.T) {
	cases := []struct {
		goos string
		env  map[string]string
		want bool
	}{
		{"linux", nil, false},
		{"linux", map[string]string{"DISPLAY": ":0"}, true},
		{"linux", map[string]string{"WAYLAND_DISPLAY": "wayland-1"}, true},
		{"darwin", map[string]string{"DISPLAY": ":0"}, true},
		{"windows", nil, false},
		{"windows", map[string]string{"SESSIONNAME": "Console"}, true},
	}
	for _, c := range cases {
		if got := ScreenDetected(c.goos, envOf(c.env)); got != c.want {
			t.Errorf("ScreenDetected(%q, %v) = %v, attendu %v", c.goos, c.env, got, c.want)
		}
	}
}

/* ─── Capture ────────────────────────────────────────────────────────────── */

// fakeRunner produit une image PNG de `w`×`h`. Pour un outil à fichier (`scrot`),
// il écrit dans le chemin fourni ; pour un outil stdout (`grim`), il renvoie le
// PNG directement.
type fakeRunner struct {
	w, h, seed int
}

func (f fakeRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	img := noiseImage(f.w, f.h, f.seed)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	if name == "scrot" || name == "gnome-screenshot" || name == "spectacle" {
		if len(args) == 0 {
			return nil, errors.New("chemin attendu")
		}
		path := args[len(args)-1]
		if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return buf.Bytes(), nil
}

// noiseImage : image RGB à haute entropie (le pire cas pour le JPEG).
func noiseImage(w, h, seed int) image.Image {
	rng := rand.New(rand.NewSource(int64(seed)))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8(rng.Intn(256)),
				G: uint8(rng.Intn(256)),
				B: uint8(rng.Intn(256)),
				A: 0xff,
			})
		}
	}
	return img
}

func TestCaptureStdoutRedimensionne(t *testing.T) {
	plan := Plan{Tool: "grim", Env: "WAYLAND_DISPLAY"}
	shot, err := Capture(context.Background(), plan, Options{
		MaxEdge: 320,
		Runner:  fakeRunner{w: 2000, h: 1000, seed: 1},
	})
	if err != nil {
		t.Fatalf("Capture : %v", err)
	}
	if shot.Width > 320 || shot.Height > 320 {
		t.Fatalf("dimensions non bornées : %d×%d", shot.Width, shot.Height)
	}
	if shot.Format != "jpeg" || shot.Bytes == 0 {
		t.Fatalf("shot = %+v", shot)
	}
	if base64Len(shot.Bytes) > HardCapBase64Bytes {
		t.Fatalf("charge base64 %d > plafond %d", base64Len(shot.Bytes), HardCapBase64Bytes)
	}
}

func TestCaptureFichierTemporaireSupprime(t *testing.T) {
	dir := t.TempDir()
	plan := Plan{Tool: "scrot", Env: "DISPLAY"}
	if _, err := Capture(context.Background(), plan, Options{
		MaxEdge: 640,
		Runner:  fakeRunner{w: 1280, h: 720, seed: 2},
		TempDir: dir,
	}); err != nil {
		t.Fatalf("Capture : %v", err)
	}
	// Aucun résidu : le dossier temporaire est vidé (le dossier parent, fourni
	// par `TempDir`, reste).
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir : %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("résidu sur disque : %v", entries)
	}
}

func TestCaptureImageVolumineuseCompressee(t *testing.T) {
	// Image 3000×2000 à haute entropie : le résultat DOIT tenir sous le plafond
	// dur (redimensionnement + JPEG adaptatifs).
	plan := Plan{Tool: "grim", Env: "WAYLAND_DISPLAY"}
	shot, err := Capture(context.Background(), plan, Options{
		Runner: fakeRunner{w: 3000, h: 2000, seed: 3},
	})
	if err != nil {
		t.Fatalf("Capture : %v", err)
	}
	if base64Len(shot.Bytes) > HardCapBase64Bytes {
		t.Fatalf("charge base64 %d > plafond %d", base64Len(shot.Bytes), HardCapBase64Bytes)
	}
	if shot.Width > DefaultMaxEdge || shot.Height > DefaultMaxEdge {
		t.Fatalf("côté long non borné : %d×%d", shot.Width, shot.Height)
	}
}

func TestCaptureRefusSiTropLourde(t *testing.T) {
	// Plafond DUR artificiellement minuscule : aucune recompression ne peut le
	// respecter ⇒ refus HONNÊTE (jamais une image tronquée en silence).
	plan := Plan{Tool: "grim", Env: "WAYLAND_DISPLAY"}
	_, err := Capture(context.Background(), plan, Options{
		Runner:         fakeRunner{w: 2000, h: 1200, seed: 4},
		MaxBase64Bytes: 100,
	})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, attendu ErrTooLarge", err)
	}
}

func TestCaptureOutilsInconnus(t *testing.T) {
	if _, err := Capture(context.Background(), Plan{Tool: "nope"}, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("err = %v, attendu ErrUnsupported", err)
	}
}

func TestCaptureBase64Windows(t *testing.T) {
	// PowerShell renvoie l'image en base64 sur stdout : elle doit être décodée.
	img := noiseImage(64, 48, 5)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	runner := b64Runner{payload: base64.StdEncoding.EncodeToString(buf.Bytes())}
	shot, err := Capture(context.Background(), Plan{Tool: "powershell", Env: "SESSIONNAME"}, Options{Runner: runner})
	if err != nil {
		t.Fatalf("Capture : %v", err)
	}
	if shot.Width != 64 || shot.Height != 48 {
		t.Fatalf("dimensions = %d×%d", shot.Width, shot.Height)
	}
}

type b64Runner struct{ payload string }

func (b b64Runner) Output(context.Context, string, ...string) ([]byte, error) {
	return []byte(b.payload), nil
}

func TestBase64Len(t *testing.T) {
	for n := 0; n < 50; n++ {
		got := base64Len(n)
		want := len(base64.StdEncoding.EncodeToString(make([]byte, n)))
		if got != want {
			t.Errorf("base64Len(%d) = %d, attendu %d", n, got, want)
		}
	}
}

func TestScaleDownNeGrossitPas(t *testing.T) {
	src := noiseImage(100, 50, 6)
	out := scaleDown(src, 1600)
	if out.Bounds() != src.Bounds() {
		t.Fatalf("agrandissement interdit : %v", out.Bounds())
	}
}
