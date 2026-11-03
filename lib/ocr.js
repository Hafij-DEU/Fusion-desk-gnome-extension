// Text from a screen area (OCR): drag a rectangle over any part of the
// screen and the text in it is copied to the clipboard. The area is saved
// as a picture, enlarged (small screen text reads much better that way) and
// read by tesseract in the ocr-languages. Opened by ocr-hotkey
// (Super+Shift+T) or the tools menu. Nothing leaves the computer.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Accelerators} from './accelerators.js';

const TITLE = 'Text from a screen area';
let picking = null; // the open AreaPicker (one at a time)

/** Run `argv`, calling `done(ok, stdout, stderr)`. */
function run(argv, done) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        done(false, '', e.message);
        return;
    }
    proc.communicate_utf8_async(null, null, (_p, res) => {
        try {
            const [, out, err] = proc.communicate_utf8_finish(res);
            done(proc.get_successful(), out ?? '', err ?? '');
        } catch (e) {
            done(false, '', e.message);
        }
    });
}

/** Full-screen layer to drag a rectangle on; `done(rect)` gets [x, y, w, h] or null. */
class AreaPicker {
    constructor(done) {
        this._done = done;
        this._layer = new St.Widget({reactive: true, can_focus: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        // Four shades around the selection, so the area itself stays clear.
        this._shades = [0, 1, 2, 3].map(() => new St.Widget({style_class: 'fusion-ocr-shade'}));
        this._box = new St.Widget({style_class: 'fusion-ocr-box', visible: false});
        this._hint = new St.Label({style_class: 'fusion-ocr-hint',
            text: 'Drag over the text to copy · Esc cancels'});
        for (const a of [...this._shades, this._box, this._hint])
            this._layer.add_child(a);
        Main.layoutManager.uiGroup.add_child(this._layer);
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        const monitor = Main.layoutManager.primaryMonitor;
        const [, hintWidth] = this._hint.get_preferred_width(-1);
        this._hint.set_position(monitor.x + Math.round((monitor.width - hintWidth) / 2), monitor.y + 48);
        this._layout(0, 0, 0, 0);
        this._layer.grab_key_focus();
        this._layer.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY) {
                this._finish(null);
                return Clutter.EVENT_STOP;
            }
            [this._x0, this._y0] = ev.get_coords();
            this._dragging = true;
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('motion-event', (_a, ev) => {
            if (this._dragging) {
                const [x, y] = ev.get_coords();
                this._layout(...this._rect(x, y));
            }
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('button-release-event', (_a, ev) => {
            if (!this._dragging)
                return Clutter.EVENT_STOP;
            this._dragging = false;
            const rect = this._rect(...ev.get_coords());
            this._finish(rect[2] >= 4 && rect[3] >= 4 ? rect : null);
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape)
                this._finish(null);
            return Clutter.EVENT_STOP;
        });
    }

    _rect(x, y) {
        const x1 = Math.round(Math.min(x, this._x0)), y1 = Math.round(Math.min(y, this._y0));
        return [x1, y1, Math.round(Math.max(x, this._x0)) - x1, Math.round(Math.max(y, this._y0)) - y1];
    }

    _layout(x, y, w, h) {
        const W = global.stage.width, H = global.stage.height;
        const [top, bottom, left, right] = this._shades;
        top.set_position(0, 0);
        top.set_size(W, y);
        bottom.set_position(0, y + h);
        bottom.set_size(W, H - y - h);
        left.set_position(0, y);
        left.set_size(x, h);
        right.set_position(x + w, y);
        right.set_size(W - x - w, h);
        this._box.visible = w > 0 && h > 0;
        this._box.set_position(x, y);
        this._box.set_size(w, h);
        this._hint.visible = !this._box.visible;
    }

    _finish(rect) {
        if (!this._layer)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._layer.destroy();
        this._layer = null;
        this._done(rect);
    }

    destroy() {
        this._finish(null);
    }
}

/** Save the screen area as a PNG (after the picker is gone from the screen). */
function capture(rect, path, done) {
    // Wait for a frame without the picker on it.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        try {
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot_area(...rect, stream, (shooter, res) => {
                let ok = false;
                try {
                    shooter.screenshot_area_finish(res);
                    ok = true;
                } catch (e) {
                    console.warn(`Fusion Desk: screen area capture failed: ${e.message}`);
                }
                stream.close(null);
                done(ok);
            });
        } catch (e) {
            console.warn(`Fusion Desk: screen area capture failed: ${e.message}`);
            done(false);
        }
        return GLib.SOURCE_REMOVE;
    });
}

/** Enlarge small pictures: tesseract reads text best at about 30 px letters. */
function enlarge(path) {
    try {
        const pix = GdkPixbuf.Pixbuf.new_from_file(path);
        const area = pix.width * pix.height;
        const factor = area > 2e6 ? 1 : area > 5e5 ? 2 : 3;
        if (factor > 1)
            pix.scale_simple(pix.width * factor, pix.height * factor, GdkPixbuf.InterpType.HYPER)
                .savev(path, 'png', [], []);
    } catch (e) {
        console.warn(`Fusion Desk: could not enlarge ${path}: ${e.message}`);
    }
}

/** The wanted languages that tesseract has, joined by "+" ('' when none). */
function languages(wanted, done) {
    run(['tesseract', '--list-langs'], (_ok, out) => {
        const have = new Set(out.split('\n').slice(1).map(l => l.trim()).filter(Boolean));
        const langs = wanted.split('+').map(l => l.trim()).filter(l => have.has(l));
        done(langs.length ? langs.join('+') : have.has('eng') ? 'eng' : [...have].filter(l => l !== 'osd')[0] ?? '');
    });
}

/** Pick a screen area and copy its text to the clipboard. */
export function startScreenText(ext) {
    if (picking)
        return;
    if (!GLib.find_program_in_path('tesseract')) {
        Main.notifyError(TITLE, 'The text reader (tesseract) is not installed. Install it in Fusion Desk settings, System page, or in a terminal:\nsudo apt install tesseract-ocr tesseract-ocr-eng');
        return;
    }
    const picker = new AreaPicker(rect => {
        picking = null;
        if (!rect)
            return;
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk']);
        GLib.mkdir_with_parents(dir, 0o700);
        const path = GLib.build_filenamev([dir, 'screen-text.png']);
        capture(rect, path, ok => {
            if (!ok) {
                Main.notifyError(TITLE, 'Could not take a picture of that area.');
                return;
            }
            enlarge(path);
            languages(ext.settings.get_string('ocr-languages'), langs => {
                if (!langs) {
                    Main.notifyError(TITLE, 'No reading language is installed. Install one in Fusion Desk settings, System page.');
                    return;
                }
                run(['tesseract', path, 'stdout', '-l', langs, '--psm', '3'], (done, out, err) => {
                    GLib.unlink(path);
                    if (!done) {
                        Main.notifyError(TITLE, err.trim().split('\n').pop() || 'The text reader failed.');
                        return;
                    }
                    const text = out.replace(/\f/g, '').replace(/[ \t]+\n/g, '\n')
                        .replace(/\n{3,}/g, '\n\n').trim();
                    if (!text) {
                        Main.notify(TITLE, 'No text found in that area.');
                        return;
                    }
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
                    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
                    Main.notify('Text copied', preview);
                });
            });
        });
    });
    picking = picker;
}

export class ScreenText {
    constructor(ext) {
        this._keys = new Accelerators();
        this._keys.add(ext.settings.get_string('ocr-hotkey'), () => startScreenText(ext));
    }

    destroy() {
        picking?.destroy();
        this._keys.destroy();
    }
}
