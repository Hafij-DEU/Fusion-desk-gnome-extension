// Small shell tweaks: bring apps that ask for attention to the front
// (instead of the "… is ready" notification), hide the workspace switcher
// popup, and speed up or slow down every animation. Written for Fusion Desk.
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceSwitcherPopup} from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

const SPEEDS = {FAST: 0.6, NORMAL: 1.0, SLOW: 1.5};

export class Tweaks {
    constructor(ext) {
        const s = ext.settings;

        if (s.get_boolean('tweak-focus-attention')) {
            // GNOME's handler shows a notification; ours just switches to the window.
            this._attention = Main.windowAttentionHandler;
            global.display.disconnectObject(this._attention);
            const focus = (_d, win) => {
                if (win && !win.has_focus() && !win.skip_taskbar)
                    Main.activateWindow(win);
            };
            global.display.connectObject('window-demands-attention', focus, 'window-marked-urgent', focus, this);
        }

        if (!s.get_boolean('tweak-workspace-popup')) {
            this._display = WorkspaceSwitcherPopup.prototype.display;
            WorkspaceSwitcherPopup.prototype.display = function () {
                // Closing it at once also releases GNOME's workspace tracker.
                this.destroy();
            };
        }

        const factor = SPEEDS[s.get_string('tweak-animation-speed')] ?? 1.0;
        if (factor !== 1.0) {
            this._oldFactor = St.Settings.get().slow_down_factor;
            St.Settings.get().slow_down_factor = factor;
        }
    }

    destroy() {
        if (this._attention) {
            global.display.disconnectObject(this);
            const h = this._attention;
            global.display.connectObject(
                'window-demands-attention', (d, w) => h._onWindowDemandsAttention(d, w),
                'window-marked-urgent', (d, w) => h._onWindowDemandsAttention(d, w), h);
            this._attention = null;
        }
        if (this._display) {
            WorkspaceSwitcherPopup.prototype.display = this._display;
            this._display = null;
        }
        if (this._oldFactor !== undefined) {
            St.Settings.get().slow_down_factor = this._oldFactor;
            this._oldFactor = undefined;
        }
    }
}
