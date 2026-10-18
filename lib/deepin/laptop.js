// Laptop switches (battery conservation, camera, Fn lock, USB charging) from
// the kernel's laptop driver in /sys. Reading is free; changing them needs
// administrator rights, so writes go through pkexec (polkit asks for the
// password) unless the file is already writable.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DRIVER_DIRS = ['/sys/bus/platform/drivers/ideapad_acpi'];
const N_ = s => s;

/** [file, label, icon] */
export const SWITCHES = [
    ['conservation_mode', N_('Battery care'), 'battery-good-symbolic'],
    ['camera_power', N_('Camera'), 'camera-web-symbolic'],
    ['fn_lock', N_('Fn lock'), 'input-keyboard-symbolic'],
    ['usb_charging', N_('USB charging'), 'media-removable-symbolic'],
];

/** Device folder of a supported laptop driver, or null. */
export function laptopDevice() {
    for (const dir of DRIVER_DIRS) {
        try {
            const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = en.next_file(null));) {
                const path = GLib.build_filenamev([dir, info.get_name()]);
                if (SWITCHES.some(([f]) => GLib.file_test(GLib.build_filenamev([path, f]), GLib.FileTest.EXISTS)))
                    return path;
            }
        } catch (e) {
            // Driver not loaded.
        }
    }
    return null;
}

/** Current value of a switch (true / false), or null when unreadable. */
export function readSwitch(device, file) {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([device, file]));
        return new TextDecoder().decode(bytes).trim() === '1';
    } catch (e) {
        return null;
    }
}

/**
 * Set a switch; `done(ok, rejected)` runs when the write finished.
 * `rejected` means the driver refused the value (not a cancelled password
 * prompt); some laptops list a switch their firmware does not support.
 */
export function writeSwitch(device, file, on, done) {
    const path = GLib.build_filenamev([device, file]);
    const value = on ? '1\n' : '0\n';
    if (GLib.access(path, 2 /* W_OK */) === 0) {
        try {
            GLib.file_set_contents(path, value);
            done(true, false);
        } catch (e) {
            done(false, true);
        }
        return;
    }
    try {
        const proc = Gio.Subprocess.new(['pkexec', 'tee', path],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(value, null, (pr, res) => {
            try {
                pr.communicate_utf8_finish(res);
                // tee exits with 1 when the write failed; pkexec uses 126 / 127
                // for a cancelled or refused password prompt.
                done(pr.get_successful(), pr.get_exit_status() === 1);
            } catch (e) {
                done(false, false);
            }
        });
    } catch (e) {
        done(false, false);
    }
}
