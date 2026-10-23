// Shared "tools" items for the panel and start-button right-click menus.
// Rebuilt every time the menu opens, so uninstalled apps simply disappear.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {listDir, readText} from './files.js';
import {PRESETS, applyPreset} from './presets.js';
import {readSnapshot, restoreSnapshot, savedLabel} from './snapshot.js';

// [label, icon, desktop ids (first installed wins)]
const RESOURCES = ['Resources', 'utilities-system-monitor-symbolic', ['net.nokyan.Resources.desktop']];
const APPS = [
    ['Terminal', 'utilities-terminal-symbolic', ['org.gnome.Ptyxis.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Console.desktop']],
    ['System Monitor', 'utilities-system-monitor-symbolic', ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop']],
    ['Extensions', 'application-x-addon-symbolic', ['com.mattjakeman.ExtensionManager.desktop', 'org.gnome.Extensions.desktop']],
    ['Tweaks', 'preferences-other-symbolic', ['org.gnome.tweaks.desktop']],
    ['Settings', 'emblem-system-symbolic', ['org.gnome.Settings.desktop', 'gnome-control-center.desktop']],
];
const DISK_USAGE = ['org.gnome.baobab.desktop'];
const SYSTEM_MONITOR = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop'];
const FLYOUT_LIMIT = 10;
// App updates are handled by App Hub (github.com/Hafij-DEU/Application-hub).
const APP_UPDATE = ['App Update', 'software-update-available-symbolic', ['io.github.hafij_bge.AppHub.desktop']];

function lookup(ids) {
    const appSys = Shell.AppSystem.get_default();
    return ids.map(id => appSys.lookup_app(id)).find(Boolean) ?? null;
}

function item(menu, label, icon, action) {
    const it = new PopupMenu.PopupImageMenuItem(label, icon);
    it.connect('activate', action);
    menu.addMenuItem(it);
    return it;
}

function formatBytes(b) {
    if (b >= 1e12)
        return `${(b / 1e12).toFixed(1)} TB`;
    if (b >= 1e9)
        return `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
    return `${Math.round(b / 1e6)} MB`;
}

/** Desktop id from a systemd app unit name (app-gnome-<id>-<pid>.scope, snap.<snap>.<app>-<uuid>.scope, …). */
function appIdForUnit(unit) {
    const unescape = t => t.replace(/\\x([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    let m = /^snap\.([^.]+)\.([^.]+?)(?:-[0-9a-f]{8}-[0-9a-f-]+)?\.scope$/.exec(unit);
    if (m)
        return [`${m[1]}_${m[2]}`];
    m = /^app-(?:(?:gnome|flatpak|kde|xfce|cosmic|dbus|systemd)-)?(.+?)(?:@[^.]*)?(?:-[0-9a-f]{6,}|-\d+|-autostart)?\.(?:scope|service)$/.exec(unit);
    if (!m)
        return [];
    const id = unescape(m[1]);
    return [id, id.toLowerCase()];
}

/**
 * Running apps, found the way Resources does: every process's systemd app
 * unit (from /proc/<pid>/cgroup) is mapped to its .desktop app, so apps
 * without windows show up too, and memory counts all of an app's processes.
 * Reads are async. Resolves to [{app, mem, units, pids}] sorted by memory.
 */
async function runningApps() {
    const appSys = Shell.AppSystem.get_default();
    const byId = new Map();
    const add = (app, pid, unit) => {
        const id = app.get_id();
        let e = byId.get(id);
        if (!e) {
            e = {app, pids: new Set(), units: new Set()};
            byId.set(id, e);
        }
        if (pid)
            e.pids.add(pid);
        if (unit)
            e.units.add(unit);
    };
    const pids = (await listDir('/proc')).filter(n => /^\d+$/.test(n));
    const cgroups = await Promise.all(pids.map(pid => readText(`/proc/${pid}/cgroup`)));
    const appForUnit = new Map();
    pids.forEach((pid, i) => {
        const path = /^0::(.*)$/m.exec(cgroups[i] ?? '')?.[1] ?? '';
        if (!path.includes('/user@'))
            return;
        const unit = path.split('/').pop();
        if (!appForUnit.has(unit))
            appForUnit.set(unit, appIdForUnit(unit).map(id => appSys.lookup_app(`${id}.desktop`)).find(Boolean) ?? null);
        const app = appForUnit.get(unit);
        if (app)
            add(app, Number(pid), unit);
    });
    // Apps GNOME tracks by window but that run outside an app unit.
    for (const app of appSys.get_running()) {
        const appPids = app.get_pids();
        appPids.forEach(pid => add(app, pid, null));
        if (!appPids.length)
            add(app, 0, null);
    }
    const rows = [...byId.values()];
    await Promise.all(rows.map(async e => {
        e.mem = await pidsMemory(e.pids);
    }));
    return rows.sort((a, b) => b.mem - a.mem);
}

/** Resident memory (bytes) of a set of processes. */
async function pidsMemory(pids) {
    const texts = await Promise.all([...pids].map(pid => readText(`/proc/${pid}/status`)));
    return texts.reduce((sum, t) => sum + Number(/VmRSS:\s+(\d+)/.exec(t ?? '')?.[1] ?? 0) * 1024, 0);
}

/** Quit an app: ask nicely when it has windows, otherwise stop its app units. */
function endApp({app, units}) {
    if (app.get_windows().length) {
        app.request_quit();
        return;
    }
    if (!units.size)
        return;
    try {
        Gio.Subprocess.new(['systemctl', '--user', 'kill', '--signal=SIGTERM', ...units], Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.error('Fusion Desk: could not end app', e);
    }
}


/** Row with icon, name, a detail line and an optional trailing button. */
function richItem(menu, {gicon, iconName, text, detail, action, button}) {
    const it = new PopupMenu.PopupBaseMenuItem({style_class: 'fusion-tools-row'});
    const icon = new St.Icon({icon_size: 16, style_class: 'popup-menu-icon'});
    if (gicon)
        icon.gicon = gicon;
    else
        icon.icon_name = iconName;
    it.add_child(icon);
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    box.add_child(new St.Label({text, style_class: 'fusion-tools-name'}));
    if (detail)
        box.add_child(detail);
    it.add_child(box);
    if (button)
        it.add_child(button);
    it.connect('activate', action);
    menu.addMenuItem(it);
    return it;
}

/**
 * Menu item that opens a side menu to its right instead of expanding inline.
 * The side menu has its own grab on top of the parent's, so the parent stays
 * open behind it. `build(menu, done)` fills it each time; `done()` closes both.
 */
const FlyoutItem = GObject.registerClass(
class FusionFlyoutItem extends PopupMenu.PopupBaseMenuItem {
    _init(label, iconName, rootMenu, build) {
        super._init({style_class: 'fusion-flyout-item'});
        this.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}));
        this.label = new St.Label({text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.add_child(new St.Icon({icon_name: 'go-next-symbolic', style_class: 'popup-menu-arrow', y_align: Clutter.ActorAlign.CENTER}));
        this._root = rootMenu;
        this._build = build;
        this.connect('destroy', () => {
            this.destroyed = true;
            this._root?.disconnectObject(this);
            this._menu?.destroy();
            this._menu = null;
        });
    }

    // Open the side menu instead of activating (which would close the parent).
    activate(_event) {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.LEFT);
            this._menu.actor.add_style_class_name('fusion-flyout');
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._manager = new PopupMenu.PopupMenuManager(this);
            this._manager.addMenu(this._menu);
            this._root.connectObject('open-state-changed', (_m, open) => {
                if (!open)
                    this._menu?.close();
            }, this);
        }
        this._menu.removeAll();
        this._build(this._menu, () => {
            this._menu?.close();
            this._root.close();
        });
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

/** "Open <app>" footer line for a flyout. */
function openFooter(menu, done, label, ids) {
    const app = lookup(ids);
    if (!app)
        return;
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    item(menu, label, 'external-link-symbolic', () => {
        done();
        app.activate();
    });
}

/** Running apps by memory use (top 10), like Resources' Apps page. */
function backgroundApps(menu, rootMenu) {
    const flyoutItem = new FlyoutItem('Background Apps', 'view-app-grid-symbolic', rootMenu, async (flyout, done) => {
        const loading = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
        flyout.addMenuItem(loading);
        const rows = await runningApps();
        if (!flyout.isOpen)
            return;
        loading.destroy();
        for (const row of rows.slice(0, FLYOUT_LIMIT)) {
            const {app, mem} = row;
            const end = new St.Button({style_class: 'fusion-tools-end', can_focus: true, accessible_name: `Quit ${app.get_name()}`,
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}), y_align: Clutter.ActorAlign.CENTER});
            end.connect('clicked', () => {
                endApp(row);
                flyout.close();
            });
            richItem(flyout, {
                gicon: app.get_icon(),
                text: app.get_name(),
                detail: new St.Label({text: mem ? `${formatBytes(mem)} memory` : '', style_class: 'fusion-tools-detail'}),
                action: () => {
                    done();
                    app.activate();
                },
                button: end,
            });
        }
        if (!rows.length)
            flyout.addMenuItem(new PopupMenu.PopupMenuItem('No apps running', {reactive: false}));
        const more = rows.length - FLYOUT_LIMIT;
        if (lookup(RESOURCES[2]))
            openFooter(flyout, done, more > 0 ? `${more} more — open Resources` : 'Open Resources', RESOURCES[2]);
        else
            openFooter(flyout, done, more > 0 ? `${more} more — open System Monitor` : 'Open System Monitor', SYSTEM_MONITOR);
    });
    menu.addMenuItem(flyoutItem);
    // Show the count once the background scan is done.
    runningApps().then(rows => {
        if (!flyoutItem.destroyed)
            flyoutItem.label.text = `Background Apps (${rows.length})`;
    }).catch(() => {});
}

/** Every mounted disk with free space and a usage bar. */
function diskUsage(menu, rootMenu) {
    menu.addMenuItem(new FlyoutItem('Disk Usage', 'drive-multidisk-symbolic', rootMenu, (flyout, done) => {
        const disks = [{name: 'System', path: '/', icon: 'drive-harddisk-system-symbolic'}];
        const seen = new Set(['/']);
        for (const mount of Gio.VolumeMonitor.get().get_mounts()) {
            const path = mount.get_root().get_path();
            if (!path || seen.has(path) || mount.is_shadowed())
                continue;
            seen.add(path);
            disks.push({name: mount.get_name(), path, gicon: mount.get_symbolic_icon()});
        }
        const analyzer = lookup(DISK_USAGE);
        for (const d of disks.slice(0, FLYOUT_LIMIT)) {
            let info;
            try {
                info = Gio.File.new_for_path(d.path).query_filesystem_info('filesystem::free,filesystem::size', null);
            } catch {
                continue;
            }
            const size = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            if (!size)
                continue;
            const used = 1 - free / size;
            const detail = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-tools-disk'});
            detail.add_child(new St.Label({text: `${formatBytes(free)} free of ${formatBytes(size)}`, style_class: 'fusion-tools-detail'}));
            const bar = new St.BoxLayout({style_class: 'fusion-tools-bar', x_expand: true});
            const fill = new St.Widget({style_class: `fusion-tools-bar-fill${used > 0.9 ? ' full' : ''}`});
            bar.add_child(fill);
            // Size the fill after layout, not during the allocation that changed the width.
            bar.connect('notify::width', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (fill.get_parent())
                        fill.set_width(Math.round(bar.width * used));
                    return GLib.SOURCE_REMOVE;
                });
            });
            detail.add_child(bar);
            richItem(flyout, {
                gicon: d.gicon, iconName: d.icon, text: d.name, detail,
                action: () => {
                    done();
                    const uri = Gio.File.new_for_path(d.path).get_uri();
                    const ctx = global.create_app_launch_context(0, -1);
                    if (analyzer)
                        analyzer.app_info.launch_uris([uri], ctx);
                    else
                        Gio.AppInfo.launch_default_for_uri(uri, ctx);
                },
            });
        }
        openFooter(flyout, done, 'Open Disk Usage Analyzer', DISK_USAGE);
    }));
}

/** "Style" submenu: one-click presets (lib/presets.js). */
export function addDesktopModeMenu(menu, settings) {
    const sub = new PopupMenu.PopupSubMenuMenuItem(_('Style'), true);
    sub.icon.icon_name = 'preferences-desktop-appearance-symbolic';
    const current = settings.get_string('desktop-mode');
    for (const [id, label] of PRESETS) {
        const it = sub.menu.addAction(_(label), () => applyPreset(settings, id));
        it.setOrnament(current === id ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }
    // One click back to the setup saved in Settings → Panel → My setup.
    const saved = readSnapshot();
    if (saved) {
        sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const mine = sub.menu.addAction(_('Restore my setup'), () => restoreSnapshot(settings));
        mine.label.text = `${_('Restore my setup')} (${savedLabel(saved)})`;
    }
    menu.addMenuItem(sub);
}

/** Panel position and quick toggles. */
function panelSubmenu(menu, settings) {
    const sub = new PopupMenu.PopupSubMenuMenuItem('Panel', true);
    sub.icon.icon_name = 'view-dual-symbolic';
    const bottom = settings.get_string('panel-position') === 'BOTTOM';
    item(sub.menu, bottom ? 'Move panel to top' : 'Move panel to bottom', bottom ? 'go-up-symbolic' : 'go-down-symbolic',
        () => settings.set_string('panel-position', bottom ? 'TOP' : 'BOTTOM'));
    const toggle = (label, get, set) => {
        const sw = new PopupMenu.PopupSwitchMenuItem(label, get());
        sw.connect('toggled', (_i, on) => set(on));
        sub.menu.addMenuItem(sw);
    };
    toggle('Group windows by app', () => settings.get_boolean('taskbar-group-apps'), on => settings.set_boolean('taskbar-group-apps', on));
    toggle('Auto-hide panel', () => settings.get_boolean('intellihide'), on => settings.set_boolean('intellihide', on));
    toggle('Pill style', () => settings.get_string('panel-style') === 'PILLS', on => settings.set_string('panel-style', on ? 'PILLS' : 'FLAT'));
    menu.addMenuItem(sub);
}

function powerSubmenu(menu) {
    const sub = new PopupMenu.PopupSubMenuMenuItem('Power', true);
    sub.icon.icon_name = 'system-shutdown-symbolic';
    const sys = SystemActions.getDefault();
    item(sub.menu, 'Lock', 'system-lock-screen-symbolic', () => sys.activateLockScreen());
    item(sub.menu, 'Log Out', 'system-log-out-symbolic', () => sys.activateLogout());
    item(sub.menu, 'Suspend', 'media-playback-pause-symbolic', () => sys.activateSuspend());
    item(sub.menu, 'Restart…', 'system-reboot-symbolic', () => sys.activateRestart());
    item(sub.menu, 'Power Off…', 'system-shutdown-symbolic', () => sys.activatePowerOff());
    menu.addMenuItem(sub);
}

/**
 * (Re)fill `section` with the tools items. Call it right before opening the
 * menu so the list matches what is installed and running now.
 * @param {PopupMenu.PopupMenuSection} section where the items go
 * @param {object} ext the extension
 * @param {PopupMenu.PopupMenu} rootMenu the menu that holds `section`
 * @param {object} [opts]
 * @param {boolean} [opts.panelItems] include the Panel submenu
 */
export function fillToolsMenu(section, ext, rootMenu, {panelItems = true} = {}) {
    section.removeAll();
    item(section, 'Fusion Desk Settings', 'preferences-system-symbolic', () => ext.openPreferences());
    addDesktopModeMenu(section, ext.settings);
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Live info and actions.
    backgroundApps(section, rootMenu);
    diskUsage(section, rootMenu);
    if (panelItems)
        panelSubmenu(section, ext.settings);
    powerSubmenu(section);
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Apps (each only while it is installed).
    const resources = lookup(RESOURCES[2]);
    if (resources)
        item(section, RESOURCES[0], RESOURCES[1], () => resources.activate());
    for (const [label, icon, ids] of APPS) {
        const app = lookup(ids);
        if (app)
            item(section, label, icon, () => app.activate());
    }

    // Only while App Hub is installed: opens it on its Updates page.
    const hub = lookup(APP_UPDATE[2]);
    if (!hub || !GLib.find_program_in_path('app-hub'))
        return;
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    item(section, APP_UPDATE[0], APP_UPDATE[1], () => {
        // App Hub with an "updates" desktop action opens straight on its
        // Updates page; older versions just open normally.
        const info = hub.get_app_info();
        if (info?.list_actions().includes('updates'))
            info.launch_action('updates', global.create_app_launch_context(0, -1));
        else
            hub.activate();
    });
}
