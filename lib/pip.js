// Picture-in-picture windows of any app stay above other windows and,
// optionally, on every workspace. A window counts as picture-in-picture by
// its title (browsers set it after mapping, so title changes are watched).
import Meta from 'gi://Meta';

// Firefox / LibreWolf "Picture-in-Picture", Chromium-based browsers
// "Picture in picture", plus a few common variants.
const PIP_TITLE = /^(picture[\s-]*in[\s-]*picture|pip|mini ?player|画中画|画中画模式)$/i;

export class PipOnTop {
    constructor(ext) {
        this._settings = ext.settings;
        this._changed = new Map(); // window -> {above, sticky} we set
        global.display.connectObject('window-created', (_d, win) => this._watch(win), this);
        this._settings.connectObject('changed::pip-extra-titles', () => this._recheckAll(),
            'changed::pip-all-workspaces', () => this._recheckAll(), this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    _isPip(win) {
        const title = (win.get_title() ?? '').trim();
        if (!title)
            return false;
        if (PIP_TITLE.test(title))
            return true;
        const extra = this._settings.get_strv('pip-extra-titles')
            .map(t => t.trim().toLowerCase()).filter(Boolean);
        return extra.includes(title.toLowerCase());
    }

    _watch(win) {
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL && win.get_window_type() !== Meta.WindowType.UTILITY)
            return;
        win.connectObject('notify::title', () => this._apply(win),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._changed.delete(win);
            }, this);
        this._apply(win);
    }

    _apply(win) {
        if (!this._isPip(win)) {
            this._undo(win);
            return;
        }
        const entry = this._changed.get(win) ?? {above: false, sticky: false};
        if (!win.is_above()) {
            win.make_above();
            entry.above = true;
        }
        const sticky = this._settings.get_boolean('pip-all-workspaces');
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
        for (const actor of global.get_window_actors())
            this._apply(actor.meta_window);
    }

    destroy() {
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const win of [...this._changed.keys()])
            this._undo(win);
        for (const actor of global.get_window_actors())
            actor.meta_window?.disconnectObject(this);
    }
}
