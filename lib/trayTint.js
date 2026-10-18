// App tray icons (other apps' indicators) that are plain white, black or
// grey get the same colour as the system status icons, so they stay
// readable on a light taskbar and follow the accent colour when that is on.
// Colourful icons keep their own colours.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
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

/**
 * True when (almost) no visible pixel is coloured: white, black or grey art.
 * `at(i)` returns [r, g, b, a] of pixel i.
 */
function isPlainArt(count, at) {
    let visible = 0, coloured = 0;
    const step = Math.max(1, Math.floor(count / 1600));
    for (let i = 0; i < count; i += step) {
        const [r, g, b, a] = at(i);
        if (a < 80)
            continue;
        visible++;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max > 40 && (max - min) / max > 0.28)
            coloured++;
    }
    return visible > 0 && coloured / visible < 0.08;
}

function pixbufIsPlain(pixbuf) {
    const px = pixbuf.get_pixels();
    const n = pixbuf.get_n_channels(), stride = pixbuf.get_rowstride(), w = pixbuf.get_width();
    const alpha = pixbuf.get_has_alpha();
    return isPlainArt(w * pixbuf.get_height(), i => {
        const o = Math.floor(i / w) * stride + (i % w) * n;
        return [px[o], px[o + 1], px[o + 2], alpha ? px[o + 3] : 255];
    });
}

/** Image file behind a GIcon (file icons; theme icons, also from an app's own theme folder). */
function iconFile(gicon, themePath) {
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path();
    if (gicon instanceof Gio.ThemedIcon) {
        const theme = new St.IconTheme();
        if (themePath)
            theme.append_search_path?.(themePath);
        return theme.lookup_by_gicon(gicon, 32, 0)?.get_filename() ?? null;
    }
    return null;
}

/**
 * Whether a tray icon is plain (white / black / grey). Returns [key, plain]:
 * key changes when the icon changes; plain is null when it cannot be told.
 */
function analyse(actor) {
    const gicon = actor.gicon;
    const icon = actor._indicator?.icon;
    if (gicon) {
        const names = gicon instanceof Gio.ThemedIcon ? gicon.get_names() : [];
        const key = gicon.to_string() ?? '';
        if (names.some(n => n.endsWith('-symbolic')))
            return [key, true];
        try {
            const path = iconFile(gicon, icon?.theme);
            if (path)
                return [key, pixbufIsPlain(GdkPixbuf.Pixbuf.new_from_file_at_size(path, 32, 32))];
        } catch (e) {
            // Unreadable image: leave it as it is.
        }
        return [key, null];
    }
    // Pixmap sent over D-Bus: a(iiay) of ARGB32 images (network byte order).
    try {
        const pixmaps = icon?.pixmap?.deepUnpack?.() ?? [];
        const [w, h, data] = pixmaps.reduce((best, p) => (!best || p[0] > best[0] ? p : best), null) ?? [];
        if (w > 0 && data?.length >= w * h * 4) {
            const key = `pixmap:${w}x${h}:${data[0]}${data[Math.floor(data.length / 2)]}${data[data.length - 1]}`;
            return [key, isPlainArt(w * h, i => [data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3], data[i * 4]])];
        }
    } catch (e) {
        // No usable pixmap.
    }
    return ['', null];
}

export class TrayTint {
    constructor(ext) {
        this._seen = new Map(); // actor -> last analysed key
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
            if (isAppTrayIcon(actor))
                this._check(actor);
            for (const child of actor.get_children())
                walk(child);
        };
        walk(this._box);
    }

    _check(actor) {
        if (!this._seen.has(actor)) {
            actor.connectObject('notify::gicon', () => this._check(actor),
                'destroy', () => this._seen.delete(actor), this);
        }
        const [key, plain] = analyse(actor);
        if (this._seen.get(actor) === key)
            return;
        this._seen.set(actor, key);
        // Plain icons: one solid colour like the status icons; others: their own colours.
        if (plain)
            tintWithForeground(actor);
        else
            removeTint(actor);
    }

    destroy() {
        for (const id of ['_timerId', '_idleId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._box?.disconnectObject(this);
        for (const actor of this._seen.keys()) {
            actor.disconnectObject(this);
            removeTint(actor);
        }
        this._seen.clear();
    }
}
