// "Show hidden icons" arrow: other apps' tray icons (AppIndicator /
// StatusNotifier and legacy tray icons) move into a small grid that opens
// from an arrow on the panel. Icons the user pins stay on the panel, next to
// the arrow. Menus of hidden icons open from the arrow.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const COLUMNS = 5;
const TRAY_ROLE = /^appindicator-/;

/** Stable id for a tray icon (its role contains a bus name that changes every run). */
function trayKey(role, indicator) {
    const id = indicator._indicator?.id;
    if (id)
        return id;
    // Legacy tray icons: "appindicator-legacy:<wm_class>:<pid>".
    const legacy = /^appindicator-(legacy:[^:]+)/.exec(role);
    return legacy ? legacy[1] : role;
}

function trayTitle(indicator, key) {
    return indicator._indicator?.title || indicator.accessible_name || key.replace(/^legacy:/, '');
}

const OverflowButton = GObject.registerClass(
class FusionOverflowButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Show hidden icons', false);
        this._ext = ext;
        this._settings = ext.settings;
        this.add_style_class_name('fusion-overflow-button');
        this._arrow = new St.Icon({
            icon_name: ext.panelAtBottom ? 'pan-up-symbolic' : 'pan-down-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._arrow);
        this.menu.actor.add_style_class_name('fusion-overflow-menu');

        this._grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fusion-overflow-grid',
        });
        const gridItem = new PopupMenu.PopupMenuSection();
        gridItem.actor.add_child(this._grid);
        this.menu.addMenuItem(gridItem);

        this._empty = new PopupMenu.PopupMenuItem('All tray icons are on the taskbar', {reactive: false});
        this.menu.addMenuItem(this._empty);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._pinMenu = new PopupMenu.PopupSubMenuMenuItem('Taskbar icons');
        this.menu.addMenuItem(this._pinMenu);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._fillPinMenu();
        });
        // An app activated from the grid (no menu) gets focus: close the grid like Windows does.
        global.display.connectObject('notify::focus-window', () => {
            if (this.menu.isOpen && global.display.focus_window)
                this.menu.close();
        }, this);
    }

    _fillPinMenu() {
        this._pinMenu.menu.removeAll();
        const pinned = this._settings.get_strv('overflow-pinned');
        const icons = this._owner.trayIcons();
        if (!icons.length) {
            this._pinMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem('No app tray icons', {reactive: false}));
            return;
        }
        for (const {key, indicator} of icons) {
            const item = new PopupMenu.PopupSwitchMenuItem(trayTitle(indicator, key), pinned.includes(key));
            item.connect('toggled', (_i, on) => {
                const list = this._settings.get_strv('overflow-pinned').filter(k => k !== key);
                if (on)
                    list.push(key);
                this._settings.set_strv('overflow-pinned', list);
            });
            this._pinMenu.menu.addMenuItem(item);
        }
    }

    _onDestroy() {
        global.display.disconnectObject(this);
        super._onDestroy();
    }
});

export class TrayOverflow {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._moved = new Map(); // container -> {indicator, cell}

        this._button = new OverflowButton(ext);
        this._button._owner = this;
        Main.panel.addToStatusArea('fusion-overflow', this._button, 0, 'right');
        this.actor = this._button.container;

        // Hidden icons' menus anchor here: an invisible copy of the arrow's
        // rectangle. GNOME switches menus when the pointer hovers a menu's
        // anchor, so the icon (inside the grid) must not be that anchor.
        this._anchor = new St.Widget({reactive: false, opacity: 0});
        Main.uiGroup.add_child(this._anchor);
        this._button.connectObject('notify::allocation', () => this._syncAnchor(), this);

        // While the grid is closed, hidden icons wait in an invisible but mapped
        // holder: tray icons only load and update their pictures while mapped.
        this._holder = new St.BoxLayout({opacity: 0, reactive: false});
        this._holder.set_position(-10000, -10000);
        Main.uiGroup.add_child(this._holder);
        this._button.menu.connect('open-state-changed', () => this._layoutGrid());

        // New tray icons can appear at any time; GNOME adds them to a panel box.
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box.connectObject('child-added', () => this._queueSync(), this);
        this._settings.connectObject('changed::overflow-pinned', () => this._queueSync(), this);
        this._queueSync();
    }

    trayIcons() {
        return Object.entries(Main.panel.statusArea)
            .filter(([role, indicator]) => indicator && TRAY_ROLE.test(role) && !indicator._destroyed)
            .map(([role, indicator]) => ({role, indicator, key: trayKey(role, indicator)}));
    }

    _queueSync() {
        if (this._syncId || this._destroyed)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const pinned = this._settings.get_strv('overflow-pinned');
        const icons = this.trayIcons();
        const hide = icons.filter(i => !pinned.includes(i.key));
        const keep = icons.filter(i => pinned.includes(i.key));

        // Pinned icons go back to the panel, right before the arrow (also after
        // the panel layout re-adds Fusion's own items behind other icons).
        for (const {indicator} of keep) {
            this._restore(indicator.container);
            this._placeBeforeArrow(indicator.container);
        }
        for (const {indicator} of hide) {
            if (!this._moved.has(indicator.container))
                this._hide(indicator);
        }
        this._layoutGrid();
        this.actor.visible = icons.length > 0;
        this._button._empty.visible = hide.length === 0;
    }

    _hide(indicator) {
        const container = indicator.container;
        container.get_parent()?.remove_child(container);
        // x_expand off: a panel button would otherwise stretch its cell across the row.
        const cell = new St.Bin({style_class: 'fusion-overflow-cell', child: container, x_expand: false, y_expand: false});
        // The app quit (or its tray extension was turned off). The cell is the
        // icon's parent: destroying it inside the icon's own destroy makes
        // Clutter abort, so drop it on the next idle instead.
        let cellGone = false;
        cell.connect('destroy', () => {
            cellGone = true;
        });
        container.connectObject('destroy', () => {
            this._moved.delete(container);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!cellGone)
                    cell.destroy();
                if (!this._destroyed)
                    this._queueSync();
                return GLib.SOURCE_REMOVE;
            });
        }, this);

        // Clicks on AppIndicator icons are handled here, Windows-style: the grid
        // closes first, then left click activates the app, middle click is the
        // app's secondary action and right click opens its menu from the arrow.
        // (Letting the icon open its own menu from inside this menu fails: the
        // release lands outside the new menu and closes it.) Legacy tray icons
        // keep their own handling.
        if (indicator.menu)
            indicator.menu.sourceActor = this._anchor;
        if (indicator._indicator) {
            cell.reactive = true;
            cell.connectObject('captured-event', (_c, event) => this._onCellEvent(indicator, event), this);
        }
        this._moved.set(container, {indicator, cell});
    }

    _onCellEvent(indicator, event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_STOP;
        if (type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button();
        const [x, y] = event.get_coords();
        const time = event.get_time();
        const app = indicator._indicator;
        this._button.menu.close();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (button === Clutter.BUTTON_MIDDLE)
                app.secondaryActivate?.(time, x, y);
            else if (button === Clutter.BUTTON_PRIMARY && app.supportsActivation !== false)
                app.open?.(x, y, time);
            else
                this._openMenuFromArrow(indicator);
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    _syncAnchor() {
        const [x, y] = this._button.get_transformed_position();
        const [w, h] = this._button.get_transformed_size();
        if (Number.isFinite(x) && Number.isFinite(y))
            this._anchor.set_position(Math.round(x), Math.round(y));
        this._anchor.set_size(Math.max(1, w), Math.max(1, h));
    }

    _openMenuFromArrow(indicator) {
        const menu = indicator.menu;
        if (menu?.numMenuItems)
            menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _restore(container) {
        const entry = this._moved.get(container);
        if (!entry)
            return;
        this._moved.delete(container);
        container.disconnectObject(this);
        const {indicator, cell} = entry;
        cell.disconnectObject(this);
        cell.set_child(null);
        cell.destroy();
        if (indicator.menu)
            indicator.menu.sourceActor = indicator;
        this._placeBeforeArrow(container);
    }

    _placeBeforeArrow(container) {
        const box = Main.panel._rightBox;
        if (this.actor.get_parent() !== box) {
            if (!container.get_parent())
                box.add_child(container);
            return;
        }
        if (container.get_parent() === box && container.get_next_sibling() === this.actor)
            return;
        container.get_parent()?.remove_child(container);
        box.insert_child_below(container, this.actor);
    }

    /** Cells go into the grid while it is open, into the holder otherwise. */
    _layoutGrid() {
        const grid = this._button._grid;
        const cells = [...this._moved.values()].map(v => v.cell);
        for (const cell of cells)
            cell.get_parent()?.remove_child(cell);
        grid.destroy_all_children();

        if (this._button.menu.isOpen) {
            let row = null;
            cells.forEach((cell, i) => {
                if (i % COLUMNS === 0) {
                    row = new St.BoxLayout({style_class: 'fusion-overflow-row', x_expand: false, x_align: Clutter.ActorAlign.CENTER});
                    grid.add_child(row);
                }
                row.add_child(cell);
            });
        } else {
            cells.forEach(cell => this._holder.add_child(cell));
        }
        grid.visible = this._moved.size > 0;
    }

    destroy() {
        this._destroyed = true;
        if (this._syncId)
            GLib.source_remove(this._syncId);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const container of [...this._moved.keys()])
            this._restore(container);
        this._button.destroy();
        this._anchor.destroy();
        this._holder.destroy();
    }
}
