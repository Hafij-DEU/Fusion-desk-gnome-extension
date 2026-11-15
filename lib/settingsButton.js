// Harbor Settings (win11-settings) button between the start button and the
// search button. Shown only while the app is installed.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const APP_ID = 'win11-settings.desktop';

export class SettingsButton {
    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this._icon = new St.Icon({icon_size: 20, fallback_icon_name: 'preferences-system-symbolic'});
        this.actor = new St.Button({
            style_class: 'fusion-win-taskview fusion-settings-button',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Settings'),
            y_align: Clutter.ActorAlign.FILL,
            child: this._icon,
        });
        this.actor.connect('clicked', () => this._app()?.activate());
        this._appSystem.connectObject('installed-changed', () => this._sync(), this);
        this._sync();
    }

    _app() {
        return this._appSystem.lookup_app(APP_ID);
    }

    _sync() {
        const app = this._app();
        this.actor.visible = !!app;
        if (app)
            this._icon.gicon = app.get_icon();
    }

    destroy() {
        this._appSystem.disconnectObject(this);
        this.actor.destroy();
    }
}
