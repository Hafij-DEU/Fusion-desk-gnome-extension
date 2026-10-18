// Intellihide (hide the panel when windows overlap it, reveal on edge
// pressure or hover) and dynamic opacity (opaque panel when a window touches it).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

const CHECK_INTERVAL = 250; // ms
const ANIMATION_TIME = 200;
const PRESSURE_THRESHOLD = 80;
const PRESSURE_TIMEOUT = 1000;
const HIDE_DELAY = 600;
const TOUCH_DISTANCE = 4;

export class AutoHide {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._hide = this._settings.get_boolean('intellihide');
        this._dynamic = this._settings.get_boolean('dynamic-opacity');
        this._hidden = false;
        if (!this._hide && !this._dynamic)
            return;

        const lm = Main.layoutManager;
        this._panelBox = lm.panelBox;

        if (this._hide) {
            // Let windows use the full screen; the panel floats over them.
            lm._untrackActor(this._panelBox);
            lm._trackActor(this._panelBox, {affectsStruts: false, trackFullscreen: true});
                        this._setupBarrier();
            lm.connectObject('monitors-changed', () => this._setupBarrier(), this);
        }

        Main.overview.connectObject('showing', () => this._check(), 'hidden', () => this._check(), this);
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
        this._check();
    }

    _setupBarrier() {
        this._destroyBarrier();
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        const bottom = this._ext.panelAtBottom;
        const y = bottom ? m.y + m.height : m.y;
        this._pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: m.x, x2: m.x + m.width,
            y1: y, y2: y,
            directions: bottom ? Meta.BarrierDirection.NEGATIVE_Y : Meta.BarrierDirection.POSITIVE_Y,
        });
        this._pressure.addBarrier(this._barrier);
        this._pressure.connect('trigger', () => this.reveal());
    }

    _destroyBarrier() {
        if (this._pressure) {
            this._pressure.removeBarrier(this._barrier);
            this._pressure.destroy();
            this._pressure = null;
        }
        this._barrier?.destroy();
        this._barrier = null;
    }

    _panelRect() {
        const [x, y] = this._panelBox.get_transformed_position();
        const [w, h] = this._panelBox.get_size();
        // Use the resting position, not the animated one.
        const ty = this._panelBox.translation_y;
        return new Mtk.Rectangle({x, y: Math.round(y - ty), width: w, height: h});
    }

    _windowsTouching(distance) {
        const panel = this._panelRect();
        const grown = new Mtk.Rectangle({
            x: panel.x, y: panel.y - distance, width: panel.width, height: panel.height + distance * 2,
        });
        const ws = global.workspace_manager.get_active_workspace();
        const mode = this._settings.get_string('intellihide-mode');
        const focus = global.display.focus_window;
        const monitor = Main.layoutManager.primaryIndex;

        return ws.list_windows().some(w => {
            if (w.minimized || !w.showing_on_its_workspace() || w.get_monitor() !== monitor)
                return false;
            const type = w.get_window_type();
            if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG && type !== Meta.WindowType.MODAL_DIALOG)
                return false;
            if (mode === 'FOCUSED' && w !== focus)
                return false;
            if (mode === 'MAXIMIZED' && !(w.is_maximized?.() ?? w.get_maximized?.()) && !w.is_fullscreen())
                return false;
            return w.get_frame_rect().overlap(grown);
        });
    }

    _check() {
        if (this._dynamic) {
            const touching = Main.overview.visible ? false : this._windowsTouching(TOUCH_DISTANCE);
            this._setOpaque(touching);
        }
        if (!this._hide)
            return;

        const keepShown =
            Main.overview.visible ||
            (this._ext.panelActor?.hover ?? Main.panel.hover) ||
            Main.panel.menuManager.activeMenu ||
            (global.stage.key_focus && this._panelBox.contains(global.stage.key_focus)) ||
            this._revealedUntil > GLib.get_monotonic_time();

        if (keepShown || !this._windowsTouching(0))
            this._show();
        else
            this._queueHide();
    }

    reveal() {
        this._revealedUntil = GLib.get_monotonic_time() + 1500 * 1000;
        this._show();
    }

    _queueHide() {
        if (this._hidden || this._hideId)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideId = 0;
            if ((this._ext.panelActor?.hover ?? Main.panel.hover) || Main.panel.menuManager.activeMenu)
                return GLib.SOURCE_REMOVE;
            this._animate(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (this._hidden)
            this._animate(false);
    }

    _animate(hide) {
        this._hidden = hide;
        const h = this._panelBox.height;
        const offset = hide ? (this._ext.panelAtBottom ? h : -h) : 0;
        this._panelBox.ease({
            translation_y: offset,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => Main.layoutManager._queueUpdateRegions?.(),
        });
    }

    _setOpaque(opaque) {
        const alpha = opaque ? 1 : this._settings.get_int('panel-opacity') / 100;
        this._ext.setPanelBackground(alpha, 'transition-duration: 250ms;');
    }

    destroy() {
        if (!this._panelBox)
            return;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._hideId)
            GLib.source_remove(this._hideId);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._destroyBarrier();
        this._panelBox.remove_all_transitions();
        this._panelBox.translation_y = 0;
        if (this._dynamic)
            this._ext.setPanelBackground(this._settings.get_int('panel-opacity') / 100);
        if (this._hide) {
            const lm = Main.layoutManager;
            lm._untrackActor(this._panelBox);
            lm._trackActor(this._panelBox, {affectsStruts: true, trackFullscreen: true});
        }
    }
}
