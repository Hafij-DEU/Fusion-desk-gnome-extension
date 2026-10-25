// Charge limit managed by Fusion Desk. Laptops with an adjustable limit
// (charge_control_end_threshold) get it set once. Others only offer a fixed
// "battery protection" mode (charge_types Long_Life, e.g. IdeaPads at about
// 80%): Fusion charges normally up to the chosen level, then switches to
// protection so charging stops, and back below the level minus a small gap.
// Writes go through the charge helper (lib/charge/), which the one-time
// setup in Settings installs with a polkit rule, so no password is asked.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HELPER = '/usr/local/libexec/fusion-desk-charge';
const POLICY = '/usr/share/polkit-1/actions/io.github.hafij-deu.fusion-desk.charge.policy';
const SUPPLY = '/sys/class/power_supply';
// Start charging again this many percent below the limit.
const GAP = 3;
const CHECK_S = 60;

/** Whether the one-time setup (helper + polkit rule) is installed. */
export function helperInstalled() {
    return GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE) && GLib.file_test(POLICY, GLib.FileTest.EXISTS);
}

/** Run the helper (`mode X` / `limit N`); `done(ok)` afterwards. */
export function runHelper(args, done = () => {}) {
    try {
        const proc = Gio.Subprocess.new(['pkexec', HELPER, ...args.map(String)],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, res) => {
            try {
                done(p.wait_check_finish(res));
            } catch (e) {
                done(false);
            }
        });
    } catch (e) {
        done(false);
    }
}

function read(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]).trim();
    } catch (e) {
        return null;
    }
}

/** The laptop battery's folder in /sys (BAT0, BAT1, ...), or null. */
function batteryDir() {
    try {
        const en = Gio.File.new_for_path(SUPPLY).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = en.next_file(null));) {
            if (/^BAT\w*$/.test(info.get_name()))
                return `${SUPPLY}/${info.get_name()}`;
        }
    } catch (e) {
        // No power supplies.
    }
    return null;
}

/** {values, current} of charge_types, or null. */
function chargeTypes(dir) {
    const text = dir ? read(`${dir}/charge_types`) : null;
    if (!text)
        return null;
    const tokens = text.split(/\s+/);
    return {
        values: tokens.map(t => t.replace(/[[\]]/g, '')),
        current: tokens.find(t => t.startsWith('['))?.replace(/[[\]]/g, '') ?? null,
    };
}

export class ChargeLimit {
    constructor(ext) {
        this._settings = ext.settings;
        this._limit = this._settings.get_int('charge-limit-percent');
        this._dir = batteryDir();
        if (!this._dir || !helperInstalled())
            return;
        if (GLib.file_test(`${this._dir}/charge_control_end_threshold`, GLib.FileTest.EXISTS)) {
            // The firmware keeps the limit itself.
            this._threshold = true;
            runHelper(['limit', this._limit]);
            return;
        }
        if (!chargeTypes(this._dir)?.values.includes('Long_Life'))
            return;
        this._check();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, CHECK_S, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Charge normally below the limit, protection mode (no charging) at it. */
    _check() {
        if (this._busy)
            return;
        const level = Number(read(`${this._dir}/capacity`));
        const types = chargeTypes(this._dir);
        if (!Number.isFinite(level) || !types)
            return;
        let want = null;
        if (level >= this._limit)
            want = 'Long_Life';
        else if (level <= this._limit - GAP)
            want = types.values.includes('Standard') ? 'Standard' : types.values.find(v => v !== 'Long_Life');
        if (!want || want === types.current)
            return;
        this._busy = true;
        runHelper(['mode', want], () => {
            this._busy = false;
        });
    }

    destroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        // Turning the setting off goes back to full charging: the adjustable
        // limit to 100, or protection mode (which this module switched on) off.
        if (this._settings.get_boolean('charge-limit'))
            return;
        if (this._threshold) {
            runHelper(['limit', 100]);
        } else if (this._dir && helperInstalled()) {
            const types = chargeTypes(this._dir);
            if (types?.current === 'Long_Life')
                runHelper(['mode', types.values.includes('Standard') ? 'Standard' : types.values.find(v => v !== 'Long_Life')]);
        }
    }
}
