// Client utilisé par chaque instance MCP : relaie vers le pont (processus unique) sur 127.0.0.1:8790.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 8790);
export async function browserCall(cmd, args = {}) {
  let token;
  try { token = readFileSync(join(here, 'browser-token.txt'), 'utf8').trim(); } catch { throw new Error('browser-token.txt absent.'); }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/call`, { method: 'POST', headers: { 'x-mcp-token': token }, body: JSON.stringify({ cmd, args }), signal: AbortSignal.timeout(30000) });
  } catch { throw new Error('Pont navigateur injoignable (redémarrer le service mcp-pc).'); }
  const r = await res.json();
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
