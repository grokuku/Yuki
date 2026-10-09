// Package screen — détection d'un ÉCRAN + d'un OUTIL de capture, puis capture
// d'écran redimensionnée en JPEG, SANS dépendance externe.
//
// # Pourquoi ce paquet
//
// L'agent d'exécution sait déjà lancer n'importe quelle commande (`exec`), donc
// lancer `scrot`/`grim` est trivial. Le VRAI trou est le RETOUR : la sortie d'une
// commande est plafonnée à 256 Kio par flux et rendue en TEXTE. Ce paquet
// produit une image PRÊTE À TRANSPORTER (JPEG borné, encodable en base64 sous le
// plafond dur de 256 Kio).
//
// # Décisions appliquées
//
//   - La capacité n'est déclarée QUE si un outil de capture EST présent ET qu'un
//     ÉCRAN est détecté. Sinon `Detect` renvoie `false` : l'agent N'ANNONCE PAS
//     une capacité qu'il ne peut pas honorer (aucun échec silencieux).
//   - Écran détecté : `DISPLAY` ou `WAYLAND_DISPLAY` non vides sous Linux/macOS ;
//     sous Windows (ni l'un ni l'autre) le signal est `SESSIONNAME` non vide, qui
//     distingue une session interactive d'un service sans bureau.
//   - Rien ne persiste sur disque : les outils qui ne savent pas écrire sur
//     stdout (scrot, gnome-screenshot, spectacle) reçoivent un fichier TEMPORAIRE
//     créé sous `os.MkdirTemp` et SUPPRIMÉ aussitôt (dossier compris) ; les autres
//     écrivent directement sur stdout.
package screen

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	// Décodeurs d'image : les outils écrivent PNG (grim/import), parfois JPEG.
	_ "image/gif"
	_ "image/png"
)

const (
	// DefaultMaxEdge : côté long maximal d'une capture, en pixels.
	DefaultMaxEdge = 1600
	// DefaultQuality : qualité JPEG par défaut (1..100).
	DefaultQuality = 70
	// MinQuality : qualité JPEG plancher lors du redimensionnement adaptatif.
	MinQuality = 40
	// TargetBinaryBytes : cible de taille binaire (l'image « tient » sous
	// ~200 Kio une fois encodée en base64).
	TargetBinaryBytes = 150 * 1024
	// HardCapBase64Bytes : plafond DUR de la charge utile base64 (256 Kio). Au
	// delà, la capture est refusée honnêtement (`ErrTooLarge`).
	HardCapBase64Bytes = 256 * 1024
	// DefaultTimeout : délai maximal d'une capture.
	DefaultTimeout = 20 * time.Second

	// maxAttempts : nombre d'essais de recompression (diminution qualité/taille).
	maxAttempts = 8
)

// ErrTooLarge : la capture reste trop lourde après redimensionnement et
// compression ; aucun envoi n'est possible sous le plafond dur.
var ErrTooLarge = errors.New("screen : capture trop lourde après compression")

// ErrUnsupported : aucun outil de capture ou aucun écran détecté.
var ErrUnsupported = errors.New("screen : capture d'écran indisponible (aucun outil ou écran détecté)")

// LookPathFunc a la signature de `os/exec.LookPath` (injectable pour les tests).
type LookPathFunc func(file string) (string, error)

// GetenvFunc a la signature de `os.Getenv` (injectable pour les tests).
type GetenvFunc func(key string) string

// Plan décrit la capture retenue après détection.
type Plan struct {
	// Tool : nom de l'outil détecté (`grim`, `import`, `scrot`,
	// `gnome-screenshot`, `spectacle`, `powershell`).
	Tool string
	// Env : variable d'environnement qui a permis de qualifier l'écran
	// (`DISPLAY`, `WAYLAND_DISPLAY` ou `SESSIONNAME`).
	Env string
}

// specFor renvoie la spécification d'exécution d'un outil, ou `false` si le nom
// est inconnu.
//
// `stream` : l'image est écrite sur STDOUT (sinon dans un fichier temporaire).
// `encode` : la sortie stdout est du base64 (Windows/PowerShell).
// `args`   : construit les arguments (`out` = chemin temporaire, vide si stdout).
type toolSpec struct {
	name   string
	env    string
	stream bool
	b64    bool
	ext    string
	args   func(out string, quality int) []string
}

var toolSpecs = map[string]toolSpec{
	"grim": {
		name: "grim", env: "WAYLAND_DISPLAY", stream: true, ext: "png",
		args: func(_ string, _ int) []string { return []string{"-t", "png", "-"} },
	},
	"import": {
		name: "import", env: "DISPLAY", stream: true, ext: "png",
		args: func(_ string, _ int) []string {
			return []string{"-silent", "-window", "root", "png:-"}
		},
	},
	"scrot": {
		name: "scrot", env: "DISPLAY", stream: false, ext: "png",
		args: func(out string, quality int) []string {
			return []string{"-q", strconv.Itoa(clampQuality(quality)), out}
		},
	},
	"gnome-screenshot": {
		name: "gnome-screenshot", env: "DISPLAY", stream: false, ext: "png",
		args: func(out string, _ int) []string { return []string{"-f", out} },
	},
	"spectacle": {
		name: "spectacle", env: "WAYLAND_DISPLAY", stream: false, ext: "png",
		args: func(out string, _ int) []string {
			return []string{"-b", "-n", "-o", out}
		},
	},
	"powershell": {
		name: "powershell", env: "SESSIONNAME", stream: true, b64: true, ext: "png",
		args: func(_ string, _ int) []string {
			return []string{"-NoProfile", "-NonInteractive", "-Command", powershellScript}
		},
	},
}

// powershellScript capture l'écran virtuel et écrit l'image PNG encodée en
// base64 sur STDOUT (aucun fichier). Le Go décode le base64 puis re-encode en
// JPEG.
const powershellScript = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing | Out-Null;` +
	`$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;` +
	`$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);` +
	`$g=[System.Drawing.Graphics]::FromImage($bmp);` +
	`$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);` +
	`$ms=New-Object System.IO.MemoryStream;` +
	`$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);` +
	`[Convert]::ToBase64String($ms.ToArray())`

// candidates renvoie, dans l'ordre de préférence, les outils susceptibles
// d'être présents pour la session courante.
//
// Wayland est préféré quand `WAYLAND_DISPLAY` est posé (une session Wayland
// expose souvent aussi `DISPLAY` via XWayland, mais les outils X11 y capturent
// mal). Les doublons sont éliminés en conservant le premier rang.
func candidates(goos string, getenv GetenvFunc) []string {
	if goos == "windows" {
		return []string{"powershell"}
	}
	var out []string
	seen := make(map[string]bool)
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	if getenv("WAYLAND_DISPLAY") != "" {
		add("grim")
		add("spectacle")
	}
	if getenv("DISPLAY") != "" {
		add("scrot")
		add("import")
		add("gnome-screenshot")
		add("spectacle")
	}
	return out
}

// ScreenDetected indique qu'un ÉCRAN est exploitable pour la plateforme.
//
//   - Windows : `SESSIONNAME` non vide (session interactive ; un service sans
//     bureau ne l'a pas) ;
//   - autres : `DISPLAY` ou `WAYLAND_DISPLAY` non vide.
func ScreenDetected(goos string, getenv GetenvFunc) bool {
	if getenv == nil {
		getenv = os.Getenv
	}
	if goos == "windows" {
		return getenv("SESSIONNAME") != ""
	}
	return getenv("DISPLAY") != "" || getenv("WAYLAND_DISPLAY") != ""
}

// Detect décide si une capture est POSSIBLE. Renvoie le plan retenu et `true`
// si (et seulement si) un écran ET un outil de capture sont présents.
//
// `getenv`/`lookPath` nuls ⇒ `os.Getenv`/`os/exec.LookPath`.
func Detect(goos string, getenv GetenvFunc, lookPath LookPathFunc) (Plan, bool) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if !ScreenDetected(goos, getenv) {
		return Plan{}, false
	}
	for _, name := range candidates(goos, getenv) {
		if _, err := lookPath(name); err != nil {
			continue
		}
		spec, ok := toolSpecs[name]
		if !ok {
			continue
		}
		return Plan{Tool: spec.name, Env: spec.env}, true
	}
	return Plan{}, false
}

// Shot est une capture PRÊTE À TRANSPORTER.
type Shot struct {
	// Format : toujours `jpeg`.
	Format string
	Width  int
	Height int
	// Bytes : taille BINAIRE des données (avant base64).
	Bytes int
	// Data : octets JPEG.
	Data []byte
}

// Runner exécute un outil et renvoie sa sortie standard. Injectable (tests).
type Runner interface {
	Output(ctx context.Context, name string, args ...string) ([]byte, error)
}

// OSRunner exécute réellement le binaire via `os/exec`.
type OSRunner struct{}

// Output exécute `name args…` et renvoie stdout. stderr est agrégé à l'erreur.
func (OSRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// Pas d'entrée interactive.
	cmd.Stdin = nil
	if err := cmd.Run(); err != nil {
		msg := bytes.TrimSpace(stderr.Bytes())
		if len(msg) > 0 {
			return nil, fmt.Errorf("%s : %w (%s)", name, err, string(msg))
		}
		return nil, fmt.Errorf("%s : %w", name, err)
	}
	return stdout.Bytes(), nil
}

// Options règle la capture.
type Options struct {
	// MaxEdge : côté long maximal (px). <= 0 ⇒ `DefaultMaxEdge`.
	MaxEdge int
	// Quality : qualité JPEG (1..100). <= 0 ⇒ `DefaultQuality`.
	Quality int
	// MaxBinaryBytes : cible de taille binaire. <= 0 ⇒ `TargetBinaryBytes`.
	MaxBinaryBytes int
	// MaxBase64Bytes : plafond DUR de la charge utile base64. <= 0 ⇒
	// `HardCapBase64Bytes`. Au-delà : `ErrTooLarge`.
	MaxBase64Bytes int
	// Timeout : délai maximal. <= 0 ⇒ `DefaultTimeout`.
	Timeout time.Duration
	// Runner : exécuteur d'outil. Nil ⇒ `OSRunner{}`.
	Runner Runner
	// TempDir : répertoire des fichiers temporaires. Vide ⇒ `os.MkdirTemp`.
	TempDir string
}

func (o Options) withDefaults() Options {
	if o.MaxEdge <= 0 {
		o.MaxEdge = DefaultMaxEdge
	}
	if o.Quality <= 0 {
		o.Quality = DefaultQuality
	}
	if o.MaxBinaryBytes <= 0 {
		o.MaxBinaryBytes = TargetBinaryBytes
	}
	if o.MaxBase64Bytes <= 0 {
		o.MaxBase64Bytes = HardCapBase64Bytes
	}
	if o.Timeout <= 0 {
		o.Timeout = DefaultTimeout
	}
	if o.Runner == nil {
		o.Runner = OSRunner{}
	}
	return o
}

// Available indique si `plan` désigne un outil connu.
func Available(plan Plan) bool {
	_, ok := toolSpecs[plan.Tool]
	return ok
}

// Capture exécute l'outil du plan, décode l'image, la redimensionne (côté long
// ≤ `MaxEdge`), l'encode en JPEG et garantit que la charge base64 reste sous le
// plafond DUR (256 Kio). Au-delà, `ErrTooLarge` est renvoyé (refus honnête).
func Capture(ctx context.Context, plan Plan, opts Options) (*Shot, error) {
	spec, ok := toolSpecs[plan.Tool]
	if !ok {
		return nil, ErrUnsupported
	}
	opts = opts.withDefaults()

	runCtx := ctx
	var cancel context.CancelFunc
	if opts.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}

	raw, err := runTool(runCtx, spec, opts)
	if err != nil {
		return nil, err
	}
	if spec.b64 {
		decoded, decErr := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(raw)))
		if decErr != nil {
			return nil, fmt.Errorf("screen : sortie base64 illisible : %w", decErr)
		}
		raw = decoded
	}
	return encodeJPEG(raw, opts)
}

// runTool exécute l'outil et renvoie les OCTETS de l'image (PNG/JPEG brut).
func runTool(ctx context.Context, spec toolSpec, opts Options) ([]byte, error) {
	if spec.stream {
		return opts.Runner.Output(ctx, spec.name, spec.args("", opts.Quality)...)
	}
	// Outil à fichier : dossier temporaire SUPPRIMÉ quoi qu'il arrive.
	dir, err := os.MkdirTemp(opts.TempDir, "yuki-shot-")
	if err != nil {
		return nil, fmt.Errorf("screen : dossier temporaire : %w", err)
	}
	defer os.RemoveAll(dir)

	out := filepath.Join(dir, "shot."+spec.ext)
	if _, err := opts.Runner.Output(ctx, spec.name, spec.args(out, opts.Quality)...); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(out)
	if err != nil {
		return nil, fmt.Errorf("screen : lecture de la capture : %w", err)
	}
	return data, nil
}

// encodeJPEG décode `raw`, redimensionne et encode en JPEG sous le plafond dur.
func encodeJPEG(raw []byte, opts Options) (*Shot, error) {
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("screen : image illisible : %w", err)
	}
	b := src.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 {
		return nil, errors.New("screen : image vide")
	}

	maxEdge := opts.MaxEdge
	quality := clampQuality(opts.Quality)
	var last *Shot
	for attempt := 0; attempt < maxAttempts; attempt++ {
		scaled := scaleDown(src, maxEdge)
		data, encErr := encodeOnce(scaled, quality)
		if encErr != nil {
			return nil, encErr
		}
		sb := scaled.Bounds()
		last = &Shot{
			Format: "jpeg",
			Width:  sb.Dx(),
			Height: sb.Dy(),
			Bytes:  len(data),
			Data:   data,
		}
		fitsHard := base64Len(len(data)) <= opts.MaxBase64Bytes
		fitsTarget := len(data) <= opts.MaxBinaryBytes
		if fitsHard && (fitsTarget || maxEdge <= 640) {
			// Sous le plafond dur, et soit sous la cible, soit déjà bien réduit.
			return last, nil
		}
		// Réduit la qualité puis, si le plancher est atteint, la dimension.
		if quality > MinQuality {
			quality -= 10
			continue
		}
		maxEdge = maxEdge * 4 / 5
		if maxEdge < 320 {
			maxEdge = 320
		}
		if last.Width <= 320 && last.Height <= 320 {
			break
		}
	}
	if last == nil {
		return nil, errors.New("screen : encodage impossible")
	}
	if base64Len(last.Bytes) > opts.MaxBase64Bytes {
		return nil, ErrTooLarge
	}
	return last, nil
}

// encodeOnce encode une image en JPEG au niveau `quality`.
func encodeOnce(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("screen : encodage JPEG : %w", err)
	}
	return buf.Bytes(), nil
}

// base64Len : longueur de l'encodage base64 standard (avec remplissage).
func base64Len(n int) int {
	return 4 * ((n + 2) / 3)
}

// clampQuality borne la qualité JPEG dans [MinQuality, 100].
func clampQuality(q int) int {
	if q < MinQuality {
		return MinQuality
	}
	if q > 100 {
		return 100
	}
	return q
}

// scaleDown réduit `src` pour que son côté long tienne sous `maxEdge`, en
// conservant le ratio. Aucun agrandissement n'est fait. Réduction par moyenne
// de blocs (box filter) : bon compromis qualité/coût, sans dépendance.
func scaleDown(src image.Image, maxEdge int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if maxEdge <= 0 {
		maxEdge = DefaultMaxEdge
	}
	longest := w
	if h > longest {
		longest = h
	}
	if longest <= maxEdge {
		return src
	}
	dstW := w * maxEdge / longest
	dstH := h * maxEdge / longest
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}
	return boxResize(src, dstW, dstH)
}

// boxResize réduit `src` vers `dstW`×`dstH` par moyenne de blocs.
func boxResize(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for dy := 0; dy < dstH; dy++ {
		y0 := b.Min.Y + dy*sh/dstH
		y1 := b.Min.Y + (dy+1)*sh/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for dx := 0; dx < dstW; dx++ {
			x0 := b.Min.X + dx*sw/dstW
			x1 := b.Min.X + (dx+1)*sw/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rs, gs, bs, as, n uint64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					r, g, bl, a := src.At(x, y).RGBA()
					rs += uint64(r)
					gs += uint64(g)
					bs += uint64(bl)
					as += uint64(a)
					n++
				}
			}
			if n == 0 {
				continue
			}
			// RGBA() renvoie des canaux 16 bits prémultipliés : on repasse en
			// 8 bits non prémultipliés pour `image.RGBA`.
			dst.SetRGBA(dx, dy, colorFromAverages(rs, gs, bs, as, n))
		}
	}
	return dst
}

// colorFromAverages convertit des sommes RGBA 16 bits prémultipliées en couleur
// 8 bits non prémultipliée.
func colorFromAverages(rs, gs, bs, as, n uint64) color.RGBA {
	ar := uint32(rs / n)
	ag := uint32(gs / n)
	ab := uint32(bs / n)
	aa := uint32(as / n)
	if aa == 0 {
		return color.RGBA{}
	}
	return color.RGBA{
		R: uint8((ar * 0xffff / aa) >> 8),
		G: uint8((ag * 0xffff / aa) >> 8),
		B: uint8((ab * 0xffff / aa) >> 8),
		A: uint8(aa >> 8),
	}
}
