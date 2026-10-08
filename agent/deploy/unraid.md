# Agent Yuki sur Unraid — survivre aux redémarrages

> Document de terrain (dossier `agent/deploy/`). Faits Unraid sourcés, date de
> vérification : 2026-10-08. Ce qui n'a pas pu être confirmé est marqué
> **incertain**.

## 1. Faits Unraid (vérifiés)

| Fait | Verdict | Source |
|---|---|---|
| Unraid **n'utilise pas systemd** | ✅ confirmé | GitHub vmstan/gravity-sync #337 « Unraid does not have systemctl » ; forum Unraid « Restart services from the cli? » : `service` ni `systemctl` ne marchent ; forum « Create a custom Service in UNRAID » (25/06/2022) : « unRAID uses Slackware. Slackware's path to the services is /etc/rc.d ». Doc plugin (validée 7.2.3) : services = `/etc/rc.d/`, tâches = `/etc/cron.d/`. |
| Le système tourne **en RAM** | ✅ confirmé | Doc plugin Unraid « File System Layout » (`plugin-docs.mstrhakr.com`, validée 7.2.3). |
| **Persiste** : `/boot` (USB), `/mnt/user`, `/mnt/cache`, `/mnt/disk*` ; **volatile** : `/etc`, `/usr/local`, `/var`, `/tmp` | ✅ confirmé | Doc plugin « File Path Reference » (tableau Persistance, validée 7.2.3) ; Doc officielle Unraid « Boot & startup failures ». |
| `/boot/config/go` s'exécute **avant** le montage du tableau (vers le démarrage du WebGUI) | ✅ confirmé | Doc officielle Unraid « Boot & startup failures » (étape 6 WebGUI → le `config/go` tourne « before or after the WebGUI starts » ; étape 7 = Array). |
| Plugin **« User Scripts »** : scripts sous `/boot/config/plugins/user.scripts/scripts/<Nom>/`, en **root** | ✅ confirmé | Source Squidly271/user.scripts (`Userscripts.page`, `helpers.php`) ; doc plugin « User Scripts Integration ». |
| Déclencheurs exacts du plugin | ✅ confirmé | Source `Userscripts.page` : *Schedule Disabled · Hourly · Daily · Weekly · Monthly · **At Startup of Array** (= `start`) · **At First Array Start Only** (= `boot`) · Cron personnalisé*. `start` = à **chaque** démarrage du tableau ; `boot` = seulement au **premier** démarrage du tableau après allumage (garde `/tmp/user.scripts/booted`). |
| Le plugin **détache** le script (ne bloque pas le boot) | ✅ confirmé | Source `backgroundScript.sh` + `startBackground.php` : lancement via `at NOW`, sortie journalisée dans `/tmp/user.scripts/...`. |
| Docker Unraid : conteneurs « **Auto-Start** » au démarrage du tableau ; données dans `appdata` | ✅ confirmé | Doc officielle Unraid « Managing & customizing containers » (onglet Docker → Auto-Start ; appdata = `/mnt/user/appdata`). |
| Unraid **8** abandonnera Slackware pour Fedora/uCore | ⚠️ annoncé (23/08/2026), **pas encore publié** ; pourrait changer l'init | Linuxiac « Unraid 8 NAS to Drop Slackware… » (23/08/2026). |

**Conséquence décisive** : sous Linux, `yuki-agent install`/`uninstall` renvoient
`ErrUnsupported` (voir `agent/internal/service/service_linux.go`). L'unité
`agent/deploy/yuki-agent.service` **est inapplicable** sur Unraid.

## 2. Hôte ou conteneur ?

Un agent dans un conteneur Docker n'exécute des commandes **que dans ce
conteneur** — pas sur l'hôte. Pour agir sur la machine il faudrait un accès
privilégié à l'hôte (`--privileged`, montage du socket Docker, namespace PID
hôte…). **Écarté** : c'est une escalade, contraire au modèle de l'agent (Yuki
décide, l'agent exécute *sur la machine*).

⇒ **L'agent doit tourner sur l'hôte Unraid.**

## 3. Procédure (hôte)

Chemins persistants (`/mnt/user/appdata` = tableau monté) :

```
/mnt/user/appdata/yuki-agent/
├── yuki-agent            # binaire (chmod 0755)
├── yuki-agent-run.sh     # wrapper superviseur
├── run.pid               # PID du wrapper
├── agent.log             # journal
└── state/                # ⚠️ ÉTAT PERSISTANT
    ├── agent.json
    ├── ca.pem
    ├── client.pem
    └── client.key
```

1. **Copier le binaire**
   ```sh
   install -d -m 0755 /mnt/user/appdata/yuki-agent/state
   install -m 0755 ./yuki-agent /mnt/user/appdata/yuki-agent/yuki-agent
   ```

2. **Appairer — UNE fois, à la main** (interactif : la machine affiche le code,
   à recopier dans Yuki → Configuration → Agents). ⚠️ **`--state-dir` est
   OBLIGATOIRE** : sinon les certificats vont dans `/etc/yuki-agent` (RAM) et
   **vous ré-appairerez à CHAQUE reboot**.
   ```sh
   /mnt/user/appdata/yuki-agent/yuki-agent pair \
     --yuki-url wss://<hote-yuki>:9443/ws \
     --config  /mnt/user/appdata/yuki-agent/state/agent.json \
     --state-dir /mnt/user/appdata/yuki-agent/state
   ```
   ⚠️ **Ne jamais mettre l'appairage dans un script de boot.**

3. **Wrapper superviseur** `/mnt/user/appdata/yuki-agent/yuki-agent-run.sh` :
   ```sh
   #!/bin/bash
   APP=/mnt/user/appdata/yuki-agent
   PID="$APP/run.pid"
   [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null && exit 0   # anti-doublon
   echo $$ > "$PID"
   trap 'kill "$CHILD" 2>/dev/null; rm -f "$PID"; exit 0' TERM INT
   while :; do
     "$APP/yuki-agent" run --config "$APP/state/agent.json" --log-level info >>"$APP/agent.log" 2>&1 &
     CHILD=$!
     wait "$CHILD"
     sleep 5
   done
   ```
   `chmod 0755 yuki-agent-run.sh`.
   ⚠️ **Limites** : pas de superviseur système — c'est cette boucle qui relance
   l'agent ; elle ne survit pas à un arrêt du tableau (`/mnt/user` disparaît) ni
   à un redémarrage (le plugin la relance).

4. **Démarrage au boot** — plugin **User Scripts** → nouveau script (ex.
   « Yuki agent »), déclencheur **« At Startup of Array »**, case
   `#arrayStarted=true`, contenu :
   ```sh
   #!/bin/bash
   #name=Yuki agent
   #description=Agent d'exécution Yuki
   #arrayStarted=true
   exec /mnt/user/appdata/yuki-agent/yuki-agent-run.sh
   ```
   (Le plugin détache le script → **ne bloque pas** le boot. Vérifier que le
   **démarrage automatique du tableau** est activé, sinon `/mnt/user` n'existe
   pas.)

5. **Utilisateur** : les scripts du plugin tournent **en root**. L'agent a donc
   les pleins privilèges (Yuki peut toute chose sur la machine) — c'est le but
   « piloter la machine », mais c'est une **décision de sécurité**. Pour
   restreindre, lancer le wrapper via `su <compte>` (perte des opérations
   privilégiées).

6. **Mise à jour propre** (jamais de `pkill` large) :
   ```sh
   PIDF=/mnt/user/appdata/yuki-agent/run.pid
   [ -f "$PIDF" ] && kill "$(cat "$PIDF")"        # le trap stoppe l'enfant
   install -m 0755 ./yuki-agent.new /mnt/user/appdata/yuki-agent/yuki-agent
   /mnt/user/appdata/yuki-agent/yuki-agent-run.sh >/dev/null 2>&1 &   # relance
   ```

## 4. À vérifier par l'utilisateur (non testable ici)

- Après un **vrai reboot** : l'agent tourne (`status` = appairé) et **aucun
  ré-appairage** n'est demandé.
- `ls /mnt/user/appdata/yuki-agent/state/` : `ca.pem`/`client.pem`/`client.key`
  présents **après** reboot (c'est le point qui décide).
- `run.log`/`agent.log` : pas de `agent.non_appaire`.

## 5. Incertain

- Quirk d'**exécution d'un binaire depuis `/mnt/user`** (shfs/FUSE) — **incertain**,
  à tester ; repli : binaire sous `/boot/config/yuki-agent/` (toujours monté).
- Comportement du plugin User Scripts à l'arrêt du tableau (le script détaché
  n'est pas tué par le plugin d'après la source) — **incertain**.
- Emplacement de `at` sur Unraid — **incertain** (le plugin en dépend).
- Unraid 8 (Fedora/uCore) pourrait changer l'init — **à revérifier** quand publié.
