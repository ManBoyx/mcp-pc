#!/usr/bin/env python3
"""Processus d'entrée/fenêtres pour le MCP du PC.

Lit une commande JSON par ligne sur stdin, répond une ligne JSON par commande.
Souris, clavier et molette passent par /dev/uinput (appareils virtuels).
La liste des fenêtres et leur focus passent par un script KWin qui rappelle
ce processus sur le bus D-Bus de session.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

import warnings
import gi
import dbus
import dbus.mainloop.glib
import dbus.service
import evdev
from evdev import AbsInfo, UInput, ecodes as e
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib

warnings.filterwarnings('ignore')
try:
    Atspi.set_timeout(1500, 15000)
except Exception:
    pass

W, H = int(os.environ.get("SCREEN_WIDTH", 1920)), int(os.environ.get("SCREEN_HEIGHT", 1080))
BUTTONS = {"left": e.BTN_LEFT, "right": e.BTN_RIGHT, "middle": e.BTN_MIDDLE}

NAMED = {
    "ctrl": e.KEY_LEFTCTRL, "control": e.KEY_LEFTCTRL, "shift": e.KEY_LEFTSHIFT,
    "alt": e.KEY_LEFTALT, "altgr": e.KEY_RIGHTALT, "super": e.KEY_LEFTMETA,
    "meta": e.KEY_LEFTMETA, "win": e.KEY_LEFTMETA,
    "enter": e.KEY_ENTER, "return": e.KEY_ENTER, "tab": e.KEY_TAB, "esc": e.KEY_ESC,
    "escape": e.KEY_ESC, "space": e.KEY_SPACE, "backspace": e.KEY_BACKSPACE,
    "delete": e.KEY_DELETE, "del": e.KEY_DELETE, "insert": e.KEY_INSERT,
    "up": e.KEY_UP, "down": e.KEY_DOWN, "left": e.KEY_LEFT, "right": e.KEY_RIGHT,
    "home": e.KEY_HOME, "end": e.KEY_END, "pageup": e.KEY_PAGEUP, "pagedown": e.KEY_PAGEDOWN,
    "menu": e.KEY_COMPOSE, "printscreen": e.KEY_SYSRQ, "capslock": e.KEY_CAPSLOCK,
    "minus": e.KEY_MINUS, "equal": e.KEY_EQUAL, "comma": e.KEY_COMMA, "dot": e.KEY_DOT,
    "slash": e.KEY_SLASH, "semicolon": e.KEY_SEMICOLON, "volumeup": e.KEY_VOLUMEUP,
    "volumedown": e.KEY_VOLUMEDOWN, "mute": e.KEY_MUTE, "playpause": e.KEY_PLAYPAUSE,
}


def keycode(name):
    n = name.strip().lower()
    if n in NAMED:
        return NAMED[n]
    if len(n) == 1 and n.isalnum():
        return getattr(e, "KEY_" + n.upper())
    if n.startswith("f") and n[1:].isdigit():
        return getattr(e, "KEY_" + n.upper())
    raise ValueError("touche inconnue: " + name)


all_keys = sorted(set(NAMED.values()) | {getattr(e, "KEY_" + c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}
                  | {getattr(e, "KEY_F%d" % i) for i in range(1, 13)})
kbd = UInput({e.EV_KEY: all_keys}, name="mcp-pc-clavier")
ptr = UInput({e.EV_KEY: list(BUTTONS.values()),
              e.EV_ABS: [(e.ABS_X, AbsInfo(0, 0, W - 1, 0, 0, 0)), (e.ABS_Y, AbsInfo(0, 0, H - 1, 0, 0, 0))]},
             name="mcp-pc-pointeur")
wheel = UInput({e.EV_KEY: [e.BTN_MIDDLE], e.EV_REL: [e.REL_WHEEL, e.REL_HWHEEL, e.REL_X, e.REL_Y]},
               name="mcp-pc-molette")
time.sleep(1.0)  # laisse KWin reconnaître les appareils


def move(x, y):
    x = max(0, min(W - 1, int(x)))
    y = max(0, min(H - 1, int(y)))
    for _ in range(2):  # le premier événement après le démarrage peut être décalé
        ptr.write(e.EV_ABS, e.ABS_X, x)
        ptr.write(e.EV_ABS, e.ABS_Y, y)
        ptr.syn()
        time.sleep(0.04)


def click(x, y, button="left", count=1):
    move(x, y)
    b = BUTTONS[button]
    for _ in range(count):
        ptr.write(e.EV_KEY, b, 1); ptr.syn(); time.sleep(0.04)
        ptr.write(e.EV_KEY, b, 0); ptr.syn(); time.sleep(0.06)


def drag(x1, y1, x2, y2):
    move(x1, y1)
    ptr.write(e.EV_KEY, e.BTN_LEFT, 1); ptr.syn(); time.sleep(0.1)
    steps = 12
    for i in range(1, steps + 1):
        move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
    time.sleep(0.1)
    ptr.write(e.EV_KEY, e.BTN_LEFT, 0); ptr.syn()


def scroll(x, y, dy=0, dx=0):
    move(x, y)
    for _ in range(abs(int(dy))):
        wheel.write(e.EV_REL, e.REL_WHEEL, -1 if dy > 0 else 1); wheel.syn(); time.sleep(0.03)
    for _ in range(abs(int(dx))):
        wheel.write(e.EV_REL, e.REL_HWHEEL, 1 if dx > 0 else -1); wheel.syn(); time.sleep(0.03)


def press(combo):
    keys = [keycode(k) for k in combo.replace(" ", "").split("+") if k]
    for k in keys:
        kbd.write(e.EV_KEY, k, 1); kbd.syn(); time.sleep(0.02)
    time.sleep(0.04)
    for k in reversed(keys):
        kbd.write(e.EV_KEY, k, 0); kbd.syn(); time.sleep(0.02)


def klipper(*args):
    return subprocess.run(["qdbus-qt6", "org.kde.klipper", "/klipper", *args],
                          capture_output=True, text=True, timeout=5).stdout.rstrip("\n")


def type_text(text):
    """Colle le texte via le presse-papiers : indépendant de la disposition du clavier."""
    old = klipper("org.kde.klipper.klipper.getClipboardContents")
    klipper("org.kde.klipper.klipper.setClipboardContents", text)
    time.sleep(0.15)
    press("ctrl+v")
    time.sleep(0.3)
    klipper("org.kde.klipper.klipper.setClipboardContents", old)


# ---------------------------------------------------------------- fenêtres (KWin)
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
SVC = "org.mcp.pc.p%d" % os.getpid()  # un nom par processus : une session MCP = un processus
_name = dbus.service.BusName(SVC, bus)
_result = {"event": threading.Event(), "data": None}


class Receiver(dbus.service.Object):
    @dbus.service.method("org.mcp.pc", in_signature="s", out_signature="")
    def report(self, payload):
        _result["data"] = payload
        _result["event"].set()


Receiver(bus, "/")
threading.Thread(target=GLib.MainLoop().run, daemon=True).start()

KW_LIST = """
var out = workspace.windowList().filter(function(w){return w.normalWindow}).map(function(w){
  return {id: String(w.internalId), title: w.caption, app: w.resourceClass, pid: w.pid,
          x: Math.round(w.frameGeometry.x), y: Math.round(w.frameGeometry.y),
          w: Math.round(w.frameGeometry.width), h: Math.round(w.frameGeometry.height),
          active: w === workspace.activeWindow, minimized: w.minimized};
});
callDBus("__SVC__", "/", "org.mcp.pc", "report", JSON.stringify({windows: out}));
"""
KW_ACT = """
var target = %s, action = %s, hit = false;
workspace.windowList().forEach(function(w){
  if (String(w.internalId) !== target) return;
  hit = true;
  if (action === "focus") { w.minimized = false; workspace.activeWindow = w; }
  else if (action === "close") { w.closeWindow(); }
  else if (action === "minimize") { w.minimized = true; }
  else if (action === "maximize") { w.setMaximize(true, true); }
});
callDBus("__SVC__", "/", "org.mcp.pc", "report", JSON.stringify({ok: hit}));
"""


def run_kwin(source):
    _result["event"].clear()
    _result["data"] = None
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(source.replace("__SVC__", SVC))
        path = f.name
    name = "mcp-pc-%d" % int(time.time() * 1000)
    sid = subprocess.run(["qdbus-qt6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", path, name],
                         capture_output=True, text=True, timeout=5).stdout.strip()
    subprocess.run(["qdbus-qt6", "org.kde.KWin", "/Scripting/Script" + sid, "org.kde.kwin.Script.run"],
                   capture_output=True, text=True, timeout=5)
    ok = _result["event"].wait(5)
    subprocess.run(["qdbus-qt6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name],
                   capture_output=True, text=True, timeout=5)
    os.unlink(path)
    if not ok:
        raise RuntimeError("KWin n'a pas répondu")
    return json.loads(_result["data"])


KW_CUR = """callDBus("__SVC__", "/", "org.mcp.pc", "report", JSON.stringify({x: workspace.cursorPos.x, y: workspace.cursorPos.y}));"""


# ---------------------------------------------------------------- interface en texte (AT-SPI)
PRIORITY = ["press", "click", "activate", "toggle", "open", "select", "jump", "check", "expand or contract", "setfocus"]
SKIP_ROLES = {"filler", "redundant object", "unknown", "section", "scroll pane", "viewport", "separator"}


def atspi_apps():
    d = Atspi.get_desktop(0)
    return [d.get_child_at_index(i) for i in range(d.get_child_count())]


def active_window_info():
    wins = run_kwin(KW_LIST)["windows"]
    act = next((w for w in wins if w["active"]), None)
    return act, wins


def find_app(want):
    """Application AT-SPI : par nom si fourni, sinon celle de la fenêtre active (via son pid)."""
    apps = atspi_apps()
    if want:
        w = want.lower()
        for a in apps:
            if w in (a.get_name() or "").lower():
                return a, None
        _, wins = active_window_info()
        for win in wins:
            if w in (win["app"] or "").lower() or w in (win["title"] or "").lower():
                for a in apps:
                    try:
                        if a.get_process_id() == win["pid"]:
                            return a, win
                    except Exception:
                        pass
        raise RuntimeError("application '%s' non exposée en accessibilité (relancer via app_launch, ou utiliser screen_screenshot)" % want)
    act, _ = active_window_info()
    if not act:
        raise RuntimeError("aucune fenêtre active")
    for a in apps:
        try:
            if a.get_process_id() == act["pid"]:
                return a, act
        except Exception:
            pass
    raise RuntimeError("la fenêtre active (%s) n'expose pas son interface (relancer l'application via app_launch, ou utiliser screen_screenshot)" % act["app"])


def node_at(root, path):
    n = root
    for i in path:
        n = n.get_child_at_index(i)
        if n is None:
            raise RuntimeError("élément introuvable (l'interface a changé, relire avec ui_read)")
    return n


def info(n):
    role = n.get_role_name()
    name = n.get_name() or ""
    st = n.get_state_set()
    actions = []
    try:
        ai = n.get_action_iface()
        if ai:
            actions = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
    except Exception:
        pass
    value = None
    try:
        if "Text" in n.get_interfaces():
            value = Atspi.Text.get_text(n, 0, min(Atspi.Text.get_character_count(n), 300))
    except Exception:
        pass
    ext = None
    try:
        c = n.get_component_iface()
        if c:
            r = c.get_extents(Atspi.CoordType.WINDOW)
            ext = (r.x, r.y, r.width, r.height)
    except Exception:
        pass
    flags = [f for f, t in (("focus", Atspi.StateType.FOCUSED), ("coché", Atspi.StateType.CHECKED),
                            ("sélectionné", Atspi.StateType.SELECTED), ("désactivé", None)) if t and st.contains(t)]
    if not st.contains(Atspi.StateType.ENABLED) and st.contains(Atspi.StateType.SENSITIVE) is False:
        flags.append("désactivé")
    return role, name, actions, value, ext, flags, st.contains(Atspi.StateType.SHOWING)


def collect(root, filt, limit):
    out, seen = [], [0]

    def walk(n, path, depth):
        if len(out) >= limit or seen[0] > 6000 or depth > 25:
            return
        seen[0] += 1
        try:
            role, name, actions, value, ext, flags, showing = info(n)
        except Exception:
            return
        if depth > 0 and not showing:
            return
        interesting = (name or actions or value) and role not in SKIP_ROLES
        if interesting and (not filt or filt in (name or "").lower() or filt in (value or "").lower() or filt in role):
            line = "[%s] %s" % (".".join(map(str, path)), role)
            if name:
                line += ' "%s"' % name[:80]
            if value:
                line += " = %r" % value[:120]
            if actions:
                line += " (%s)" % ",".join(actions[:3])
            if flags:
                line += " {%s}" % ",".join(flags)
            out.append(line)
        for i in range(n.get_child_count()):
            c = n.get_child_at_index(i)
            if c is not None:
                walk(c, path + [i], depth + 1)

    walk(root, [], 0)
    return out


def ui_read(a):
    app, win = find_app(a.get("app"))
    lines = collect(app, (a.get("filter") or "").lower() or None, int(a.get("max", 250)))
    head = "Application : %s" % (app.get_name() or "?")
    return {"text": head + "\n" + ("\n".join(lines) if lines else "(aucun élément lisible)")}


def locate(app, a):
    if a.get("id"):
        return node_at(app, [int(x) for x in a["id"].split(".") if x != ""])
    name = (a.get("name") or "").lower()
    role = (a.get("role") or "").lower()
    if not name:
        raise RuntimeError("fournir name ou id")
    exact, partial = [], []

    def walk(n, depth):
        if depth > 25 or len(exact) > 20:
            return
        try:
            r, nm, acts, val, ext, flags, showing = info(n)
            if depth > 0 and not showing:
                return
            if (not role or role in r) and nm:
                (exact if nm.lower() == name else partial if name in nm.lower() else []).append(n)
        except Exception:
            return
        for i in range(n.get_child_count()):
            c = n.get_child_at_index(i)
            if c is not None:
                walk(c, depth + 1)

    walk(app, 0)
    found = exact or partial
    if not found:
        raise RuntimeError("aucun élément nommé '%s' (voir ui_read)" % a["name"])
    if len(found) > 1 and not exact:
        names = sorted({info(n)[1] for n in found})[:8]
        raise RuntimeError("plusieurs éléments correspondent : %s. Préciser name, role ou id" % ", ".join(names))
    return found[0]


def ui_click(a):
    app, win = find_app(a.get("app"))
    n = locate(app, a)
    role, name, actions, value, ext, flags, showing = info(n)
    want = (a.get("action") or "").lower()
    ai = n.get_action_iface()
    if ai and actions:
        idx = None
        names = [x.lower() for x in actions]
        if want and want in names:
            idx = names.index(want)
        elif not want:
            for pr in PRIORITY:
                if pr in names:
                    idx = names.index(pr)
                    break
            if idx is None:
                idx = 0
        if idx is not None:
            ai.do_action(idx)
            return {"text": 'Action "%s" sur %s "%s".' % (actions[idx], role, name)}
    # Pas d'action : clic à la position estimée (approximatif sous Wayland).
    if ext and win:
        fr = app.get_child_at_index(0).get_component_iface().get_extents(Atspi.CoordType.WINDOW)
        fw, fh = fr.width, fr.height
        x = win["x"] + (win["w"] - fw) // 2 + ext[0] + ext[2] // 2
        y = win["y"] + (win["h"] - fh) + ext[1] + ext[3] // 2
        click(x, y)
        return {"text": 'Pas d\'action disponible : clic estimé en (%d, %d) sur %s "%s". À vérifier.' % (x, y, role, name)}
    raise RuntimeError("cet élément n'a pas d'action et pas de position")


def ui_set_text(a):
    app, win = find_app(a.get("app"))
    n = locate(app, a)
    role, name, actions, value, ext, flags, showing = info(n)
    text = a["text"]
    if "EditableText" in n.get_interfaces():
        Atspi.EditableText.set_text_contents(n, text)
        return {"text": 'Texte écrit dans %s "%s".' % (role, name)}
    c = n.get_component_iface()
    if c:
        c.grab_focus()
        time.sleep(0.2)
        type_text(text)
        return {"text": 'Texte collé dans %s "%s" (focus puis presse-papiers).' % (role, name)}
    raise RuntimeError("cet élément n'accepte pas de texte")


HANDLERS = {
    "move": lambda a: move(a["x"], a["y"]),
    "click": lambda a: click(a["x"], a["y"], a.get("button", "left"), 2 if a.get("double") else 1),
    "drag": lambda a: drag(a["x1"], a["y1"], a["x2"], a["y2"]),
    "scroll": lambda a: scroll(a.get("x", W // 2), a.get("y", H // 2), a.get("dy", 0), a.get("dx", 0)),
    "key": lambda a: press(a["keys"]),
    "type": lambda a: type_text(a["text"]),
    "cursor": lambda a: run_kwin(KW_CUR),
    "windows": lambda a: run_kwin(KW_LIST),
    "ui_read": ui_read,
    "ui_click": ui_click,
    "ui_set_text": ui_set_text,
    "window": lambda a: run_kwin(KW_ACT % (json.dumps(a["id"]), json.dumps(a["action"]))),
}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        res = HANDLERS[req["cmd"]](req.get("args", {}))
        reply = {"id": req.get("id"), "ok": True, "result": res}
    except Exception as exc:  # une commande ratée ne doit pas tuer le processus
        reply = {"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": str(exc)}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
