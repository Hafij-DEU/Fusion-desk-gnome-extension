// Blurred, see-through app windows: windows of the chosen apps turn
// slightly transparent and get a blurred copy of whatever is behind them
// (the wallpaper, other windows), like frosted glass. Written for Fusion
// Desk. A blur surface sits right below each window, follows it and hides
// with it; full-screen windows stay solid.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {addSurfaceBlur} from './style.js';


export class WindowBlur {
    constructor(ext) {
        const s = ext.settings;
        this._tracker = Shell.WindowTracker.get_default();
        this._windows = new Map(); // MetaWindow -> {actor, bin}
        this._apps = new Set(s.get_strv('window-blur-apps'));
        this._opacity = Math.round(s.get_int('window-blur-opacity') * 2.55);
        this._radius = Math.max(10, Math.round(s.get_int('window-blur-strength') * 0.8));

        global.display.connectObject('window-created', (_d, win) => this._queue(win),
            'restacked', () => this._restack(), this);
        this._tracker.connectObject('tracked-windows-changed', () => this._scan(), this);
        this._scan();
    }

    _scan() {
        for (const actor of global.get_window_actors())
            this._queue(actor.meta_window);
    }

    /** The app is known only once the tracker has matched the window. */
    _queue(win) {
        if (!win || this._windows.has(win) || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const id = this._tracker.get_window_app(win)?.get_id();
        if (id && this._apps.has(id))
            this._add(win);
    }

    _add(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const bin = new St.Widget({reactive: false});
        addSurfaceBlur(bin, this._radius, 0.9);
        global.window_group.insert_child_below(bin, actor);
        const entry = {actor, bin};
        this._windows.set(win, entry);

        const sync = () => this._sync(win, entry);
        win.connectObject('position-changed', sync, 'size-changed', sync,
            'notify::fullscreen', sync, 'workspace-changed', sync, 'unmanaged', () => this._remove(win), this);
        actor.connectObject('notify::visible', sync, 'notify::opacity', () => this._applyOpacity(win, entry),
            'destroy', () => this._remove(win), this);
        sync();
        // Open animations end on full opacity: set ours again afterwards.
        entry.later = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            entry.later = 0;
            this._applyOpacity(win, entry);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyOpacity(win, entry) {
        // Only when nothing (an open / close animation) is fading the window.
        if (entry.actor.get_transition('opacity'))
            return;
        const want = win.is_fullscreen() ? 255 : this._opacity;
        if (entry.actor.opacity === 255 || entry.actor.opacity === this._opacity)
            entry.actor.opacity = want;
    }

    _sync(win, entry) {
        const rect = win.get_frame_rect();
        entry.bin.set_position(rect.x, rect.y);
        entry.bin.set_size(rect.width, rect.height);
        entry.bin.visible = entry.actor.visible && !win.minimized && !win.is_fullscreen();
        this._applyOpacity(win, entry);
    }

    /** Keep every blur surface right below its window. */
    _restack() {
        for (const {actor, bin} of this._windows.values()) {
            if (actor.get_parent() === bin.get_parent())
                global.window_group.set_child_below_sibling(bin, actor);
        }
    }

    _remove(win) {
        const entry = this._windows.get(win);
        if (!entry)
            return;
        this._windows.delete(win);
        if (entry.later)
            GLib.source_remove(entry.later);
        win.disconnectObject(this);
        entry.actor.disconnectObject(this);
        if (entry.actor.opacity === this._opacity)
            entry.actor.opacity = 255;
        entry.bin.destroy();
    }

    destroy() {
        global.display.disconnectObject(this);
        this._tracker.disconnectObject(this);
        for (const win of [...this._windows.keys()])
            this._remove(win);
    }
}
