// Focused window icon + title.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

export class WindowTitle {
    constructor() {
        this._tracker = Shell.WindowTracker.get_default();
        this.actor = new St.BoxLayout({style_class: 'fusion-title', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'fusion-title-label'});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(this._icon);
        this.actor.add_child(this._label);
        global.display.connectObject('notify::focus-window', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this._window?.disconnectObject(this);
        this._window = global.display.focus_window;
        this._window?.connectObject('notify::title', () => this._sync(), this);
        const app = this._window ? this._tracker.get_window_app(this._window) : null;
        this._icon.child = app ? app.create_icon_texture(18) : null;
        this._label.text = this._window?.get_title() ?? '';
        this.actor.visible = !!this._window;
    }

    destroy() {
        global.display.disconnectObject(this);
        this._window?.disconnectObject(this);
        this.actor.destroy();
    }
}
