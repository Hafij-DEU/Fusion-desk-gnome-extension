// Start menu data: apps, categories, pinned apps, frequent apps, recent files,
// places, power actions and search. No widgets here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {readText} from '../files.js';

export const CATEGORIES = [
    {name: 'Accessories', icon: 'applications-utilities-symbolic', match: ['Utility', 'Accessibility', 'Core']},
    {name: 'Development', icon: 'applications-engineering-symbolic', match: ['Development', 'IDE']},
    {name: 'Education', icon: 'applications-science-symbolic', match: ['Education', 'Science']},
    {name: 'Games', icon: 'applications-games-symbolic', match: ['Game']},
    {name: 'Graphics', icon: 'applications-graphics-symbolic', match: ['Graphics']},
    {name: 'Internet', icon: 'web-browser-symbolic', match: ['Network', 'WebBrowser', 'Email', 'Chat']},
    {name: 'Multimedia', icon: 'applications-multimedia-symbolic', match: ['AudioVideo', 'Audio', 'Video']},
    {name: 'Office', icon: 'applications-office-symbolic', match: ['Office']},
    {name: 'System', icon: 'applications-system-symbolic', match: ['System', 'Settings', 'Monitor']},
    {name: 'Other', icon: 'applications-other-symbolic', match: []},
];

const PLACES = [
    ['Home', 'user-home-symbolic', null],
    ['Documents', 'folder-documents-symbolic', GLib.UserDirectory.DIRECTORY_DOCUMENTS],
    ['Downloads', 'folder-download-symbolic', GLib.UserDirectory.DIRECTORY_DOWNLOAD],
    ['Music', 'folder-music-symbolic', GLib.UserDirectory.DIRECTORY_MUSIC],
    ['Pictures', 'folder-pictures-symbolic', GLib.UserDirectory.DIRECTORY_PICTURES],
    ['Videos', 'folder-videos-symbolic', GLib.UserDirectory.DIRECTORY_VIDEOS],
];

const SHORTCUTS = [
    ['Settings', ['org.gnome.Settings.desktop', 'gnome-control-center.desktop']],
    ['Software', ['org.gnome.Software.desktop', 'snap-store_snap-store.desktop', 'io.github.hafij_bge.AppHub.desktop', 'io.github.hafij.apphub.desktop']],
    ['Terminal', ['org.gnome.Ptyxis.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Console.desktop']],
    ['Files', ['org.gnome.Nautilus.desktop']],
    ['Tweaks', ['org.gnome.tweaks.desktop']],
    ['App Hub', ['io.github.hafij_bge.AppHub.desktop']],
];

// id, label, icon, SystemActions method, availability property
export const POWER_ACTIONS = [
    ['lock', 'Lock', 'system-lock-screen-symbolic', 'activateLockScreen', 'can-lock-screen'],
    ['switch-user', 'Switch User', 'system-switch-user-symbolic', 'activateSwitchUser', 'can-switch-user'],
    ['logout', 'Log Out', 'system-log-out-symbolic', 'activateLogout', 'can-logout'],
    ['suspend', 'Suspend', 'media-playback-pause-symbolic', 'activateSuspend', 'can-suspend'],
    ['restart', 'Restart', 'system-reboot-symbolic', 'activateRestart', 'can-restart'],
    ['poweroff', 'Power Off', 'system-shutdown-symbolic', 'activatePowerOff', 'can-power-off'],
];

export function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError('Could not open', e.message);
    }
}

/**
 * Evaluate a plain arithmetic expression (+ - * / % ^, parentheses, decimals)
 * with a small parser instead of eval. Returns null if it is not one.
 */
export function calculate(text) {
    const src = text.replace(/^=/, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.').replace(/\s+/g, '');
    if (!/^[\d.+\-*/%^()]+$/.test(src) || !/\d/.test(src) || !/[+\-*/%^]/.test(src))
        return null;
    let i = 0;
    const peek = () => src[i];
    const fail = () => {
        throw new Error('syntax');
    };
    // expr := term (('+'|'-') term)* ; term := power (('*'|'/'|'%') power)*
    // power := unary ('^' power)? ; unary := '-' unary | '+' unary | atom
    const expr = () => {
        let v = term();
        while (peek() === '+' || peek() === '-')
            v = src[i++] === '+' ? v + term() : v - term();
        return v;
    };
    const term = () => {
        let v = power();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = src[i++];
            const r = power();
            v = op === '*' ? v * r : op === '/' ? v / r : v % r;
        }
        return v;
    };
    const power = () => {
        const b = unary();
        if (peek() === '^') {
            i++;
            return b ** power();
        }
        return b;
    };
    const unary = () => {
        if (peek() === '-') {
            i++;
            return -unary();
        }
        if (peek() === '+') {
            i++;
            return unary();
        }
        return atom();
    };
    const atom = () => {
        if (peek() === '(') {
            i++;
            const v = expr();
            if (src[i++] !== ')')
                fail();
            return v;
        }
        const m = /^\d*\.?\d+|^\d+\./.exec(src.slice(i));
        if (!m)
            fail();
        i += m[0].length;
        return Number(m[0]);
    };
    try {
        const value = expr();
        if (i !== src.length || !Number.isFinite(value))
            return null;
        return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
    } catch {
        return null;
    }
}

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

/** Recently used files (newest first), read without blocking the shell. */
const RECENT_APPS_KEPT = 20;
const NEW_APP_DAYS = 7;

export async function readRecentFiles(limit = 20) {
    const text = await readText(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    if (!text)
        return [];
    const items = [];
    for (const m of text.matchAll(/<bookmark\b([^>]*)>/g)) {
        const href = /href="([^"]*)"/.exec(m[1])?.[1];
        const modified = /modified="([^"]*)"/.exec(m[1])?.[1] ?? '';
        if (!href || !href.startsWith('file://'))
            continue;
        items.push({uri: href.replace(/&amp;/g, '&'), modified});
    }
    items.sort((a, b) => b.modified.localeCompare(a.modified));

    // Look up name and icon; files that no longer exist drop out.
    const found = await Promise.all(items.slice(0, limit * 2).map(async item => {
        const file = Gio.File.new_for_uri(item.uri);
        try {
            const info = await file.query_info_async('standard::display-name,standard::icon', 0, GLib.PRIORITY_DEFAULT, null);
            return {uri: item.uri, name: info.get_display_name(), gicon: info.get_icon(), path: file.get_path(),
                modified: item.modified};
        } catch {
            return null;
        }
    }));
    return found.filter(Boolean).slice(0, limit);
}

/** GTK file-manager bookmarks: [{name, uri}]. */
async function readBookmarks() {
    const text = await readText(GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'bookmarks']));
    if (!text)
        return [];
    return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const [uri, ...label] = line.split(' ');
        return {uri, name: label.join(' ') || Gio.File.new_for_uri(uri).get_basename() || uri};
    });
}

export class MenuModel {
    constructor(ext) {
        this.settings = ext.settings;
        this._appSys = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._usage = Shell.AppUsage.get_default();
        this._dirty = true;
        this._pinnedListeners = new Set();

        this._appSys.connectObject('installed-changed', () => {
            this._dirty = true;
            this._noteInstalled();
        }, this);

        // Recently opened apps: an app that starts running is moved to the
        // front of menu-recent-apps (apps already running now do not count).
        this._running = new Set(this._appSys.get_running().map(a => a.get_id()));
        this._appSys.connectObject('app-state-changed', (_s, app) => this._onAppState(app), this);
        this._noteInstalled();
        const pinnedChanged = () => this._pinnedListeners.forEach(cb => cb());
        this._favorites.connectObject('changed', pinnedChanged, this);
        this.settings.connectObject('changed::menu-pinned', pinnedChanged,
            'changed::menu-pinned-source', pinnedChanged, this);
    }

    _load() {
        if (!this._dirty)
            return;
        this._dirty = false;
        const apps = [];
        for (const info of this._appSys.get_installed()) {
            if (!info.should_show())
                continue;
            const app = this._appSys.lookup_app(info.get_id());
            if (app)
                apps.push(app);
        }
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));
        this._apps = apps;
        this._byCategory = new Map(CATEGORIES.map(c => [c.name, []]));
        for (const app of apps) {
            const cats = (app.app_info.get_categories() ?? '').split(';');
            const cat = CATEGORIES.find(c => c.match.some(m => cats.includes(m))) ?? CATEGORIES.at(-1);
            this._byCategory.get(cat.name).push(app);
        }
    }

    get apps() {
        this._load();
        return this._apps;
    }

    /** Non-empty categories as [{name, icon, apps}]. */
    categories() {
        this._load();
        return CATEGORIES.map(c => ({...c, apps: this._byCategory.get(c.name)}))
            .filter(c => c.apps.length);
    }

    lookup(id) {
        return this._appSys.lookup_app(id);
    }

    // ---- Pinned ---------------------------------------------------------

    get ownPinned() {
        return this.settings.get_string('menu-pinned-source') === 'OWN';
    }

    pinnedApps() {
        if (!this.ownPinned)
            return this._favorites.getFavorites();
        return this.settings.get_strv('menu-pinned').map(id => this.lookup(id)).filter(Boolean);
    }

    isPinned(app) {
        const id = app.get_id();
        return this.ownPinned
            ? this.settings.get_strv('menu-pinned').includes(id)
            : this._favorites.isFavorite(id);
    }

    togglePin(app) {
        const id = app.get_id();
        if (!this.ownPinned) {
            this.toggleTaskbarPin(app);
            return;
        }
        const list = this.settings.get_strv('menu-pinned');
        const i = list.indexOf(id);
        if (i >= 0)
            list.splice(i, 1);
        else
            list.push(id);
        this.settings.set_strv('menu-pinned', list);
    }

    /** Move a pinned app by `step` places (own list only). */
    movePin(app, step) {
        if (!this.ownPinned)
            return;
        const list = this.settings.get_strv('menu-pinned');
        const i = list.indexOf(app.get_id());
        const j = i + step;
        if (i < 0 || j < 0 || j >= list.length)
            return;
        [list[i], list[j]] = [list[j], list[i]];
        this.settings.set_strv('menu-pinned', list);
    }

    isTaskbarPinned(app) {
        return this._favorites.isFavorite(app.get_id());
    }

    toggleTaskbarPin(app) {
        const id = app.get_id();
        if (this._favorites.isFavorite(id))
            this._favorites.removeFavorite(id);
        else
            this._favorites.addFavorite(id);
    }

    onPinnedChanged(cb) {
        this._pinnedListeners.add(cb);
        return () => this._pinnedListeners.delete(cb);
    }

    // ---- Other lists ------------------------------------------------------

    _onAppState(app) {
        const id = app.get_id();
        if (app.state === Shell.AppState.STOPPED) {
            this._running.delete(id);
            return;
        }
        if (this._running.has(id) || !app.app_info?.should_show())
            return;
        this._running.add(id);
        const list = this.settings.get_strv('menu-recent-apps').filter(x => x !== id);
        list.unshift(id);
        this.settings.set_strv('menu-recent-apps', list.slice(0, RECENT_APPS_KEPT));
    }

    /**
     * Newly installed apps: ids that were not in menu-known-apps. The first
     * run only records what is installed (nothing counts as new then).
     */
    _noteInstalled() {
        const ids = this._appSys.get_installed().filter(i => i.should_show()).map(i => i.get_id());
        const known = this.settings.get_strv('menu-known-apps');
        const now = Math.floor(Date.now() / 1000);
        let fresh = this.settings.get_strv('menu-new-apps')
            .filter(e => ids.includes(e.split('|')[0]) && now - Number(e.split('|')[1]) < NEW_APP_DAYS * 86400);
        if (known.length) {
            const knownSet = new Set(known);
            for (const id of ids) {
                if (!knownSet.has(id))
                    fresh.unshift(`${id}|${now}`);
            }
        }
        fresh = fresh.slice(0, 20);
        if (fresh.join() !== this.settings.get_strv('menu-new-apps').join())
            this.settings.set_strv('menu-new-apps', fresh);
        if (ids.slice().sort().join() !== known.slice().sort().join())
            this.settings.set_strv('menu-known-apps', ids);
    }

    _lookup(ids) {
        return ids.map(id => this._appSys.lookup_app(id)).filter(app => app?.app_info?.should_show());
    }

    /** Apps installed in the last NEW_APP_DAYS days, newest first. */
    newApps(n = 4) {
        return this._lookup(this.settings.get_strv('menu-new-apps').map(e => e.split('|')[0])).slice(0, n);
    }

    /** Recently opened apps, newest first; topped up with frequent apps. */
    recentApps(n = 6) {
        const out = this._lookup(this.settings.get_strv('menu-recent-apps'));
        if (this.settings.get_boolean('menu-show-frequent')) {
            for (const app of this.frequentApps(n * 2)) {
                if (!out.includes(app))
                    out.push(app);
            }
        }
        return out.slice(0, n);
    }

    frequentApps(n = 8) {
        return this._usage.get_most_used().filter(app => app.app_info?.should_show()).slice(0, n);
    }

    /**
     * Refresh the recent-files and bookmark caches in the background.
     * Resolves to true when something changed (the open menu then redraws).
     */
    async preload() {
        const [recent, bookmarks] = await Promise.all([readRecentFiles(80), readBookmarks()]);
        if (this._destroyed)
            return false;
        const key = JSON.stringify([recent.map(f => f.uri), bookmarks]);
        const changed = key !== this._cacheKey;
        this._cacheKey = key;
        this._recent = recent;
        this._bookmarks = bookmarks;
        return changed;
    }

    /** Recent files for search (from the cache that preload() keeps fresh). */
    _searchableFiles() {
        return this._recent ?? [];
    }

    recentFiles(n = 20) {
        return this.settings.get_boolean('menu-show-recent') ? (this._recent ?? []).slice(0, n) : [];
    }

    places() {
        const out = [];
        for (const [name, icon, dir] of PLACES) {
            const path = dir === null ? GLib.get_home_dir() : GLib.get_user_special_dir(dir);
            if (path)
                out.push({name, icon, uri: Gio.File.new_for_path(path).get_uri()});
        }
        out.push({name: 'Trash', icon: 'user-trash-symbolic', uri: 'trash:///'});
        return out;
    }

    shortcuts() {
        const out = [];
        for (const [name, ids] of SHORTCUTS) {
            const app = ids.map(id => this.lookup(id)).find(Boolean);
            if (app)
                out.push({name, app});
        }
        return out;
    }

    /** Mounted drives the user can open/eject: [{name, gicon, uri, mount}]. */
    devices() {
        const out = [];
        for (const mount of Gio.VolumeMonitor.get().get_mounts()) {
            if (mount.is_shadowed())
                continue;
            const root = mount.get_root();
            if (root.get_path() === '/')
                continue;
            out.push({name: mount.get_name(), gicon: mount.get_symbolic_icon(), uri: root.get_uri(), mount});
        }
        return out;
    }

    /** GTK file-manager bookmarks: [{name, uri}] (cached by preload()). */
    bookmarks() {
        return this._bookmarks ?? [];
    }

    ejectOrUnmount(mount) {
        const op = new Gio.MountOperation();
        const done = (m, res) => {
            try {
                if (mount.can_eject())
                    m.eject_with_operation_finish(res);
                else
                    m.unmount_with_operation_finish(res);
            } catch (e) {
                Main.notifyError(`Could not eject ${mount.get_name()}`, e.message);
            }
        };
        if (mount.can_eject())
            mount.eject_with_operation(Gio.MountUnmountFlags.NONE, op, null, done);
        else
            mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, op, null, done);
    }

    /** Enabled and available power actions as [{id, name, icon, activate}]. */
    powerActions() {
        const sys = SystemActions.getDefault();
        const wanted = this.settings.get_strv('menu-power-options');
        return POWER_ACTIONS
            .filter(([id, , , , prop]) => wanted.includes(id) && (sys[prop.replace(/-(\w)/g, (_m, c) => c.toUpperCase())] ?? true))
            .map(([id, name, icon, method]) => ({id, name, icon, activate: () => sys[method]()}));
    }

    get userName() {
        return GLib.get_real_name() || GLib.get_user_name();
    }

    // ---- Search -------------------------------------------------------------

    /** Results for `query`: {calc, command, apps, files, web}. */
    search(query) {
        const s = this.settings;
        const out = {calc: null, command: null, apps: [], files: [], web: null};
        if (s.get_boolean('menu-search-calc'))
            out.calc = calculate(query);
        if (query.startsWith('>')) {
            if (s.get_boolean('menu-search-commands'))
                out.command = query.slice(1).trim() || null;
            return out;
        }

        const q = query.toLowerCase();
        const scored = [];
        for (const app of this.apps) {
            const name = app.get_name().toLowerCase();
            const info = app.app_info;
            let score = -1;
            if (name.startsWith(q))
                score = 0;
            else if (name.split(/\s+/).some(w => w.startsWith(q)))
                score = 1;
            else if (name.includes(q))
                score = 2;
            else if ((info.get_generic_name?.() ?? '').toLowerCase().includes(q) ||
                     (info.get_keywords?.() ?? []).some(k => k.toLowerCase().startsWith(q)) ||
                     (info.get_executable?.() ?? '').toLowerCase().includes(q))
                score = 3;
            else if ((info.get_description() ?? '').toLowerCase().includes(q))
                score = 4;
            if (score >= 0)
                scored.push([score, app]);
        }
        scored.sort((a, b) => a[0] - b[0]);
        out.apps = scored.slice(0, s.get_int('menu-max-results')).map(([, app]) => app);

        if (s.get_boolean('menu-search-files') && s.get_boolean('menu-show-recent'))
            out.files = this._searchableFiles().filter(f => f.name.toLowerCase().includes(q)).slice(0, 6);

        const url = s.get_string('menu-web-search');
        if (url)
            out.web = url.replace('%s', encodeURIComponent(query));
        return out;
    }

    runCommand(cmd) {
        try {
            const [, argv] = GLib.shell_parse_argv(cmd);
            this.runArgv(argv);
        } catch (e) {
            Main.notifyError('Command failed', e.message);
        }
    }

    runArgv(argv) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notifyError('Command failed', e.message);
        }
    }

    destroy() {
        this._destroyed = true;
        this._appSys.disconnectObject(this);
        this._favorites.disconnectObject(this);
        this.settings.disconnectObject(this);
        this._pinnedListeners.clear();
    }
}
