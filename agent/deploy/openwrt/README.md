# Agent Yuki sur OpenWrt (musl, procd)

Installation et limites **connues** de l'agent d'exécution Yuki (`agent/`) sur un
routeur **OpenWrt**.

> ⚠️ Ce document ne prétend RIEN avoir vu tourner sur un routeur réel : voir la
> section [« Ce qui est prouvé / ce qui ne l'est pas »](#ce-qui-est-prouvé--ce-qui-ne-lest-pas).

## 1. Pourquoi ça marche : aucun CGO, binaire statique

Le module Go de l'agent n'a **aucune** dépendance C (aucun `import "C"` ; la
seule dépendance externe, `golang.org/x/sys`, est importée sous `//go:build
windows`). Compilé avec `CGO_ENABLED=0`, Go produit un **ELF statique** qui ne
lie **aucune libc** : le même binaire tourne sur **glibc** (Debian…) et sur
**musl** (OpenWrt, Alpine). Il n'y a donc **pas** de « toolchain musl » à
installer, et **pas** de second linkage : `-musl` dans le nom du fichier nomme
la **cible validée**, pas une variante de compilation.

Mesures (agent 0.2.0, `-trimpath -ldflags "-s -w"`, `CGO_ENABLED=0`) :

| Binaire | Taille | `file` |
| --- | --- | --- |
| `yuki-agent-linux-amd64-musl` | 7 835 808 o (≈ 7,5 Mio) | `ELF 64-bit LSB executable, x86-64, statically linked` |
| `yuki-agent-linux-arm64-musl` | 7 209 120 o (≈ 6,9 Mio) | `ELF 64-bit LSB executable, ARM aarch64, statically linked` |

Pic de mémoire résidentielle mesuré en mode `run` (config mTLS chargée, boucle de
reconnexion vers un hôte injoignable, **sans** commande en cours) :
**≈ 8 Mio** (`VmHWM` 8 116–8 252 Kio sur deux mesures de 4 s, 7–8 threads),
stable (pas de croissance sur la durée). Chaque commande lancée coûte en plus la
mémoire de son propre processus : c'est la commande qui est grosse, pas l'agent.

## 2. Architectures

**`aarch64` (`arm64`) et `x86_64` (`amd64`)**, deux artefacts distincts :

- `aarch64_cortex-a53/a72` : la majorité des routeurs OpenWrt récents
  (MediaTek Filogic, Qualcomm/IPQ, Raspberry Pi 4/5 en OpenWrt) ;
- `x86_64` : OpenWrt en machine virtuelle / mini-PC (le cas de test le plus
  simple).

⚠️ **Non couvert** : `mips_24kc` / `mipsel_24kc` (beaucoup de box ISP bon
marché) et `arm_cortex-a7` (`armv7`). Go sait les produire
(`GOARCH=mipsle GOMIPS=softfloat`, `GOARCH=arm GOARM=7`) ; ils ne sont pas
publiés ici par décision explicite — demandez-les si votre routeur est en MIPS.

## 3. Installation en 3 lignes (SSH sur le routeur)

```sh
# 1) binaire (cible persistante : /usr/sbin, PAS /tmp qui est un tmpfs en RAM)
scp yuki-agent-linux-arm64-musl root@routeur:/tmp/ && ssh root@routeur 'install -m 0755 /tmp/yuki-agent-linux-arm64-musl /usr/sbin/yuki-agent && rm /tmp/yuki-agent-linux-arm64-musl'

# 2) appairage (écrit ca.pem / client.pem / client.key dans /etc/yuki-agent)
ssh root@routeur '/usr/sbin/yuki-agent pair --yuki-url wss://yuki.example.org:9443/ws --config /etc/yuki-agent/agent.json'

# 3) service procd (démarrage automatique au boot)
scp yuki-agent.init root@routeur:/etc/init.d/yuki-agent && ssh root@routeur 'chmod +x /etc/init.d/yuki-agent && /etc/init.d/yuki-agent enable && /etc/init.d/yuki-agent start'
```

Vérification : `logread -e yuki-agent` (journaux JSON structurés, sur stderr) et
`/etc/init.d/yuki-agent status`.

Vérifier l'intégrité du binaire avant de l'installer :
`sha256sum yuki-agent-linux-arm64-musl` puis comparaison avec la ligne
correspondante de `SHA256SUMS` (publié avec les artefacts et attaché à la
release).

Pour choisir la bonne architecture sur le routeur :

```sh
. /etc/openwrt_release && echo "$DISTRIB_ARCH"   # ex. aarch64_cortex-a53
```

## 4. Ce qui ne fonctionne PAS sans intervention

1. **systemd** — OpenWrt n'en a pas (il a **procd**). L'unité
   `deploy/yuki-agent.service` et `deploy/install.sh` sont inutilisables ici :
   c'est `openwrt/yuki-agent.init` qui les remplace. Conséquence : les
   sous-commandes `yuki-agent install` / `uninstall` **refusent** de faire quoi
   que ce soit sous Linux (`internal/service/service_linux.go`) — c'est
   volontaire, elles renvoient vers les scripts.
2. **`bash`** — l'agent **n'en dépend pas** : le shell par défaut est
   `/bin/sh` (`internal/exec/proc_linux.go`, `defaultShell`) et `bash` n'est
   utilisé que si Yuki le DEMANDE explicitement (`shell` dans la requête ou dans
   la configuration). Sous OpenWrt, `/bin/sh` est le **busybox ash** : les
   commandes qui utilisent du bashisme (`[[ ]]`, `set -o pipefail`, tableaux)
   échoueront — c'est une limite des commandes, pas de l'agent. Si besoin :
   `opkg install bash` puis `"shell": "/bin/bash"` dans `agent.json`.
3. **Persistance après reboot** — sur OpenWrt, `/usr` et `/etc` sont sur
   l'**overlayfs** (persistants), `/tmp` est un **tmpfs en RAM** (perdu au
   reboot). Le binaire doit vivre dans `/usr/sbin` et l'état
   (`ca.pem`, `client.pem`, `client.key`, `agent.json`) dans `/etc/yuki-agent` —
   c'est le défaut de l'agent (`internal/agent/config.go`, `DefaultStateDir`).
4. **`sysupgrade`** — une mise à jour du firmware OpenWrt **efface** les fichiers
   qui ne sont pas dans `/etc/sysupgrade.conf`. Ajoutez-y `/etc/yuki-agent` pour
   survivre à un `sysupgrade -n` :
   `echo /etc/yuki-agent >> /etc/sysupgrade.conf`. Le binaire dans `/usr/sbin`,
   lui, **est perdu** : réinstallez-le après chaque flash (il est petit, mais il
   n'y a pas d'`opkg` pour l'instant — un paquet `.ipk` serait l'étape suivante).
5. **Espace flash** — sur un routeur à 8 Mio de flash, l'overlay fait souvent
   1–3 Mio : un binaire de 7 Mio **n'y rentre pas**. Vérifiez avec `df -h /overlay`
   AVANT, et prévoyez soit un routeur avec plus de flash / port USB, soit une
   variante d'agent allégée. ⚠️ À dire franchement : c'est la contrainte la plus
   probable sur du matériel d'entrée de gamme.
6. **Pas d'écran, pas d'outil de capture** — la capacité « capture d'écran »
   (`internal/screen`) reste **non annoncée** sur un routeur (aucun `DISPLAY`,
   aucun outil) : `Detect` renvoie `false`, l'agent n'annonce pas une capacité
   qu'il ne peut pas honorer.

## 5. Ce qui est prouvé / ce qui ne l'est pas

**Prouvé (exécution réelle, pas seulement compilation) :**

- compilation croisée `CGO_ENABLED=0` pour `linux/amd64` et `linux/arm64` ;
- `file` : ELF **statique**, `x86-64` et `ARM aarch64` respectivement (tailles
  du tableau ci-dessus) ;
- exécution du binaire **arm64 sous QEMU** (`qemu-aarch64-static`, pas de routeur) :
  `version`, `help`, `status` répondent, et `run` démarre réellement — chargement
  de la configuration mTLS, tentative de connexion TCP, boucle de reconnexion,
  arrêt propre sur `SIGTERM` (le signal que procd envoie).

**NON prouvé (à valider chez vous) :**

- le démarrage via **procd** sur un vrai OpenWrt (`/etc/init.d/yuki-agent start`) ;
- une **connexion mTLS réelle** vers Yuki depuis un routeur ;
- l'**exécution d'une commande** reçue de Yuki sur un routeur ;
- la place réellement disponible dans **votre** overlay, et le comportement
  après `sysupgrade`.

Aucun routeur OpenWrt n'était disponible pendant l'implémentation : tout ce qui
précède est mesuré sur l'hôte de build et sous QEMU.
