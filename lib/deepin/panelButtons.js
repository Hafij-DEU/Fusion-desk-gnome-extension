// Deepin mode buttons that join the Fusion taskbar (which otherwise stays as
// the user set it up): the Deepin launcher and the control centre.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {giconFor} from '../icons.js';

/** Launcher tile next to the start button; opens the Deepin launcher. */
export class DeepinLauncherButton {
    constructor(ext) {
        const custom = ext.settings.get_string('deepin-launcher-icon');
        const size = Math.round(ext.settings.get_int('panel-height') * 0.62);
        this.actor = new St.Button({
            style_class: `fusion-deepin-panel-launcher${custom ? ' fusion-deepin-panel-launcher-custom' : ''}`,
            can_focus: true,
            track_hover: true,
            accessible_name: _('Launcher'),
            y_align: Clutter.ActorAlign.CENTER,
            width: size,
            height: size,
            child: new St.Icon({
                gicon: giconFor(custom, 'view-app-grid-symbolic', `${ext.path}/icons`),
                icon_size: custom ? size : Math.round(size * 0.55),
            }),
        });
        this.actor.connect('clicked', () => ext.deepin?.launcher?.toggle());
        this._ext = ext;
        if (ext.deepin)
            ext.deepin.launcherButton = this.actor;
    }

    destroy() {
        if (this._ext.deepin?.launcherButton === this.actor)
            this._ext.deepin.launcherButton = null;
        this.actor.destroy();
    }
}

/**
 * Control centre button: a wide bell after the start button or in the tray,
 * or no button at all with the clock opening the control centre instead.
 */
export class DeepinControlButton {
    constructor(ext) {
        this.actor = null;
        const toggle = () => ext.deepin?.controlCenter?.toggle();
        if (ext.settings.get_string('deepin-control-position') === 'CLOCK') {
            // Left click on the clock: control centre; the calendar opens from its header.
            const date = Main.panel.statusArea.dateMenu;
            if (!date?._clickGesture)
                return;
            this._date = date;
            date._clickGesture.set_enabled(false);
            this._gesture = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true});
            this._gesture.connect('recognize', () => {
                date.menu.close();
                toggle();
            });
            date.add_action(this._gesture);
            return;
        }
        this.actor = new St.Button({
            style_class: 'panel-button fusion-deepin-panel-control',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Control centre'),
            y_align: Clutter.ActorAlign.FILL,
            child: new St.Icon({icon_name: 'preferences-system-notifications-symbolic', icon_size: 18}),
        });
        this.actor.connect('clicked', toggle);
    }

    destroy() {
        if (this._date) {
            this._date.remove_action(this._gesture);
            this._date._clickGesture.set_enabled(true);
            this._date = this._gesture = null;
        }
        this.actor?.destroy();
    }
}
