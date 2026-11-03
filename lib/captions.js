// Live captions: a see-through dark bar near the bottom (or top) of the
// screen, or wherever its title was dragged to (captions-place), that
// shows what is being said in any sound the computer plays, or in the
// microphone, optionally translated into English. The words come from
// lib/captions/fusion-desk-captions (pw-record + a local whisper-server;
// the sound never leaves the computer). Translating uses DeepL (key from
// the login keyring, lib/deeplKey.js) or Google's free translator when
// captions-online is on, and the translator on this computer when they
// fail or are off. Toggled by captions-hotkey (Super+Ctrl+L) or the tools
// menu; the captions-* settings restart it while it runs.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Accelerators} from './accelerators.js';
import {LANGUAGES, TRANSLATOR_DIR, findModel, translatorReady} from './captionModels.js';
import {lookupKey} from './deeplKey.js';

const LINES = 3;
const RESTART_KEYS = ['captions-source', 'captions-language', 'captions-translate', 'captions-model',
    'captions-online', 'captions-deepl'];

let current = null; // the running LiveCaptions module (one per extension)

/** Turn live captions on or off. */
export function toggleCaptions() {
    current?.toggle();
}

export class LiveCaptions {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._keys = new Accelerators();
        this._keys.add(this._settings.get_string('captions-hotkey'), () => this.toggle());
        this._settings.connectObject('changed', (_s, key) => {
            if (RESTART_KEYS.includes(key) && this._proc)
                this._start();
            else if (['captions-position', 'captions-place', 'captions-size', 'captions-opacity'].includes(key))
                this._restyle();
        }, this);
        current = this;
        // Still on after the module was rebuilt (e.g. a new shortcut).
        if (ext.state.captionsOn)
            this._start();
    }

    toggle() {
        if (this._bar)
            this._stop();
        else
            this._start();
    }

    _start() {
        this._stopHelper();
        this._ext.state.captionsOn = true;
        this._lines = [];
        this._partial = '';
        this._slow = 0;
        this._buildBar();
        const s = this._settings;
        const translate = s.get_boolean('captions-translate') && s.get_string('captions-language') !== 'en';
        const local = translate && translatorReady();
        const online = translate && s.get_boolean('captions-online');
        const deepl = online && s.get_boolean('captions-deepl');
        const model = findModel(s.get_string('captions-model'), translate && !local && !online);
        if (!model) {
            this._status('No speech model yet. Get one in Fusion Desk settings, System page, Live captions.');
            return;
        }
        const argv = ['python3', GLib.build_filenamev([this._ext.path, 'lib', 'captions', 'fusion-desk-captions']),
            '--model', model, '--source', s.get_string('captions-source'),
            '--language', s.get_string('captions-language')];
        if (translate)
            argv.push('--translate');
        if (local)
            argv.push('--translator-dir', TRANSLATOR_DIR);
        if (online)
            argv.push('--online');
        if (deepl)
            argv.push('--deepl-key-stdin');
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._status(`Could not start: ${e.message}`);
            return;
        }
        this._proc = proc;
        this._status('Loading the speech model…');
        // The key goes through the pipe, never on the command line.
        if (deepl) {
            lookupKey(key => {
                if (this._proc !== proc)
                    return;
                proc.get_stdin_pipe().write_bytes_async(new GLib.Bytes(new TextEncoder().encode(`${key}\n`)),
                    GLib.PRIORITY_DEFAULT, null, (pipe, res) => {
                        try {
                            pipe.write_bytes_finish(res);
                        } catch {
                            // the helper is gone
                        }
                    });
            });
        }
        const data = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const next = () => data.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            let line;
            try {
                [line] = data.read_line_finish_utf8(res);
            } catch {
                line = null;
            }
            if (line === null || this._proc !== proc)
                return;
            this._onLine(line);
            next();
        });
        next();
        proc.wait_async(null, () => {
            if (this._proc !== proc)
                return;
            this._proc = null;
            if (!this._failed)
                this._status('Captions stopped.');
        });
    }

    _onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (msg.error) {
            this._failed = true;
            this._status(`Live captions stopped: ${msg.error}.`);
        } else if (msg.status === 'loading') {
            this._status('Loading the speech model…');
        } else if (msg.status === 'slow') {
            this._slow = msg.seconds;
            this._setTitle();
        } else if (msg.status === 'listening') {
            this._failed = false;
            const source = this._settings.get_string('captions-source') === 'mic' ? 'the microphone' : 'the computer\'s sound';
            this._status(`Listening to ${source}…`);
        } else if (typeof msg.text === 'string') {
            if (msg.final) {
                this._lines.push(msg.text);
                this._lines = this._lines.slice(-LINES);
                this._partial = '';
            } else {
                this._partial = msg.text;
            }
            this._show();
        }
    }

    _status(text) {
        if (!this._bar)
            return;
        this._lines = [];
        this._partial = '';
        this._text.text = text;
        this._text.add_style_class_name('dim');
    }

    /** The newest words that fit in LINES lines; older words drop off the top. */
    _show() {
        const words = [...this._lines, this._partial].filter(Boolean).join(' ').split(' ');
        if (!words.join(''))
            return;
        this._text.remove_style_class_name('dim');
        // The label has a fixed height, so measure the text inside it.
        const text = this._text.clutter_text;
        const width = text.width || this._bar.width;
        const fits = n => {
            this._text.text = words.slice(n).join(' ');
            return text.get_preferred_height(width)[1] <= this._lineHeight * LINES + 1;
        };
        // Fewest words dropped so the text fits.
        let lo = 0, hi = words.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (fits(mid))
                hi = mid;
            else
                lo = mid + 1;
        }
        fits(lo);
    }

    _buildBar() {
        if (this._bar)
            return;
        this._bar = new St.BoxLayout({style_class: 'fusion-captions', orientation: Clutter.Orientation.VERTICAL,
            reactive: false});
        // The title row moves the bar; the text below lets clicks through.
        const head = new St.BoxLayout({style_class: 'fusion-captions-head', reactive: true, track_hover: true});
        head.add_child(new St.Icon({style_class: 'fusion-captions-grip', icon_name: 'list-drag-handle-symbolic',
            y_align: Clutter.ActorAlign.CENTER}));
        this._title = new St.Label({style_class: 'fusion-captions-title', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        head.connect('button-press-event', (_a, ev) => ev.get_button() === 1 ? this._beginDrag(ev) : Clutter.EVENT_PROPAGATE);
        head.connect('touch-event', (_a, ev) => ev.type() === Clutter.EventType.TOUCH_BEGIN
            ? this._beginDrag(ev) : Clutter.EVENT_PROPAGATE);
        const close = new St.Button({style_class: 'fusion-captions-close', reactive: true, can_focus: true,
            accessible_name: 'Turn off live captions', child: new St.Icon({icon_name: 'window-close-symbolic'})});
        close.connect('clicked', () => this._stop());
        head.add_child(this._title);
        head.add_child(close);
        this._text = new St.Label({style_class: 'fusion-captions-text', x_expand: true, clip_to_allocation: true});
        this._text.clutter_text.line_wrap = true;
        this._text.clutter_text.ellipsize = 0; // Pango.EllipsizeMode.NONE
        this._bar.add_child(head);
        this._bar.add_child(this._text);
        Main.layoutManager.uiGroup.add_child(this._bar);
        Main.layoutManager.connectObject('monitors-changed', () => this._restyle(), this);
        global.display.connectObject('workareas-changed', () => this._restyle(), this);
        this._restyle();
    }

    _beginDrag(ev) {
        this._endDrag(false);
        const [x, y] = ev.get_coords();
        this._grab = [x - this._bar.x, y - this._bar.y];
        this._dragId = global.stage.connect('captured-event', (_s, e) => {
            const type = e.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                const [ex, ey] = e.get_coords();
                this._moveTo(ex - this._grab[0], ey - this._grab[1]);
                return Clutter.EVENT_STOP;
            }
            if ([Clutter.EventType.BUTTON_RELEASE, Clutter.EventType.TOUCH_END, Clutter.EventType.TOUCH_CANCEL]
                .includes(type)) {
                this._endDrag(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    }

    /** Stop following the pointer; `save` keeps the place (as a share of the free room) for next time. */
    _endDrag(save) {
        if (!this._dragId)
            return;
        global.stage.disconnect(this._dragId);
        this._dragId = 0;
        if (!save)
            return;
        const area = this._area();
        const share = (v, start, room) => room > 0 ? Math.min(1, Math.max(0, (v - start) / room)) : 0.5;
        this._settings.set_value('captions-place', new GLib.Variant('(dd)', [
            share(this._bar.x, area.x, area.width - this._bar.width),
            share(this._bar.y, area.y, area.height - this._bar.height)]));
    }

    _area() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }

    /** Put the bar at x, y, kept inside the work area. */
    _moveTo(x, y) {
        const area = this._area();
        const clamp = (v, start, room) => Math.round(Math.min(Math.max(v, start), start + Math.max(0, room)));
        this._bar.set_position(clamp(x, area.x, area.width - this._bar.width),
            clamp(y, area.y, area.height - this._bar.height));
    }

    /** What the captions are; a model too slow to keep up says so instead. */
    _setTitle() {
        if (!this._bar)
            return;
        if (this._slow) {
            this._title.text = `Captions lag: this model takes ${this._slow} s per update here; pick a smaller model in settings`;
            return;
        }
        const lang = this._settings.get_string('captions-language');
        const translate = this._settings.get_boolean('captions-translate') && lang !== 'en';
        const spoken = LANGUAGES.find(l => l[0] === lang)?.[1];
        this._title.text = translate
            ? `Live captions · ${lang === 'auto' ? 'translated' : `${spoken} translated`} into English`
            : `Live captions${lang === 'auto' ? '' : ` · ${spoken}`}`;
    }

    _restyle() {
        if (!this._bar)
            return;
        const s = this._settings;
        const size = s.get_int('captions-size');
        this._text.style = `font-size: ${size}px;`;
        const opacity = s.get_int('captions-opacity') / 100;
        this._bar.style = `background-color: rgba(28, 28, 28, ${opacity}); box-shadow: 0 4px 16px rgba(0, 0, 0, ${0.4 * opacity});`;
        this._setTitle();
        // Height of one line at this size.
        const probe = new St.Label({style_class: 'fusion-captions-text', style: `font-size: ${size}px;`, text: 'Xg'});
        this._bar.add_child(probe);
        this._lineHeight = probe.get_preferred_height(-1)[1];
        probe.destroy();
        const area = this._area();
        const width = Math.min(Math.round(area.width * 0.7), 1100);
        this._bar.width = width;
        this._text.height = Math.round(this._lineHeight * LINES);
        const [, barHeight] = this._bar.get_preferred_height(width);
        const [fx, fy] = s.get_value('captions-place').deepUnpack();
        if (fx >= 0 && fy >= 0) {
            this._moveTo(area.x + fx * (area.width - width), area.y + fy * (area.height - barHeight));
        } else {
            const gap = Math.round(area.height * 0.04);
            const y = s.get_string('captions-position') === 'top'
                ? area.y + gap
                : area.y + area.height - barHeight - gap;
            this._bar.set_position(area.x + Math.round((area.width - width) / 2), y);
        }
        this._show();
    }

    _stopHelper() {
        const proc = this._proc;
        this._proc = null;
        this._failed = false;
        if (!proc)
            return;
        // Closing stdin stops it; SIGTERM in case it is stuck.
        try {
            proc.get_stdin_pipe()?.close(null);
        } catch {
            // already closed
        }
        proc.send_signal(15);
    }

    _stop() {
        this._ext.state.captionsOn = false;
        this._stopHelper();
        this._endDrag(false);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._bar?.destroy();
        this._bar = null;
    }

    destroy() {
        const on = this._ext.state.captionsOn;
        this._stop();
        // Keep it on across a rebuild; disable() clears the state.
        this._ext.state.captionsOn = on;
        this._settings.disconnectObject(this);
        this._keys.destroy();
        if (current === this)
            current = null;
    }
}
