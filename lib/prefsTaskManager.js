// Preferences: Harbor Task Manager (System page). Open it
// when installed; otherwise Install downloads the newest .deb from its
// GitHub releases and installs it with apt-get as root through pkexec,
// which asks for the password.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

const APP_ID = 'io.github.hafij_deu.Harbor.TaskManager.desktop';
const REPO = 'Hafij-DEU/harbor';
const RELEASES = `https://github.com/${REPO}/releases`;
const APT_GET = '/usr/bin/apt-get';

const appInfo = () => Gio.DesktopAppInfo.new(APP_ID);

/** GET `url`; `done(bytes, error)`. */
function fetch(session, url, done) {
    const msg = Soup.Message.new('GET', url);
    msg.request_headers.append('User-Agent', 'fusion-desk');
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
            const bytes = s.send_and_read_finish(res);
            if (msg.status_code !== 200)
                throw new Error(`HTTP ${msg.status_code}`);
            done(bytes, null);
        } catch (e) {
            done(null, e.message);
        }
    });
}

/** "Task Manager" group: Open when installed, else Install. */
export function taskManagerGroup(window) {
    const g = new Adw.PreferencesGroup({title: 'Task Manager'});
    const toast = text => window.add_toast(new Adw.Toast({title: text, timeout: 5}));
    const row = new Adw.ActionRow({
        title: 'Harbor Task Manager',
        subtitle: 'Apps, processes, performance, Memory Sweep, and swap, zram and zswap settings',
    });
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    g.add(row);
    const session = new Soup.Session({timeout: 60});

    const sync = () => {
        const installed = appInfo() !== null;
        button.label = installed ? 'Open' : 'Install';
        button.css_classes = installed ? [] : ['suggested-action'];
        button.sensitive = true;
    };
    const fail = text => {
        sync();
        toast(text);
    };

    const install = () => {
        button.sensitive = false;
        button.label = 'Downloading…';
        fetch(session, `https://api.github.com/repos/${REPO}/releases/latest`, (bytes, error) => {
            let asset = null;
            try {
                if (error)
                    throw new Error(error);
                const release = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                asset = release.assets?.find(a => a.name.endsWith('_all.deb'));
            } catch (e) {
                asset = null;
            }
            if (!asset) {
                fail('No Task Manager release found; opening the releases page');
                new Gtk.UriLauncher({uri: RELEASES}).launch(window, null, null);
                return;
            }
            fetch(session, asset.browser_download_url, (deb, err) => {
                if (err) {
                    fail(`Download failed: ${err}`);
                    return;
                }
                const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk']);
                GLib.mkdir_with_parents(dir, 0o700);
                const path = GLib.build_filenamev([dir, GLib.path_get_basename(asset.name)]);
                try {
                    GLib.file_set_contents(path, deb.toArray());
                } catch (e) {
                    fail(e.message);
                    return;
                }
                button.label = 'Installing…';
                let proc;
                try {
                    proc = Gio.Subprocess.new(['pkexec', APT_GET, 'install', '-y', path],
                        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
                } catch (e) {
                    fail(e.message);
                    return;
                }
                proc.communicate_utf8_async(null, null, (_p, res) => {
                    let out = '';
                    try {
                        [, , out] = proc.communicate_utf8_finish(res);
                    } catch (e) {
                        out = e.message;
                    }
                    GLib.unlink(path);
                    const code = proc.get_exit_status();
                    // pkexec uses 126 / 127 when the password is not given.
                    if (code === 126 || code === 127)
                        fail('Cancelled');
                    else if (code !== 0)
                        fail(out.trim().split('\n').filter(l => l.startsWith('E:')).pop() ?? `Failed (code ${code})`);
                    else
                        fail('Task Manager is installed');
                });
            });
        });
    };

    button.connect('clicked', () => {
        const info = appInfo();
        if (!info) {
            install();
            return;
        }
        try {
            info.launch([], null);
        } catch (e) {
            toast(e.message);
        }
    });
    sync();
    return g;
}
