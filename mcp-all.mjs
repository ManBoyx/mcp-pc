#!/usr/bin/env node
// Serveur MCP stdio unique : relaie Desktop Commander (fichiers, terminal) et
// ajoute les outils de contrôle du bureau (écran, souris, clavier, fenêtres, applications).
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCall } from './browser-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write('[mcp-all] ' + a.join(' ') + '\n');

// Binaire local (npm i dans ce dossier) : évite le wrapper « npm exec » (~85 Mo de RAM par session) et la vérification réseau de @latest.
const dc = spawn(process.execPath, [join(here, 'node_modules/@wonderwhy-er/desktop-commander/dist/index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
dc.on('exit', (code) => { log('desktop-commander arrêté', code); process.exit(1); });

// Assistant Python (écran, souris, AT-SPI : ~45 Mo) : lancé à la demande, arrêté après 3 min d'inactivité.
let helper = null, idleTimer = null;
const waiting = new Map();
let helperSeq = 0;
function startHelper() {
  const h = spawn('python3', [join(here, 'inputd.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  h.on('exit', () => {
    if (helper === h) helper = null;
    for (const [id, w] of waiting) { waiting.delete(id); w.reject(new Error('assistant arrêté')); }
  });
  createInterface({ input: h.stdout }).on('line', (line) => {
    const r = JSON.parse(line);
    const w = waiting.get(r.id);
    if (!w) return;
    waiting.delete(r.id);
    r.ok ? w.resolve(r.result) : w.reject(new Error(r.error));
  });
  return h;
}
const ask = (cmd, args = {}) => new Promise((resolve, reject) => {
  helper ??= startHelper();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!waiting.size) { helper?.kill(); helper = null; } else idleTimer.refresh(); }, 180000);
  const id = ++helperSeq;
  waiting.set(id, { resolve, reject });
  helper.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  setTimeout(() => { if (waiting.delete(id)) reject(new Error('délai dépassé')); }, 20000);
});

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

const num = { type: 'number' };
const TOOLS = [
  { name: 'screen_screenshot', description: "Capture l'écran entier (taille définie par SCREEN_WIDTH et SCREEN_HEIGHT, 1920x1080 par défaut) et renvoie l'image. Les coordonnées de la souris sont en pixels de cette image.", inputSchema: { type: 'object', properties: {} } },
  { name: 'screen_click', description: 'Clique à la position (x, y). button: left, right ou middle. double: true pour un double clic.', inputSchema: { type: 'object', properties: { x: num, y: num, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }, required: ['x', 'y'] } },
  { name: 'screen_move', description: 'Déplace le pointeur à (x, y) sans cliquer.', inputSchema: { type: 'object', properties: { x: num, y: num }, required: ['x', 'y'] } },
  { name: 'screen_drag', description: 'Glisser-déposer de (x1, y1) vers (x2, y2) avec le bouton gauche.', inputSchema: { type: 'object', properties: { x1: num, y1: num, x2: num, y2: num }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'screen_scroll', description: 'Fait défiler à (x, y). dy > 0 descend, dy < 0 monte (en crans de molette). dx pour le défilement horizontal.', inputSchema: { type: 'object', properties: { x: num, y: num, dy: num, dx: num } } },
  { name: 'keyboard_press', description: 'Appuie sur une touche ou un raccourci (agit sur la fenêtre active : la vérifier avant Entrée), par exemple "enter", "ctrl+c", "alt+tab", "super", "ctrl+shift+t", "f5".', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'keyboard_type', description: "Saisit du texte dans l'élément qui a le focus de la fenêtre active (via le presse-papiers, accents et symboles compris). Vérifier la fenêtre active avant, avec windows_list.", inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'windows_list', description: 'Liste les fenêtres ouvertes : id, titre, application, position, taille, active, réduite.', inputSchema: { type: 'object', properties: {} } },
  { name: 'windows_control', description: "Agit sur une fenêtre par son id (voir windows_list) : focus (la met au premier plan), close, minimize ou maximize.", inputSchema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['focus', 'close', 'minimize', 'maximize'] } }, required: ['id', 'action'] } },
  { name: 'ui_read', description: "Lit l'interface d'une application en texte (boutons, champs, menus, onglets, leur nom, leur état et leur texte), sans capture d'écran. Par défaut la fenêtre active ; app pour en cibler une autre. filter limite aux éléments dont le nom, le texte ou le rôle contient ce mot. Chaque ligne commence par un id [0.3.2] utilisable avec ui_click et ui_set_text. Ne fonctionne que pour les applications qui exposent leur interface (celles lancées avec app_launch en général) ; sinon utiliser screen_screenshot.", inputSchema: { type: 'object', properties: { app: { type: 'string' }, filter: { type: 'string' }, max: num } } },
  { name: 'ui_click', description: "Active un élément de l'interface par son nom (ou son id donné par ui_read) : bouton, case à cocher, onglet, élément de liste ou de menu. role précise le type (button, check box, page tab…). action choisit une action précise ; par défaut la plus naturelle (Press, Toggle…). Sans action disponible, clique à une position estimée.", inputSchema: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' }, role: { type: 'string' }, app: { type: 'string' }, action: { type: 'string' } } } },
  { name: 'ui_set_text', description: "Écrit du texte dans un champ de l'interface, désigné par son nom ou son id (voir ui_read). Remplace le contenu du champ.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, role: { type: 'string' }, app: { type: 'string' } }, required: ['text'] } },
  { name: 'app_list', description: "Liste les applications installées (id, nom, description). query filtre par nom ou id. À utiliser avant app_launch pour trouver le bon nom.", inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'app_launch', description: "Lance une application. Soit par son nom ou son id (voir app_list), par exemple app=\"Firefox\" ou app=\"org.kde.dolphin\" ; soit par une commande (command=\"dolphin ~/Documents\", \"xdg-open https://...\"). Fournir app ou command. Détaché : l'application reste ouverte.", inputSchema: { type: 'object', properties: { app: { type: 'string' }, command: { type: 'string' } } } },
  { name: 'browser_tabs', description: "Liste les onglets du navigateur (id, titre, URL ; * = onglet actif). Nécessite l'extension « Contrôle PC ». Préférer browser_* à screen_screenshot pour tout ce qui est web.", inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_read', description: "Lit une page web en texte compact : titre, URL, titres, texte et éléments interactifs numérotés [ref] (liens, boutons, champs avec leur valeur). Sans capture d'écran. filter limite aux éléments contenant ce mot ; scope = sélecteur CSS d'une zone ; tab = id d'onglet (défaut : actif). Les refs sont valables jusqu'au prochain browser_read.", inputSchema: { type: 'object', properties: { tab: num, filter: { type: 'string' }, scope: { type: 'string' }, withText: { type: 'boolean' }, maxChars: num } } },
  { name: 'browser_click', description: "Clique sur l'élément [ref] donné par browser_read.", inputSchema: { type: 'object', properties: { ref: num, tab: num }, required: ['ref'] } },
  { name: 'browser_type', description: "Écrit dans le champ [ref] (ou choisit une option d'une liste). submit: true valide avec Entrée. append: true ajoute au texte existant.", inputSchema: { type: 'object', properties: { ref: num, text: { type: 'string' }, submit: { type: 'boolean' }, append: { type: 'boolean' }, tab: num }, required: ['ref', 'text'] } },
  { name: 'browser_navigate', description: "Ouvre une URL dans l'onglet actif (ou un nouvel onglet avec newTab: true) et attend le chargement. Revenir en arrière : back: true.", inputSchema: { type: 'object', properties: { url: { type: 'string' }, newTab: { type: 'boolean' }, back: { type: 'boolean' }, tab: num } } },
  { name: 'browser_extract', description: "Renvoie le texte brut de la page (ou de la zone selector) pour lire un article ou un long contenu. Défiler : scroll_dy en pixels (browser_extract sans selector après défilement).", inputSchema: { type: 'object', properties: { selector: { type: 'string' }, scroll_dy: num, maxChars: num, tab: num } } },
  { name: 'browser_tab', description: "Active (action: activate) ou ferme (action: close) l'onglet tab.", inputSchema: { type: 'object', properties: { tab: num, action: { type: 'string', enum: ['activate', 'close'] } }, required: ['tab', 'action'] } },
  { name: 'app_profile', description: "Aide à comprendre une application : renvoie ses conseils d'usage et ses commandes dédiées (modules/*.json), plus un aperçu texte de son interface (ui_read compact). À appeler avant de piloter une application inconnue.", inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
  { name: 'app_command', description: "Exécute une commande dédiée d'une application décrite dans modules/*.json (voir app_profile), avec ses paramètres dans args. Plus fiable que de cliquer.", inputSchema: { type: 'object', properties: { app: { type: 'string' }, command: { type: 'string' }, args: { type: 'object' } }, required: ['app', 'command'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));


const APP_DIRS = ['/usr/share/applications', '/usr/local/share/applications', `${process.env.HOME}/.local/share/applications`,
  '/var/lib/flatpak/exports/share/applications', `${process.env.HOME}/.local/share/flatpak/exports/share/applications`];
async function loadApps() {
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const apps = new Map();
  for (const dir of APP_DIRS) {
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      let t; try { t = await rf(join(dir, f), 'utf8'); } catch { continue; }
      const main = t.split(/\n\[/)[0];
      const get = (k) => main.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
      if (get('Type') && get('Type') !== 'Application') continue;
      if (get('NoDisplay') === 'true' || get('Hidden') === 'true' || !get('Exec')) continue;
      const id = f.replace(/\.desktop$/, '');
      apps.set(id, { id, name: get('Name[fr]') || get('Name') || id, comment: get('Comment[fr]') || get('Comment') || '' });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function findApp(apps, q) {
  const n = norm(q);
  const exact = apps.filter((a) => norm(a.id) === n || norm(a.name) === n);
  if (exact.length) return { app: exact[0] };
  const part = apps.filter((a) => norm(a.name).includes(n) || norm(a.id).includes(n));
  if (part.length === 1) return { app: part[0] };
  return { candidates: part.slice(0, 8) };
}

let modCache;
async function loadModules() {
  if (modCache) return modCache;
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const dir = join(here, 'modules'); modCache = [];
  for (const f of await readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try { const m = JSON.parse(await rf(join(dir, f), 'utf8')); modCache.push({ ...m, re: new RegExp(m.match, 'i') }); } catch (e) { log('module invalide', f, e.message); }
  }
  return modCache;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const activeWindow = async () => {
  const w = (await ask('windows')).windows.find((x) => x.active);
  return w ? `${w.app} - ${w.title}` : 'aucune';
};
const withActive = async (t) => text(`${t} Fenêtre active : ${await activeWindow()}.`);
async function callTool(name, a = {}) {
  switch (name) {
    case 'browser_tabs': return text(await browserCall('tabs'));
    case 'browser_read': return text(await browserCall('read', a));
    case 'browser_click': return text(await browserCall('act', { ...a, kind: 'click' }));
    case 'browser_type': return text(await browserCall('act', { ...a, kind: 'type' }));
    case 'browser_navigate': return text(a.back ? await browserCall('back', a) : await browserCall('navigate', a));
    case 'browser_extract': {
      if (a.scroll_dy) await browserCall('scroll', { dy: a.scroll_dy, tab: a.tab });
      return text(await browserCall('extract', a));
    }
    case 'browser_tab': return text(await browserCall(a.action === 'close' ? 'close' : 'activate', a));
    case 'app_profile': {
      const mods = await loadModules(); const m = mods.find((x) => x.re.test(a.app));
      let ui = '';
      try { ui = (await ask('ui_read', { app: a.app })).text.split('\n').slice(0, 60).join('\n'); } catch (e) { ui = `(interface non lisible : ${e.message})`; }
      const cmds = m ? Object.entries(m.commands || {}).map(([k, c]) => `- ${k} : ${c.description} (${[...new Set((c.argv.join(' ').match(/\{(\w+)\}/g) || []))].join(', ') || 'sans argument'})`).join('\n') : '';
      return text([m ? `Conseils : ${m.hints}` : 'Aucun module pour cette application : utiliser ui_read / ui_click.', cmds && `Commandes (app_command) :\n${cmds}`, `Interface :\n${ui}`].filter(Boolean).join('\n\n'));
    }
    case 'app_command': {
      const m = (await loadModules()).find((x) => x.re.test(a.app));
      const c = m?.commands?.[a.command];
      if (!c) return text(`Commande inconnue. Voir app_profile ${a.app}.`);
      const vals = { ...(c.defaults || {}), ...(a.args || {}) };
      const argv = c.argv.map((t) => t.replace(/\{(\w+)\}/g, (_, k) => String(vals[k] ?? '')));
      if (argv.some((t, i) => /\{|^$/.test(t) && i > 0)) return text('Argument manquant pour ' + a.command);
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', cwd: process.env.HOME });
      child.unref();
      return text(`Lancé : ${argv.join(' ')}`);
    }
    case 'screen_screenshot': {
      const png = join(tmpdir(), `mcp-shot-${process.pid}.png`);
      await run('spectacle', ['-b', '-n', '-f', '-o', png]);
      const jpg = png.replace('.png', '.jpg');
      await run('python3', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],"JPEG",quality=72)', png, jpg]);
      const data = (await readFile(jpg)).toString('base64');
      await Promise.all([unlink(png), unlink(jpg)]);
      return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `Écran ${process.env.SCREEN_WIDTH ?? 1920}x${process.env.SCREEN_HEIGHT ?? 1080} (pixels = coordonnées de la souris).` }] };
    }
    case 'screen_click': await ask('click', a); return withActive(`Clic ${a.double ? 'double ' : ''}${a.button ?? 'gauche'} en (${a.x}, ${a.y}).`);
    case 'screen_move': await ask('move', a); return text(`Pointeur en (${a.x}, ${a.y}).`);
    case 'screen_drag': await ask('drag', a); return text(`Glissé de (${a.x1}, ${a.y1}) à (${a.x2}, ${a.y2}).`);
    case 'screen_scroll': await ask('scroll', a); return text('Défilement fait.');
    case 'keyboard_press': await ask('key', a); return withActive(`Touche(s) ${a.keys} envoyée(s).`);
    case 'keyboard_type': await ask('type', a); return withActive(`${[...a.text].length} caractères saisis.`);
    case 'windows_list': return text(JSON.stringify((await ask('windows')).windows, null, 1));
    case 'windows_control': {
      const r = await ask('window', a);
      if (!r.ok) return text('Fenêtre introuvable (id périmé ?).');
      if (a.action !== 'focus') return text(`${a.action} fait.`);
      for (let i = 0; i < 3; i++) {
        await new Promise((res) => setTimeout(res, 400));
        const w = (await ask('windows')).windows.find((x) => x.id === a.id);
        if (w?.active) return text(`Fenêtre au premier plan : ${w.app} - ${w.title}.`);
        await ask('window', a);
      }
      return text(`Le focus n'a pas pris. Fenêtre active : ${await activeWindow()}. Ne pas saisir de texte avant d'avoir vérifié.`);
    }
    case 'ui_read': return text((await ask('ui_read', a)).text);
    case 'ui_click': return text((await ask('ui_click', a)).text);
    case 'ui_set_text': return text((await ask('ui_set_text', a)).text);
    case 'app_list': {
      const apps = await loadApps();
      const n = a.query ? norm(a.query) : '';
      const out = apps.filter((x) => !n || norm(x.name).includes(n) || norm(x.id).includes(n));
      return text(out.length ? out.map((x) => `${x.name} [${x.id}]${x.comment ? ' : ' + x.comment : ''}`).join('\n') : 'Aucune application trouvée.');
    }
    case 'app_launch': {
      if (!a.app && !a.command) return text('Fournir app (nom ou id) ou command.');
      let cmd = a.command, label = a.command;
      if (!cmd) {
        const r = findApp(await loadApps(), a.app);
        if (!r.app) return text(r.candidates.length ? `Plusieurs applications possibles, précise l'id : ${r.candidates.map((x) => `${x.name} [${x.id}]`).join(', ')}` : `Application introuvable : ${a.app}. Utilise app_list.`);
        cmd = `gtk-launch '${r.app.id}'`; label = `${r.app.name} [${r.app.id}]`;
      }
      const child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore', cwd: process.env.HOME, env: { ...process.env, QT_ACCESSIBILITY: '1', QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1', GTK_A11Y: 'atspi' } });
      child.unref();
      return text(`Lancé : ${label}`);
    }
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const INSTRUCTIONS = `Serveur de contrôle d'un PC Linux (KDE Plasma sous Wayland). Accès complet avec les droits de l'utilisateur : fichiers, terminal, écran, souris, clavier, fenêtres, applications.

Disques et LVM : le diagnostic en lecture seule est autorisé (lsblk, df, pvs, vgs, lvs, blkid -p, wipefs -n, file -s), avec sudo seulement si nécessaire. Aucune suppression, aucun formatage, aucune modification de partition ou de LVM, et pas de wipefs sans -n, sans l'accord explicite de l'utilisateur, demandé après avoir présenté le diagnostic. Le serveur bloque ces commandes tant que l'utilisateur n'a pas donné son accord en tapant lui-même : sudo touch /etc/mcp-pc-accord-disques (valable 15 minutes).

Accès root : si sudo est disponible sans mot de passe, utilise sudo -n. RÈGLE ABSOLUE : avant chaque usage de sudo ou de tout droit root, demande l'accord de l'utilisateur dans la conversation, en indiquant la commande exacte et pourquoi, puis attends sa réponse. Seule exception, déjà accordée : le diagnostic disques en lecture seule listé plus haut. Un accord vaut pour la commande présentée, pas pour la suite. Si sudo -n échoue en demandant un mot de passe, ne cherche pas à l'obtenir : donne la commande à l'utilisateur pour qu'il la lance lui-même.

Pour piloter une application, préfère l'interface en texte (ui_read, ui_click, ui_set_text) aux captures d'écran : elle est plus fiable et n'envoie pas l'image de l'écran. Lance les applications avec app_launch pour qu'elles exposent leur interface. N'utilise screen_screenshot qu'en secours, quand une application n'expose rien.

Pour le web (navigateur Chromium), utilise browser_read / browser_click / browser_type (extension, texte uniquement) plutôt que ui_read ou les captures. Pour une application inconnue, appelle d'abord app_profile.

Avant de saisir du texte ou d'appuyer sur Entrée à l'écran, vérifie la fenêtre active (windows_list ou la réponse de l'outil précédent).`;

// Commandes qui écrivent sur les disques, le LVM ou les partitions.
const ACCORD = process.env.MCP_ACCORD_FILE || '/etc/mcp-pc-accord-disques';
const DESTRUCTIVE = [
  /(^|[\s;&|`(])(mkfs(\.\w+)?|mkswap|parted|fdisk|cfdisk|sfdisk|sgdisk|gdisk|blkdiscard|shred|cryptsetup|resize2fs|tune2fs|e2fsck|xfs_repair|fsck(\.\w+)?)(\s|$)/,
  /(^|[\s;&|`(])(pv|vg|lv)(create|remove|move|resize|extend|reduce|rename|change|convert|split|merge)(\s|$)/,
  /(^|[\s;&|`(])dd\s[^;&|]*\bof=\/dev\//,
  /(^|[\s;&|`(])truncate\s[^;&|]*\/dev\//,
  />\s*\/dev\/(sd|nvme|vd|hd|mmcblk|mapper|dm-|loop|zram)/,
];
const isDestructive = (cmd) => DESTRUCTIVE.some((r) => r.test(cmd)) || (/(^|[\s;&|`(])wipefs(\s|$)/.test(cmd) && !/\s(-n|--no-act)(\s|$)/.test(cmd));
const accordValide = async () => {
  try { const { mtimeMs } = await (await import('node:fs/promises')).stat(ACCORD); return Date.now() - mtimeMs < 15 * 60 * 1000; }
  catch { return false; }
};
const commandOf = (params) => (params?.name === 'start_process' ? params.arguments?.command : params?.name === 'interact_with_process' ? params.arguments?.input : '') ?? '';

const listIds = new Set();
const initIds = new Set();
createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'tools/list') listIds.add(msg.id);
  if (msg.method === 'initialize') initIds.add(msg.id);
  if (msg.method === 'tools/call' && NAMES.has(msg.params?.name)) {
    try { send({ jsonrpc: '2.0', id: msg.id, result: await callTool(msg.params.name, msg.params.arguments) }); }
    catch (err) { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `Erreur : ${err.message}` }] } }); }
    return;
  }
  if (msg.method === 'tools/call') {
    const cmd = commandOf(msg.params);
    if (cmd && isDestructive(cmd) && !(await accordValide())) {
      log('bloqué :', cmd.slice(0, 120));
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: "Bloqué : cette commande écrit sur les disques, les partitions ou le LVM. Présente d'abord le diagnostic à l'utilisateur et demande son accord explicite. Il le confirme en tapant lui-même : sudo touch /etc/mcp-pc-accord-disques (valable 15 minutes). Sinon, donne-lui la commande à lancer lui-même." }] } });
      return;
    }
  }
  dc.stdin.write(line + '\n');
});
createInterface({ input: dc.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && listIds.delete(msg.id) && msg.result?.tools) msg.result.tools.push(...TOOLS);
    if (msg.id !== undefined && initIds.delete(msg.id) && msg.result) msg.result.instructions = [msg.result.instructions, INSTRUCTIONS].filter(Boolean).join('\n\n');
    send(msg);
  } catch { process.stdout.write(line + '\n'); }
});
log('prêt :', TOOLS.length, 'outils bureau + Desktop Commander');
