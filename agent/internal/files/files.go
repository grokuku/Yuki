// Package files implémente la LECTURE et l'ÉCRITURE d'un fichier de la machine,
// au service du transfert de fichiers de Yuki (capacité `files`).
//
// # Principes
//
//   - **Chemin ABSOLU obligatoire** : un chemin relatif dépendrait du répertoire
//     de travail du service (non maîtrisé par Yuki) ⇒ refusé (`io_error`).
//   - **Aucune liste blanche** (décision utilisateur) : Yuki peut lire et écrire
//     n'importe quel chemin absolu accessible au processus. Les garde-fous sont
//     la capacité déclarée, le plafond de taille et la trace d'audit côté Yuki.
//   - **Écriture ATOMIQUE** : les octets vont dans `<path>.part`, puis `fsync`
//     puis `rename`. Un fichier partiel n'est JAMAIS visible à la destination
//     finale, et un refus supprime le `.part` (aucun résidu).
//   - **Jamais d'écrasement silencieux** : la destination existante est refusée
//     (`conflict`) sauf si l'appelant a explicitement demandé `ecraser`.
//   - **Empreinte vérifiée** : le SHA-256 du fichier COMPLET est calculé pendant
//     la lecture/écriture ; il est comparé à l'empreinte annoncée et une
//     divergence (`digest_mismatch`) supprime ce qui a été écrit.
//
// ⚠️ Aucun CONTENU n'est jamais journalisé : ni les octets, ni l'empreinte d'un
// fichier secret. Seules des métadonnées (chemin, taille) le sont côté agent.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// DefaultChunkBytes est la taille BINAIRE par défaut d'un morceau (192 Kio).
//
// ⚠️ En base64, un morceau pèse ×4/3 (~256 Kio) : la trame JSON reste très en
// dessous de `maxFrameBytes` (8 Mio) côté agent ET côté gateway.
const DefaultChunkBytes = 192 * 1024

// MaxChunkBytes borne la taille d'un morceau demandée par Yuki. Au-delà on
// ramène à cette valeur : un morceau démesuré dépasserait la trame max.
const MaxChunkBytes = 4 * 1024 * 1024

// ErrRelatif : le chemin fourni n'est pas absolu.
var ErrRelatif = errors.New("chemin relatif refusé : un chemin ABSOLU est exigé")

// ErrIntrouvable : le fichier demandé n'existe pas (ou n'est pas un fichier
// ordinaire, ou n'est pas lisible).
var ErrIntrouvable = errors.New("fichier introuvable ou illisible")

// ErrConflit : la destination existe déjà et l'écrasement n'a pas été demandé.
var ErrConflit = errors.New("la destination existe déjà (écrasement non demandé)")

// ErrEmpreinte : l'empreinte observée diffère de celle annoncée.
var ErrEmpreinte = errors.New("empreinte SHA-256 différente de celle annoncée")

// clampChunk ramène la taille demandée dans les bornes acceptables.
func clampChunk(requested int) int {
	if requested <= 0 {
		return DefaultChunkBytes
	}
	if requested > MaxChunkBytes {
		return MaxChunkBytes
	}
	return requested
}

// absPath valide et nettoie un chemin ABSOLU.
func absPath(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", fmt.Errorf("%w : chemin vide", ErrRelatif)
	}
	if !filepath.IsAbs(trimmed) {
		return "", ErrRelatif
	}
	return filepath.Clean(trimmed), nil
}

// Reader lit un fichier par morceaux en calculant son empreinte.
type Reader struct {
	file   *os.File
	path   string
	offset int64
	total  int64
	chunk  int
	seq    int
	digest hash.Hash
	done   bool
}

// Open prépare la lecture d'un fichier à partir de `offset`.
//
// ⚠️ `maxTotal` > 0 borne la taille ACCEPTÉE : une taille supérieure est
// refusée AVANT toute lecture (donc avant tout envoi de morceau) avec
// `ErrTropGros`.
func Open(path string, offset int64, maxTotal int64) (*Reader, error) {
	clean, err := absPath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(clean)
	if err != nil {
		return nil, fmt.Errorf("%w : %v", ErrIntrouvable, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w : n'est pas un fichier ordinaire", ErrIntrouvable)
	}
	if maxTotal > 0 && info.Size() > maxTotal {
		return nil, &TropGrosError{Size: info.Size(), Limit: maxTotal}
	}
	if offset < 0 || offset > info.Size() {
		return nil, fmt.Errorf("%w : offset %d hors du fichier (%d octets)", ErrIntrouvable, offset, info.Size())
	}
	f, err := os.Open(clean)
	if err != nil {
		return nil, fmt.Errorf("%w : %v", ErrIntrouvable, err)
	}
	r := &Reader{file: f, path: clean, offset: offset, total: info.Size(), chunk: DefaultChunkBytes, digest: sha256.New()}
	if offset > 0 {
		// ⚠️ Reprise : on AVANCE sans relire le préfixe. L'empreinte annoncée
		// porte sur le fichier COMPLET — Yuki la vérifie contre son propre
		// calcul du préfixe déjà reçu (voir `transfer.ts`).
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, fmt.Errorf("%w : %v", ErrIntrouvable, err)
		}
	}
	return r, nil
}

// TropGrosError : la taille du fichier dépasse le plafond demandé.
type TropGrosError struct {
	Size  int64
	Limit int64
}

func (e *TropGrosError) Error() string {
	return fmt.Sprintf("fichier trop lourd : %d octets (plafond %d)", e.Size, e.Limit)
}

// Total renvoie la taille totale du fichier.
func (r *Reader) Total() int64 { return r.total }

// Offset renvoie la position courante de lecture.
func (r *Reader) Offset() int64 { return r.offset }

// Seq renvoie le numéro du prochain morceau.
func (r *Reader) Seq() int { return r.seq }

// Done indique que tout le fichier a été lu.
func (r *Reader) Done() bool { return r.done }

// SetChunk fixe la taille d'un morceau (bornée).
func (r *Reader) SetChunk(n int) { r.chunk = clampChunk(n) }

// Next lit le morceau suivant. `data` est vide et `last` vrai quand on est au
// bout. ⚠️ Aucune allocation au-delà du morceau demandé.
func (r *Reader) Next() (data []byte, off int64, last bool, err error) {
	if r.done {
		return nil, r.offset, true, nil
	}
	size := r.chunk
	if remaining := r.total - r.offset; remaining < int64(size) {
		size = int(remaining)
	}
	buf := make([]byte, size)
	off = r.offset
	var read int
	read, err = io.ReadFull(r.file, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, off, false, fmt.Errorf("%w : %v", ErrIntrouvable, err)
	}
	buf = buf[:read]
	r.digest.Write(buf)
	r.offset += int64(read)
	r.seq++
	r.done = r.offset >= r.total
	return buf, off, r.done, nil
}

// Sha256 renvoie l'empreinte hexadécimale (minuscule) du fichier COMPLET.
//
// ⚠️ Sur une reprise (`offset > 0`), l'empreinte ne couvre QUE les octets lus
// depuis `offset` : c'est un digest PARTIEL, à ne pas confondre avec celui du
// fichier entier. La vérification finale appartient à Yuki (qui possède le
// préfixe et l'empreinte annoncée).
func (r *Reader) Sha256() string {
	return hex.EncodeToString(r.digest.Sum(nil))
}

// Close ferme le fichier.
func (r *Reader) Close() error { return r.file.Close() }

// Writer écrit un fichier par morceaux, atomiquement.
//
// ⚠️ La destination finale n'est JAMAIS touchée tant que `Commit` n'a pas été
// appelé : les octets vont dans `<path>.part`. Un `Abort` supprime le `.part`.
type Writer struct {
	path    string
	part    string
	file    *os.File
	want    int64
	mode    os.FileMode
	written int64
	seq     int
	digest  hash.Hash
}

// Create prépare l'écriture d'un fichier à `path`.
//
// ⚠️ `ecraser` = faux et destination existante ⇒ `ErrConflit` (aucune écriture).
// `bytes` < 0 n'est pas permis ; l'écriture est refusée dès qu'elle dépasse.
func Create(path string, bytes int64, mode int, ecraser bool) (*Writer, error) {
	clean, err := absPath(path)
	if err != nil {
		return nil, err
	}
	if bytes < 0 {
		return nil, fmt.Errorf("%w : taille annoncée négative", ErrConflit)
	}
	if !ecraser {
		if _, statErr := os.Lstat(clean); statErr == nil {
			return nil, ErrConflit
		}
	}
	// ⚠️ Le `.part` est TOUJOURS dans le MÊME répertoire que la destination : le
	// `rename` est ainsi atomique (même système de fichiers).
	part := clean + ".part"
	perm := os.FileMode(0o600)
	if mode > 0 {
		perm = os.FileMode(mode) & 0o777
	}
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return nil, fmt.Errorf("%w : %v", ErrIOError{}, err)
	}
	return &Writer{path: clean, part: part, file: f, want: bytes, mode: perm, digest: sha256.New()}, nil
}

// ErrIOError : erreur d'entrée/sortie côté agent.
type ErrIOError struct{}

func (ErrIOError) Error() string { return "erreur d'entrée/sortie" }

// WriteChunk écrit un morceau. Un dépassement de la taille annoncée est refusé.
func (w *Writer) WriteChunk(data []byte) error {
	if w.written+int64(len(data)) > w.want {
		return fmt.Errorf("%w : le flux dépasse les %d octets annoncés", ErrIOError{}, w.want)
	}
	if _, err := w.file.Write(data); err != nil {
		return fmt.Errorf("%w : %v", ErrIOError{}, err)
	}
	w.digest.Write(data)
	w.written += int64(len(data))
	w.seq++
	return nil
}

// Seq renvoie le nombre de morceaux déjà écrits.
func (w *Writer) Seq() int { return w.seq }

// Written renvoie les octets déjà écrits.
func (w *Writer) Written() int64 { return w.written }

// Commit vérifie la taille ET l'empreinte, force l'écriture sur disque
// (`fsync`) puis renomme le `.part` vers la destination FINALE.
//
// ⚠️ Une divergence d'empreinte (`ErrEmpreinte`) supprime le `.part` : aucun
// fichier corrompu n'est publié.
func (w *Writer) Commit(wantSha string) (string, error) {
	if w.written != w.want {
		w.Abort()
		return "", fmt.Errorf("%w : %d octets reçus sur %d annoncés", ErrIOError{}, w.written, w.want)
	}
	got := hex.EncodeToString(w.digest.Sum(nil))
	if wantSha != "" && !strings.EqualFold(wantSha, got) {
		w.Abort()
		return "", ErrEmpreinte
	}
	// ⚠️ fsync AVANT le rename : sans lui, une coupure d'alimentation pourrait
	// laisser un fichier à la bonne taille mais au contenu incomplet.
	if err := w.file.Sync(); err != nil {
		w.Abort()
		return "", fmt.Errorf("%w : %v", ErrIOError{}, err)
	}
	if err := w.file.Close(); err != nil {
		w.Abort()
		return "", fmt.Errorf("%w : %v", ErrIOError{}, err)
	}
	if err := os.Rename(w.part, w.path); err != nil {
		w.Abort()
		return "", fmt.Errorf("%w : %v", ErrIOError{}, err)
	}
	return got, nil
}

// Abort supprime le fichier partiel (le `.part`), sans toucher la destination.
func (w *Writer) Abort() {
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	_ = os.Remove(w.part)
}

// Sha256 renvoie l'empreinte hexadécimale des octets déjà écrits.
func (w *Writer) Sha256() string {
	return hex.EncodeToString(w.digest.Sum(nil))
}
