// Deepin mode buttons that join the Fusion taskbar (which otherwise stays as
// the user set it up): the Deepin launcher and the control centre.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
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

/** Bell button in the tray; slides the control centre in from the right. */
export class DeepinControlButton {
    constructor(ext) {
        this.actor = new St.Button({
            style_class: 'panel-button fusion-deepin-panel-control',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Control centre'),
            y_align: Clutter.ActorAlign.FILL,
            child: new St.Icon({icon_name: 'preferences-system-notifications-symbolic', style_class: 'system-status-icon'}),
        });
        this.actor.connect('clicked', () => ext.deepin?.controlCenter?.toggle());
    }

    destroy() {
        this.actor.destroy();
    }
}
