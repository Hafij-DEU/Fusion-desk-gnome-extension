// Custom clock format on the date menu (multi-line supported).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Clock {
    constructor(ext) {
        this._settings = ext.settings;
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._orig = dateMenu?._clockDisplay;
        // Another extension may have replaced or detached GNOME's clock label.
        if (!this._orig?.get_parent() || !this._settings.get_boolean('clock-custom'))
            return;

        this._label = new St.Label({style_class: 'clock fusion-clock', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._orig.get_parent().insert_child_above(this._label, this._orig);
        this._orig.hide();

        this._update();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _update() {
        const fmt = this._settings.get_string('clock-format').replace(/\\n/g, '\n');
        const now = GLib.DateTime.new_now_local();
        const text = now.format(fmt) ?? now.format('%H:%M');
        if (this._label.text !== text)
            this._label.text = text;
    }

    destroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._label?.destroy();
        this._orig?.show();
    }
}
