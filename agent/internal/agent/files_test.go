package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/grokuku/yuki/agent/internal/proto"
	"github.com/grokuku/yuki/agent/internal/transport"
)

/* ─── Transfert de fichiers (capacité `files`) — gestionnaires AGENT ──────── */

func waitFileChunks(t *testing.T, c *replyCollector) []*proto.FileChunk {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var chunks []*proto.FileChunk
		var errMsg *proto.Error
		for _, m := range c.all() {
			switch typed := m.(type) {
			case *proto.FileChunk:
				chunks = append(chunks, typed)
			case *proto.Error:
				errMsg = typed
			}
		}
		if errMsg != nil {
			t.Fatalf("erreur inattendue : %s (%s)", errMsg.Code, errMsg.Message)
		}
		if len(chunks) > 0 && chunks[len(chunks)-1].Dernier {
			return chunks
		}
		if time.Now().After(deadline) {
			t.Fatalf("aucun morceau final reçu (%d morceaux)", len(chunks))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFileGetEnvoieMorceauxEtEmpreinte(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	path := filepath.Join(dir, "source.bin")
	content := []byte("0123456789abcdefghij")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("écriture : %v", err)
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FileGet{
		CmdID: "c-1", Path: path, MaxTotal: 1 << 20, Chunk: 7,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	chunks := waitFileChunks(t, replies)
	// ⚠️ 20 octets par morceaux de 7 ⇒ 3 morceaux (7+7+6).
	if len(chunks) != 3 {
		t.Fatalf("morceaux = %d, attendu 3", len(chunks))
	}
	var rebuilt []byte
	for i, chunk := range chunks {
		if chunk.Seq != i {
			t.Fatalf("seq %d : obtenu %d", i, chunk.Seq)
		}
		if chunk.Offset != int64(len(rebuilt)) {
			t.Fatalf("offset %d : obtenu %d", i, chunk.Offset)
		}
		rebuilt = append(rebuilt, chunk.Data...)
		if i < len(chunks)-1 && chunk.Sha256 != "" {
			t.Fatalf("empreinte présente sur un morceau NON final")
		}
	}
	last := chunks[len(chunks)-1]
	want := sha256.Sum256(content)
	if last.Sha256 != hex.EncodeToString(want[:]) {
		t.Fatalf("empreinte finale fausse")
	}
	if last.Total != int64(len(content)) {
		t.Fatalf("total = %d", last.Total)
	}
	if string(rebuilt) != string(content) {
		t.Fatalf("réassemblage fidèle attendu")
	}
}

func TestFileGetOffsetReprise(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	path := filepath.Join(dir, "source.bin")
	content := []byte("ABCDEFGHIJ")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("écriture : %v", err)
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FileGet{
		CmdID: "c-2", Path: path, Offset: 4, MaxTotal: 1 << 20, Chunk: 1024,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	chunks := waitFileChunks(t, replies)
	if len(chunks) != 1 {
		t.Fatalf("morceaux = %d", len(chunks))
	}
	if string(chunks[0].Data) != "EFGHIJ" {
		t.Fatalf("reprise : obtenu %q", string(chunks[0].Data))
	}
	if chunks[0].Offset != 4 {
		t.Fatalf("offset = %d", chunks[0].Offset)
	}
}

func TestFileGetRefuseTropGrosAvantLecture(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	path := filepath.Join(dir, "gros.bin")
	if err := os.WriteFile(path, make([]byte, 4096), 0o600); err != nil {
		t.Fatalf("écriture : %v", err)
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FileGet{
		CmdID: "c-3", Path: path, MaxTotal: 1024, Chunk: 1024,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	// ⚠️ AUCUN morceau n'est émis : le refus est décidé AVANT la lecture.
	for _, m := range replies.all() {
		if chunk, ok := m.(*proto.FileChunk); ok {
			t.Fatalf("morceau émis malgré le refus (%d octets)", len(chunk.Data))
		}
	}
	errMsg, ok := replies.first(proto.TypeError).(*proto.Error)
	if !ok {
		t.Fatalf("refus attendu")
	}
	if errMsg.Code != proto.CodeTooLarge {
		t.Fatalf("code = %s", errMsg.Code)
	}
}

func TestFileGetRefuseCheminRelatifEtIntrouvable(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	cases := []struct {
		name string
		path string
		code proto.ErrorCode
	}{
		{"relatif", "relative/path.bin", proto.CodeIOError},
		{"introuvable", filepath.Join(t.TempDir(), "absent.bin"), proto.CodeNotFound},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			replies := &replyCollector{}
			if err := rt.HandleMessage(t.Context(), &proto.FileGet{
				CmdID: "c-x", Path: test.path, MaxTotal: 1 << 20,
			}, replies.reply); err != nil {
				t.Fatalf("HandleMessage : %v", err)
			}
			errMsg, ok := replies.first(proto.TypeError).(*proto.Error)
			if !ok {
				t.Fatalf("refus attendu")
			}
			if errMsg.Code != test.code {
				t.Fatalf("code = %s, attendu %s", errMsg.Code, test.code)
			}
		})
	}
}

func TestFilePutEcritAtomiquement(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	dest := filepath.Join(dir, "cible.bin")
	content := []byte("bonjour le monde")
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FilePut{
		CmdID: "p-1", Path: dest, Bytes: int64(len(content)), Sha256: digest,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	// ⚠️ Le `.part` existe, la destination NON (écriture non publiée).
	if _, err := os.Stat(dest); err == nil {
		t.Fatalf("destination visible avant la fin du transfert")
	}
	if err := rt.HandleMessage(t.Context(), &proto.FilePutChunk{
		CmdID: "p-1", Seq: 0, Data: content[:7],
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	if err := rt.HandleMessage(t.Context(), &proto.FilePutChunk{
		CmdID: "p-1", Seq: 1, Data: content[7:], Dernier: true, Sha256: digest,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	result, ok := replies.first(proto.TypeFileResult).(*proto.FileResult)
	if !ok {
		t.Fatalf("file_result attendu")
	}
	if result.Status != proto.FileStatusOK || result.Code != "" {
		t.Fatalf("résultat = %+v", result)
	}
	if result.Bytes != int64(len(content)) || result.Sha256 != digest {
		t.Fatalf("métadonnées fausses : %+v", result)
	}
	written, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("lecture : %v", err)
	}
	if string(written) != string(content) {
		t.Fatalf("contenu écrit faux")
	}
	// ⚠️ Aucun `.part` résiduel.
	if _, err := os.Stat(dest + ".part"); err == nil {
		t.Fatalf("fichier partiel laissé après succès")
	}
}

func TestFilePutRefuseConflitSansEcraser(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	dest := filepath.Join(dir, "existe.bin")
	if err := os.WriteFile(dest, []byte("original"), 0o600); err != nil {
		t.Fatalf("écriture : %v", err)
	}
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FilePut{
		CmdID: "p-2", Path: dest, Bytes: 3, Sha256: "00",
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	result, ok := replies.first(proto.TypeFileResult).(*proto.FileResult)
	if !ok {
		t.Fatalf("file_result attendu")
	}
	if result.Status != proto.FileStatusRefused || result.Code != proto.CodeConflict {
		t.Fatalf("résultat = %+v", result)
	}
	kept, _ := os.ReadFile(dest)
	if string(kept) != "original" {
		t.Fatalf("destination modifiée malgré le conflit")
	}
}

func TestFilePutRefuseEmpreinteAlteree(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	dir := t.TempDir()
	dest := filepath.Join(dir, "altere.bin")
	content := []byte("contenu")
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FilePut{
		CmdID: "p-3", Path: dest, Bytes: int64(len(content)), Sha256: "deadbeef",
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	if err := rt.HandleMessage(t.Context(), &proto.FilePutChunk{
		CmdID: "p-3", Seq: 0, Data: content, Dernier: true, Sha256: "deadbeef",
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	result, ok := replies.first(proto.TypeFileResult).(*proto.FileResult)
	if !ok {
		t.Fatalf("file_result attendu")
	}
	if result.Code != proto.CodeDigestMismatch {
		t.Fatalf("code = %s", result.Code)
	}
	// ⚠️ Aucun fichier corrompu n'est publié, aucun `.part` ne subsiste.
	if _, err := os.Stat(dest); err == nil {
		t.Fatalf("fichier publié malgré l'empreinte fausse")
	}
	if _, err := os.Stat(dest + ".part"); err == nil {
		t.Fatalf("partiel laissé après refus d'empreinte")
	}
}

func TestFilePutMorceauOrphelinInterrompu(t *testing.T) {
	rt, _ := newTestRuntime(t, transport.NopLogger{})
	replies := &replyCollector{}
	if err := rt.HandleMessage(t.Context(), &proto.FilePutChunk{
		CmdID: "absent", Seq: 0, Data: []byte("x"), Dernier: true,
	}, replies.reply); err != nil {
		t.Fatalf("HandleMessage : %v", err)
	}
	result, ok := replies.first(proto.TypeFileResult).(*proto.FileResult)
	if !ok {
		t.Fatalf("file_result attendu")
	}
	if result.Code != proto.CodeInterrupted {
		t.Fatalf("code = %s", result.Code)
	}
}
