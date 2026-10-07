//go:build linux

package exec

import (
	"fmt"
	osexec "os/exec"
	"syscall"
)

// platformSupported : l'exécution réelle est disponible sous Linux.
func platformSupported() bool { return true }

// defaultShell : `/bin/sh -c <script>` par défaut (D123, shell complet).
func defaultShell() string { return "/bin/sh" }

// commandArgs construit les arguments passés à l'interpréteur. Sous Linux, le
// contrat POSIX est `-c <script>` ; `shell` (choix de l'interpréteur) ne
// restreint RIEN (shell complet, D123).
func commandArgs(_, _ string, script string) []string {
	return []string{"-c", script}
}

// applySysProcAttr place la commande dans SON PROPRE GROUPE de processus.
// ⚠️ C'est ce qui permet de tuer TOUT le groupe au timeout : sans `Setpgid`,
// les processus forkeés survivraient en orphelins.
func applySysProcAttr(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// posixController interrompt le GROUPE de processus de `cmd` (identifié par son
// PGID = PID du chef, grâce à `Setpgid`).
type posixController struct {
	pid int
}

// newController capture le PID chef du groupe. Aucune ressource kernel n'est
// allouée : `Close` est donc sans effet.
func newController(cmd *osexec.Cmd) (processController, error) {
	if cmd == nil || cmd.Process == nil {
		return nil, fmt.Errorf("exec : aucun processus à contrôler")
	}
	return &posixController{pid: cmd.Process.Pid}, nil
}

// Terminate signale le GROUPE entier : SIGTERM (courtois) ou SIGKILL (force).
func (c *posixController) Terminate(force bool) error {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	// PID négatif = « tout le groupe de processus ».
	if err := syscall.Kill(-c.pid, sig); err != nil {
		return fmt.Errorf("exec : signal %v au groupe %d : %w", sig, c.pid, err)
	}
	return nil
}

// Close n'a rien à libérer (pas de handle kernel côté POSIX).
func (c *posixController) Close() {}

// exitCodeOf traduit l'état du processus en code de sortie. Un processus tué
// par un signal suit la convention du shell : 128 + numéro de signal
// (SIGTERM ⇒ 143, SIGKILL ⇒ 137).
func exitCodeOf(cmd *osexec.Cmd, waitErr error) int {
	if cmd.ProcessState == nil {
		if waitErr != nil {
			return -1
		}
		return 0
	}
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return cmd.ProcessState.ExitCode()
}
