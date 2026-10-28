// Preferences: the packages lib/linux-pip needs (System page, region PiP
// group). Install runs apt-get as root through pkexec, which asks for the
// password; the same commands are shown to copy into a terminal.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {commandRow} from './prefsSwap.js';

// Same lists as X11_PKGS and WL_PKGS in lib/linux-pip.
const X11_PKGS = ['slop', 'ffmpeg', 'mpv'];
const WL_PKGS = ['slop', 'mpv', 'python3-gi', 'gir1.2-gstreamer-1.0', 'gstreamer1.0-pipewire',
    'gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good', 'x11-xserver-utils'];
// Only these are removed: the rest are shared parts of the desktop.
const OWN_PKGS = ['slop', 'mpv'];
const APT_GET = '/usr/bin/apt-get';

const packages = () => (GLib.getenv('XDG_SESSION_TYPE') === 'x11' ? X11_PKGS : WL_PKGS);

/** The packages of `list` that dpkg does not have installed. */
function missingPackages(list) {
    try {
        const [, out] = GLib.spawn_sync(null, ['dpkg-query', '-W', '-f=${Package} ${db:Status-Status}\n', ...list],
            null, GLib.SpawnFlags.SEARCH_PATH, null);
        const installed = new Set(new TextDecoder().decode(out).split('\n')
            .filter(l => l.endsWith(' installed')).map(l => l.split(' ')[0]));
        return list.filter(p => !installed.has(p));
    } catch (e) {
        return list;
    }
}

/** "Install and remove" for the region PiP packages, with an Install button. */
export function regionPipInstallRow(window) {
    const pkgs = packages();
    const toast = text => window.add_toast(new Adw.Toast({title: text, timeout: 4}));
    const expander = new Adw.ExpanderRow({title: 'Install and remove'});
    const install = new Gtk.Button({label: 'Install', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    expander.add_suffix(install);
    const sync = () => {
        const missing = missingPackages(pkgs);
        expander.subtitle = missing.length
            ? `Missing: ${missing.join(', ')}`
            : 'Everything it needs is installed';
        install.visible = missing.length > 0 && GLib.file_test(APT_GET, GLib.FileTest.IS_EXECUTABLE);
    };
    install.connect('clicked', () => {
        const missing = missingPackages(pkgs);
        install.sensitive = false;
        expander.subtitle = `Installing ${missing.join(', ')}…`;
        let proc;
        try {
            proc = Gio.Subprocess.new(['pkexec', APT_GET, 'install', '-y', ...missing],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            install.sensitive = true;
            sync();
            toast(e.message);
            return;
        }
        proc.communicate_utf8_async(null, null, (_p, res) => {
            let err = '';
            try {
                [, , err] = proc.communicate_utf8_finish(res);
            } catch (e) {
                err = e.message;
            }
            install.sensitive = true;
            sync();
            const code = proc.get_exit_status();
            // pkexec uses 126 / 127 when the password is not given.
            if (code === 126 || code === 127)
                toast('Cancelled');
            else if (code !== 0)
                toast(err.trim().split('\n').filter(l => l.startsWith('E:')).pop() ?? `Failed (code ${code})`);
            else
                toast('Installed');
        });
    });
    sync();
    expander.add_row(commandRow('Install in a terminal',
        `sudo apt-get update && sudo apt-get install -y ${pkgs.join(' ')}`, window));
    expander.add_row(commandRow('Remove (the other packages are shared parts of the desktop, so they stay)',
        `sudo apt-get remove ${OWN_PKGS.join(' ')}`, window));
    return expander;
}
