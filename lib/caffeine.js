// Caffeine: Quick Settings toggle that inhibits idle and suspend, optionally
// for a set time (the toggle's menu picks the duration).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;
// Minutes (0 = until turned off) and labels for the duration menu.
const DURATIONS = [[0, 'Until turned off'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'],
    [120, '2 hours'], [240, '4 hours']];

const now = () => Math.floor(GLib.get_real_time() / 1e6);

function remaining(seconds) {
    const m = Math.ceil(seconds / 60);
    if (m < 60)
        return `${m} min left`;
    return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min ` : ''}left`;
}

const CaffeineIndicator = GObject.registerClass(
class FusionCaffeineIndicator extends SystemIndicator {
    _init(ext) {
        super._init();
        this._settings = ext.settings;
        const gicon = Gio.icon_new_for_string(`${ext.path}/icons/fusion-caffeine-symbolic.svg`);

        this._indicator = this._addIndicator();
        this._indicator.gicon = gicon;

        const toggle = this._toggle = new QuickMenuToggle({title: 'Caffeine', gicon, toggleMode: true});
        this._settings.bind('caffeine-active', toggle, 'checked', Gio.SettingsBindFlags.DEFAULT);
        toggle.menu.setHeader(gicon, 'Caffeine', 'Keep the screen awake');
        this._items = new Map();
        for (const [minutes, label] of DURATIONS) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                this._settings.set_int('caffeine-duration', minutes);
                this._settings.set_int64('caffeine-until', 0);
                if (this._settings.get_boolean('caffeine-active'))
                    this._arm();
                else
                    this._settings.set_boolean('caffeine-active', true);
            });
            this._items.set(minutes, item);
            toggle.menu.addMenuItem(item);
        }
        this.quickSettingsItems.push(toggle);

        this._settings.connectObject('changed::caffeine-active', () => this._sync(),
            'changed::caffeine-duration', () => this._syncLabels(), this);
        this._sync();
    }

    /** Start the countdown for the chosen duration (keeps a running one). */
    _arm() {
        const minutes = this._settings.get_int('caffeine-duration');
        const until = this._settings.get_int64('caffeine-until');
        if (minutes > 0 && until <= now())
            this._settings.set_int64('caffeine-until', now() + minutes * 60);
        else if (minutes === 0)
            this._settings.set_int64('caffeine-until', 0);
        this._tick();
        if (!this._timerId && this._settings.get_int64('caffeine-until')) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
                this._tick();
                return this._timerId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
        }
    }

    _disarm() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settings.get_int64('caffeine-until'))
            this._settings.set_int64('caffeine-until', 0);
    }

    _tick() {
        const until = this._settings.get_int64('caffeine-until');
        if (until && until <= now()) {
            this._timerId = 0;
            this._settings.set_boolean('caffeine-active', false);
            return;
        }
        this._syncLabels();
    }

    _syncLabels() {
        const active = this._settings.get_boolean('caffeine-active');
        const until = this._settings.get_int64('caffeine-until');
        const minutes = this._settings.get_int('caffeine-duration');
        const label = DURATIONS.find(([m]) => m === minutes)?.[1] ?? `${minutes} min`;
        this._toggle.subtitle = active ? (until ? remaining(until - now()) : 'Until turned off') : label;
        for (const [m, item] of this._items)
            item.setOrnament(m === minutes ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    _sync() {
        const active = this._settings.get_boolean('caffeine-active');
        this._indicator.visible = active;
        if (active)
            this._arm();
        else
            this._disarm();
        this._syncLabels();
        if (active && !this._cookie && !this._pending)
            this._inhibit();
        else if (!active && this._cookie)
            this._uninhibit();
    }

    _inhibit() {
        this._pending = true;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Inhibit',
            new GLib.Variant('(susu)', ['fusion-desk', 0, 'Caffeine is on', INHIBIT_IDLE | INHIBIT_SUSPEND]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                this._pending = false;
                try {
                    [this._cookie] = conn.call_finish(res).deepUnpack();
                    if (this._destroyed || !this._settings.get_boolean('caffeine-active'))
                        this._uninhibit();
                } catch (e) {
                    console.error('Fusion Desk: caffeine inhibit failed', e);
                }
            });
    }

    _uninhibit() {
        const cookie = this._cookie;
        this._cookie = 0;
        if (!cookie)
            return;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Uninhibit', new GLib.Variant('(u)', [cookie]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._settings.disconnectObject(this);
        this._uninhibit();
        this.quickSettingsItems.forEach(i => i.destroy());
        super.destroy();
    }
});

export class Caffeine {
    constructor(ext) {
        this._indicator = new CaffeineIndicator(ext);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    destroy() {
        this._indicator.destroy();
    }
}
