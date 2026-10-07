//go:build linux

package exec

import "testing"

func TestPlatformSupportedLinux(t *testing.T) {
	if !platformSupported() {
		t.Fatal("platformSupported() = false sous Linux")
	}
	if defaultShell() != "/bin/sh" {
		t.Fatalf("defaultShell() = %q", defaultShell())
	}
}

func TestCommandArgsLinux(t *testing.T) {
	args := commandArgs("", "/bin/sh", "echo bonjour")
	if len(args) != 2 || args[0] != "-c" || args[1] != "echo bonjour" {
		t.Fatalf("commandArgs = %v", args)
	}
}
