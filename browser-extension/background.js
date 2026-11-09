import { TOKEN, BRIDGE } from './config.js';
import { snapshot, act, extract, scrollPage } from './page.js';

const headers = { 'x-mcp-token': TOKEN };

async function tabOf(id) {
  if (id) return chrome.tabs.get(id);
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('Aucun onglet actif.');
  return t;
}
async function inPage(tabId, func, arg) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [arg] });
  return r?.result;
}
async function waitLoaded(tabId, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const commands = {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => `${t.id}${t.active ? '*' : ''} ${t.title?.slice(0, 70)} — ${t.url?.slice(0, 100)}`).join('\n');
  },
  async read(a) {
    const t = await tabOf(a.tab);
    if (/^(chrome|brave|helium|edge|about):/.test(t.url || '')) throw new Error('Page interne du navigateur : non lisible par extension. Utiliser ui_read.');
    return inPage(t.id, snapshot, a);
  },
  async act(a) {
    const t = await tabOf(a.tab);
    const r = await inPage(t.id, act, a);
    if (!r.ok) throw new Error(r.error);
    await new Promise((res) => setTimeout(res, 300));
    const after = await chrome.tabs.get(t.id);
    return `Fait. Page : ${after.title} — ${after.url}`;
  },
  async extract(a) {
    const t = await tabOf(a.tab);
    const r = await inPage(t.id, extract, a);
    if (!r.ok) throw new Error(r.error);
    return r.text;
  },
  async scroll(a) {
    const t = await tabOf(a.tab);
    const r = await inPage(t.id, scrollPage, a);
    return `Position ${r.y}/${r.max}`;
  },
  async navigate(a) {
    let t;
    if (a.newTab) t = await chrome.tabs.create({ url: a.url });
    else { t = await tabOf(a.tab); await chrome.tabs.update(t.id, { url: a.url, active: true }); }
    await waitLoaded(t.id);
    const after = await chrome.tabs.get(t.id);
    return `Onglet ${after.id} : ${after.title} — ${after.url}`;
  },
  async activate(a) {
    const t = await chrome.tabs.update(a.tab, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return `Onglet ${t.id} actif.`;
  },
  async close(a) { await chrome.tabs.remove(a.tab); return 'Onglet fermé.'; },
  async back(a) { const t = await tabOf(a.tab); await chrome.tabs.goBack(t.id); await waitLoaded(t.id); return 'Retour.'; },
};

let running = false;
async function loop() {
  if (running) return; running = true;
  for (;;) {
    try {
      const res = await fetch(BRIDGE + '/poll', { headers });
      if (res.status === 204) continue;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { id, cmd, args } = await res.json();
      let out;
      try { out = { id, ok: true, result: await commands[cmd](args || {}) }; }
      catch (e) { out = { id, ok: false, error: String(e.message || e) }; }
      await fetch(BRIDGE + '/result', { method: 'POST', headers, body: JSON.stringify(out) });
    } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { loop(); });
chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
loop();
