// App Hub (github.com/Hafij-DEU/Application-hub) inside the start menu:
// update status of the user's apps, one-click updates/installs and disk space.
// Data comes from the `app-hub list` CLI, cached on disk between sessions.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as W from './widgets.js';

const HUB_DIR = '/usr/lib/app-hub';
const HUB_DESKTOP = 'io.github.hafij_bge.AppHub.desktop';
const HUB_REPO = 'Hafij-DEU/Application-hub';
const STALE_SECONDS = 30 * 60;
const BACKGROUND_CHECK_SECONDS = 60 * 60;
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk', 'app-hub.json']);

export function appHubInstalled() {
    return GLib.find_program_in_path('app-hub') !== null;
}

/** Open App Hub (its .desktop when known, else the `app-hub` command). */
export function openAppHub() {
    const app = Shell.AppSystem.get_default().lookup_app(HUB_DESKTOP);
    if (app) {
        app.activate();
        return;
    }
    try {
        Gio.Subprocess.new(['app-hub'], Gio.SubprocessFlags.NONE);
    } catch (e) {
        Main.notifyError('Could not open App Hub', e.message);
    }
}

function httpGet(url, accept, done, method = 'GET') {
    const session = new Soup.Session({user_agent: 'fusion-desk', timeout: 120});
    const msg = Soup.Message.new(method, url);
    if (accept)
        msg.request_headers.append('Accept', accept);
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
        try {
            const bytes = sess.send_and_read_finish(res);
            if (msg.get_status() !== Soup.Status.OK)
                throw new Error(`HTTP ${msg.get_status()} for ${url}`);
            done(null, bytes, msg.get_uri().to_string());
        } catch (e) {
            done(e, null, null);
        }
    });
}

/**
 * Latest release as {tag, asset: {name, url, digest}}. Uses the GitHub API, or,
 * when that is rate-limited, the /releases/latest redirect (no API quota).
 */
function latestRelease(done) {
    httpGet(`https://api.github.com/repos/${HUB_REPO}/releases/latest`, 'application/vnd.github+json', (err, bytes) => {
        if (!err) {
            try {
                const release = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                const assets = release.assets ?? [];
                const a = assets.find(x => x.name.endsWith('_all.deb')) ?? assets.find(x => x.name.endsWith('.deb'));
                if (a) {
                    done(null, {tag: release.tag_name ?? '', asset: {name: a.name, url: a.browser_download_url, digest: a.digest ?? ''}});
                    return;
                }
            } catch {
                // Fall through to the redirect.
            }
        }
        httpGet(`https://github.com/${HUB_REPO}/releases/latest`, null, (err2, _b, finalUrl) => {
            const tag = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl ?? '')?.[1];
            if (err2 || !tag) {
                done(err2 ?? err ?? new Error('No release found'));
                return;
            }
            const name = `app-hub_${tag.replace(/^v/, '')}_all.deb`;
            done(null, {tag, asset: {name, url: `https://github.com/${HUB_REPO}/releases/download/${tag}/${name}`, digest: ''}});
        }, 'HEAD');
    });
}

function readJson(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

/** id -> {name, summary, desktop, icon} from App Hub's catalog + library files. */
function loadCatalog() {
    const out = {};
    const files = [
        `${HUB_DIR}/catalog.json`,
        `${HUB_DIR}/library-default.json`,
        GLib.build_filenamev([GLib.get_user_config_dir(), 'app-hub', 'library.json']),
    ];
    for (const f of files) {
        for (const a of readJson(f)?.apps ?? []) {
            if (a?.id)
                out[a.id] = {name: a.name ?? a.id, summary: a.summary ?? '', desktop: a.desktop ?? '', icon: a.icon ?? `${a.id}.png`};
        }
    }
    return out;
}

/** Parse `app-hub list --json` (App Hub 1.5.2+); null if it is not that output. */
function parseJson(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!Array.isArray(data?.apps))
        return null;
    return data.apps.filter(a => a?.id).map(a => ({
        id: a.id,
        name: a.name || a.id,
        summary: a.summary ?? '',
        desktop: a.desktop ?? '',
        icon: a.icon || `${a.id}.png`,
        installed: a.installed ?? '',
        latest: a.latest ?? '',
        status: a.status ?? '',
    }));
}

/** Parse `app-hub list` (older App Hub): header row, then columns separated by 2+ spaces. */
function parseList(text) {
    const rows = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (!rows.length || !rows[0].startsWith('APP'))
        return null;
    return rows.slice(1).map(l => {
        const [id, installed, latest, ...rest] = l.split(/\s{2,}/);
        return {id, installed: installed === '-' ? '' : installed, latest: latest === '-' ? '' : latest, status: rest.join(' ')};
    }).filter(r => r.id);
}

/** Shared state for every menu (main panel, secondary panels, runner). */
class Store {
    constructor() {
        this.apps = [];
        this.checkedAt = 0;
        this.error = '';
        this.busy = new Set(); // ids being updated/installed; '*' = update everything
        this.checking = false;
        this.hubState = ''; // '', 'downloading', 'installing' (getting App Hub itself)
        this._listeners = new Set();
        const cached = readJson(CACHE);
        if (Array.isArray(cached?.apps)) {
            this.apps = cached.apps;
            this.checkedAt = cached.checkedAt ?? 0;
        }
    }

    subscribe(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _emit() {
        for (const cb of [...this._listeners]) {
            try {
                cb();
            } catch (e) {
                console.error('Fusion Desk: App Hub listener failed', e);
            }
        }
    }

    get updates() {
        return this.apps.filter(a => a.status === 'update available');
    }

    get stale() {
        return GLib.get_real_time() / 1e6 - this.checkedAt > STALE_SECONDS;
    }

    refresh() {
        if (this.checking || !appHubInstalled())
            return;
        this.checking = true;
        this._emit();
        // JSON first; App Hub before 1.5.2 rejects --json, then read the text table.
        this._run(['app-hub', 'list', '--json'], (ok, stdout, stderr) => {
            const apps = ok ? parseJson(stdout) : null;
            if (apps || (!ok && !stderr.includes('unrecognized arguments'))) {
                this._finishRefresh(apps, stderr);
                return;
            }
            this._run(['app-hub', 'list'], (ok2, stdout2, stderr2) => {
                const rows = ok2 ? parseList(stdout2) : null;
                const catalog = rows ? loadCatalog() : {};
                this._finishRefresh(rows?.map(r => ({...r, ...(catalog[r.id] ?? {name: r.id, summary: '', desktop: '', icon: `${r.id}.png`})})), stderr2);
            });
        });
    }

    _finishRefresh(apps, stderr) {
        this.checking = false;
        if (apps) {
            this.apps = apps;
            this.checkedAt = Math.floor(GLib.get_real_time() / 1e6);
            this.error = '';
            this._save();
        } else {
            this.error = (stderr || 'App Hub did not answer').trim().split('\n').pop();
        }
        this._emit();
    }

    /** Run an App Hub action (asks for the password through polkit), then re-check. */
    action(key, argv) {
        if (this.busy.has(key))
            return;
        this.busy.add(key);
        this._emit();
        this._run(argv, (ok, _out, stderr) => {
            this.busy.delete(key);
            if (!ok && stderr)
                this.error = stderr.trim().split('\n').pop();
            this._emit();
            this.refresh();
        });
    }

    /**
     * Open App Hub; when it is not installed, download the latest .deb from its
     * GitHub releases, check its SHA-256, install it (polkit prompt) and open it.
     */
    getAppHub() {
        if (appHubInstalled()) {
            openAppHub();
            return;
        }
        if (this.hubState)
            return;
        const fail = e => {
            this.hubState = '';
            this.error = e.message;
            this._emit();
            Main.notifyError('Could not install App Hub', e.message);
        };
        this.hubState = 'downloading';
        this.error = '';
        this._emit();
        latestRelease((err, release) => {
            if (err)
                return fail(err);
            const asset = release.asset;
            httpGet(asset.url, null, (err2, deb) => {
                if (err2)
                    return fail(err2);
                const want = asset.digest.replace(/^sha256:/, '');
                const got = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, deb);
                if (want && want !== got)
                    return fail(new Error(`Checksum mismatch for ${asset.name}`));
                const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk']);
                const path = GLib.build_filenamev([dir, asset.name.replace(/[^\w.+-]/g, '_')]);
                try {
                    GLib.mkdir_with_parents(dir, 0o700);
                    GLib.file_set_contents(path, deb.toArray());
                } catch (e) {
                    return fail(e);
                }
                this.hubState = 'installing';
                this._emit();
                this._run(['pkexec', 'apt-get', 'install', '-y', path], (ok, _out, stderr) => {
                    GLib.unlink(path);
                    if (!ok || !appHubInstalled())
                        return fail(new Error(stderr.trim().split('\n').pop() || 'Installation was cancelled'));
                    this.hubState = '';
                    this._emit();
                    Main.notify('App Hub installed', `Version ${release.tag}`.trim());
                    openAppHub();
                    this.refresh();
                });
            });
        });
    }

    _run(argv, done) {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    done(p.get_successful(), out ?? '', err ?? '');
                } catch (e) {
                    done(false, '', e.message);
                }
            });
        } catch (e) {
            done(false, '', e.message);
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE), 0o700);
            GLib.file_set_contents(CACHE, JSON.stringify({checkedAt: this.checkedAt, apps: this.apps}));
        } catch {
            // Cache is optional.
        }
    }
}

let store = null;
// App Hub's icon shipped with Fusion Desk, for when App Hub is not installed yet.
let bundledIcon = 'system-software-install-symbolic';
export function setBundledIcon(path) {
    bundledIcon = path;
}

export function getStore() {
    store ??= new Store();
    return store;
}

function ago(seconds) {
    if (!seconds)
        return 'never checked';
    const d = Math.floor(GLib.get_real_time() / 1e6) - seconds;
    if (d < 60)
        return 'checked just now';
    if (d < 3600)
        return `checked ${Math.floor(d / 60)} min ago`;
    if (d < 86400)
        return `checked ${Math.floor(d / 3600)} h ago`;
    return `checked ${Math.floor(d / 86400)} d ago`;
}

function diskInfo() {
    try {
        const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::free,filesystem::size', null);
        return {free: info.get_attribute_uint64('filesystem::free'), size: info.get_attribute_uint64('filesystem::size')};
    } catch {
        return null;
    }
}

const gb = b => `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB`;

/** Icon for an App Hub app: its installed .desktop icon, else App Hub's bundled png. */
function hubIcon(app, size) {
    const shellApp = app.desktop ? Shell.AppSystem.get_default().lookup_app(app.desktop) : null;
    if (shellApp)
        return shellApp.create_icon_texture(size);
    const path = app.icon?.startsWith('/') ? app.icon : `${HUB_DIR}/icons/${app.icon}`;
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return new St.Icon({gicon: Gio.icon_new_for_string(path), icon_size: size});
    return new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: size});
}

/** App Hub icon with an update-count badge (for rails, footers and tabs). */
export function hubBadgeIcon(size = 18) {
    const hubApp = Shell.AppSystem.get_default().lookup_app(HUB_DESKTOP);
    const icon = hubApp ? hubApp.create_icon_texture(size)
        : new St.Icon({gicon: Gio.icon_new_for_string(bundledIcon), icon_size: size, fallback_icon_name: 'system-software-install-symbolic'});
    const bin = new St.Widget({layout_manager: new Clutter.BinLayout()});
    bin.add_child(icon);
    const badge = new St.Label({style_class: 'fusion-hub-badge', visible: false,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
    bin.add_child(badge);
    const s = getStore();
    const sync = () => {
        const n = s.updates.length;
        badge.visible = n > 0;
        badge.text = String(n);
    };
    sync();
    const unsub = s.subscribe(sync);
    bin.connect('destroy', unsub);
    return bin;
}

/** The App Hub panel shown inside a menu layout. */
/** Panel icon: opens App Hub, or downloads and installs it first. */
export class AppHubButton {
    constructor(ext) {
        setBundledIcon(GLib.build_filenamev([ext.path, 'icons', 'app-hub.png']));
        this._store = getStore();
        this.actor = new St.Button({
            style_class: 'panel-button fusion-icon-button fusion-apphub-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'App Hub',
            child: hubBadgeIcon(18),
        });
        this.actor.connect('clicked', () => this._store.getAppHub());
        this._unsub = this._store.subscribe(() => {
            this.actor.opacity = this._store.hubState ? 140 : 255;
        });
        // Keep the update badge current.
        if (appHubInstalled() && this._store.stale)
            this._store.refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, BACKGROUND_CHECK_SECONDS, () => {
            if (appHubInstalled())
                this._store.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        GLib.source_remove(this._timerId);
        this._unsub();
        this.actor.destroy();
    }
}

export class AppHubPanel {
    constructor(ctx, {scroll = true} = {}) {
        this.ctx = ctx;
        this._store = getStore();
        this._showAvailable = false;
        this.actor = W.vbox('fusion-hub', {x_expand: true, y_expand: true});

        const header = W.hbox('fusion-hub-header');
        header.add_child(hubBadgeIcon(32));
        const titles = W.vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(W.label('App Hub', 'fusion-hub-title'));
        this._status = W.label('', 'fusion-sm-item-desc');
        titles.add_child(this._status);
        header.add_child(titles);
        this._refreshButton = W.iconButton(ctx, 'view-refresh-symbolic', 'Check for updates', () => this._store.refresh(), {close: false});
        header.add_child(this._refreshButton);
        header.add_child(W.iconButton(ctx, 'external-link-symbolic', 'Open App Hub', () => this._openHub()));
        this.actor.add_child(header);

        this._list = W.vbox('fusion-hub-list');
        this.actor.add_child(scroll ? W.scrollView(this._list) : this._list);

        this._disk = W.vbox('fusion-hub-disk');
        this.actor.add_child(this._disk);

        this._unsub = this._store.subscribe(() => this._render());
        this.actor.connect('destroy', () => this._unsub());
        this._render();
        if (appHubInstalled() && (this._store.stale || !this._store.apps.length))
            this._store.refresh();
    }

    _openHub() {
        this.ctx.close();
        this._store.getAppHub();
    }

    _launch(app) {
        const shellApp = app.desktop ? Shell.AppSystem.get_default().lookup_app(app.desktop) : null;
        this.ctx.close();
        if (shellApp)
            shellApp.activate();
        else
            this.ctx.model.runCommand(`app-hub open ${app.id}`);
    }

    _actionButton(label, key, argv, style = 'fusion-hub-action') {
        const busy = this._store.busy.has(key) || this._store.busy.has('*');
        const b = new St.Button({style_class: style, label: busy ? 'Working…' : label, can_focus: true,
            track_hover: true, reactive: !busy, y_align: Clutter.ActorAlign.CENTER});
        b.connect('clicked', () => this._store.action(key, argv));
        return b;
    }

    _row(app, suffix, subtitle) {
        const row = new St.Button({style_class: 'fusion-sm-item', can_focus: true, track_hover: true, x_expand: true,
            accessible_name: app.name});
        const box = W.hbox('fusion-sm-item-box', {x_expand: true});
        box.add_child(hubIcon(app, this.ctx.listSize));
        const text = W.vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(W.label(app.name, 'fusion-sm-item-name'));
        text.add_child(W.label(subtitle, 'fusion-sm-item-desc'));
        box.add_child(text);
        if (suffix)
            box.add_child(suffix);
        row.set_child(box);
        if (app.installed)
            row.connect('clicked', () => this._launch(app));
        return row;
    }

    _renderMissing() {
        const s = this._store;
        this._refreshButton.hide();
        this._status.text = {downloading: 'Downloading the latest release…', installing: 'Installing… (enter your password)'}[s.hubState] ??
            (s.error || 'Not installed');
        this._list.destroy_all_children();
        this._disk.destroy_all_children();
        const box = W.vbox('fusion-hub-missing', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, y_expand: true});
        box.add_child(W.label('Install, update and remove your apps from GitHub, deb, snap, flatpak and AppImage.',
            'fusion-sm-item-desc', {x_align: Clutter.ActorAlign.CENTER}));
        const b = new St.Button({style_class: 'fusion-hub-action fusion-hub-primary', can_focus: true, track_hover: true,
            label: s.hubState ? 'Working…' : 'Get App Hub', reactive: !s.hubState, x_align: Clutter.ActorAlign.CENTER});
        b.connect('clicked', () => s.getAppHub());
        box.add_child(b);
        this._list.add_child(box);
    }

    _render() {
        const s = this._store;
        if (!appHubInstalled()) {
            this._renderMissing();
            return;
        }
        this._refreshButton.show();
        const updates = s.updates;
        const installed = s.apps.filter(a => a.installed && a.status !== 'update available');
        const available = s.apps.filter(a => !a.installed && a.status === 'not installed');

        if (s.checking)
            this._status.text = 'Checking for updates…';
        else if (s.error)
            this._status.text = s.error;
        else if (updates.length)
            this._status.text = `${updates.length} update${updates.length > 1 ? 's' : ''} available · ${ago(s.checkedAt)}`;
        else
            this._status.text = s.apps.length ? `Everything is up to date · ${ago(s.checkedAt)}` : ago(s.checkedAt);

        this._list.destroy_all_children();
        if (updates.length) {
            this._list.add_child(W.heading('Updates', null));
            const all = this._actionButton('Update everything', '*', ['app-hub', 'update-all', '-y'], 'fusion-hub-action fusion-hub-primary');
            all.x_align = Clutter.ActorAlign.END;
            this._list.get_last_child().add_child(all);
            for (const a of updates)
                this._list.add_child(this._row(a, this._actionButton('Update', a.id, ['app-hub', 'update', a.id]), `${a.installed} → ${a.latest}`));
        }
        if (installed.length) {
            this._list.add_child(W.heading('My apps'));
            for (const a of installed)
                this._list.add_child(this._row(a, null, a.status === 'up to date' ? `${a.installed} · up to date` : `${a.installed} · ${a.status}`));
        }
        if (available.length) {
            const toggle = {label: this._showAvailable ? 'Hide' : `Show ${available.length}`, cb: () => {
                this._showAvailable = !this._showAvailable;
                this._render();
            }};
            this._list.add_child(W.heading('Available to install', toggle));
            if (this._showAvailable) {
                for (const a of available)
                    this._list.add_child(this._row(a, this._actionButton('Install', a.id, ['app-hub', 'install', a.id]), `${a.latest} · ${a.summary}`));
            }
        }
        if (!s.apps.length && !s.checking)
            this._list.add_child(W.emptyLabel('No data yet: press ↻ to check.'));

        // Disk space
        this._disk.destroy_all_children();
        const d = diskInfo();
        if (d?.size) {
            const used = 1 - d.free / d.size;
            const line = W.hbox('fusion-hub-disk-line');
            line.add_child(W.label('Disk', 'fusion-sm-item-name', {x_expand: true}));
            line.add_child(W.label(`${gb(d.free)} free of ${gb(d.size)}`, 'fusion-sm-item-desc'));
            const free = new St.Button({style_class: 'fusion-sm-pill', label: 'Free up space', can_focus: true});
            free.connect('clicked', () => this._openHub());
            line.add_child(free);
            this._disk.add_child(line);
            const bar = new St.BoxLayout({style_class: 'fusion-hub-bar', x_expand: true});
            const fill = new St.Widget({style_class: `fusion-hub-bar-fill${used > 0.9 ? ' full' : ''}`});
            bar.add_child(fill);
            // Size the fill after layout, not during the allocation that changed the width.
            bar.connect('notify::width', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (fill.get_parent())
                        fill.set_width(Math.round(bar.width * used));
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._disk.add_child(bar);
        }
    }

    destroy() {
        this.actor.destroy();
    }
}
