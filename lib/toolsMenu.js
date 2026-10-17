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
import {askInstallAppHub} from './appHubInstall.js';

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

const decoder = new TextDecoder();

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

/** Resident memory of an app's processes (bytes). */
function appMemory(app) {
    let total = 0;
    for (const pid of app.get_pids()) {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/status`);
            const kb = /VmRSS:\s+(\d+)/.exec(decoder.decode(bytes))?.[1];
            total += Number(kb ?? 0) * 1024;
        } catch {
            // Process already gone.
        }
    }
    return total;
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
    const count = Shell.AppSystem.get_default().get_running().length;
    menu.addMenuItem(new FlyoutItem(`Background Apps (${count})`, 'view-app-grid-symbolic', rootMenu, (flyout, done) => {
        const rows = Shell.AppSystem.get_default().get_running()
            .map(app => ({app, mem: appMemory(app)})).sort((a, b) => b.mem - a.mem);
        for (const {app, mem} of rows.slice(0, FLYOUT_LIMIT)) {
            const end = new St.Button({style_class: 'fusion-tools-end', can_focus: true, accessible_name: `Quit ${app.get_name()}`,
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}), y_align: Clutter.ActorAlign.CENTER});
            end.connect('clicked', () => {
                app.request_quit();
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
    }));
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

    // Always offered: opens App Hub on its Updates page, or asks to install App Hub.
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    item(section, APP_UPDATE[0], APP_UPDATE[1], () => {
        const hub = lookup(APP_UPDATE[2]);
        if (!hub || !GLib.find_program_in_path('app-hub')) {
            askInstallAppHub(`${ext.path}/icons/app-hub.png`);
            return;
        }
        // App Hub with an "updates" desktop action opens straight on its
        // Updates page; older versions just open normally.
        const info = hub.get_app_info();
        if (info?.list_actions().includes('updates'))
            info.launch_action('updates', global.create_app_launch_context(0, -1));
        else
            hub.activate();
    });
}
