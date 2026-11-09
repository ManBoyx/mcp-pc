# Extension « Contrôle PC »
Donne à l'assistant la lecture et le pilotage des pages web **en texte** (pas de capture d'écran).
Installation (Chromium, Chrome, Brave, Helium…) : `chrome://extensions` (ou `helium://extensions`) → activer « Mode développeur » → « Charger l'extension non empaquetée » → choisir ce dossier.
Elle ne parle qu'à `127.0.0.1:8790` (serveur mcp-pc), avec le jeton de `config.js`. Copiez `config.example.js` en `config.js` et collez-y le contenu de `../browser-token.txt` (créé au premier lancement). Ne partagez jamais `config.js`.
