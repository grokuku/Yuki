//go:build linux

package service

import (
	"context"
	"fmt"
)

// Install : sous Linux, l'installation est confiée aux scripts de `deploy/`
// (unité systemd + `systemctl enable --now` ; script procd `/etc/init.d` sur
// OpenWrt, qui n'a PAS systemd). On oriente l'opérateur plutôt que de dupliquer
// la logique d'installation des scripts.
func Install(InstallOptions) error {
	return fmt.Errorf("%w : sous Linux, utilisez `deploy/install.sh` (unité systemd `%s`) ou, sous OpenWrt, `deploy/openwrt/yuki-agent.init` (procd)", ErrUnsupported, Name)
}

// Uninstall : sous Linux, utiliser `systemctl disable --now %s` puis supprimer
// l'unité (voir `deploy/install.sh`) ; sous OpenWrt, `/etc/init.d/%s disable &&
// /etc/init.d/%s stop` puis supprimer le script (procd ne connaît pas systemd).
func Uninstall() error {
	return fmt.Errorf("%w : sous Linux, utilisez `systemctl disable --now %s` ; sous OpenWrt, `/etc/init.d/%s disable`", ErrUnsupported, Name, Name)
}

// Run exécute l'agent au PREMIER PLAN : sous Linux, c'est le SUPERVISEUR qui
// appelle `yuki-agent run` et gère le cycle de vie — systemd sur une distribution
// classique, procd sur OpenWrt.
func Run(ctx context.Context, execute func(context.Context) error) error {
	return execute(ctx)
}

// Status : le service est géré par le superviseur de la plateforme (systemd, ou
// procd sous OpenWrt).
func Status() (string, error) {
	return fmt.Sprintf("géré par le superviseur (systemd : `systemctl status %s` ; OpenWrt/procd : `/etc/init.d/%s status`)", Name, Name), nil
}
