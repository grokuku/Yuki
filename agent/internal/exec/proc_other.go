//go:build !linux && !windows

package exec

import (
	"fmt"
	osexec "os/exec"
)

// platformSupported : l'exécution réelle n'est disponible que sous Linux et
// Windows (les autres plateformes échouent explicitement, cf. `ErrUnsupported`).
func platformSupported() bool { return false }

// defaultShell : shell POSIX par défaut (plateforme non supportée à ce jour).
func defaultShell() string { return "/bin/sh" }

// commandArgs : contrat POSIX `-c <script>`.
func commandArgs(_, _ string, script string) []string {
	return []string{"-c", script}
}

// applySysProcAttr : aucun groupe de processus ici (plateforme non supportée).
func applySysProcAttr(cmd *osexec.Cmd) {}

// newController : non supporté sur cette plateforme.
func newController(*osexec.Cmd) (processController, error) {
	return nil, fmt.Errorf("exec : contrôle de processus non supporté sur cette plateforme")
}

// exitCodeOf : code de sortie brut.
func exitCodeOf(cmd *osexec.Cmd, waitErr error) int {
	if cmd.ProcessState == nil {
		if waitErr != nil {
			return -1
		}
		return 0
	}
	return cmd.ProcessState.ExitCode()
}
