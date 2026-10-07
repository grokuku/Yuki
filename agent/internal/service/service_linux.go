//go:build linux

package service

import (
	"context"
	"fmt"
)

// Install : sous Linux, l'installation est confiée à `deploy/install.sh`
// (unité systemd + `systemctl enable --now`). On oriente l'opérateur plutôt que
// de dupliquer la logique d'installation du script.
func Install(InstallOptions) error {
	return fmt.Errorf("%w : sous Linux, utilisez `deploy/install.sh` (unité systemd `%s`)", ErrUnsupported, Name)
}

// Uninstall : sous Linux, utiliser `systemctl disable --now %s` puis supprimer
// l'unité (voir `deploy/install.sh`).
func Uninstall() error {
	return fmt.Errorf("%w : sous Linux, utilisez `systemctl disable --now %s`", ErrUnsupported, Name)
}

// Run exécute l'agent au PREMIER PLAN : sous Linux, c'est systemd (ou un
// opérateur) qui appelle `yuki-agent run` et gère le cycle de vie.
func Run(ctx context.Context, execute func(context.Context) error) error {
	return execute(ctx)
}

// Status : le service est géré par systemd.
func Status() (string, error) {
	return fmt.Sprintf("géré par systemd (unité %s ; `systemctl status %s`)", Name, Name), nil
}
