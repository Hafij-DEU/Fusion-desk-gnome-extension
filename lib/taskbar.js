// Taskbar: pinned + running apps with indicators, window previews and app menus.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {giconFor} from './icons.js';
import {tintWithAccent} from './style.js';

const PREVIEW_SHOW_DELAY = 350;
const PREVIEW_HIDE_DELAY = 300;
const PREVIEW_WIDTH = 220;
const PREVIEW_HEIGHT = 130;

/** Button that opens the GNOME app grid. */
export class AppsButton {
    constructor(ext) {
        const size = ext.settings.get_int('taskbar-icon-size');
        this.actor = new St.Button({
            style_class: 'fusion-task-button fusion-apps-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Show Applications',
            child: new St.Icon({
                gicon: giconFor(ext.settings.get_string('apps-icon'), 'view-app-grid-symbolic', `${ext.path}/icons`),
                fallback_icon_name: 'view-app-grid-symbolic',
                icon_size: ext.settings.get_string('apps-icon') ? size : Math.round(size * 0.75),
            }),
        });
        tintWithAccent(this.actor.child, ext.settings);
        this.actor.connect('clicked', () => {
            if (Main.overview.visible && Main.overview.dash.showAppsButton.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

/** Taskbar windows of `app`, limited to the active workspace and/or a monitor (-1 = any). */
function windowsOf(app, isolate, monitor = -1) {
    const ws = global.workspace_manager.get_active_workspace();
    return app.get_windows().filter(w =>
        !w.skip_taskbar &&
        (!isolate || w.located_on_workspace(ws)) &&
        (monitor < 0 || w.get_monitor() === monitor));
}

const byStableSequence = (a, b) => a.get_stable_sequence() - b.get_stable_sequence();

const AppButton = GObject.registerClass(
class FusionAppButton extends St.Button {
    _init(taskbar, app) {
        super._init({
            style_class: 'fusion-task-button',
            can_focus: true,
            track_hover: true,
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            accessible_name: app.get_name(),
        });
        this.app = app;
        this._taskbar = taskbar;

        const size = taskbar.settings.get_int('taskbar-icon-size');
        const row = new St.BoxLayout({style_class: 'fusion-task-row', y_align: Clutter.ActorAlign.CENTER});
        const col = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Bin({child: app.create_icon_texture(size), style_class: 'fusion-task-icon'});
        this._dots = new St.BoxLayout({style_class: 'fusion-task-dots', x_align: Clutter.ActorAlign.CENTER});
        if (taskbar.settings.get_string('taskbar-indicator-position') === 'TOP') {
            col.add_child(this._dots);
            col.add_child(this._icon);
        } else {
            col.add_child(this._icon);
            col.add_child(this._dots);
        }
        row.add_child(col);
        this._label = new St.Label({style_class: 'fusion-task-label', y_align: Clutter.ActorAlign.CENTER, visible: false});
        row.add_child(this._label);
        this.set_child(row);

        this.connect('clicked', (_b, button) => this._onClicked(button));
        this.connect('notify::hover', () => taskbar.onHover(this));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.connect('destroy', () => this._menu?.destroy());
    }

    get windows() {
        return windowsOf(this.app, this._taskbar.isolate, this._taskbar.monitor).sort(byStableSequence);
    }

    get tooltipText() {
        return this.app.get_name();
    }

    _isFocused() {
        return this._taskbar.tracker.focus_app === this.app;
    }

    /** Text for the label next to the icon, or null to hide it. */
    _labelText(windows) {
        if (!this._taskbar.settings.get_boolean('taskbar-labels') || !windows.length)
            return null;
        const w = windows.find(x => x.has_focus()) ?? windows[0];
        return w.get_title() ?? this.app.get_name();
    }

    sync() {
        const windows = this.windows;
        const focused = this._isFocused();
        this._dots.destroy_all_children();
        const style = this._taskbar.indicatorStyle;
        const count = style === 'NONE' ? 0 : style === 'LINE' ? Math.min(windows.length, 1) : Math.min(windows.length, 3);
        for (let i = 0; i < count; i++) {
            this._dots.add_child(new St.Widget({
                style_class: `fusion-task-dot${focused ? ' focused' : ''}`,
                style: `background-color: ${this._taskbar.indicatorColor};`,
                opacity: focused ? 255 : 160,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (focused)
            this.add_style_pseudo_class('active');
        else
            this.remove_style_pseudo_class('active');

        const text = this._labelText(windows);
        this._label.visible = text !== null;
        if (text !== null)
            this._label.text = text;
    }

    _onClicked(button) {
        const settings = this._taskbar.settings;
        const windows = this.windows;

        if (button === Clutter.BUTTON_SECONDARY) {
            this._taskbar.hidePreview();
            this._openMenu();
            return;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            this._taskbar.hidePreview();
            const action = settings.get_string('taskbar-middle-click');
            if (action === 'MINIMIZE')
                windows.forEach(w => w.minimize());
            else if (action === 'QUIT')
                this.app.request_quit();
            else
                this.app.open_new_window(-1);
            return;
        }

        const action = settings.get_string('taskbar-click-action');
        if (action === 'PREVIEW' && windows.length > 1 && this._taskbar.hasPreview) {
            this._taskbar.showPreviewNow(this);
            return;
        }
        this._taskbar.hidePreview();

        if (!windows.length) {
            this.app.activate();
            return;
        }

        if (action === 'MINIMIZE') {
            if (this._taskbar.tracker.focus_app === this.app && windows.some(w => !w.minimized)) {
                windows.forEach(w => w.minimize());
            } else {
                const mru = this.app.get_windows().filter(w => windows.includes(w)).reverse();
                mru.forEach(w => Main.activateWindow(w));
            }
            return;
        }

        const focusWin = global.display.focus_window;
        const focusedIdx = windows.indexOf(focusWin);
        if (focusedIdx === -1) {
            // Bring back the most recently used window of this app.
            const mru = this.app.get_windows().find(w => windows.includes(w)) ?? windows[0];
            Main.activateWindow(mru);
        } else if (windows.length === 1) {
            focusWin.minimize();
        } else {
            Main.activateWindow(windows[(focusedIdx + 1) % windows.length]);
        }
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        const action = this._taskbar.settings.get_string('taskbar-scroll-action');
        if (!step || action === 'NOTHING')
            return Clutter.EVENT_PROPAGATE;
        if (action === 'WORKSPACE') {
            const wm = global.workspace_manager;
            const idx = Math.max(0, Math.min(wm.get_active_workspace_index() + step, wm.n_workspaces - 1));
            wm.get_workspace_by_index(idx).activate(global.get_current_time());
            return Clutter.EVENT_STOP;
        }
        const windows = this.windows;
        if (!windows.length)
            return Clutter.EVENT_PROPAGATE;
        const idx = windows.indexOf(global.display.focus_window);
        const next = idx === -1 ? 0 : (idx + step + windows.length) % windows.length;
        Main.activateWindow(windows[next]);
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        if (!this._menu) {
            const side = this._taskbar.ext.panelAtBottom ? St.Side.BOTTOM : St.Side.TOP;
            this._menu = new AppMenu(this, side, {favoritesSection: true, showSingleWindows: true});
            this._menu.setApp(this.app);
            this._menu.connectObject('open-state-changed', (_m, open) => {
                if (!open)
                    this.sync_hover();
            }, this);
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._taskbar.menuManager.addMenu(this._menu);
        }
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

/** One button per window, used when the taskbar does not group apps. */
const WindowButton = GObject.registerClass(
class FusionWindowButton extends AppButton {
    _init(taskbar, app, win) {
        super._init(taskbar, app);
        this.win = win;
        this.add_style_class_name('fusion-task-window');
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        win.connectObject('notify::title', () => this.sync(), this);
        this.connect('destroy', () => this.win.disconnectObject(this));
    }

    get windows() {
        return [this.win];
    }

    get tooltipText() {
        return this.win.get_title() || this.app.get_name();
    }

    _isFocused() {
        return global.display.focus_window === this.win;
    }

    _labelText() {
        return this.win.get_title() || this.app.get_name();
    }

    _onClicked(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            super._onClicked(button);
            return;
        }
        this._taskbar.hidePreview();
        if (button === Clutter.BUTTON_MIDDLE) {
            const action = this._taskbar.settings.get_string('taskbar-middle-click');
            if (action === 'MINIMIZE')
                this.win.minimize();
            else if (action === 'QUIT')
                this.win.delete(global.get_current_time());
            else
                this.app.open_new_window(-1);
            return;
        }
        if (this._isFocused() && !this.win.minimized)
            this.win.minimize();
        else
            Main.activateWindow(this.win);
    }
});

/** Floating window-preview strip shown above/below a hovered app button. */
class PreviewPopup {
    constructor(taskbar) {
        this._taskbar = taskbar;
        this.actor = new St.BoxLayout({
            style_class: 'fusion-preview',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this.actor.connectObject('notify::hover', () => taskbar.onHover(null), this);
        Main.layoutManager.addTopChrome(this.actor);
        this.button = null;
    }

    show(button) {
        const windows = button.windows;
        if (!windows.length) {
            this.hide();
            return;
        }
        this.button = button;
        this.actor.destroy_all_children();
        for (const win of windows)
            this.actor.add_child(this._makeItem(win));

        this.actor.show();
        const [, natW] = this.actor.get_preferred_width(-1);
        const [, natH] = this.actor.get_preferred_height(natW);
        const [bx, by] = button.get_transformed_position();
        const [bw, bh] = button.get_transformed_size();
        const mon = Main.layoutManager.findMonitorForActor(button) ?? Main.layoutManager.primaryMonitor;
        let x = Math.round(bx + bw / 2 - natW / 2);
        x = Math.max(mon.x + 4, Math.min(x, mon.x + mon.width - natW - 4));
        const y = this._taskbar.ext.panelAtBottom
            ? Math.round(by - natH - 6)
            : Math.round(by + bh + 6);
        this.actor.set_position(x, y);
    }

    _makeItem(win) {
        const item = new St.Button({
            style_class: 'fusion-preview-item',
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        const header = new St.BoxLayout({style_class: 'fusion-preview-header'});
        const title = new St.Label({
            text: win.get_title() ?? '',
            style_class: 'fusion-preview-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = new St.Button({
            style_class: 'fusion-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
        });
        close.connect('clicked', () => {
            win.delete(global.get_current_time());
            this._taskbar.hidePreview();
        });
        header.add_child(title);
        header.add_child(close);
        box.add_child(header);

        const thumb = new St.Widget({
            style_class: 'fusion-preview-thumb',
            width: PREVIEW_WIDTH,
            height: PREVIEW_HEIGHT,
            layout_manager: new Clutter.BinLayout(),
        });
        const actor = win.get_compositor_private();
        if (actor) {
            const scale = Math.min(PREVIEW_WIDTH / actor.width, PREVIEW_HEIGHT / actor.height, 1);
            const clone = new Clutter.Clone({
                source: actor,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: Math.round(actor.width * scale),
                height: Math.round(actor.height * scale),
            });
            thumb.add_child(clone);
        }
        if (win.minimized)
            thumb.opacity = 160;
        box.add_child(thumb);
        item.set_child(box);
        item.connect('clicked', (_b, mouse) => {
            if (mouse === Clutter.BUTTON_MIDDLE) {
                if (this._taskbar.settings.get_boolean('taskbar-preview-close-middle'))
                    win.delete(global.get_current_time());
                this._taskbar.hidePreview();
                return;
            }
            Main.activateWindow(win);
            this._taskbar.hidePreview();
        });
        return item;
    }

    hide() {
        this.actor.hide();
        this.actor.destroy_all_children();
        this.button = null;
    }

    destroy() {
        this.actor.disconnectObject(this);
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
        this.button = null;
    }
}

export class Taskbar {
    /**
     * @param {object} ext the extension
     * @param {object} [opts]
     * @param {number} [opts.monitor] only show windows on this monitor (secondary panels)
     * @param {boolean} [opts.hotkeys] bind Super+1..9 (main taskbar only)
     */
    constructor(ext, {monitor = null, hotkeys = true} = {}) {
        this.ext = ext;
        this.settings = ext.settings;
        this.isolate = this.settings.get_boolean('taskbar-isolate-workspaces');
        this.groupApps = this.settings.get_boolean('taskbar-group-apps');
        // With panels on every monitor, each taskbar lists only its own monitor's windows.
        this._fixedMonitor = monitor;
        this._isolateMonitor = monitor !== null || this.settings.get_boolean('multi-monitor');
        this.tracker = Shell.WindowTracker.get_default();
        this.menuManager = new PopupMenu.PopupMenuManager(Main.panel);
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._buttons = new Map();
        this._order = [];

        this.indicatorStyle = this.settings.get_string('taskbar-indicator-style');
        // Empty = follow the system accent colour (Settings → Appearance).
        this.indicatorColor = this.settings.get_string('taskbar-indicator-color') || '-st-accent-color';

        this.actor = new St.BoxLayout({
            style_class: `fusion-taskbar fusion-ind-${this.indicatorStyle.toLowerCase()}`,
            reactive: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        if (this.settings.get_boolean('taskbar-previews'))
            this._preview = new PreviewPopup(this);
        if (this.settings.get_boolean('taskbar-tooltips')) {
            this._tooltip = new St.Label({style_class: 'fusion-tooltip', visible: false});
            Main.uiGroup.add_child(this._tooltip);
        }
        if (hotkeys && this.settings.get_boolean('taskbar-hotkeys'))
            this._bindHotkeys();

        const queue = () => this._queueRedisplay();
        this._appSystem.connectObject('app-state-changed', queue, 'installed-changed', queue, this);
        this._favorites.connectObject('changed', queue, this);
        this.tracker.connectObject('tracked-windows-changed', queue,
            'notify::focus-app', () => this._syncAll(), this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);
        global.display.connectObject('window-created', queue,
            'notify::focus-window', () => this._syncAll(), this);
        global.window_manager.connectObject('minimize', () => this._syncAll(),
            'unminimize', () => this._syncAll(), this);
        if (this._isolateMonitor) {
            global.display.connectObject('window-entered-monitor', queue,
                'window-left-monitor', queue, this);
            Main.layoutManager.connectObject('monitors-changed', queue, this);
        }

        this._redisplay();
    }

    _queueRedisplay() {
        if (this._redisplayId)
            return;
        this._redisplayId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._redisplayId = 0;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Monitor whose windows this taskbar lists, or -1 for all. */
    get monitor() {
        if (!this._isolateMonitor)
            return -1;
        return this._fixedMonitor ?? Main.layoutManager.primaryIndex;
    }

    _wantedApps() {
        const apps = [];
        if (this.settings.get_boolean('taskbar-show-favorites'))
            apps.push(...this._favorites.getFavorites());
        const running = this._appSystem.get_running()
            .filter(app => !apps.includes(app) && windowsOf(app, this.isolate, this.monitor).length > 0);
        // Keep running apps in first-seen order so icons do not jump around.
        running.sort((a, b) => {
            const ia = this._order.indexOf(a.get_id());
            const ib = this._order.indexOf(b.get_id());
            return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
        });
        apps.push(...running);
        return apps;
    }

    /** Buttons to show: one per app, or one per window when not grouping. */
    _wantedItems(apps) {
        if (this.groupApps)
            return apps.map(app => ({key: app.get_id(), app}));
        const items = [];
        for (const app of apps) {
            const windows = windowsOf(app, this.isolate, this.monitor).sort(byStableSequence);
            // Pinned apps without windows stay as icon-only launchers.
            if (!windows.length)
                items.push({key: app.get_id(), app});
            for (const win of windows)
                items.push({key: `window:${win.get_stable_sequence()}`, app, win});
        }
        return items;
    }

    _redisplay() {
        const apps = this._wantedApps();
        this._order = apps.map(a => a.get_id());
        const items = this._wantedItems(apps);
        const keys = new Set(items.map(i => i.key));

        for (const [key, button] of this._buttons) {
            if (!keys.has(key)) {
                if (this._preview?.button === button)
                    this._preview.hide();
                if (this._pendingTarget === button)
                    this._cancelHoverTimers();
                button.destroy();
                this._buttons.delete(key);
            }
        }
        items.forEach(({key, app, win}, i) => {
            let button = this._buttons.get(key);
            if (!button) {
                button = win ? new WindowButton(this, app, win) : new AppButton(this, app);
                this._buttons.set(key, button);
                this.actor.add_child(button);
            }
            this.actor.set_child_at_index(button, i);
        });
        this._syncAll();
    }

    _syncAll() {
        for (const button of this._buttons.values())
            button.sync();
    }

    get hasPreview() {
        return !!this._preview;
    }

    showPreviewNow(button) {
        this.hidePreview();
        this._preview?.show(button);
    }

    _syncTooltip(button) {
        if (!this._tooltip)
            return;
        if (this._tooltipId) {
            GLib.source_remove(this._tooltipId);
            this._tooltipId = 0;
        }
        const target = button?.hover ? button : null;
        if (!target || (this._preview && target.windows.length) || this.menuManager.activeMenu) {
            this._tooltip.hide();
            return;
        }
        this._pendingTarget = target;
        this._tooltipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._tooltip.visible ? 0 : 300, () => {
            this._tooltipId = 0;
            if (!target.hover)
                return GLib.SOURCE_REMOVE;
            this._tooltip.text = target.tooltipText;
            this._tooltip.show();
            const [tw, th] = this._tooltip.get_preferred_size().slice(2);
            const [bx, by] = target.get_transformed_position();
            const [bw, bh] = target.get_transformed_size();
            const y = this.ext.panelAtBottom ? by - th - 8 : by + bh + 8;
            this._tooltip.set_position(Math.round(bx + bw / 2 - tw / 2), Math.round(y));
            return GLib.SOURCE_REMOVE;
        });
    }

    _bindHotkeys() {
        const kb = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        this._hotkeySettings = kb;
        for (let i = 1; i <= 9; i++) {
            for (const [name, newWindow] of [[`switch-to-application-${i}`, false], [`open-new-window-application-${i}`, true]]) {
                Main.wm.removeKeybinding(name);
                Main.wm.addKeybinding(name, kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
                    () => this._activateNth(i - 1, newWindow));
            }
        }
    }

    _unbindHotkeys() {
        if (!this._hotkeySettings)
            return;
        const kb = this._hotkeySettings;
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        for (let i = 1; i <= 9; i++) {
            Main.wm.removeKeybinding(`switch-to-application-${i}`);
            Main.wm.removeKeybinding(`open-new-window-application-${i}`);
            Main.wm.addKeybinding(`switch-to-application-${i}`, kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
                Main.wm._switchToApplication.bind(Main.wm));
            Main.wm.addKeybinding(`open-new-window-application-${i}`, kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
                Main.wm._openNewApplicationWindow.bind(Main.wm));
        }
        this._hotkeySettings = null;
    }

    _activateNth(n, newWindow) {
        const button = this.actor.get_child_at_index(n);
        if (!button?.app)
            return;
        Main.overview.hide();
        if (newWindow)
            button.app.open_new_window(-1);
        else
            button._onClicked(Clutter.BUTTON_PRIMARY);
    }

    onHover(button) {
        this._syncTooltip(button);
        if (!this._preview)
            return;
        const overPreview = this._preview.actor.hover;
        const hovered = button?.hover ? button : null;

        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (this._showId) {
            GLib.source_remove(this._showId);
            this._showId = 0;
        }

        if (hovered && !this.menuManager.activeMenu) {
            this._pendingTarget = hovered;
            const delay = this._preview.actor.visible ? 0 : PREVIEW_SHOW_DELAY;
            this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._showId = 0;
                if (hovered.hover)
                    this._preview.show(hovered);
                return GLib.SOURCE_REMOVE;
            });
        } else if (!overPreview && this._preview.actor.visible) {
            this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_HIDE_DELAY, () => {
                this._hideId = 0;
                const stillOver = this._preview.actor.hover ||
                    [...this._buttons.values()].some(b => b.hover);
                if (!stillOver)
                    this._preview.hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /** Drop the tooltip/preview timers, e.g. when their button is about to be destroyed. */
    _cancelHoverTimers() {
        for (const id of ['_tooltipId', '_showId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._pendingTarget = null;
    }

    hidePreview() {
        for (const id of ['_showId', '_hideId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._preview?.hide();
    }

    destroy() {
        this.hidePreview();
        this._unbindHotkeys();
        if (this._tooltipId)
            GLib.source_remove(this._tooltipId);
        this._tooltip?.destroy();
        if (this._redisplayId)
            GLib.source_remove(this._redisplayId);
        this._appSystem.disconnectObject(this);
        this._favorites.disconnectObject(this);
        this.tracker.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._preview?.destroy();
        this.actor.destroy();
        this._buttons.clear();
    }
}

