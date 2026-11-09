import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';

const dir = new URL('./', import.meta.url);
const ISSUER = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const CALLBACK = process.env.OAUTH_REDIRECT_URI ?? '';
if (!ISSUER || !CALLBACK) { console.error('PUBLIC_URL et OAUTH_REDIRECT_URI sont requis.'); process.exit(1); }
const secretFile = new URL('token.txt', dir);
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('hex'), { mode: 0o600 });
const secret = readFileSync(secretFile, 'utf8').trim();
const UPSTREAM = { host: '127.0.0.1', port: 8787 };
const ACCESS_TTL = 30 * 24 * 3600e3;
const REFRESH_TTL = 365 * 24 * 3600e3;

const stateFile = new URL('oauth-state.json', dir);
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { clients: {}, access: {}, refresh: {} };
const codes = new Map();
const save = () => writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

const rand = () => randomBytes(32).toString('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res, code, body) =>
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const readBody = (req) => new Promise((ok) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => ok(b));
});
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let failures = [];
const rateLimited = () => {
  const now = Date.now();
  failures = failures.filter((t) => now - t < 15 * 60e3);
  return failures.length >= 5;
};

function authorizePage(p, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] ?? '')}">`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autoriser l'accès au PC</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1>Autoriser ce client ?</h1>
<p>Cette application demandera l'accès complet (fichiers et shell) à ce PC. Saisis la clé secrète pour confirmer.</p>
${error ? `<p style="color:#b00020">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<input type="password" name="secret" autofocus required style="width:100%;padding:.6rem;font-size:1rem">
<button style="margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem">Autoriser</button></form></body>`;
}

function validateAuthz(p) {
  const c = state.clients[p.client_id];
  if (!c) return 'client_id inconnu';
  if (p.redirect_uri !== CALLBACK || !c.redirect_uris.includes(p.redirect_uri)) return 'redirect_uri refusée';
  if (p.response_type !== 'code') return 'response_type invalide';
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'PKCE S256 requis';
  return null;
}

function issueTokens(clientId) {
  const access = rand(), refresh = rand(), now = Date.now();
  state.access[access] = { clientId, exp: now + ACCESS_TTL };
  state.refresh[refresh] = { clientId, exp: now + REFRESH_TTL };
  for (const [k, v] of Object.entries(state.access)) if (v.exp < now) delete state.access[k];
  for (const [k, v] of Object.entries(state.refresh)) if (v.exp < now) delete state.refresh[k];
  save();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
}

function bearerValid(header) {
  if (!header?.startsWith('Bearer ')) return false;
  const t = header.slice(7);
  if (safeEq(t, secret)) return true;
  const a = state.access[t];
  return !!a && a.exp > Date.now();
}

async function oauth(req, res, url) {
  const path = url.pathname;
  if (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource/')) {
    return json(res, 200, { resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (path === '/register' && req.method === 'POST') {
    let meta;
    try { meta = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid_client_metadata' }); }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.some((u) => u !== CALLBACK)) {
      return json(res, 400, { error: 'invalid_redirect_uri' });
    }
    const client_id = rand();
    state.clients[client_id] = { redirect_uris: uris, name: String(meta.client_name ?? '').slice(0, 100) };
    save();
    return json(res, 201, {
      client_id, client_name: state.clients[client_id].name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    });
  }
  if (path === '/authorize' && req.method === 'GET') {
    const p = Object.fromEntries(url.searchParams);
    const err = validateAuthz(p);
    if (err) return res.writeHead(400, { 'Content-Type': 'text/plain' }).end(err);
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(authorizePage(p));
  }
  if (path === '/authorize' && req.method === 'POST') {
    const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const err = validateAuthz(p);
    if (err) return res.writeHead(400, { 'Content-Type': 'text/plain' }).end(err);
    const page = (e) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(authorizePage(p, e));
    if (rateLimited()) return page('Trop de tentatives, réessaie dans 15 minutes.');
    if (!safeEq(p.secret ?? '', secret)) { failures.push(Date.now()); return page('Clé incorrecte.'); }
    const code = rand();
    codes.set(code, { clientId: p.client_id, challenge: p.code_challenge, exp: Date.now() + 5 * 60e3 });
    const back = new URL(CALLBACK);
    back.searchParams.set('code', code);
    if (p.state) back.searchParams.set('state', p.state);
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (path === '/token' && req.method === 'POST') {
    const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
    if (p.grant_type === 'authorization_code') {
      const c = codes.get(p.code);
      codes.delete(p.code);
      const challenge = createHash('sha256').update(p.code_verifier ?? '').digest('base64url');
      if (!c || c.exp < Date.now() || c.clientId !== p.client_id || !safeEq(challenge, c.challenge)) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      return json(res, 200, issueTokens(c.clientId));
    }
    if (p.grant_type === 'refresh_token') {
      const r = state.refresh[p.refresh_token];
      if (!r || r.exp < Date.now() || r.clientId !== p.client_id) return json(res, 400, { error: 'invalid_grant' });
      delete state.refresh[p.refresh_token];
      return json(res, 200, issueTokens(r.clientId));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  return false;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.on('finish', () => console.log(`[proxy] ${req.method} ${url.pathname} -> ${res.statusCode} ua=${req.headers['user-agent'] ?? '-'}`));
  try {
    if (await oauth(req, res, url) !== false) return;
  } catch (e) {
    return json(res, 500, { error: 'server_error' });
  }
  if (!bearerValid(req.headers.authorization)) {
    res.writeHead(401, {
      'WWW-Authenticate': `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    }).end('unauthorized');
    return;
  }
  const up = http.request({ ...UPSTREAM, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end('upstream down'));
  req.pipe(up);
}).listen(8788, '127.0.0.1');
