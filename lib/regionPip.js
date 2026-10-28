// Picture-in-picture of any screen area: lib/linux-pip lets you drag a
// rectangle (on Wayland after the screen-sharing dialog, which is skipped
// once a screen was shared) and shows it live in a small mpv window titled
// "Screen area - Picture in picture", so PipOnTop keeps it above and on
// every workspace like the other PiP windows. Opened by the
// region-pip-hotkey (Super+Alt+P) or the tools menu; the region-pip-*
// settings are read at each start. PiP windows keep running when the
// extension is disabled.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Accelerators} from './accelerators.js';

// The portal's restore token: with it the screen-sharing dialog is skipped.
export const RESTORE_TOKEN = GLib.build_filenamev([GLib.get_user_state_dir(), 'linux-pip', 'restore-token']);

let pending = null; // the launch still choosing its area (one at a time)

const KEY_NAMES = {Return: 'Enter', KP_Enter: 'Enter', Escape: 'Esc', space: 'Space', Primary: 'Ctrl', Control: 'Ctrl'};

/** "<Alt>Return" as "Alt+Enter", letters only (passed to the script), '' when off or odd. */
function accelText(accel) {
    const parts = [...accel.matchAll(/<(\w+)>/g)].map(m => m[1]);
    const key = accel.replace(/<\w+>/g, '');
    if (!key)
        return '';
    const text = [...parts, key.length === 1 ? key.toUpperCase() : key]
        .map(k => KEY_NAMES[k] ?? k).join('+');
    return /^[A-Za-z0-9+]+$/.test(text) ? text : '';
}

/** Read `stream` line by line, calling `onLine` for each until it ends. */
function readLines(stream, onLine) {
    const data = new Gio.DataInputStream({base_stream: stream, close_base_stream: true});
    const next = () => data.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        let line;
        try {
            [line] = data.read_line_finish_utf8(res);
        } catch {
            line = null;
        }
        if (line === null)
            return;
        onLine(line);
        next();
    });
    next();
}

/** What went wrong, from the script's error output, or '' when it was cancelled or fine. */
function failure(lines) {
    const text = lines.join('\n');
    if (/cancel/i.test(text))
        return '';
    if (text.includes('missing required program')) {
        // The list of programs and the install command (never run from here).
        const items = lines.filter(l => /^\s+- /.test(l)).map(l => l.trim().slice(2));
        const cmd = lines.find(l => /^\s+sudo /.test(l))?.trim();
        return `Missing: ${items.join(', ')}. Install them in Fusion Desk settings, System page${cmd ? `, or in a terminal:\n${cmd}` : ''}.`;
    }
    const error = lines.find(l => l.startsWith('linux-pip: error:'));
    if (error)
        return error.replace('linux-pip: error:', '').trim();
    return '';
}

/** Start a picture-in-picture of a screen area (`choose`: ask for the screen again). */
export function startRegionPip(ext, choose = false) {
    if (pending)
        return;
    const s = ext.settings;
    // Fusion keeps the window on top (PipOnTop): T only names the shortcut.
    const ontop = accelText(s.get_string('ontop-hotkey'));
    const argv = ['bash', GLib.build_filenamev([ext.path, 'lib', 'linux-pip']),
        '--fps', `${s.get_int('region-pip-fps')}`, '--size', `${s.get_int('region-pip-size')}`,
        ontop ? `--managed=${ontop}` : '--managed'];
    if (!s.get_boolean('region-pip-cursor'))
        argv.push('--no-cursor');
    if (choose)
        argv.push('--choose');
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        Main.notifyError('Could not start picture-in-picture', e.message);
        return;
    }
    pending = proc;
    const errors = [];
    // "Capturing …" means the window is up: another area may be picked now.
    const onLine = line => {
        if (pending === proc && line.startsWith('Capturing'))
            pending = null;
    };
    readLines(proc.get_stdout_pipe(), onLine);
    readLines(proc.get_stderr_pipe(), line => {
        onLine(line);
        errors.push(line);
    });
    proc.wait_async(null, () => {
        if (pending === proc)
            pending = null;
        if (proc.get_successful())
            return;
        // Let the last error lines arrive.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            const why = failure(errors);
            if (why)
                Main.notifyError('Picture-in-picture of a screen area failed', why);
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class RegionPip {
    constructor(ext) {
        this._keys = new Accelerators();
        this._keys.add(ext.settings.get_string('region-pip-hotkey'), () => startRegionPip(ext));
    }

    destroy() {
        this._keys.destroy();
    }
}
