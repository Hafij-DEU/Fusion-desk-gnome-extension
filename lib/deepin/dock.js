// Deepin-style dock: Fashion mode (floating, centred, rounded) or Efficient
// mode (full width), with keep shown / keep hidden / smart hide.
// Clean-room reimplementation of the behaviour; no DDE code or assets.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Taskbar} from '../taskbar.js';
import {ShowDesktop} from '../buttons.js';
import {addDesktopModeMenu} from '../toolsMenu.js';
import {addBlur, surfaceStyle, themeClass} from './common.js';

const FASHION_MARGIN = 8;   // gap between a Fashion dock and the screen edge
const REVEAL_DELAY = 200;   // pointer at the edge before a hidden dock shows
const HIDE_DELAY = 400;     // pointer away before an auto-hide dock hides
const SLIDE_TIME = 300;
const DODGE_TYPES = [
    Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY,
];

export const PLUGINS = [
    ['multitask', () => _('Multitask view')],
    ['tray', () => _('Status icons')],
    ['datetime', () => _('Date and time')],
    ['trash', () => _('Trash')],
    ['control', () => _('Control centre')],
    ['power', () => _('Power')],
    ['show-desktop', () => _('Show desktop')],
];

/**
 * Settings seen by Fusion's taskbar inside the dock: grouped icons without
 * labels at the dock's icon size, dot indicators facing the screen edge.
 */
function taskbarSettings(settings, iconSize, atBottom) {
    const overrides = {
        'taskbar-icon-size': iconSize,
        'taskbar-labels': false,
        'taskbar-group-apps': true,
        'taskbar-show-favorites': true,
        'taskbar-indicator-style': 'DOTS',
        'taskbar-indicator-position': atBottom ? 'BOTTOM' : 'TOP',
        'multi-monitor': false,
    };
    return new Proxy(settings, {
        get(target, prop) {
            if (prop === 'get_int' || prop === 'get_boolean' || prop === 'get_string')
                return key => (key in overrides ? overrides[key] : target[prop](key));
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}

export class Dock {
    constructor(deepin) {
        this._deepin = deepin;
        const ext = this._ext = deepin.ext;
        const s = this._settings = ext.settings;

        this._fashion = s.get_string('deepin-dock-mode') === 'FASHION';
        this._atBottom = s.get_string('deepin-dock-position') === 'BOTTOM';
        this._hideMode = s.get_string('deepin-dock-hide');
        this._size = s.get_int('deepin-dock-size');
        this._iconSize = Math.round(this._size * 9 / 14);
        this._margin = this._fashion ? FASHION_MARGIN : 0;
        this._plugins = new Set(s.get_strv('deepin-dock-plugins'));
        this._hidden = false;

        const radius = this._fashion ? Math.round((this._size + 2 * Math.max(6, Math.round(0.16 * this._size))) / 4) : 0;
        this.actor = new St.BoxLayout({
            name: 'fusionDeepinDock',
            style_class: `fusion-deepin-dock ${themeClass(s)} ${this._fashion ? 'fusion-deepin-fashion' : 'fusion-deepin-efficient'}`,
            style: surfaceStyle(s, `border-radius: ${radius}px; height: ${this._size}px;`),
            reactive: true,
            track_hover: true,
        });
        addBlur(this.actor, s, 30);

        this._appsBox = new St.BoxLayout({style_class: 'fusion-deepin-dock-section', y_align: Clutter.ActorAlign.CENTER});
        this._pluginBox = new St.BoxLayout({style_class: 'fusion-deepin-dock-section fusion-deepin-plugins', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._appsBox);

        this._buildApps(ext);
        if (this._fashion) {
            this.actor.add_child(this._separator());
        } else {
            // Efficient: apps on the left, plugins on the right edge.
            this.actor.add_child(new St.Widget({x_expand: true}));
        }
        this.actor.add_child(this._pluginBox);
        this._buildPlugins();

        this.actor.connect('button-press-event', (_a, event) => this._onButtonPress(event));
        this.actor.connect('notify::width', () => this._reposition());
        this.actor.connect('leave-event', () => this._queueCheck(HIDE_DELAY));

        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: true});
        if (this._hideMode === 'KEEP_SHOWN') {
            // Separate invisible actor so a floating dock still reserves the
            // strip between it and the screen edge.
            this._strut = new St.Widget({reactive: false, opacity: 0});
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true, trackFullscreen: true});
        } else {
            this._edge = new St.Widget({reactive: true, track_hover: true, height: 1, visible: false});
            Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: true});
            this._edge.connect('enter-event', () => this._onEdgeEntered());
            this._trackWindows();
        }
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        Main.overview.connectObject('showing', () => this._queueCheck(0), 'hidden', () => this._queueCheck(0), this);
        this._reposition();
        this._queueCheck(0);
    }

    // ---- content ------------------------------------------------------------

    _item(iconName, accessibleName, onClick, extraClass = '') {
        const button = new St.Button({
            style_class: `fusion-deepin-dock-item ${extraClass}`,
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
            child: new St.Icon({
                gicon: Gio.ThemedIcon.new_from_names([iconName].flat()),
                icon_size: Math.round(this._iconSize * 0.62),
                style_class: 'fusion-deepin-dock-glyph',
            }),
            width: this._iconSize,
            height: this._iconSize,
        });
        button.connect('clicked', onClick);
        return button;
    }

    _plugin(iconName, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'fusion-deepin-plugin',
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', onClick);
        return button;
    }

    _separator() {
        return new St.Widget({style_class: 'fusion-deepin-dock-sep', y_align: Clutter.ActorAlign.CENTER, height: Math.round(this._size * 0.5)});
    }

    _buildApps(ext) {
        this.launcherButton = this._item('view-app-grid-symbolic', _('Launcher'),
            () => this._deepin.launcher?.toggle(), 'fusion-deepin-launcher-button');
        this._appsBox.add_child(this.launcherButton);
        if (this._plugins.has('multitask')) {
            this._appsBox.add_child(this._item(['multitasking-view-symbolic', 'focus-windows-symbolic', 'view-grid-symbolic'],
                _('Multitask view'), () => Main.overview.toggle(), 'fusion-deepin-multitask-button'));
        }

        // Fusion's taskbar engine (pinned + running apps, previews, app menu)
        // with Deepin-style settings.
        const dockExt = Object.create(ext, {
            settings: {value: taskbarSettings(ext.settings, this._iconSize, this._atBottom)},
            panelAtBottom: {value: this._atBottom},
        });
        try {
            this._taskbar = new Taskbar(dockExt, {hotkeys: true});
            this._taskbar.actor.add_style_class_name('fusion-deepin-tasks');
            this._appsBox.add_child(this._taskbar.actor);
        } catch (e) {
            console.error('Fusion Desk: Deepin dock taskbar failed', e);
        }
    }

    _buildPlugins() {
        const panel = Main.panel;
        if (this._plugins.has('tray')) {
            // GNOME's status area (quick settings and other extensions'
            // indicators) becomes the dock tray; it goes back on destroy.
            this._trayBox = new St.BoxLayout({style_class: 'fusion-deepin-tray', y_align: Clutter.ActorAlign.CENTER});
            this._rightBox = panel._rightBox;
            this._rightBox.get_parent()?.remove_child(this._rightBox);
            this._trayBox.add_child(this._rightBox);
            this._pluginBox.add_child(this._trayBox);
        }
        if (this._plugins.has('datetime'))
            this._takeDateMenu();
        if (this._plugins.has('trash'))
            this._pluginBox.add_child(this._buildTrash());
        if (this._plugins.has('control')) {
            this._controlButton = this._plugin('preferences-system-notifications-symbolic', _('Control centre'),
                () => this._deepin.controlCenter?.toggle());
            this._pluginBox.add_child(this._controlButton);
        }
        if (this._plugins.has('power'))
            this._pluginBox.add_child(this._buildPower());
        if (this._plugins.has('show-desktop') && !this._fashion) {
            this._showDesktop = new ShowDesktop();
            this._showDesktop.actor.add_style_class_name('fusion-deepin-show-desktop');
            this.actor.add_child(this._showDesktop.actor);
        }
        // GNOME puts its items back into the default boxes on session-mode
        // changes; take the date menu again afterwards.
        Main.sessionMode.connectObject('updated', () => {
            if (this._plugins.has('datetime'))
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this.actor)
                        this._takeDateMenu();
                    return GLib.SOURCE_REMOVE;
                });
        }, this);
    }

    _takeDateMenu() {
        const date = Main.panel.statusArea.dateMenu?.container;
        if (!date || date.get_parent() === this._pluginBox)
            return;
        date.get_parent()?.remove_child(date);
        this._dateMenu = date;
        this._dateMenu.add_style_class_name('fusion-deepin-datetime');
        const index = this._trayBox ? this._pluginBox.get_children().indexOf(this._trayBox) + 1 : 0;
        this._pluginBox.insert_child_at_index(date, index);
    }

    _buildTrash() {
        this._trash = this._plugin('user-trash-symbolic', _('Trash'), () => {
            Gio.AppInfo.launch_default_for_uri('trash:///', global.create_app_launch_context(0, -1));
        });
        try {
            this._trashFile = Gio.File.new_for_uri('trash:///');
            this._trashMonitor = this._trashFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._trashMonitor.connect('changed', () => this._syncTrash());
            this._syncTrash();
        } catch (e) {
            console.debug(`Fusion Desk: trash monitor unavailable: ${e.message}`);
        }
        return this._trash;
    }

    _syncTrash() {
        this._trashFile?.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (file, res) => {
                try {
                    const count = file.query_info_finish(res).get_attribute_uint32('trash::item-count');
                    if (this._trash)
                        this._trash.child.icon_name = count > 0 ? 'user-trash-full-symbolic' : 'user-trash-symbolic';
                } catch (e) {
                    // Trash backend missing (gvfs not running): keep the empty icon.
                }
            });
    }

    _buildPower() {
        const button = this._plugin('system-shutdown-symbolic', _('Power'), () => {
            if (!this._powerMenu) {
                const menu = this._powerMenu = new PopupMenu.PopupMenu(button, 0.5,
                    this._atBottom ? St.Side.BOTTOM : St.Side.TOP);
                menu.actor.add_style_class_name('fusion-deepin-menu');
                const sys = SystemActions.getDefault();
                const add = (label, icon, fn) => menu.addAction(label, fn, icon);
                add(_('Lock'), 'system-lock-screen-symbolic', () => sys.activateLockScreen());
                add(_('Log Out'), 'system-log-out-symbolic', () => sys.activateLogout());
                add(_('Suspend'), 'media-playback-pause-symbolic', () => sys.activateSuspend());
                add(_('Restart…'), 'system-reboot-symbolic', () => sys.activateRestart());
                add(_('Power Off…'), 'system-shutdown-symbolic', () => sys.activatePowerOff());
                Main.uiGroup.add_child(menu.actor);
                menu.actor.hide();
                this._menuManager().addMenu(menu);
            }
            this._powerMenu.toggle();
        });
        return button;
    }

    _menuManager() {
        this._menus ??= new PopupMenu.PopupMenuManager(this.actor);
        return this._menus;
    }

    // ---- right-click menu ------------------------------------------------------

    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        const src = global.stage.get_event_actor(event);
        const empty = src === this.actor || src === this._appsBox || src === this._pluginBox ||
            src === this._taskbar?.actor || src === this._trayBox;
        if (!empty)
            return Clutter.EVENT_PROPAGATE;
        this._openDockMenu(event.get_coords()[0]);
        return Clutter.EVENT_STOP;
    }

    _openDockMenu(x) {
        const s = this._settings;
        if (!this._dockMenu) {
            this._menuAnchor = new St.Widget({width: 1, height: 1, opacity: 0});
            Main.uiGroup.add_child(this._menuAnchor);
            this._dockMenu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, this._atBottom ? St.Side.BOTTOM : St.Side.TOP);
            this._dockMenu.actor.add_style_class_name('fusion-deepin-menu');
            Main.uiGroup.add_child(this._dockMenu.actor);
            this._dockMenu.actor.hide();
            this._menuManager().addMenu(this._dockMenu);
        }
        const menu = this._dockMenu;
        menu.removeAll();

        const choice = (sub, label, key, value) => {
            const it = sub.menu.addAction(label, () => s.set_string(key, value));
            it.setOrnament(s.get_string(key) === value ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        };
        const submenu = (label, icon) => {
            const sub = new PopupMenu.PopupSubMenuMenuItem(label, true);
            sub.icon.icon_name = icon;
            menu.addMenuItem(sub);
            return sub;
        };

        const mode = submenu(_('Mode'), 'view-dual-symbolic');
        choice(mode, _('Fashion mode'), 'deepin-dock-mode', 'FASHION');
        choice(mode, _('Efficient mode'), 'deepin-dock-mode', 'EFFICIENT');
        const pos = submenu(_('Location'), 'view-restore-symbolic');
        choice(pos, _('Bottom'), 'deepin-dock-position', 'BOTTOM');
        choice(pos, _('Top'), 'deepin-dock-position', 'TOP');
        const status = submenu(_('Status'), 'view-reveal-symbolic');
        choice(status, _('Keep shown'), 'deepin-dock-hide', 'KEEP_SHOWN');
        choice(status, _('Keep hidden'), 'deepin-dock-hide', 'KEEP_HIDDEN');
        choice(status, _('Smart hide'), 'deepin-dock-hide', 'SMART_HIDE');
        const plugins = submenu(_('Plugins'), 'application-x-addon-symbolic');
        for (const [id, label] of PLUGINS) {
            const on = this._plugins.has(id);
            const sw = new PopupMenu.PopupSwitchMenuItem(label(), on);
            sw.connect('toggled', (_i, state) => {
                const list = s.get_strv('deepin-dock-plugins').filter(p => p !== id);
                if (state)
                    list.push(id);
                s.set_strv('deepin-dock-plugins', list);
            });
            plugins.menu.addMenuItem(sw);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addDesktopModeMenu(menu, s);
        menu.addAction(_('Dock settings'), () => this._ext.openPreferences(), 'preferences-system-symbolic');

        const [, y] = this.actor.get_transformed_position();
        this._menuAnchor.set_position(Math.round(x), Math.round(this._atBottom ? y : y + this.actor.height));
        if (this._menuIdleId)
            GLib.source_remove(this._menuIdleId);
        // Open once the anchor has been allocated at its new position.
        this._menuIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._menuIdleId = 0;
            this._dockMenu?.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- geometry ------------------------------------------------------------

    get monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    /** Space the dock keeps from windows when shown (for other surfaces). */
    get reservedHeight() {
        return this._size + 2 * this._margin;
    }

    get atBottom() {
        return this._atBottom;
    }

    _reposition() {
        const m = this.monitor;
        if (!m || !this.actor)
            return;
        if (!this._fashion)
            this.actor.set_width(m.width);
        const w = this._fashion ? Math.min(this.actor.width, m.width - 2 * this._margin) : m.width;
        const x = m.x + Math.floor((m.width - w) / 2);
        this._shownY = this._atBottom ? m.y + m.height - this._size - this._margin : m.y + this._margin;
        this.actor.set_position(x, this._shownY);
        if (this._strut) {
            this._strut.set_size(m.width, this._size + this._margin);
            this._strut.set_position(m.x, this._atBottom ? m.y + m.height - this._size - this._margin : m.y);
        }
        if (this._edge) {
            this._edge.set_size(m.width, 1);
            this._edge.set_position(m.x, this._atBottom ? m.y + m.height - 1 : m.y);
        }
    }

    /** Dock rectangle when shown, stretched to the screen edge. */
    _shownRect() {
        const m = this.monitor;
        const y1 = this._atBottom ? this._shownY : m.y;
        const y2 = this._atBottom ? m.y + m.height : this._shownY + this._size;
        return {x: this.actor.x, y: y1, width: this.actor.width, height: y2 - y1};
    }

    // ---- auto hide -------------------------------------------------------------

    _trackWindows() {
        this._tracked = new Set();
        const queue = () => this._queueCheck(100);
        const track = win => {
            if (this._tracked.has(win))
                return;
            this._tracked.add(win);
            win.connectObject('position-changed', queue, 'size-changed', queue,
                'notify::minimized', queue, 'workspace-changed', queue,
                'unmanaged', () => {
                    win.disconnectObject(this);
                    this._tracked.delete(win);
                    queue();
                }, this);
        };
        global.display.list_all_windows().forEach(track);
        global.display.connectObject('window-created', (_d, win) => {
            track(win);
            queue();
        }, 'restacked', queue, this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);
    }

    _windowOverlaps() {
        const r = this._shownRect();
        const mon = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(win => {
            if (win.minimized || win.get_monitor() !== mon || !win.showing_on_its_workspace())
                return false;
            if (!DODGE_TYPES.includes(win.get_window_type()))
                return false;
            const f = win.get_frame_rect();
            return f.x < r.x + r.width && f.x + f.width > r.x && f.y < r.y + r.height && f.y + f.height > r.y;
        });
    }

    _pointerInside() {
        const [px, py] = global.get_pointer();
        const r = this._shownRect();
        return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
    }

    _wantShown() {
        if (this._hideMode === 'KEEP_SHOWN')
            return true;
        if (this._deepin.launcher?.isOpen || this._deepin.controlCenter?.isOpen || Main.overview.visible)
            return true;
        // A menu or dialog is open: keep the dock where it is.
        if (Main.actionMode !== Shell.ActionMode.NORMAL)
            return !this._hidden;
        if (this._pointerInside())
            return !this._hidden || this._revealing;
        if (this._hideMode === 'KEEP_HIDDEN')
            return false;
        return !this._windowOverlaps();
    }

    _onEdgeEntered() {
        if (this._revealId)
            return;
        this._revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY, () => {
            this._revealId = 0;
            if (this._pointerInside()) {
                this._revealing = true;
                this._update();
                this._revealing = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueCheck(delay) {
        if (this._hideMode === 'KEEP_SHOWN' || this._checkId)
            return;
        this._checkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._checkId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Re-evaluate visibility; the launcher and control centre call this too. */
    update() {
        this._update();
    }

    _update() {
        if (!this.actor || this._hideMode === 'KEEP_SHOWN')
            return;
        if (this._wantShown())
            this._show();
        else
            this._hide();
        // While revealed, poll so leaving the dock or a closing menu hides it.
        if (!this._hidden && !this._pollId) {
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
                if (!this.actor)
                    return GLib.SOURCE_REMOVE;
                this._update();
                if (this._hidden) {
                    this._pollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _show() {
        if (!this._hidden)
            return;
        this._hidden = false;
        this._edge.hide();
        this.actor.show();
        this.actor.remove_transition('translation-y');
        this.actor.ease({translation_y: 0, duration: SLIDE_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    _hide() {
        if (this._hidden)
            return;
        this._hidden = true;
        const off = (this._size + this._margin + 4) * (this._atBottom ? 1 : -1);
        this.actor.remove_transition('translation-y');
        this.actor.ease({
            translation_y: off,
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                if (this._hidden && this.actor) {
                    this.actor.hide();
                    this._edge?.show();
                }
            },
        });
    }

    // ---- teardown ------------------------------------------------------------

    destroy() {
        for (const id of ['_checkId', '_pollId', '_revealId', '_menuIdleId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const win of this._tracked ?? [])
            win.disconnectObject(this);
        this._tracked = null;
        this._trashMonitor?.cancel();
        this._trashMonitor = null;
        this._trashFile = null;
        this._trash = null;

        this._powerMenu?.destroy();
        this._dockMenu?.destroy();
        this._menuAnchor?.destroy();
        this._taskbar?.destroy();
        this._showDesktop?.destroy();

        // Give GNOME's panel items back before our actors go away.
        if (this._rightBox) {
            this._rightBox.get_parent()?.remove_child(this._rightBox);
            Main.panel.add_child(this._rightBox);
            this._rightBox = null;
        }
        const date = Main.panel.statusArea.dateMenu?.container;
        if (date && this._dateMenu === date) {
            date.remove_style_class_name('fusion-deepin-datetime');
            if (date.get_parent() !== Main.panel._centerBox) {
                date.get_parent()?.remove_child(date);
                Main.panel._centerBox.insert_child_at_index(date, 0);
            }
        }
        this._dateMenu = null;

        if (this._strut) {
            Main.layoutManager.removeChrome(this._strut);
            this._strut.destroy();
            this._strut = null;
        }
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
    }
}
