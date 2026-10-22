// Picture-in-picture windows of any app stay above other windows and,
// optionally, on every workspace. A window counts as picture-in-picture by
// its title (browsers set it after mapping, so title changes are watched).
// Windows of the apps listed in ontop-apps stay above too (not on every
// workspace).
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

// Firefox / LibreWolf "Picture-in-Picture", Chromium-based browsers
// "Picture in picture", Telegram's video window, titles ending in " - PiP",
// plus a few common variants.
const PIP_TITLE = /^(picture[\s-]*in[\s-]*picture|pip|mini ?player|telegramdesktop|画中画|画中画模式)$|\s-\sPiP$/i;
// Firefox names its PiP window's role this way in every language (X11 / XWayland).
const PIP_ROLE = 'PictureInPicture';

export class PipOnTop {
    constructor(ext) {
        this._settings = ext.settings;
        this._changed = new Map(); // window -> {above, sticky} we set
        // New windows are not in the stack yet: wait until they are shown.
        this._unshown = new Set();
        // Windows handled so far (the tracker can report a window before
        // window-created reaches this module).
        this._watched = new Set();
        global.display.connectObject('window-created', (_d, win) => this._watch(win, true), this);
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
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL && win.get_window_type() !== Meta.WindowType.UTILITY)
            return;
        if (this._watched.has(win))
            return;
        this._watched.add(win);
        win.connectObject('notify::title', () => this._apply(win),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._changed.delete(win);
                this._unshown.delete(win);
                this._watched.delete(win);
            }, this);
        if (fresh) {
            this._unshown.add(win);
            win.connectObject('shown', () => {
                if (this._unshown.delete(win))
                    this._apply(win);
            }, this);
            return;
        }
        this._apply(win);
    }

    _isOnTopApp(win) {
        const id = this._tracker.get_window_app(win)?.get_id();
        return !!id && this._settings.get_strv('ontop-apps').includes(id);
    }

    _apply(win) {
        if (!this._watched.has(win) || this._unshown.has(win))
            return;
        const pip = this._isPip(win);
        if (!pip && !this._isOnTopApp(win)) {
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

    _recheckAll() {
        for (const win of this._watched)
            this._apply(win);
    }

    destroy() {
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._tracker.disconnectObject(this);
        for (const win of [...this._changed.keys()])
            this._undo(win);
        for (const win of this._watched)
            win.disconnectObject(this);
        this._watched.clear();
        this._unshown.clear();
    }
}
