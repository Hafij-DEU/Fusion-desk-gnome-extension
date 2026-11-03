// Text from a screen area (OCR): drag a rectangle over any part of the
// screen, then pick the words to copy (or copy everything at once with
// ocr-choose-text off). The area is saved as a picture, enlarged (small
// screen text reads much better that way) and read by tesseract in the
// ocr-languages. Opened by ocr-hotkey (Super+Shift+T) or the tools menu.
// Nothing leaves the computer.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Accelerators} from './accelerators.js';

const TITLE = 'Text from a screen area';
let picking = null; // the open AreaPicker or TextPicker (one at a time)
let generation = 0; // goes up when the module stops, so late results are dropped

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

/** Four shades around [x, y, w, h], so the area itself stays clear. */
function layoutShades([top, bottom, left, right], x, y, w, h) {
    const W = global.stage.width, H = global.stage.height;
    top.set_position(0, 0);
    top.set_size(W, y);
    bottom.set_position(0, y + h);
    bottom.set_size(W, H - y - h);
    left.set_position(0, y);
    left.set_size(x, h);
    right.set_position(x + w, y);
    right.set_size(W - x - w, h);
}

/** A full-screen modal layer with shades; the base of both pickers. */
class Overlay {
    constructor() {
        this._layer = new St.Widget({reactive: true, can_focus: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        this._shades = [0, 1, 2, 3].map(() => new St.Widget({style_class: 'fusion-ocr-shade'}));
        for (const a of this._shades)
            this._layer.add_child(a);
        Main.layoutManager.uiGroup.add_child(this._layer);
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        this._layer.grab_key_focus();
    }

    _close() {
        if (!this._layer)
            return false;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._layer.destroy();
        this._layer = null;
        return true;
    }
}

/** Drag a rectangle; `done(rect)` gets [x, y, w, h] or null. */
class AreaPicker extends Overlay {
    constructor(done) {
        super();
        this._done = done;
        this._box = new St.Widget({style_class: 'fusion-ocr-box', visible: false});
        this._hint = new St.Label({style_class: 'fusion-ocr-hint',
            text: 'Drag over the text to copy · Esc cancels'});
        this._layer.add_child(this._box);
        this._layer.add_child(this._hint);
        const monitor = Main.layoutManager.primaryMonitor;
        const [, hintWidth] = this._hint.get_preferred_width(-1);
        this._hint.set_position(monitor.x + Math.round((monitor.width - hintWidth) / 2), monitor.y + 48);
        this._layout(0, 0, 0, 0);
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
        layoutShades(this._shades, x, y, w, h);
        this._box.visible = w > 0 && h > 0;
        this._box.set_position(x, y);
        this._box.set_size(w, h);
        this._hint.visible = !this._box.visible;
    }

    _finish(rect) {
        if (this._close())
            this._done(rect);
    }

    destroy() {
        this._finish(null);
    }
}

/**
 * `words` as text: spaces within a line, a line break between lines, and a
 * blank line where there is a gap of a line or more. Not by tesseract's
 * paragraphs and blocks: it often splits those in the wrong place.
 */
function joinWords(words) {
    let out = '';
    words.forEach((w, i) => {
        const prev = words[i - 1];
        if (prev && prev.line === w.line)
            out += ' ';
        else if (prev)
            out += w.y - (prev.y + prev.h) > Math.max(prev.h, w.h) * 0.8 ? '\n\n' : '\n';
        out += w.text;
    });
    return out;
}

/** A flat button with an icon and a label, for the picker's bar and menu. */
function iconButton(styleClass, iconName, label, accel, action) {
    const box = new St.BoxLayout({x_expand: true});
    box.add_child(new St.Icon({icon_name: iconName, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    if (accel)
        box.add_child(new St.Label({text: accel, style_class: 'fusion-ocr-accel', y_align: Clutter.ActorAlign.CENTER}));
    const button = new St.Button({style_class: styleClass, child: box, can_focus: true, x_expand: true});
    button.connect('clicked', action);
    return button;
}

/**
 * The picture of the area, frozen in place and dimmed, with the words
 * tesseract found lit up. Drag (or click) over the words to select them, like
 * text in a document; right-click for Copy text and Select all. `done(text)`
 * gets the text to copy, or null.
 */
class TextPicker extends Overlay {
    constructor(rect, image, words, done) {
        super();
        this._done = done;
        this._words = words;
        this._anchor = this._end = -1;
        this._menu = null;
        const [x, y, w, h] = this._area = rect;
        layoutShades(this._shades, x, y, w, h);
        // The screen as it was: a video keeps playing underneath.
        const uri = Gio.File.new_for_path(image).get_uri();
        this._layer.add_child(new St.Widget({x, y, width: w, height: h,
            style: `background-image: url("${uri}"); background-size: ${w}px ${h}px;`}));
        this._layer.add_child(new St.Widget({style_class: 'fusion-ocr-dim', x, y, width: w, height: h}));
        this._boxes = words.map(word => {
            // The word undimmed: its own piece of the picture, with the
            // selection tint on top.
            const bx = Math.round(x + word.x) - 2, by = Math.round(y + word.y) - 2;
            const width = Math.round(word.w) + 4, height = Math.round(word.h) + 4;
            // St draws a background image past the actor's edges, so clip it.
            const piece = new St.Widget({x: bx, y: by, width, height, clip_to_allocation: true,
                style: `background-image: url("${uri}"); background-size: ${w}px ${h}px; ` +
                    `background-position: ${x - bx}px ${y - by}px;`});
            const box = new St.Widget({style_class: 'fusion-ocr-word', width, height});
            piece.add_child(box);
            this._layer.add_child(piece);
            return box;
        });
        this._layer.add_child(new St.Widget({style_class: 'fusion-ocr-box', x, y, width: w, height: h}));
        this._buildBar();

        this._layer.connect('button-press-event', (_a, ev) => {
            const [px, py] = ev.get_coords();
            if (this._within(this._bar, px, py))
                return Clutter.EVENT_PROPAGATE;
            if (this._menu) {
                // A click away from the menu only closes it.
                if (this._within(this._menu, px, py))
                    return Clutter.EVENT_PROPAGATE;
                this._closeMenu();
                return Clutter.EVENT_STOP;
            }
            if (!this._inside(px, py)) {
                this._finish(null);
                return Clutter.EVENT_STOP;
            }
            if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
                // Right-click on an unselected word selects it first.
                const hit = this._hit(px, py);
                if (hit >= 0 && !this._selected().includes(this._words[hit])) {
                    this._anchor = this._end = hit;
                    this._sync();
                }
                this._openMenu(px, py);
            } else if (ev.get_button() === Clutter.BUTTON_PRIMARY) {
                // A click on a word selects it; a click beside the text clears.
                this._pressAt = [px, py];
                this._anchor = this._end = this._hit(px, py);
                this._dragging = true;
                this._sync();
            }
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('motion-event', (_a, ev) => {
            const [px, py] = ev.get_coords();
            // Selecting starts once the pointer really moves, so a click
            // beside the text still clears.
            if (this._dragging && Math.abs(px - this._pressAt[0]) + Math.abs(py - this._pressAt[1]) > 3) {
                if (this._anchor < 0)
                    this._anchor = this._nearest(...this._pressAt);
                this._end = this._nearest(px, py);
                this._sync();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._layer.connect('button-release-event', () => {
            this._dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });
        this._layer.connect('key-press-event', (_a, ev) => {
            const key = ev.get_key_symbol();
            const ctrl = (ev.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            if (key === Clutter.KEY_Escape) {
                if (this._menu)
                    this._closeMenu();
                else
                    this._finish(null);
            } else if (ctrl && (key === Clutter.KEY_a || key === Clutter.KEY_A)) {
                this._selectAll();
            } else if ((ctrl && (key === Clutter.KEY_c || key === Clutter.KEY_C)) ||
                       key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                // Nothing selected copies everything.
                const chosen = this._selected();
                this._finish(joinWords(chosen.length ? chosen : words));
            }
            return Clutter.EVENT_STOP;
        });
        this._sync();
    }

    /** Copy all text, Copy text and Close, above the area like a toolbar. */
    _buildBar() {
        const bar = this._bar = new St.BoxLayout({style_class: 'fusion-ocr-bar'});
        const add = (...args) => {
            const b = iconButton('fusion-ocr-button', ...args);
            b.x_expand = false;
            bar.add_child(b);
            return b;
        };
        add('edit-select-all-symbolic', 'Copy all text', '', () => this._finish(joinWords(this._words)));
        this._copy = add('edit-copy-symbolic', 'Copy text', '', () => this._finish(joinWords(this._selected())));
        add('window-close-symbolic', 'Close', '', () => this._finish(null));
        this._layer.add_child(bar);
        // Above the area, or below it, or inside its top edge.
        const [x, y, w, h] = this._area;
        const [, barWidth] = bar.get_preferred_width(-1);
        const [, barHeight] = bar.get_preferred_height(barWidth);
        const monitor = this._monitor();
        const gap = 12;
        let by = y - gap - barHeight;
        if (by < monitor.y)
            by = y + h + gap + barHeight <= monitor.y + monitor.height ? y + h + gap : y + gap;
        bar.set_position(this._clampX(x + Math.round((w - barWidth) / 2), barWidth), by);
    }

    _monitor() {
        const [x, y, w, h] = this._area;
        const index = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x, y, width: w, height: h}));
        return Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
    }

    _clampX(x, width) {
        const monitor = this._monitor();
        return Math.min(Math.max(x, monitor.x + 12), monitor.x + monitor.width - width - 12);
    }

    _openMenu(px, py) {
        const menu = this._menu = new St.BoxLayout({style_class: 'fusion-ocr-menu', vertical: true});
        const n = this._selected().length;
        const copy = iconButton('fusion-ocr-menu-item', 'edit-copy-symbolic', 'Copy text', 'Ctrl+C',
            () => this._finish(joinWords(this._selected())));
        copy.reactive = n > 0;
        copy.opacity = n > 0 ? 255 : 128;
        menu.add_child(copy);
        menu.add_child(iconButton('fusion-ocr-menu-item', 'edit-select-all-symbolic', 'Select all', 'Ctrl+A', () => {
            this._closeMenu();
            this._selectAll();
        }));
        this._layer.add_child(menu);
        const [, menuWidth] = menu.get_preferred_width(-1);
        const [, menuHeight] = menu.get_preferred_height(menuWidth);
        const monitor = this._monitor();
        const my = py + menuHeight > monitor.y + monitor.height ? py - menuHeight : py;
        menu.set_position(this._clampX(Math.round(px), menuWidth), Math.round(my));
    }

    _closeMenu() {
        this._menu?.destroy();
        this._menu = null;
        this._layer?.grab_key_focus();
    }

    _selectAll() {
        this._anchor = 0;
        this._end = this._words.length - 1;
        this._sync();
    }

    _within(actor, px, py) {
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        return px >= ax && px < ax + aw && py >= ay && py < ay + ah;
    }

    _inside(px, py) {
        const [x, y, w, h] = this._area;
        return px >= x && px < x + w && py >= y && py < y + h;
    }

    /** Index of the word box under (px, py), or -1. */
    _hit(px, py) {
        return this._boxes.findIndex(box => this._within(box, px, py));
    }

    /** Index of the word under (px, py), or else of the closest one. */
    _nearest(px, py) {
        const [x0, y0] = this._area;
        let best = 0, bestDist = Infinity;
        this._words.forEach((w, i) => {
            const dx = Math.max(x0 + w.x - px, 0, px - (x0 + w.x + w.w));
            // Lines count more than columns, so a drag follows the line it is on.
            const dy = Math.max(y0 + w.y - py, 0, py - (y0 + w.y + w.h)) * 3;
            if (dx + dy < bestDist) {
                best = i;
                bestDist = dx + dy;
            }
        });
        return best;
    }

    _selected() {
        if (this._anchor < 0)
            return [];
        return this._words.slice(Math.min(this._anchor, this._end), Math.max(this._anchor, this._end) + 1);
    }

    _sync() {
        const lo = Math.min(this._anchor, this._end), hi = Math.max(this._anchor, this._end);
        this._boxes.forEach((box, i) => {
            if (this._anchor >= 0 && i >= lo && i <= hi)
                box.add_style_class_name('selected');
            else
                box.remove_style_class_name('selected');
        });
        const n = this._selected().length;
        this._copy.reactive = n > 0;
        this._copy.opacity = n > 0 ? 255 : 128;
    }

    _finish(text) {
        this._menu = null;
        if (this._close())
            this._done(text);
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

/**
 * Write an enlarged copy of `path` to `out` (tesseract reads text best at
 * about 30 px letters). Returns how many pixels of `out` make one pixel of
 * the `width`-wide screen area, or 0 when it failed.
 */
function enlarge(path, out, width) {
    try {
        const pix = GdkPixbuf.Pixbuf.new_from_file(path);
        const area = pix.width * pix.height;
        const factor = area > 2e6 ? 1 : area > 5e5 ? 2 : 3;
        pix.scale_simple(pix.width * factor, pix.height * factor, GdkPixbuf.InterpType.HYPER)
            .savev(out, 'png', [], []);
        // On a scaled screen the picture has more pixels than the area.
        return factor * pix.width / width;
    } catch (e) {
        console.warn(`Fusion Desk: could not enlarge ${path}: ${e.message}`);
        return 0;
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

/** Words of a tesseract TSV in reading order, with boxes in pixels of the screen area. */
function parseWords(tsv, scale) {
    const words = [];
    for (const row of tsv.split('\n').slice(1)) {
        // level page block par line word left top width height conf text; level 5 = a word
        const f = row.split('\t');
        if (f.length < 12 || f[0] !== '5')
            continue;
        const text = f.slice(11).join('\t').trim();
        if (!text)
            continue;
        const [, , block, par, line, , left, top, width, height] = f.map(Number);
        words.push({text, block, line: `${block}.${par}.${line}`,
            x: left / scale, y: top / scale, w: width / scale, h: height / scale});
    }
    return words;
}

function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    Main.notify('Text copied', text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

/** Pick a screen area, then the words in it, and copy them to the clipboard. */
export function startScreenText(ext) {
    if (picking)
        return;
    if (!GLib.find_program_in_path('tesseract')) {
        Main.notifyError(TITLE, 'The text reader (tesseract) is not installed. Install it in Fusion Desk settings, System page, or in a terminal:\nsudo apt install tesseract-ocr tesseract-ocr-eng');
        return;
    }
    const gen = generation;
    picking = new AreaPicker(rect => {
        picking = null;
        if (!rect)
            return;
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk']);
        GLib.mkdir_with_parents(dir, 0o700);
        // A new name each time: the shell keeps pictures it showed by file name.
        const stamp = GLib.get_real_time();
        const path = GLib.build_filenamev([dir, `screen-text-${stamp}.png`]);
        const big = GLib.build_filenamev([dir, `screen-text-${stamp}-big.png`]);
        const cleanUp = () => {
            GLib.unlink(path);
            GLib.unlink(big);
        };
        const fail = (notify, text) => {
            cleanUp();
            notify(TITLE, text);
        };
        capture(rect, path, ok => {
            const scale = ok ? enlarge(path, big, rect[2]) : 0;
            if (!scale) {
                fail(Main.notifyError, 'Could not take a picture of that area.');
                return;
            }
            languages(ext.settings.get_string('ocr-languages'), langs => {
                if (!langs) {
                    fail(Main.notifyError, 'No reading language is installed. Install one in Fusion Desk settings, System page.');
                    return;
                }
                run(['tesseract', big, 'stdout', '-l', langs, '--psm', '3', 'tsv'], (done, out, err) => {
                    GLib.unlink(big);
                    if (gen !== generation) {
                        cleanUp();
                        return;
                    }
                    if (!done) {
                        fail(Main.notifyError, err.trim().split('\n').pop() || 'The text reader failed.');
                        return;
                    }
                    const words = parseWords(out, scale);
                    if (!words.length) {
                        fail(Main.notify, 'No text found in that area.');
                        return;
                    }
                    // A new area pick started meanwhile: no second layer on top of it.
                    if (!ext.settings.get_boolean('ocr-choose-text') || picking) {
                        cleanUp();
                        copyText(joinWords(words));
                        return;
                    }
                    picking = new TextPicker(rect, path, words, text => {
                        picking = null;
                        cleanUp();
                        if (text)
                            copyText(text);
                    });
                });
            });
        });
    });
}

/** Delete area pictures left behind when the shell stopped with a picker open. */
function removeLeftovers() {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk']));
    try {
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = children.next_file(null));) {
            const name = info.get_name();
            if (name.startsWith('screen-text-') && name.endsWith('.png'))
                dir.get_child(name).delete(null);
        }
        children.close(null);
    } catch {
        // No folder yet, or nothing to delete.
    }
}

export class ScreenText {
    constructor(ext) {
        removeLeftovers();
        this._keys = new Accelerators();
        this._keys.add(ext.settings.get_string('ocr-hotkey'), () => startScreenText(ext));
    }

    destroy() {
        generation++;
        picking?.destroy();
        this._keys.destroy();
    }
}
