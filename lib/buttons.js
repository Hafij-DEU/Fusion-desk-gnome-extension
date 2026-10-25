// Small single-purpose panel buttons.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ScreenshotButton {
    constructor() {
        this.actor = new St.Button({
            style_class: 'panel-button fusion-icon-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Screenshot',
            child: new St.Icon({icon_name: 'camera-photo-symbolic', style_class: 'system-status-icon'}),
        });
        this.actor.connect('clicked', () => Main.screenshotUI.open().catch(logError));
    }

    destroy() {
        this.actor.destroy();
    }
}

/** Thin strip at the panel edge that minimizes / restores all windows. */
export class ShowDesktop {
    constructor() {
        this._minimized = [];
        this.actor = new St.Button({
            style_class: 'fusion-show-desktop',
            can_focus: true,
            track_hover: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            accessible_name: 'Show Desktop',
        });
        this.actor.connect('clicked', () => this._toggle());
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._minimized = [];
        }, this);
    }

    _toggle() {
        const ws = global.workspace_manager.get_active_workspace();
        const restorable = this._minimized.filter(w => w.minimized && w.get_workspace() === ws);
        if (restorable.length) {
            restorable.forEach(w => w.unminimize());
            restorable.at(-1).activate(global.get_current_time());
            this._minimized = [];
            return;
        }
        // Minimize in stacking order so restore keeps it.
        this._minimized = global.display.sort_windows_by_stacking(ws.list_windows().filter(w =>
            !w.minimized && !w.skip_taskbar && w.get_window_type() === Meta.WindowType.NORMAL && w.can_minimize()));
        this._minimized.forEach(w => w.minimize());
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        this.actor.destroy();
    }
}
