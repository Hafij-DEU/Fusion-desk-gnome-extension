// Picture-in-picture windows of any app stay above other windows and,
// optionally, on every workspace. A window counts as picture-in-picture by
// its title (browsers set it after mapping, so title changes are watched).
// Windows of the apps listed in ontop-apps stay above too (not on every
// workspace). Several such windows of different apps all stay visible: they
// are kept above, re-raised over a focused full-screen window and set again
// when something else takes their "above" state away. The ontop-hotkey
// (Alt+Enter) keeps the focused window on top, or lets it go.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Accelerators} from './accelerators.js';

// Firefox / LibreWolf "Picture-in-Picture", Chromium-based browsers
// "Picture in picture", Telegram's video window ("TelegramDesktop": Qt's
// fallback for an untitled window), plus a few common variants. Players
// often put their name first ("Astra Player — Picture in picture",
// "Movie - PiP"), so a PiP name after a dash, bar or colon counts too.
// Browser windows end with the browser's name, so a page about PiP never matches.
const PIP_NAME = '(picture[\\s-]*in[\\s-]*picture|pip|mini[\\s-]?player|画中画|画中画模式)';
const PIP_TITLE = new RegExp(`^(${PIP_NAME}|telegramdesktop)$|\\s[-–—|:]\\s*${PIP_NAME}$`, 'i');
// Firefox names its PiP window's role this way in every language (X11 / XWayland).
const PIP_ROLE = 'PictureInPicture';
// Window types a picture-in-picture window can have (Chromium on Wayland uses a dialog-like type).
const TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.UTILITY, Meta.WindowType.DIALOG];
// A new window that never reports "shown" is handled after this delay anyway.
const SHOWN_FALLBACK_MS = 1500;

export class PipOnTop {
    constructor(ext) {
        this._settings = ext.settings;
        this._changed = new Map(); // window -> {above, sticky} we set
        // New windows are not in the stack yet: wait until they are shown.
        this._unshown = new Set();
        // Windows handled so far (the tracker can report a window before
        // window-created reaches this module).
        this._watched = new Set();
        // Windows the shortcut put on top, and ones it took off (not re-raised by a rule).
        this._pinned = new Set();
        this._released = new Set();
        this._keys = new Accelerators();
        this._keys.add(this._settings.get_string('ontop-hotkey'), () => this._toggleFocused());
        global.display.connectObject('window-created', (_d, win) => this._watch(win, true),
            'restacked', () => this._queueKeepOnTop(), this);
        const recheck = () => this._recheckAll();
        this._settings.connectObject('changed::pip-on-top', recheck, 'changed::pip-extra-titles', recheck,
            'changed::pip-all-workspaces', recheck, 'changed::ontop-apps', recheck, this);
        // A new window's app is known only once the tracker has matched it.
        this._tracker = Shell.WindowTracker.get_default();
        this._tracker.connectObject('tracked-windows-changed', recheck, this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    _isPip(win) {
        if (!this._settings.get_boolean('pip-on-top'))
            return false;
        if (win.get_role?.() === PIP_ROLE)
            return true;
        const title = (win.get_title() ?? '').trim();
        if (!title)
            return false;
        if (PIP_TITLE.test(title))
            return true;
        const extra = this._settings.get_strv('pip-extra-titles')
            .map(t => t.trim().toLowerCase()).filter(Boolean);
        return extra.includes(title.toLowerCase());
    }

    _watch(win, fresh = false) {
        if (!win || !TYPES.includes(win.get_window_type()))
            return;
        if (this._watched.has(win))
            return;
        this._watched.add(win);
        win.connectObject('notify::title', () => this._apply(win),
            'notify::above', () => {
                if (win.is_above() || !this._changed.has(win))
                    return;
                // A window the shortcut pinned was let go from elsewhere (its window menu): keep it off.
                if (this._pinned.delete(win)) {
                    this._changed.delete(win);
                    this._released.add(win);
                    return;
                }
                // Something else (the app) took "above" away from a rule's window: set it again.
                this._apply(win);
            },
            'unmanaged', () => {
                win.disconnectObject(this);
                this._changed.delete(win);
                this._unshown.delete(win);
                this._watched.delete(win);
                this._pinned.delete(win);
                this._released.delete(win);
            }, this);
        if (fresh) {
            this._unshown.add(win);
            win.connectObject('shown', () => {
                if (this._unshown.delete(win))
                    this._apply(win);
            }, this);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOWN_FALLBACK_MS, () => {
                if (this._unshown.delete(win))
                    this._apply(win);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._apply(win);
    }

    _isOnTopApp(win) {
        const id = this._tracker.get_window_app(win)?.get_id();
        return !!id && this._settings.get_strv('ontop-apps').includes(id);
    }

    _apply(win) {
        if (!this._watched.has(win) || this._unshown.has(win) || this._released.has(win))
            return;
        const pip = this._isPip(win);
        if (!pip && !this._isOnTopApp(win) && !this._pinned.has(win)) {
            this._undo(win);
            return;
        }
        const entry = this._changed.get(win) ?? {above: false, sticky: false};
        if (!win.is_above()) {
            win.make_above();
            entry.above = true;
        }
        const sticky = pip && this._settings.get_boolean('pip-all-workspaces');
        if (sticky && !win.is_on_all_workspaces()) {
            win.stick();
            entry.sticky = true;
        } else if (!sticky && entry.sticky) {
            win.unstick();
            entry.sticky = false;
        }
        this._changed.set(win, entry);
    }

    /** Only take back what this module set. */
    _undo(win) {
        const entry = this._changed.get(win);
        if (!entry)
            return;
        if (entry.above && win.is_above())
            win.unmake_above();
        if (entry.sticky && win.is_on_all_workspaces())
            win.unstick();
        this._changed.delete(win);
    }

    /** The shortcut: keep the focused window on top, or let it go. */
    _toggleFocused() {
        const win = global.display.focus_window;
        if (!win || win.get_window_type() === Meta.WindowType.DESKTOP)
            return;
        this._watch(win);
        const on = !win.is_above();
        if (on) {
            this._released.delete(win);
            this._pinned.add(win);
            this._apply(win);
            if (!win.is_above())
                win.make_above();
        } else {
            this._pinned.delete(win);
            this._released.add(win);
            this._changed.delete(win);
            win.unmake_above();
        }
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: on ? 'view-pin-symbolic' : 'window-restore-symbolic'}),
            on ? 'Always on top' : 'Not on top', null, null);
    }

    _recheckAll() {
        for (const win of this._watched)
            this._apply(win);
    }

    _queueKeepOnTop() {
        if (this._raiseId || !this._changed.size)
            return;
        this._raiseId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._raiseId = 0;
            this._keepOnTop();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * A focused full-screen window shares the top layer with "above"
     * windows and can cover them: raise the kept windows over it (only when
     * they are below one, so this does not loop on its own restacking).
     */
    _keepOnTop() {
        const kept = [...this._changed.keys()].filter(w => !w.minimized && w.showing_on_its_workspace?.() !== false);
        if (!kept.length)
            return;
        const stack = global.display.sort_windows_by_stacking(global.display.list_all_windows());
        for (const win of kept) {
            const at = stack.indexOf(win);
            const covered = stack.slice(at + 1).some(o => !this._changed.has(o) && o.is_fullscreen() &&
                o.get_monitor() === win.get_monitor() && (o.is_on_all_workspaces() || o.get_workspace() === win.get_workspace() ||
                win.is_on_all_workspaces()));
            if (at >= 0 && covered)
                win.raise();
        }
    }

    destroy() {
        if (this._raiseId)
            GLib.source_remove(this._raiseId);
        this._raiseId = 0;
        this._keys.destroy();
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._tracker.disconnectObject(this);
        for (const win of [...this._changed.keys()])
            this._undo(win);
        for (const win of this._watched)
            win.disconnectObject(this);
        this._watched.clear();
        this._unshown.clear();
        this._pinned.clear();
        this._released.clear();
    }
}
