#!/bin/sh
cd "$(dirname "$0")"
: "${PUBLIC_URL:?Définir PUBLIC_URL (URL publique HTTPS de ce serveur) et OAUTH_REDIRECT_URI avant de lancer}"
: "${OAUTH_REDIRECT_URI:?Définir OAUTH_REDIRECT_URI (URL de retour OAuth de votre client MCP)}"
export PUBLIC_URL OAUTH_REDIRECT_URI
# Le service démarre au boot, avant la connexion KDE : on attend la session graphique
# (3 minutes au plus) puis on reprend ses variables d'écran pour piloter les applications.
for i in $(seq 1 90); do
  systemctl --user show-environment | grep -q '^WAYLAND_DISPLAY=' && break
  sleep 2
done
eval "$(systemctl --user show-environment | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|KDE_FULL_SESSION|XAUTHORITY)=' | sed 's/^/export /')"
./node_modules/.bin/supergateway --stdio "node $(pwd)/mcp-all.mjs" \
  --outputTransport streamableHttp --port 8787 --stateful &
node auth-proxy.mjs &
node browser-bridge.mjs &
wait -n
exit 1
