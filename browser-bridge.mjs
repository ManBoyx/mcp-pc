// Processus unique (lancé par start.sh) : pont entre le serveur MCP et l'extension navigateur (Chromium/Chrome) : HTTP local, sans dépendance.
// L'extension interroge /poll (long polling), exécute la commande, renvoie le résultat sur /result.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 8790);
const tokenFile = join(here, 'browser-token.txt');
if (!existsSync(tokenFile)) { writeFileSync(tokenFile, randomBytes(24).toString('hex')); chmodSync(tokenFile, 0o600); }
const TOKEN = readFileSync(tokenFile, 'utf8').trim();

const queue = [];            // commandes en attente d'être prises par l'extension
const pending = new Map();   // id -> { resolve, reject, timer }
let poller = null;           // requête /poll en attente
let lastSeen = 0;
let seq = 0;

const deliver = () => {
  if (poller && queue.length) {
    const p = poller; poller = null; clearTimeout(p.timer);
    p.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(queue.shift()));
  }
};

const server = http.createServer((req, res) => {
  const deny = (c) => res.writeHead(c).end();
  if (req.headers['x-mcp-token'] !== TOKEN || (req.headers.origin && !req.headers.origin.startsWith('chrome-extension://'))) return deny(403);
  if (req.url !== '/call') lastSeen = Date.now();
  if (req.method === 'GET' && req.url === '/poll') {
    if (poller) { clearTimeout(poller.timer); poller.res.writeHead(204).end(); }
    poller = { res, timer: setTimeout(() => { poller = null; res.writeHead(204).end(); }, 25000) };
    req.on('close', () => { if (poller?.res === res) { clearTimeout(poller.timer); poller = null; } });
    return deliver();
  }
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      try {
        const r = JSON.parse(body); const w = pending.get(r.id);
        if (w) { pending.delete(r.id); clearTimeout(w.timer); r.ok ? w.resolve(r.result) : w.reject(new Error(r.error)); }
        res.writeHead(204).end();
      } catch { deny(400); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/call') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { cmd, args } = JSON.parse(body);
        const out = await browserCall(cmd, args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: out }));
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }
  deny(404);
});
server.listen(PORT, '127.0.0.1');
server.on('error', (e) => process.stderr.write(`[browser-bridge] ${e.message}\n`));

const bridgeConnected = () => Date.now() - lastSeen < 40000;
function browserCall(cmd, args = {}, timeoutMs = 20000) {
  if (!bridgeConnected()) return Promise.reject(new Error("Extension navigateur non connectée. Ouvrir le navigateur avec l'extension « Contrôle PC » activée (voir browser-extension/LISEZMOI.md)."));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Le navigateur n\'a pas répondu à temps.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    queue.push({ id, cmd, args });
    deliver();
  });
}
