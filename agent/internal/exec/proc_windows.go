//go:build windows

package exec

import (
	"fmt"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// platformSupported : l'exécution réelle est disponible sous Windows (A6).
func platformSupported() bool { return true }

// defaultShell : `cmd.exe /d /s /c <script>` par défaut (shell complet, D123).
func defaultShell() string { return "cmd.exe" }

// commandArgs construit les arguments de l'interpréteur Windows :
//
//   - `cmd.exe` (défaut) : `/d /s /c <script>` (autocomplétion et echo désactivés,
//     guillemets gérés par `cmd`) ;
//   - `powershell.exe`/`pwsh` : `-NoProfile -NonInteractive -Command <script>`
//     (profil non chargé, aucune invite interactive).
//
// La détection s'appuie sur le NOM DE BASE du binaire résolu ; à défaut, le
// shell annoncé est consulté.
func commandArgs(shell, resolvedPath, script string) []string {
	lower := strings.ToLower(filepath.Base(resolvedPath))
	announced := strings.ToLower(strings.TrimSpace(shell))
	if strings.Contains(lower, "powershell") || strings.Contains(lower, "pwsh") ||
		strings.Contains(announced, "powershell") || strings.Contains(announced, "pwsh") {
		return []string{"-NoProfile", "-NonInteractive", "-Command", script}
	}
	// `cmd.exe` (ou tout autre interpréteur compatible) : /d /s /c.
	return []string{"/d", "/s", "/c", script}
}

// applySysProcAttr place la commande dans son propre GROUPE de processus
// (`CREATE_NEW_PROCESS_GROUP`) afin de pouvoir lui envoyer CTRL_BREAK.
func applySysProcAttr(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// windowsController porte le JOB OBJECT d'UNE commande. Le job est créé après
// le démarrage du shell puis le shell y est rattaché : au timeout, tuer le job
// (`TerminateJobObject`) tue TOUT l'ARBRE (shell + descendants), y compris ceux
// qui auraient été forkeés entre-temps.
//
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` garantit en outre que la mort de l'agent
// (fermeture du handle) entraîne celle de tous les descendants.
type windowsController struct {
	job windows.Handle
	pid int
}

// newController crée et configure le job object, puis y rattache le processus
// du shell. En cas d'échec, la commande est abandonnée AVANT exécution (cf.
// `Runner.Run`) : on n'exécute jamais sans maîtrise de l'arbre.
func newController(cmd *osexec.Cmd) (processController, error) {
	if cmd == nil || cmd.Process == nil {
		return nil, fmt.Errorf("exec : aucun processus à contrôler")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("exec : création du job object : %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("exec : configuration du job object : %w", err)
	}
	pid := cmd.Process.Pid
	handle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(pid),
	)
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("exec : ouverture du processus %d : %w", pid, err)
	}
	assignErr := windows.AssignProcessToJobObject(job, handle)
	windows.CloseHandle(handle)
	if assignErr != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("exec : rattachement du processus au job : %w", assignErr)
	}
	return &windowsController{job: job, pid: pid}, nil
}

// Terminate : tentative courtoise par CTRL_BREAK (process group), sinon arrêt
// immédiat de TOUT le job. Windows n'a pas d'équivalent de SIGTERM : le
// CTRL_BREAK est l'arrêt courtois le plus proche ; `force` court-circuite.
func (c *windowsController) Terminate(force bool) error {
	if c.job == 0 {
		return fmt.Errorf("exec : job object absent")
	}
	if !force {
		// Courtois : à défaut de console, l'appel échoue — on escalade alors
		// après la grâce via `Terminate(true)`.
		return windows.GenerateConsoleCtrlEvent(uint32(syscall.CTRL_BREAK_EVENT), uint32(c.pid))
	}
	if err := windows.TerminateJobObject(c.job, 1); err != nil {
		return fmt.Errorf("exec : arrêt du job object : %w", err)
	}
	return nil
}

// Close libère le handle du job object (et, via KILL_ON_JOB_CLOSE, toute
// descendance encore vivante).
func (c *windowsController) Close() {
	if c.job != 0 {
		_ = windows.CloseHandle(c.job)
		c.job = 0
	}
}

// exitCodeOf : code de sortie brut sous Windows.
func exitCodeOf(cmd *osexec.Cmd, waitErr error) int {
	if cmd.ProcessState == nil {
		if waitErr != nil {
			return -1
		}
		return 0
	}
	return cmd.ProcessState.ExitCode()
}
