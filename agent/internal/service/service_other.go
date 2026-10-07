//go:build !linux && !windows

package service

import (
	"context"
	"fmt"
)

// Install : aucune intégration de service sur cette plateforme.
func Install(InstallOptions) error {
	return fmt.Errorf("%w : aucune intégration de service sur cette plateforme", ErrUnsupported)
}

// Uninstall : aucune intégration de service sur cette plateforme.
func Uninstall() error {
	return fmt.Errorf("%w : aucune intégration de service sur cette plateforme", ErrUnsupported)
}

// Run exécute l'agent au PREMIER PLAN.
func Run(ctx context.Context, execute func(context.Context) error) error {
	return execute(ctx)
}

// Status : aucun service système connu.
func Status() (string, error) {
	return "aucune intégration de service sur cette plateforme", nil
}
