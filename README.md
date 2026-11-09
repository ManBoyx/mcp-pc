**Français** · [English](#english)

# mcp-pc — contrôle d'un PC Linux par un assistant (serveur MCP)

Serveur [MCP](https://modelcontextprotocol.io) qui permet à un assistant IA compatible de piloter **un PC Linux à distance** : fichiers et terminal, capture d'écran, souris, clavier, fenêtres, lecture de l'interface des applications **en texte** (AT-SPI), lancement d'applications et navigation web par une extension de navigateur.

> ⚠️ **Cet outil donne un contrôle complet de la machine** (fichiers, shell, écran, clavier, souris) à quiconque s'authentifie. Lisez la section [Sécurité](#sécurité) avant de l'exposer sur Internet. Projet personnel, **non audité**.

## Architecture

| Élément | Rôle | Port |
|---|---|---|
| `mcp-all.mjs` | Serveur MCP (stdio) : relaie [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) (fichiers, terminal) et ajoute les outils du bureau | — |
| `supergateway` | Expose ce serveur en HTTP (streamable HTTP) | 8787 (local) |
| `auth-proxy.mjs` | Place une authentification OAuth 2.0 (PKCE S256, enregistrement dynamique de client) devant le serveur. Une clé secrète est demandée à l'autorisation ; 5 échecs bloquent 15 minutes | 8788 (local) |
| `browser-bridge.mjs` + `browser-extension/` | Pont entre le serveur et une extension Chromium : lecture et pilotage des pages web en texte | 8790 (local) |
| `inputd.py` | Assistant Python : souris/clavier virtuels (`/dev/uinput`), fenêtres (KWin), interface des applications (AT-SPI), presse-papiers. Lancé à la demande, arrêté après 3 min d'inactivité | — |
| `modules/*.json` | Conseils et commandes par application (exemples : Dolphin, Kate, navigateur). Ajoutez les vôtres | — |

**Outils ajoutés :** `screen_screenshot`, `screen_click`, `screen_move`, `screen_drag`, `screen_scroll`, `keyboard_press`, `keyboard_type`, `windows_list`, `windows_control`, `ui_read`, `ui_click`, `ui_set_text`, `app_list`, `app_launch`, `app_profile`, `app_command`, `browser_tabs`, `browser_read`, `browser_click`, `browser_type`, `browser_navigate`, `browser_extract`, `browser_tab`.

**Garde-fou :** les commandes qui écrivent sur les disques, partitions ou LVM (`mkfs`, `fdisk`, `dd of=/dev/…`, `lvremove`, `wipefs` sans `-n`…) sont bloquées tant que l'utilisateur n'a pas tapé lui-même `sudo touch /etc/mcp-pc-accord-disques` (valable 15 minutes ; chemin modifiable avec `MCP_ACCORD_FILE`). C'est une protection heuristique, **pas une frontière de sécurité**.

## Prérequis

Développé et utilisé sous **Linux avec KDE Plasma (Wayland)** ; d'autres environnements ne sont pas pris en charge (KWin, `spectacle`, `qdbus-qt6` et Klipper sont utilisés).

- Node.js 20 ou plus récent, puis `npm install` dans ce dossier.
- Python 3 avec `python-evdev`, `python-dbus`, `PyGObject` (Atspi) et `Pillow`.
- Accès en écriture à `/dev/uinput` pour l'utilisateur (règle udev ou groupe `input`).
- Un client MCP distant qui gère OAuth, et une **URL publique en HTTPS** qui redirige vers le port 8788 (tunnel ou reverse proxy de votre choix).

## Installation et lancement

```bash
npm install
export PUBLIC_URL="https://votre-url-publique"          # URL HTTPS vue par le client
export OAUTH_REDIRECT_URI="https://client.exemple/oauth/callback"   # adresse de retour OAuth de VOTRE client
export SCREEN_WIDTH=1920 SCREEN_HEIGHT=1080              # résolution de l'écran (par défaut 1920x1080)
./start.sh
```

`start.sh` attend la session graphique (3 minutes au plus), ce qui permet de le lancer au démarrage comme service utilisateur.
Au premier lancement, deux fichiers sont créés (droits `0600`) :
- `token.txt` : la **clé secrète** à saisir sur la page d'autorisation quand vous connectez votre client ;
- `browser-token.txt` : le jeton du pont navigateur.

**Extension navigateur :** dans `browser-extension/`, copiez `config.example.js` en `config.js`, collez-y le contenu de `browser-token.txt`, puis chargez le dossier comme extension non empaquetée (`chrome://extensions`, mode développeur).

Variables : `PUBLIC_URL` et `OAUTH_REDIRECT_URI` (obligatoires), `SCREEN_WIDTH`, `SCREEN_HEIGHT`, `BROWSER_BRIDGE_PORT` (8790), `MCP_ACCORD_FILE`.

## Sécurité

- Quiconque connaît la clé de `token.txt` **et** atteint votre URL peut contrôler la machine avec les droits de l'utilisateur. Gardez cette clé longue et secrète ; ne la partagez jamais.
- Ne versionnez jamais `token.txt`, `browser-token.txt`, `oauth-state.json` ni `browser-extension/config.js` (le `.gitignore` les exclut). `oauth-state.json` contient les jetons d'accès : le supprimer révoque toutes les connexions.
- Exposez le service sur Internet seulement derrière un tunnel ou un reverse proxy que vous maîtrisez, de préférence avec un contrôle d'accès supplémentaire. Les jetons d'accès durent 30 jours, les jetons de renouvellement 365 jours.
- Si vous n'avez pas besoin d'un accès distant, gardez tout sur `127.0.0.1`.
- `sudo` : le serveur n'élève jamais ses droits de lui-même ; les instructions données à l'assistant exigent votre accord avant toute commande root, mais ce n'est qu'une consigne, pas un verrou technique.

## Licence

[GPL-3.0](LICENSE). Dépendances : Desktop Commander et supergateway (MIT).

---

# English

# mcp-pc — control a Linux PC from an AI assistant (MCP server)

An [MCP](https://modelcontextprotocol.io) server that lets a compatible AI assistant drive **a Linux PC remotely**: files and terminal, screenshots, mouse, keyboard, windows, **text-based** reading of application interfaces (AT-SPI), launching applications, and web browsing through a browser extension.

> ⚠️ **This tool gives complete control of the machine** (files, shell, screen, keyboard, mouse) to anyone who authenticates. Read the [Security](#security) section before exposing it to the Internet. Personal project, **not audited**.

## Architecture

| Component | Role | Port |
|---|---|---|
| `mcp-all.mjs` | MCP server (stdio): relays [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) (files, terminal) and adds the desktop tools | — |
| `supergateway` | Exposes that server over HTTP (streamable HTTP) | 8787 (local) |
| `auth-proxy.mjs` | Puts OAuth 2.0 authentication (PKCE S256, dynamic client registration) in front. A secret key is requested at authorization; 5 failures lock it for 15 minutes | 8788 (local) |
| `browser-bridge.mjs` + `browser-extension/` | Bridge between the server and a Chromium extension: reads and drives web pages as text | 8790 (local) |
| `inputd.py` | Python helper: virtual mouse/keyboard (`/dev/uinput`), windows (KWin), application UI (AT-SPI), clipboard. Started on demand, stopped after 3 min idle | — |
| `modules/*.json` | Per-application hints and commands (examples: Dolphin, Kate, browser). Add your own | — |

**Added tools:** `screen_screenshot`, `screen_click`, `screen_move`, `screen_drag`, `screen_scroll`, `keyboard_press`, `keyboard_type`, `windows_list`, `windows_control`, `ui_read`, `ui_click`, `ui_set_text`, `app_list`, `app_launch`, `app_profile`, `app_command`, `browser_tabs`, `browser_read`, `browser_click`, `browser_type`, `browser_navigate`, `browser_extract`, `browser_tab`.

**Safeguard:** commands that write to disks, partitions or LVM (`mkfs`, `fdisk`, `dd of=/dev/…`, `lvremove`, `wipefs` without `-n`…) are blocked until the user types `sudo touch /etc/mcp-pc-accord-disques` themselves (valid for 15 minutes; path changeable with `MCP_ACCORD_FILE`). This is a heuristic protection, **not a security boundary**.

## Requirements

Developed and used on **Linux with KDE Plasma (Wayland)**; other environments are not supported (KWin, `spectacle`, `qdbus-qt6` and Klipper are used).

- Node.js 20 or newer, then `npm install` in this folder.
- Python 3 with `python-evdev`, `python-dbus`, `PyGObject` (Atspi) and `Pillow`.
- Write access to `/dev/uinput` for the user (udev rule or `input` group).
- A remote MCP client that supports OAuth, and a **public HTTPS URL** forwarding to port 8788 (tunnel or reverse proxy of your choice).

## Installation and start

```bash
npm install
export PUBLIC_URL="https://your-public-url"                      # HTTPS URL as seen by the client
export OAUTH_REDIRECT_URI="https://client.example/oauth/callback"   # OAuth callback of YOUR client
export SCREEN_WIDTH=1920 SCREEN_HEIGHT=1080                      # screen resolution (default 1920x1080)
./start.sh
```

`start.sh` waits for the graphical session (3 minutes at most), so it can be started at boot as a user service.
On first run, two files are created (mode `0600`):
- `token.txt`: the **secret key** to type on the authorization page when you connect your client;
- `browser-token.txt`: the browser bridge token.

**Browser extension:** in `browser-extension/`, copy `config.example.js` to `config.js`, paste the content of `browser-token.txt` into it, then load the folder as an unpacked extension (`chrome://extensions`, developer mode).

Variables: `PUBLIC_URL` and `OAUTH_REDIRECT_URI` (required), `SCREEN_WIDTH`, `SCREEN_HEIGHT`, `BROWSER_BRIDGE_PORT` (8790), `MCP_ACCORD_FILE`.

## Security

- Anyone who knows the key in `token.txt` **and** can reach your URL can control the machine with the user's rights. Keep that key long and secret; never share it.
- Never commit `token.txt`, `browser-token.txt`, `oauth-state.json` or `browser-extension/config.js` (the `.gitignore` excludes them). `oauth-state.json` holds the access tokens: deleting it revokes every connection.
- Expose the service to the Internet only behind a tunnel or reverse proxy you control, preferably with an extra access control. Access tokens last 30 days, refresh tokens 365 days.
- If you do not need remote access, keep everything on `127.0.0.1`.
- `sudo`: the server never elevates by itself; the instructions given to the assistant require your approval before any root command, but that is only an instruction, not a technical lock.

## License

[GPL-3.0](LICENSE). Dependencies: Desktop Commander and supergateway (MIT).
