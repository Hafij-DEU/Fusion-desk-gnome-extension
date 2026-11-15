// Harbor Settings (win11-settings) button between the start button and the
// search button. Shown only while the app is installed.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {tintWithAccent} from './style.js';

const APP_ID = 'win11-settings.desktop';

export class SettingsButton {
    constructor(ext) {
        this._appSystem = Shell.AppSystem.get_default();
        // Same size as the start button icon.
        const size = ext.settings.get_int('menu-button-icon-size');
        this._icon = new St.Icon({icon_size: size, fallback_icon_name: 'preferences-system-symbolic'});
        // In the accent colour like the start icon: a cut-out tile, because a
        // tint turns the app's full-colour icon into a flat square.
        this._accentIcon = ext.settings.get_boolean('icons-follow-accent')
            ? Gio.FileIcon.new(Gio.File.new_for_path(`${ext.path}/icons/settings-tile.svg`))
            : null;
        if (this._accentIcon)
            tintWithAccent(this._icon, ext.settings);
        this.actor = new St.Button({
            style_class: 'fusion-win-taskview fusion-settings-button',
            style: 'padding: 0 6px;',
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
            this._icon.gicon = this._accentIcon ?? app.get_icon();
    }

    destroy() {
        this._appSystem.disconnectObject(this);
        this.actor.destroy();
    }
}
