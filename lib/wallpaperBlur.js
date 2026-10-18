// Wallpaper blur: the desktop background of a monitor blurs while windows are
// open on it (current workspace, not minimised) and turns sharp again when
// its desktop is empty. Strength comes from wallpaper-blur-strength.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT = 'fusion-wallpaper-blur';
const FADE_MS = 250;
// Windows that count as "open" (not the desktop icons window, docks or popups).
const COUNTED = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

export class WallpaperBlur {
    constructor(ext) {
        this._settings = ext.settings;
        this._radius = Math.round(this._settings.get_int('wallpaper-blur-strength') * 0.6);
        this._blurred = new Map(); // background actor -> blurred now
        const lm = Main.layoutManager;
        lm.connectObject('monitors-changed', () => this._queue(), this);
        // Background managers swap their actor when the wallpaper changes.
        Main.layoutManager._backgroundGroup.connectObject('child-added', () => this._queue(), this);
        global.window_manager.connectObject(
            'map', () => this._queue(), 'destroy', () => this._queue(),
            'minimize', () => this._queue(), 'unminimize', () => this._queue(),
            'switch-workspace', () => this._queue(), this);
        global.display.connectObject('restacked', () => this._queue(), 'window-entered-monitor', () => this._queue(), this);
        this._sync(false);
    }

    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._sync(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Monitors that show at least one open window of the current workspace. */
    _busyMonitors() {
        const busy = new Set();
        const ws = global.workspace_manager.get_active_workspace();
        for (const win of global.display.list_all_windows()) {
            if (win.minimized || win.is_hidden() || !COUNTED.includes(win.get_window_type()) || win.skip_taskbar)
                continue;
            if (!win.is_on_all_workspaces() && win.get_workspace() !== ws)
                continue;
            busy.add(win.get_monitor());
        }
        return busy;
    }

    _sync(animate) {
        const busy = this._busyMonitors();
        const seen = new Set();
        for (const mgr of Main.layoutManager._bgManagers ?? []) {
            const actor = mgr.backgroundActor;
            if (!actor)
                continue;
            seen.add(actor);
            if (!this._blurred.has(actor))
                actor.connectObject('destroy', () => this._blurred.delete(actor), this);
            this._set(actor, busy.has(mgr._monitorIndex), animate);
        }
        for (const actor of [...this._blurred.keys()]) {
            if (!seen.has(actor))
                this._clear(actor);
        }
    }

    _set(actor, blur, animate) {
        if (this._blurred.get(actor) === blur)
            return;
        this._blurred.set(actor, blur);
        let effect = actor.get_effect(EFFECT);
        if (!effect) {
            effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1.0});
            actor.add_effect_with_name(EFFECT, effect);
        }
        const radius = blur ? this._radius : 0;
        actor.remove_transition(`@effects.${EFFECT}.radius`);
        if (animate) {
            actor.ease_property(`@effects.${EFFECT}.radius`, radius, {
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            effect.radius = radius;
        }
    }

    _clear(actor) {
        actor.disconnectObject(this);
        actor.remove_transition(`@effects.${EFFECT}.radius`);
        actor.remove_effect_by_name(EFFECT);
        this._blurred.delete(actor);
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        for (const actor of [...this._blurred.keys()])
            this._clear(actor);
    }
}
