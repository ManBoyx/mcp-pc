// Fonctions injectées dans la page. Chaque fonction doit être autonome (sérialisée par executeScript).

export function snapshot(opts) {
  const { filter = '', maxChars = 12000, withText = true, scope = '' } = opts || {};
  const S = (window.__mcp = window.__mcp || { refs: new Map(), n: 0 });
  S.refs.clear(); S.n = 0;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=option],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const labelOf = (el) => {
    let t = el.getAttribute('aria-label') || '';
    if (!t && el.getAttribute('aria-labelledby')) t = el.getAttribute('aria-labelledby').split(' ').map((i) => document.getElementById(i)?.textContent).join(' ');
    if (!t && el.labels?.length) t = [...el.labels].map((l) => l.textContent).join(' ');
    if (!t) t = el.placeholder || el.alt || el.title || '';
    if (!t) t = el.innerText || el.textContent || '';
    if (!t) { const img = el.querySelector?.('img[alt],svg title'); t = img?.alt || img?.textContent || ''; }
    return norm(t).slice(0, 80);
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', search: 'searchbox' })[el.type] || 'input:' + el.type;
    if (t === 'textarea') return 'textarea';
    if (t === 'select') return 'select';
    return t === 'summary' ? 'summary' : t === 'button' ? 'button' : 'clickable';
  };
  const lines = [];
  let chars = 0;
  const push = (l) => { if (chars < maxChars) { lines.push(l); chars += l.length + 1; } };
  const f = filter.toLowerCase();
  const root = scope ? document.querySelector(scope) || document.body : document.body;
  const walk = (node) => {
    for (const el of node.children) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'PATH'].includes(el.tagName)) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!visible(el) && !el.shadowRoot) continue;
      const tag = el.tagName.toLowerCase();
      if (el.matches(INTERACTIVE) && !(tag === 'input' && el.type === 'hidden')) {
        const ref = ++S.n; S.refs.set(ref, new WeakRef(el));
        const label = labelOf(el);
        let extra = '';
        if (el.value !== undefined && ['input', 'textarea', 'select'].includes(tag) && el.type !== 'password') extra += ` value="${norm(el.value).slice(0, 60)}"`;
        if (el.type === 'password') extra += ' (mot de passe)';
        if (el.checked) extra += ' coché';
        if (el.disabled) extra += ' désactivé';
        if (el.getAttribute('aria-expanded')) extra += ` étendu=${el.getAttribute('aria-expanded')}`;
        if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) extra += ' actif';
        if (tag === 'a' && el.href) { try { const u = new URL(el.href); extra += ` → ${u.origin === location.origin ? u.pathname + u.search : u.href}`.slice(0, 120); } catch {} }
        const line = `[${ref}] ${roleOf(el)} "${label}"${extra}`;
        if (!f || line.toLowerCase().includes(f)) push(line);
        if (tag === 'a' || tag === 'button' || tag === 'select') continue; // pas de descente : le libellé est déjà pris
      } else if (withText && !f && /^(H[1-6]|P|LI|TD|TH|LABEL|FIGCAPTION|BLOCKQUOTE|PRE|DT|DD|SPAN|DIV)$/.test(el.tagName) && !el.children.length) {
        const t = norm(el.textContent);
        if (t.length > 1) push((/^H[1-6]$/.test(el.tagName) ? '#'.repeat(+el.tagName[1]) + ' ' : '· ') + t.slice(0, 200));
      }
      walk(el);
    }
  };
  walk(root);
  const head = `${document.title} — ${location.href}\n`;
  return head + lines.join('\n') + (chars >= maxChars ? '\n… tronqué (utiliser filter ou scope).' : '');
}

export function act(a) {
  const S = window.__mcp;
  const el = S?.refs.get(a.ref)?.deref();
  if (!el || !el.isConnected) return { ok: false, error: `Élément ${a.ref} périmé : relancer browser_read.` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (a.kind === 'click') {
    const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, o));
    el.click();
    return { ok: true };
  }
  if (a.kind === 'type') {
    el.focus();
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((x) => x.text.trim() === a.text || x.value === a.text) || [...el.options].find((x) => x.text.toLowerCase().includes(a.text.toLowerCase()));
      if (!opt) return { ok: false, error: 'Option introuvable : ' + [...el.options].map((x) => x.text.trim()).slice(0, 20).join(' | ') };
      el.value = opt.value;
    } else if (el.isContentEditable) {
      document.execCommand('selectAll'); document.execCommand('insertText', false, a.text);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, a.append ? el.value + a.text : a.text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.text }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (a.submit) {
      for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.form?.requestSubmit?.();
    }
    return { ok: true };
  }
  return { ok: false, error: 'action inconnue' };
}

export function extract(a) {
  const el = a.selector ? document.querySelector(a.selector) : document.body;
  if (!el) return { ok: false, error: 'Sélecteur introuvable.' };
  return { ok: true, text: (el.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, a.maxChars || 15000) };
}

export function scrollPage(a) {
  window.scrollBy(0, a.dy ?? 600);
  return { ok: true, y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight };
}
