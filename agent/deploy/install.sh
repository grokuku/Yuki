#!/bin/sh
# =============================================================================
# Installation de l'agent d'exécution Yuki comme service systemd (Lot 4, A6).
#
# Ce script :
#   1. copie le binaire `yuki-agent` dans <prefix>/bin (défaut /usr/local/bin) ;
#   2. installe l'unité systemd avec `User=`/`Group=` PARAMÉTRABLES ;
#   3. active et démarre le service (`systemctl enable --now`).
#
# ⚠️ COMPTE DE SERVICE (privilège, D120) :
#   - par défaut, le service tourne sous le compte UTILISATEUR qui a lancé
#     l'installation (`$SUDO_USER`, sinon `$USER`) — JAMAIS root silencieusement ;
#   - `--user root` (ou `YUKI_AGENT_USER=root`) donne à l'agent les pleins
#     privilèges : un processus ne s'élève pas à chaud, c'est à l'installation
#     qu'on choisit ;
#   - si le compte visé n'existe pas et n'est pas root, il est créé en compte
#     système.
#
# ⚠️ PRÉREQUIS : appairez d'abord la machine (`yuki-agent pair`), car `run`
# refuse de démarrer sans CA + certificats.
#
# ⚠️ ROOT : ce script écrit dans /etc, /usr/local/bin et pilote systemd. S'il
# n'est pas déjà root, il se ré-exécute via `sudo` (en le disant). Utilisez
# `--dry-run` pour n'afficher que les actions.
# =============================================================================
set -eu

PREFIX="/usr/local"
BINARY_SRC=""
CONFIG="/etc/yuki-agent/agent.json"
STATE_DIR="/etc/yuki-agent"
TARGET_USER="${YUKI_AGENT_USER:-}"
TARGET_GROUP=""
UNIT_SRC=""
DRY_RUN=0
SERVICE_NAME="yuki-agent"

usage() {
	cat <<'EOF'
Usage : deploy/install.sh [options]

Options :
  --binary <chemin>     binaire à installer (défaut : ./yuki-agent puis $PATH)
  --prefix <chemin>     préfixe d'installation (défaut : /usr/local)
  --config <chemin>     fichier de configuration du service
                        (défaut : /etc/yuki-agent/agent.json)
  --state-dir <chemin>  répertoire d'état (certificats)
  --user <compte>       compte de service systemd (privilège, D120)
  --group <groupe>      groupe de service (défaut : groupe du compte)
  --unit <chemin>       unité systemd source (défaut : <script>/yuki-agent.service)
  --dry-run             n'effectue aucune modification
  -h, --help            affiche cette aide
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--binary) BINARY_SRC=${2:?"--binary requiert une valeur"}; shift 2 ;;
		--prefix) PREFIX=${2:?"--prefix requiert une valeur"}; shift 2 ;;
		--config) CONFIG=${2:?"--config requiert une valeur"}; shift 2 ;;
		--state-dir) STATE_DIR=${2:?"--state-dir requiert une valeur"}; shift 2 ;;
		--user) TARGET_USER=${2:?"--user requiert une valeur"}; shift 2 ;;
		--group) TARGET_GROUP=${2:?"--group requiert une valeur"}; shift 2 ;;
		--unit) UNIT_SRC=${2:?"--unit requiert une valeur"}; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "install.sh : option inconnue « $1 »" >&2; usage >&2; exit 2 ;;
	esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -z "$UNIT_SRC" ]; then
	UNIT_SRC="$SCRIPT_DIR/yuki-agent.service"
fi
if [ ! -f "$UNIT_SRC" ]; then
	echo "install.sh : unité systemd introuvable : $UNIT_SRC" >&2
	exit 1
fi

# --- Binaire ---------------------------------------------------------------
if [ -z "$BINARY_SRC" ]; then
	if [ -x "$SCRIPT_DIR/../yuki-agent" ]; then
		BINARY_SRC="$SCRIPT_DIR/../yuki-agent"
	elif command -v yuki-agent >/dev/null 2>&1; then
		BINARY_SRC=$(command -v yuki-agent)
	else
		echo "install.sh : binaire yuki-agent introuvable (utilisez --binary)" >&2
		exit 1
	fi
fi
if [ ! -x "$BINARY_SRC" ]; then
	echo "install.sh : « $BINARY_SRC » n'est pas un exécutable" >&2
	exit 1
fi

# --- Compte de service -----------------------------------------------------
if [ -z "$TARGET_USER" ]; then
	if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
		TARGET_USER="$SUDO_USER"
	elif [ -n "${USER:-}" ] && [ "$USER" != "root" ]; then
		TARGET_USER="$USER"
	else
		TARGET_USER="root"
	fi
fi
if [ -z "$TARGET_GROUP" ]; then
	if [ "$TARGET_USER" = "root" ]; then
		TARGET_GROUP="root"
	else
		TARGET_GROUP="$TARGET_USER"
	fi
fi

echo "Compte de service retenu : $TARGET_USER:$TARGET_GROUP"
if [ "$TARGET_USER" = "root" ]; then
	echo "⚠️  L'agent tournera en root : il pourra exécuter TOUTE commande avec les pleins privilèges (D120)." >&2
fi

# --- Élévation de privilèges (dite explicitement) --------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
	if command -v sudo >/dev/null 2>&1; then
		echo "install.sh : élévation via sudo (nécessaire pour /etc, $PREFIX/bin et systemd)."
		exec sudo -- "$0" "$@"
	fi
	echo "install.sh : exécution en root requise (écrit dans /etc, $PREFIX/bin et pilote systemd)." >&2
	echo "             relancez avec sudo ou root." >&2
	exit 1
fi

BIN_DEST="$PREFIX/bin/yuki-agent"
UNIT_DEST="/etc/systemd/system/$SERVICE_NAME.service"

run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] $*"
	else
		"$@"
	fi
}

# --- Compte système --------------------------------------------------------
if [ "$TARGET_USER" != "root" ] && ! id "$TARGET_USER" >/dev/null 2>&1; then
	echo "Création du compte système $TARGET_USER..."
	run useradd --system --no-create-home --shell /usr/sbin/nologin "$TARGET_USER" || true
fi

# --- Binaire ---------------------------------------------------------------
run install -d -m 0755 "$PREFIX/bin"
run install -m 0755 "$BINARY_SRC" "$BIN_DEST"

# --- Répertoire d'état et configuration ------------------------------------
run install -d -m 0750 -o "$TARGET_USER" -g "$TARGET_GROUP" "$STATE_DIR"
if [ ! -f "$CONFIG" ]; then
	echo "⚠️  Configuration absente : $CONFIG"
	echo "    Appairez la machine AVANT de démarrer le service :"
	echo "      $BIN_DEST pair --yuki-url <wss://…> --config $CONFIG"
fi

# --- Unité systemd ---------------------------------------------------------
run install -m 0644 "$UNIT_SRC" "$UNIT_DEST"
if [ "$DRY_RUN" -eq 0 ]; then
	# Paramétrage du compte et de la commande de démarrage.
	sed -i "s|^User=.*|User=$TARGET_USER|" "$UNIT_DEST"
	sed -i "s|^Group=.*|Group=$TARGET_GROUP|" "$UNIT_DEST"
	sed -i "s|^ExecStart=.*|ExecStart=$BIN_DEST run --config $CONFIG|" "$UNIT_DEST"
fi

run systemctl daemon-reload
run systemctl enable --now "$SERVICE_NAME"

echo
echo "Service « $SERVICE_NAME » installé."
echo "  binaire      : $BIN_DEST"
echo "  configuration: $CONFIG"
echo "  compte       : $TARGET_USER:$TARGET_GROUP"
echo "  état         : systemctl status $SERVICE_NAME"
echo "  journaux     : journalctl -u $SERVICE_NAME -f"
