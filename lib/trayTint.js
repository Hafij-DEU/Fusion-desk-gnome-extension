// App tray icons (other apps' indicators, often white or full-colour images)
// painted in the same colour as the system status icons, so they stay
// readable on a light taskbar and follow the accent colour when that is on.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {removeTint, tintWithForeground} from './style.js';

function isAppTrayIcon(actor) {
    if (!(actor instanceof St.Icon))
        return false;
    const type = GObject.type_name(actor.constructor.$gtype ?? GObject.TYPE_NONE) ?? '';
    return /AppIndicator|TrayIcon|StatusNotifier/i.test(`${type} ${actor.constructor.name}`);
}

export class TrayTint {
    constructor(ext) {
        this._tinted = new Set();
        if (ext.settings.get_string('tray-app-icons') !== 'MATCH')
            return;
        this._box = Main.panel._rightBox;
        this._box.connectObject('child-added', () => this._queue(), this);
        this._scan();
        // Indicators add or swap their icons later (app start, icon change).
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const walk = actor => {
            if (isAppTrayIcon(actor) && !this._tinted.has(actor)) {
                tintWithForeground(actor);
                this._tinted.add(actor);
                actor.connectObject('destroy', () => this._tinted.delete(actor), this);
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(this._box);
    }

    destroy() {
        for (const id of ['_timerId', '_idleId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._box?.disconnectObject(this);
        for (const actor of this._tinted) {
            actor.disconnectObject(this);
            removeTint(actor);
        }
        this._tinted.clear();
    }
}
