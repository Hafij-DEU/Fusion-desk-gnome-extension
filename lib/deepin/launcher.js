// Deepin-style launcher: fullscreen blurred app grid with a category rail and
// search, or a small 780×600 window with a category / A–Z list, favourites
// and all apps. Clean-room reimplementation; no DDE code or assets.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    CATEGORIES, addBlur, allApps, categoryName, categoryOf, isAutostart, matchesSearch,
    openSettingsPanel, sendToDesktop, setAutostart, surfaceStyle, themeClass,
} from './common.js';
import {accentFill} from '../style.js';

const WINDOW_W = 780;
const WINDOW_H = 600;
const FULL_COLS = 7;
const FULL_ROWS = 4;
const WINDOW_COLS = 4;
const FADE_TIME = 150;

export class Launcher {
    constructor(deepin) {
        this._deepin = deepin;
        this._ext = deepin.ext;
        this._settings = deepin.ext.settings;
        this.isOpen = false;
        Main.overview.connectObject('showing', () => this.close(), this);
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;
        this._deepin.controlCenter?.close();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._fullscreen = this._settings.get_string('deepin-launcher-mode') === 'FULLSCREEN';
        this._apps = allApps();
        this._category = null;

        this._root = new St.Widget({
            style_class: 'fusion-deepin-launcher-root',
            reactive: true,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            layout_manager: new Clutter.FixedLayout(),
            opacity: 0,
        });
        // Below the taskbar, like Deepin's dock: it stays visible over the launcher.
        const panelBox = Main.layoutManager.panelBox;
        if (panelBox.get_parent() === Main.uiGroup)
            Main.uiGroup.insert_child_below(this._root, panelBox);
        else
            Main.uiGroup.add_child(this._root);
        this._menus = new PopupMenu.PopupMenuManager(this._root);

        if (this._fullscreen)
            this._buildFullscreen(monitor);
        else
            this._buildWindowed(monitor);

        this._root.connect('button-press-event', (_a, event) => {
            // Clicks on empty space close the launcher.
            const src = global.stage.get_event_actor(event);
            if (this._isBackground(src)) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('key-press-event', (_a, event) => this._onKeyPress(event));

        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        this.isOpen = true;
        this._entry.grab_key_focus();
        this._root.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._menus = null;
        const root = this._root;
        this._root = null;
        this._entry = null;
        root.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => root.destroy(),
        });
    }

    _isBackground(actor) {
        // Outside our tree (e.g. the taskbar under the grab) counts as background.
        if (!actor || !this._root.contains(actor))
            return true;
        return actor === this._root || (this._backgrounds ?? []).includes(actor);
    }

    _switchMode() {
        const next = this._fullscreen ? 'WINDOWED' : 'FULLSCREEN';
        this.close();
        this._settings.set_string('deepin-launcher-mode', next);
        this.open();
    }

    // ---- shared pieces -------------------------------------------------------

    _searchEntry(styleClass) {
        const entry = new St.Entry({
            style_class: `fusion-deepin-search ${styleClass}`,
            hint_text: _('Search'),
            can_focus: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'fusion-deepin-search-icon'}),
        });
        entry.clutter_text.connect('text-changed', () => this._refresh());
        entry.clutter_text.connect('activate', () => this._activateFirst());
        return entry;
    }

    _query() {
        return this._entry?.get_text().trim() ?? '';
    }

    _launch(app) {
        this.close();
        app.open_new_window(-1);
    }

    _activateFirst() {
        const q = this._query();
        const list = q ? this._apps.filter(a => matchesSearch(a, q)) : [];
        if (list.length)
            this._launch(list[0]);
    }

    _tile(app, size, iconSize) {
        const tile = new St.Button({
            style_class: 'fusion-deepin-app',
            can_focus: true,
            track_hover: true,
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: app.get_name(),
            width: size,
            height: size,
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'fusion-deepin-app-box',
        });
        const icon = app.create_icon_texture(iconSize);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const label = new St.Label({text: app.get_name(), style_class: 'fusion-deepin-app-label', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        label.set_width(size - 12);
        box.add_child(label);
        tile.set_child(box);
        tile.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._openAppMenu(tile, app);
            else
                this._launch(app);
        });
        return tile;
    }

    _row(app, iconSize = 24) {
        const row = new St.Button({
            style_class: 'fusion-deepin-list-app',
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: app.get_name(),
            x_expand: true,
        });
        const box = new St.BoxLayout({style_class: 'fusion-deepin-list-box', x_align: Clutter.ActorAlign.START});
        box.add_child(app.create_icon_texture(iconSize));
        const label = new St.Label({text: app.get_name(), y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        row.set_child(box);
        row.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._openAppMenu(row, app);
            else
                this._launch(app);
        });
        return row;
    }

    /** Rows of `cols` tiles in a vertical box. */
    _grid(apps, cols, size, iconSize, spacing) {
        const grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fusion-deepin-grid',
            style: `spacing: ${spacing}px;`,
            x_align: Clutter.ActorAlign.CENTER,
        });
        let row = null;
        apps.forEach((app, i) => {
            if (i % cols === 0) {
                row = new St.BoxLayout({style: `spacing: ${spacing}px;`});
                grid.add_child(row);
            }
            row.add_child(this._tile(app, size, iconSize));
        });
        return grid;
    }

    _openAppMenu(source, app) {
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('fusion-deepin-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menus.addMenu(menu);
        menu.addAction(_('Open'), () => this._launch(app));
        if (app.can_open_new_window() && app.get_n_windows() > 0)
            menu.addAction(_('New Window'), () => this._launch(app));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const favs = AppFavorites.getAppFavorites();
        const pinned = favs.isFavorite(app.get_id());
        menu.addAction(pinned ? _('Unpin from taskbar') : _('Pin to taskbar'), () => {
            if (pinned)
                favs.removeFavorite(app.get_id());
            else
                favs.addFavorite(app.get_id());
        });
        menu.addAction(_('Send to desktop'), () => sendToDesktop(app));
        const auto = new PopupMenu.PopupSwitchMenuItem(_('Start at login'), isAutostart(app));
        auto.connect('toggled', (_i, on) => setAutostart(app, on));
        menu.addMenuItem(auto);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            if (this._query())
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        const dirs = {
            [Clutter.KEY_Up]: St.DirectionType.UP, [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT, [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        };
        const focus = global.stage.key_focus;
        const inEntry = focus === this._entry?.clutter_text;
        if (sym in dirs && !(inEntry && (sym === Clutter.KEY_Left || sym === Clutter.KEY_Right))) {
            const from = inEntry ? null : focus;
            this._content?.navigate_focus(from, dirs[sym], false);
            return Clutter.EVENT_STOP;
        }
        // Typing anywhere goes to the search field.
        const ch = event.get_key_unicode();
        if (!inEntry && ch && /\S/.test(ch) && !(event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            this._entry.grab_key_focus();
            this._entry.clutter_text.insert_text(ch, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _refresh() {
        if (this._fullscreen)
            this._fillFullscreen();
        else
            this._fillWindowed();
    }

    // ---- fullscreen ------------------------------------------------------------

    _buildFullscreen(monitor) {
        const bg = new St.Widget({
            style_class: 'fusion-deepin-launcher-full-bg',
            width: monitor.width, height: monitor.height,
        });
        if (this._settings.get_boolean('accent-gradient'))
            bg.set_style(accentFill(this._settings, 'rgba(0, 15, 39, 0.45)', 35));
        addBlur(bg, this._settings, 60, 0.65);
        this._root.add_child(bg);

        const reserved = this._deepin.reservedHeight;
        const atBottom = this._deepin.atBottom;
        const main = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fusion-deepin-launcher-full fusion-deepin-dark',
            width: monitor.width,
            height: monitor.height - reserved,
            y: atBottom ? 0 : reserved,
        });
        this._root.add_child(main);

        const header = new St.BoxLayout({style_class: 'fusion-deepin-full-header', x_expand: true});
        this._entry = this._searchEntry('fusion-deepin-search-full');
        const leftPad = new St.Widget({x_expand: true});
        const rightPad = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.END});
        const mode = new St.Button({
            style_class: 'fusion-deepin-mode-button',
            can_focus: true,
            accessible_name: _('Windowed mode'),
            child: new St.Icon({icon_name: 'view-restore-symbolic', icon_size: 16}),
        });
        mode.connect('clicked', () => this._switchMode());
        rightPad.add_child(mode);
        header.add_child(leftPad);
        header.add_child(this._entry);
        header.add_child(rightPad);
        main.add_child(header);

        const body = new St.BoxLayout({x_expand: true, y_expand: true});
        main.add_child(body);
        this._rail = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fusion-deepin-rail',
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(this._rail);
        this._buildRail();

        this._scroll = new St.ScrollView({
            style_class: 'fusion-deepin-full-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        body.add_child(this._scroll);
        this._backgrounds = [bg, main, header, leftPad, rightPad, body, this._rail, this._scroll];

        // Deepin sizes cells to fit 7 × 4 per screen; the item is 4/5 of a cell.
        const railW = 200;
        const availW = monitor.width - 2 * railW;
        const availH = monitor.height - reserved - 140;
        const cell = Math.floor(Math.min(availW / FULL_COLS, availH / FULL_ROWS));
        this._fullTile = Math.round(cell * 0.8);
        this._fullIcon = Math.max(48, Math.min(128, Math.round(this._fullTile * 0.5)));
        this._fullSpacing = cell - this._fullTile;
        this._fillFullscreen();
    }

    _buildRail() {
        const present = new Set(this._apps.map(categoryOf));
        const add = (id, label, icon) => {
            const button = new St.Button({
                style_class: 'fusion-deepin-rail-item',
                can_focus: true,
                track_hover: true,
                toggle_mode: true,
                checked: this._category === id,
                x_align: Clutter.ActorAlign.FILL,
            });
            const box = new St.BoxLayout({style_class: 'fusion-deepin-rail-box', x_align: Clutter.ActorAlign.START});
            box.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
            box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            button.set_child(box);
            button.connect('clicked', () => {
                this._category = id;
                this._entry.set_text('');
                this._rail.get_children().forEach(b => (b.checked = b === button));
                this._fillFullscreen();
            });
            this._rail.add_child(button);
        };
        add(null, _('All'), 'view-app-grid-symbolic');
        for (const c of CATEGORIES) {
            if (present.has(c.id))
                add(c.id, categoryName(c), c.icon);
        }
    }

    _fillFullscreen() {
        const q = this._query();
        let apps = this._apps;
        if (q)
            apps = apps.filter(a => matchesSearch(a, q));
        else if (this._category)
            apps = apps.filter(a => categoryOf(a) === this._category);

        let child;
        if (!apps.length) {
            child = new St.Label({text: _('No search results'), style_class: 'fusion-deepin-empty', x_align: Clutter.ActorAlign.CENTER});
        } else {
            child = this._grid(apps, FULL_COLS, this._fullTile, this._fullIcon, this._fullSpacing);
        }
        const wrap = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        wrap.add_child(child);
        this._backgrounds = (this._backgrounds ?? []).filter(a => a.get_parent?.() !== null);
        this._backgrounds.push(wrap);
        if (child instanceof St.BoxLayout)
            this._backgrounds.push(child, ...child.get_children());
        this._scroll.set_child(wrap);
        this._content = wrap;
    }

    // ---- windowed --------------------------------------------------------------

    _buildWindowed(monitor) {
        const s = this._settings;
        const atBottom = this._deepin.atBottom;
        const reserved = this._deepin.reservedHeight;
        // Open next to the launcher button (left in Efficient mode, centre otherwise).
        const button = this._deepin.launcherButton;
        const anchorX = button ? button.get_transformed_position()[0] - 10 : monitor.x + 10;
        const x = Math.max(monitor.x + 10, Math.min(anchorX, monitor.x + monitor.width - WINDOW_W - 10)) - monitor.x;
        const y = atBottom ? monitor.height - reserved - WINDOW_H - 10 : reserved + 10;

        const win = new St.BoxLayout({
            style_class: `fusion-deepin-launcher-window ${themeClass(s)}`,
            style: surfaceStyle(s),
            reactive: true,
            x, y, width: WINDOW_W, height: WINDOW_H,
        });
        addBlur(win, s, 40);
        this._root.add_child(win);
        this._backgrounds = [];

        // Left third: category or A–Z list, then Settings and Power.
        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-win-left', width: 250});
        const head = new St.BoxLayout({style_class: 'fusion-deepin-win-head'});
        head.add_child(new St.Label({text: _('Categories'), style_class: 'fusion-deepin-win-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._listMode = 'category';
        const switchBox = new St.BoxLayout({style_class: 'fusion-deepin-switch'});
        const modeButton = (mode, child, name) => {
            const b = new St.Button({
                style_class: 'fusion-deepin-switch-item', can_focus: true, toggle_mode: true,
                checked: this._listMode === mode, accessible_name: name, child,
            });
            b.connect('clicked', () => {
                this._listMode = mode;
                switchBox.get_children().forEach(c => (c.checked = c === b));
                this._fillList();
            });
            return b;
        };
        switchBox.add_child(modeButton('category', new St.Icon({icon_name: 'view-list-bullet-symbolic', icon_size: 14}), _('By category')));
        switchBox.add_child(modeButton('letter', new St.Label({text: 'A–Z'}), _('By name')));
        head.add_child(switchBox);
        left.add_child(head);
        this._list = new St.ScrollView({style_class: 'fusion-deepin-win-list', y_expand: true, hscrollbar_policy: St.PolicyType.NEVER});
        left.add_child(this._list);
        const bar = new St.BoxLayout({style_class: 'fusion-deepin-win-bar'});
        const barButton = (icon, name, fn) => {
            const b = new St.Button({style_class: 'fusion-deepin-round-button', can_focus: true, accessible_name: name,
                child: new St.Icon({icon_name: icon, icon_size: 16})});
            b.connect('clicked', fn);
            return b;
        };
        bar.add_child(barButton('emblem-system-symbolic', _('Settings'), () => {
            this.close();
            openSettingsPanel();
        }));
        bar.add_child(new St.Widget({x_expand: true}));
        const power = barButton('system-shutdown-symbolic', _('Power'), () => this._openPowerMenu(power));
        bar.add_child(power);
        left.add_child(bar);
        win.add_child(left);

        // Right two thirds: search, favourites, all apps.
        const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-win-right', x_expand: true});
        const top = new St.BoxLayout({style_class: 'fusion-deepin-win-top'});
        this._entry = this._searchEntry('fusion-deepin-search-win');
        this._entry.x_expand = true;
        top.add_child(this._entry);
        top.add_child(barButton('view-fullscreen-symbolic', _('Fullscreen mode'), () => this._switchMode()));
        right.add_child(top);
        this._winScroll = new St.ScrollView({style_class: 'fusion-deepin-win-scroll', y_expand: true, hscrollbar_policy: St.PolicyType.NEVER});
        right.add_child(this._winScroll);
        win.add_child(right);

        this._winTile = Math.floor((WINDOW_W - 250 - 60) / WINDOW_COLS) - 4;
        this._fillList();
        this._fillWindowed();
    }

    _openPowerMenu(source) {
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('fusion-deepin-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menus.addMenu(menu);
        const sys = SystemActions.getDefault();
        const act = (label, icon, fn) => menu.addAction(label, () => {
            this.close();
            fn();
        }, icon);
        act(_('Lock'), 'system-lock-screen-symbolic', () => sys.activateLockScreen());
        act(_('Log Out'), 'system-log-out-symbolic', () => sys.activateLogout());
        act(_('Suspend'), 'media-playback-pause-symbolic', () => sys.activateSuspend());
        act(_('Restart…'), 'system-reboot-symbolic', () => sys.activateRestart());
        act(_('Power Off…'), 'system-shutdown-symbolic', () => sys.activatePowerOff());
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    _fillList() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-list'});
        const header = (text, icon) => {
            const h = new St.BoxLayout({style_class: 'fusion-deepin-list-header'});
            if (icon)
                h.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
            h.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(h);
        };
        if (this._listMode === 'category') {
            for (const c of CATEGORIES) {
                const apps = this._apps.filter(a => categoryOf(a) === c.id);
                if (!apps.length)
                    continue;
                header(categoryName(c), c.icon);
                apps.forEach(a => box.add_child(this._row(a)));
            }
        } else {
            let letter = null;
            for (const a of this._apps) {
                const first = a.get_name().charAt(0).toUpperCase();
                const l = /[A-Z]/.test(first) ? first : '#';
                if (l !== letter) {
                    letter = l;
                    header(l, null);
                }
                box.add_child(this._row(a));
            }
        }
        this._list.set_child(box);
    }

    _section(title, apps, emptyText = '') {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-win-section'});
        box.add_child(new St.Label({text: title, style_class: 'fusion-deepin-win-title'}));
        if (apps.length) {
            box.add_child(this._grid(apps, WINDOW_COLS, this._winTile, 48, 4));
        } else if (emptyText) {
            box.add_child(new St.Label({text: emptyText, style_class: 'fusion-deepin-empty-hint'}));
        }
        return box;
    }

    _fillWindowed() {
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-win-content'});
        const q = this._query();
        if (q) {
            const found = this._apps.filter(a => matchesSearch(a, q));
            content.add_child(this._section(_('Search results'), found, _('No search results')));
        } else {
            const favs = AppFavorites.getAppFavorites().getFavorites().filter(a => a.get_app_info()?.should_show());
            content.add_child(this._section(_('My Favorites'), favs, _('Add your favourite apps here')));
            // Most used first, like Deepin's windowed "All Apps".
            const usage = Shell.AppUsage.get_default();
            const all = [...this._apps].sort((a, b) => usage.compare(a.get_id(), b.get_id()) ||
                a.get_name().localeCompare(b.get_name()));
            content.add_child(this._section(_('All Apps'), all));
        }
        this._winScroll.set_child(content);
        this._content = content;
    }

    destroy() {
        Main.overview.disconnectObject(this);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.isOpen = false;
        this._root?.destroy();
        this._root = null;
        this._entry = null;
    }
}
