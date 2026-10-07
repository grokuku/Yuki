//go:build linux

package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestInstallLinuxOrienteVersScript(t *testing.T) {
	err := Install(InstallOptions{BinaryPath: "/usr/local/bin/yuki-agent"})
	if !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Install = %v, attendu ErrUnsupported", err)
	}
	if !strings.Contains(err.Error(), "install.sh") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestUninstallLinuxOrienteVersSystemctl(t *testing.T) {
	err := Uninstall()
	if !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Uninstall = %v, attendu ErrUnsupported", err)
	}
	if !strings.Contains(err.Error(), "systemctl") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestRunPremierPlanExecute(t *testing.T) {
	called := false
	err := Run(context.Background(), func(ctx context.Context) error {
		called = true
		return ctx.Err()
	})
	if !called {
		t.Fatal("Run n'a pas appelé l'exécutable fourni")
	}
	if err != nil {
		t.Fatalf("Run = %v", err)
	}
}

func TestStatusMentionneSystemd(t *testing.T) {
	status, err := Status()
	if err != nil {
		t.Fatalf("Status = %v", err)
	}
	if !strings.Contains(status, "systemd") {
		t.Fatalf("status = %q", status)
	}
}
