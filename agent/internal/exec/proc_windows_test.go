//go:build windows

package exec

import (
	"strings"
	"testing"
)

// ⚠️ Ce fichier n'est compilé QUE pour Windows : il constitue la PREUVE que le
// VRAI chemin d'exécution Windows (`proc_windows.go`, job object) est bien
// compilé — et non un stub. Vérification :
//
//	GOOS=windows GOARCH=amd64 go test -c ./internal/exec
//
// (le binaire de test Windows n'est pas exécutable ici, mais sa compilation
// prouve que le code Windows réel est bien pris et référence `windowsController`.)
var _ processController = (*windowsController)(nil)

func TestPlatformSupportedWindows(t *testing.T) {
	if !platformSupported() {
		t.Fatal("platformSupported() = false : Windows serait un stub")
	}
	if defaultShell() != "cmd.exe" {
		t.Fatalf("defaultShell() = %q", defaultShell())
	}
}

func TestCommandArgsWindows(t *testing.T) {
	cmdArgs := commandArgs("", `C:\Windows\System32\cmd.exe`, "echo bonjour")
	want := []string{"/d", "/s", "/c", "echo bonjour"}
	for i := range want {
		if cmdArgs[i] != want[i] {
			t.Fatalf("cmd.exe : args[%d] = %q, attendu %q (%v)", i, cmdArgs[i], want[i], cmdArgs)
		}
	}

	psArgs := commandArgs("powershell", `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "Get-Date")
	if len(psArgs) != 4 || psArgs[0] != "-NoProfile" || psArgs[1] != "-NonInteractive" ||
		psArgs[2] != "-Command" || psArgs[3] != "Get-Date" {
		t.Fatalf("powershell : args = %v", psArgs)
	}

	// pwsh (PowerShell 7) détecté aussi.
	pwshArgs := commandArgs("pwsh", `C:\Program Files\PowerShell\7\pwsh.exe`, "1")
	if pwshArgs[0] != "-NoProfile" {
		t.Fatalf("pwsh : args = %v", pwshArgs)
	}
}

func TestNewControllerSansProcessusEchoue(t *testing.T) {
	if _, err := newController(nil); err == nil {
		t.Fatal("newController(nil) aurait dû échouer")
	}
}

func TestControllerTerminateSansJobEchoue(t *testing.T) {
	c := &windowsController{}
	if err := c.Terminate(true); err == nil || !strings.Contains(err.Error(), "job object absent") {
		t.Fatalf("Terminate sans job = %v", err)
	}
	c.Close() // ne doit pas paniquer
}
