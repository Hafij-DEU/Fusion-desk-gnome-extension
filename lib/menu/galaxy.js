// Galaxy start menu layout: a wallpaper scene behind glass panels. A side
// rail (home, all apps, places, recent files, favourites, settings, dark
// style, power), a frequent + A–Z app list with category tabs and the search
// box, and a pinned tile grid with free widget places and quick actions.
// The class is made by galaxyLayout(BaseLayout), so this file does not import
// layouts.js (which registers it).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as W from './widgets.js';
import * as D from './dashboard.js';
import {pictureSize} from './dashboard.js';
import {appHubInstalled, openAppHub} from './appHub.js';

const MENU_W = 1120, MENU_H = 980; // the design's 1341×1173, scaled to fit 1080p
const PANEL_BLUR = 12;
const TILE_COLUMNS = 4;
const TILE_H = 124;
const FREQUENT = 8;
const WIDGET_PLACES = 3;
const WIDGET_H = 128, NOTE_H = 80;
// Dashboard widgets the Galaxy layout can show under its tiles (setting menu-dash-sections).
const WIDGETS = ['calendar', 'note', 'storage', 'tip'];

// id, label, desktop categories (null = every app)
const TABS = [
    ['all', 'All', null],
    ['work', 'Work', ['Office', 'Development', 'Education', 'Science', 'IDE']],
    ['tools', 'Tools', ['Utility', 'System', 'Settings', 'Accessibility', 'Monitor', 'Core']],
    ['media', 'Media', ['AudioVideo', 'Audio', 'Video', 'Graphics', 'Player']],
    ['web', 'Web', ['Network', 'WebBrowser', 'Email', 'Chat']],
];

function categories(app) {
    return (app.app_info?.get_categories?.() ?? '').split(';').filter(Boolean);
}

/** "Web Browser", "Media Player" …: the app's generic name, or its description. */
function subtitle(app) {
    const info = app.app_info;
    return info?.get_generic_name?.() || info?.get_description?.() || '';
}

/** `helpers`: notesEntry and progressBar from layouts.js (shared with the Dashboard). */
export function galaxyLayout(BaseLayout, helpers) {
    return class GalaxyLayout extends BaseLayout {
        static title = 'Galaxy';
        static size = [MENU_W, 0]; // height set on open
        static columns = TILE_COLUMNS;
        static searchMovable = false;

        constructor(ctx) {
            super(ctx, 'galaxy');
            this._tab = 'all';
            this._view = 'home';
            this._tilesAsList = false;
            this._panels = [];

            const path = GLib.build_filenamev([ctx.ext.path, 'icons', 'galaxy-background.jpg']);
            this._bgUri = GLib.filename_to_uri(path, null);
            this._bgSize = pictureSize(path) ?? [1341, 1173];

            // The wallpaper fills the whole menu; the panels sit on it.
            this._scene = new St.Widget({style_class: 'fusion-sm-galaxy-scene', layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true});
            this.actor.add_child(this._scene);
            this._body = W.hbox('fusion-sm-galaxy-body', {x_expand: true, y_expand: true});
            this._scene.add_child(this._body);
            this._body.add_child(this._panel(this._rail(), 'fusion-sm-galaxy-rail'));
            this._body.add_child(this._panel(this._appsPane(), 'fusion-sm-galaxy-apps'));
            this._body.add_child(this._panel(this._pinnedPane(), 'fusion-sm-galaxy-pinned', {x_expand: true}));
            this._scene.connect('notify::allocation', () => this._queueScene());

            // One look, as designed: deep blue glass whatever the system style.
            this.actor.add_style_class_name('fusion-sm-galaxy-dark');
            this.settings.connectObject('changed::menu-dash-sections', () => this.ctx.menu.isOpen && this._fillTiles(), this);
            this.actor.connect('key-press-event', (_a, event) => {
                // Ctrl+K: search.
                if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) && event.get_key_symbol() === Clutter.KEY_k) {
                    this.search.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        // ---- Panels and scene ------------------------------------------------------

        /** A glass panel: a blurred copy of the wallpaper under translucent glass. */
        _panel(content, style, params = {}) {
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true, ...params});
            const blur = new St.Widget({style_class: 'fusion-sm-galaxy-blur', x_expand: true, y_expand: true});
            blur.add_effect_with_name('fusion-galaxy-blur', new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: PANEL_BLUR, brightness: 1.0}));
            const glass = W.vbox(`fusion-sm-galaxy-panel ${style}`, {x_expand: true, y_expand: true});
            glass.add_child(content);
            holder.add_child(blur);
            holder.add_child(glass);
            holder._blur = blur;
            this._panels.push(holder);
            return holder;
        }

        _queueScene() {
            if (this._sceneId)
                return;
            this._sceneId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._sceneId = 0;
                this._syncScene();
                return GLib.SOURCE_REMOVE;
            });
        }

        /** Wallpaper as "cover" (no stretching, no blank edges), and the same picture under each panel. */
        _syncScene() {
            if (this._destroyed || !this._scene.get_stage())
                return;
            const [sw, sh] = [this._scene.width, this._scene.height];
            if (!sw || !sh)
                return;
            const [iw, ih] = this._bgSize;
            const scale = Math.max(sw / iw, sh / ih);
            const [w, h] = [Math.ceil(iw * scale), Math.ceil(ih * scale)];
            const [x0, y0] = [Math.round((sw - w) / 2), Math.round((sh - h) / 2)];
            const bg = (x, y) => `background-image: url("${this._bgUri}"); background-size: ${w}px ${h}px; background-position: ${x}px ${y}px;`;
            this._scene.set_style(`${bg(x0, y0)} border-radius: ${this._radius()};`);
            const [scx, scy] = this._scene.get_transformed_position();
            for (const panel of this._panels) {
                const [px, py] = panel.get_transformed_position();
                panel._blur.set_style(`${bg(Math.round(x0 - (px - scx)), Math.round(y0 - (py - scy)))} border-radius: 22px;`);
            }
        }

        _radius() {
            const s = this.settings;
            const custom = s.get_string('menu-theme') === 'CUSTOM';
            const r = Math.max(0, custom ? s.get_int('menu-radius') - s.get_int('menu-border-width') : 17);
            const menu = this.ctx.menu.actor;
            if (menu.has_style_class_name('fusion-sm-flush-bottom'))
                return `${r}px ${r}px ${r}px 0`;
            if (menu.has_style_class_name('fusion-sm-flush-top'))
                return `0 ${r}px ${r}px ${r}px`;
            return `${r}px`;
        }

        // ---- Rail ----------------------------------------------------------------------

        _railButton(icon, name, action, {view = null, close = false} = {}) {
            const b = W.iconButton(this.ctx, icon, name, () => action(), {style: 'fusion-sm-galaxy-rail-item', size: 22, close});
            if (view)
                b._view = view;
            return b;
        }

        _rail() {
            const rail = this._railBox = W.vbox('fusion-sm-galaxy-rail-box', {y_expand: true});
            rail.add_child(this._railButton('open-menu-symbolic', 'Activities overview', () => {
                this.ctx.close();
                Main.overview.show();
            }));
            rail.add_child(new St.Widget({style_class: 'fusion-sm-galaxy-rail-gap'}));
            rail.add_child(this._railButton('go-home-symbolic', 'Home', () => this._show('home'), {view: 'home'}));
            rail.add_child(this._railButton('view-app-grid-symbolic', 'All apps', () => this._show('all'), {view: 'all'}));
            rail.add_child(this._railButton('folder-symbolic', 'Places', () => this._show('places'), {view: 'places'}));
            rail.add_child(this._railButton('document-open-recent-symbolic', 'Recent files', () => this._show('recent'), {view: 'recent'}));
            rail.add_child(this._railButton('starred-symbolic', 'Favourites', () => this._show('favourites'), {view: 'favourites'}));
            const settingsApp = this.model.lookup('org.gnome.Settings.desktop');
            if (settingsApp)
                rail.add_child(this._railButton('emblem-system-symbolic', 'Settings', () => settingsApp.activate(), {close: true}));
            rail.add_child(new St.Widget({y_expand: true}));
            // Dark style on / off (GNOME's own setting).
            this._moon = this._railButton('weather-clear-night-symbolic', 'Dark style', () => {
                const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                iface.set_string('color-scheme', iface.get_string('color-scheme') === 'prefer-dark' ? 'default' : 'prefer-dark');
            });
            rail.add_child(this._moon);
            const power = this._railButton('system-shutdown-symbolic', 'Power', () => {
                this.ctx.showActions(power, 'Power', this.model.powerActions().map(a => [a.icon, a.name, () => {
                    this.ctx.close();
                    a.activate();
                }]), {style: 'fusion-sm-power-pop', iconSize: 20});
            });
            rail.add_child(power);
            return rail;
        }

        _syncMoon() {
            const dark = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme') === 'prefer-dark';
            this._moon.child.icon_name = dark ? 'weather-clear-symbolic' : 'weather-clear-night-symbolic';
        }

        _markRail() {
            for (const b of this._railBox.get_children()) {
                if (b._view === this._view)
                    b.add_style_pseudo_class('checked');
                else
                    b.remove_style_pseudo_class('checked');
            }
        }

        // ---- App list pane ------------------------------------------------------------

        _appsPane() {
            const pane = W.vbox('fusion-sm-galaxy-pane', {y_expand: true});
            const head = W.hbox('fusion-sm-galaxy-head', {x_expand: true});
            this._listTitle = W.label('Frequent Apps', 'fusion-sm-galaxy-title', {x_expand: true});
            head.add_child(this._listTitle);
            head.add_child(W.iconButton(this.ctx, 'edit-find-symbolic', 'Search (Ctrl+K)', () => this.search.grab_key_focus(),
                {style: 'fusion-sm-round fusion-sm-galaxy-head-button', size: 18, close: false}));
            head.add_child(W.iconButton(this.ctx, 'preferences-system-symbolic', 'Start menu settings', () => this.ctx.ext.openPreferences(),
                {style: 'fusion-sm-round fusion-sm-galaxy-head-button', size: 18}));
            pane.add_child(head);

            this._tabs = W.hbox('fusion-sm-galaxy-tabs');
            this._tabButtons = new Map();
            for (const [id, name] of TABS) {
                const b = new St.Button({style_class: 'fusion-sm-galaxy-tab', label: name, can_focus: true, track_hover: true});
                b.connect('clicked', () => {
                    this._tab = id;
                    this._show('home');
                });
                this._tabButtons.set(id, b);
                this._tabs.add_child(b);
            }
            pane.add_child(this._tabs);

            this._list = W.vbox('fusion-sm-galaxy-list');
            this._listScroll = W.scrollView(this._list, 'fusion-sm-scroll fusion-sm-galaxy-list-scroll');
            pane.add_child(this._listScroll);
            this._resultsBox = this._list;

            const search = W.hbox('fusion-sm-galaxy-search', {x_expand: true});
            const entry = this._makeSearch('Search apps, files, settings…');
            entry.add_style_class_name('fusion-sm-galaxy-search-entry');
            search.add_child(entry);
            search.add_child(W.label('Ctrl  K', 'fusion-sm-galaxy-key', {y_align: Clutter.ActorAlign.CENTER}));
            pane.add_child(search);
            return pane;
        }

        /** App row: icon, name, kind, pin and ⋮. */
        _appRow(app, {highlight = false} = {}) {
            const row = W.hbox(`fusion-sm-galaxy-row${highlight ? ' highlight' : ''}`, {x_expand: true});
            const main = W.appRow(this.ctx, app, {desc: false, note: subtitle(app) || null, size: 32});
            main.add_style_class_name('fusion-sm-galaxy-row-main');
            // The row has its own pin button: drop appRow's small pin mark.
            main.get_child().get_children().filter(c => c.has_style_class_name?.('fusion-sm-pin')).forEach(c => c.destroy());
            row.add_child(main);
            const pinned = this.model.isPinned(app);
            row.add_child(W.iconButton(this.ctx, 'view-pin-symbolic', pinned ? 'Unpin from Start' : 'Pin to Start', () => {
                this.model.togglePin(app);
                this.reset();
            }, {style: `fusion-sm-round fusion-sm-galaxy-row-pin${pinned ? ' pinned' : ''}`, size: 14, close: false}));
            const more = W.iconButton(this.ctx, 'view-more-symbolic', 'More', () => this.ctx.showAppMenu(more, app),
                {style: 'fusion-sm-round fusion-sm-galaxy-row-more', size: 14, close: false});
            row.add_child(more);
            return row;
        }

        _appsOfTab() {
            const wanted = TABS.find(t => t[0] === this._tab)?.[2];
            return wanted ? this.model.apps.filter(a => categories(a).some(c => wanted.includes(c))) : this.model.apps;
        }

        _fillHomeList() {
            const items = [];
            const apps = this._appsOfTab();
            const set = new Set(apps);
            const frequent = this.model.frequentApps(FREQUENT * 3).filter(a => set.has(a)).slice(0, FREQUENT);
            frequent.forEach((app, i) => items.push(this._appRow(app, {highlight: i === 0})));
            let letter = null;
            for (const app of apps) {
                const first = app.get_name().charAt(0).toUpperCase();
                const l = /[A-Z]/.test(first) ? first : '#';
                if (l !== letter) {
                    letter = l;
                    items.push(W.label(l, 'fusion-sm-galaxy-letter'));
                }
                items.push(this._appRow(app));
            }
            if (!items.length)
                items.push(W.emptyLabel('No apps of this kind.'));
            this._fillList(this._list, this._listScroll, items);
        }

        // ---- Pinned pane ---------------------------------------------------------------

        _pinnedPane() {
            const pane = W.vbox('fusion-sm-galaxy-pane', {y_expand: true});
            const head = W.hbox('fusion-sm-galaxy-head', {x_expand: true});
            this._tilesTitle = W.label('Pinned', 'fusion-sm-galaxy-title');
            head.add_child(this._tilesTitle);
            head.add_child(W.iconButton(this.ctx, 'document-edit-symbolic', 'Edit pinned apps', () => this.ctx.ext.openPreferences(),
                {style: 'fusion-sm-round fusion-sm-galaxy-head-button', size: 16}));
            head.add_child(new St.Widget({x_expand: true}));
            const toggle = W.hbox('fusion-sm-galaxy-toggle');
            this._gridButton = W.iconButton(this.ctx, 'view-grid-symbolic', 'Tiles', () => this._setTilesList(false),
                {style: 'fusion-sm-galaxy-toggle-button', size: 16, close: false});
            this._listButton = W.iconButton(this.ctx, 'view-list-symbolic', 'List', () => this._setTilesList(true),
                {style: 'fusion-sm-galaxy-toggle-button', size: 16, close: false});
            toggle.add_child(this._gridButton);
            toggle.add_child(this._listButton);
            head.add_child(toggle);
            const more = W.iconButton(this.ctx, 'view-more-horizontal-symbolic', 'More', () => {
                this.ctx.showActions(more, '', [
                    ['view-app-grid-symbolic', 'All apps', () => this._show('all'), true],
                    ['view-pin-symbolic', 'Pinned apps', () => this._show('home'), true],
                    ['preferences-system-symbolic', 'Start menu settings', () => {
                        this.ctx.close();
                        this.ctx.ext.openPreferences();
                    }],
                ]);
            }, {style: 'fusion-sm-round fusion-sm-galaxy-head-button', size: 16, close: false});
            head.add_child(more);
            pane.add_child(head);

            this._tiles = W.vbox('fusion-sm-galaxy-tiles');
            this._tilesScroll = W.scrollView(this._tiles, 'fusion-sm-scroll fusion-sm-galaxy-tiles-scroll');
            pane.add_child(this._tilesScroll);
            // Widgets stay at the bottom next to the bar; the tiles above scroll.
            this._widgetHolder = W.vbox('fusion-sm-galaxy-widget-holder', {x_expand: true});
            pane.add_child(this._widgetHolder);
            pane.add_child(this._quickBar());
            return pane;
        }

        _setTilesList(list) {
            this._tilesAsList = list;
            this._fillTiles();
        }

        _tile(app) {
            const tile = W.appTile(this.ctx, app, {size: 44, wrap: true, style: 'fusion-sm-tile fusion-sm-galaxy-tile'});
            tile.x_expand = true;
            tile.set_height(TILE_H); // the same for every tile, two lines of name at most
            tile.y_expand = false;
            return tile;
        }

        /** A Dashboard-style widget card: title with icon, then its content. */
        _widget(title, emoji, extra = []) {
            const card = W.vbox('fusion-sm-galaxy-widget', {x_expand: true, y_expand: false, height: WIDGET_H});
            const head = W.hbox('fusion-sm-galaxy-widget-head', {x_expand: true});
            head.add_child(W.label(emoji, 'fusion-sm-galaxy-widget-emoji'));
            head.add_child(W.label(title, 'fusion-sm-galaxy-widget-title', {x_expand: true}));
            extra.forEach(a => head.add_child(a));
            card.add_child(head);
            return card;
        }

        _calendarWidget() {
            const card = this._widget('Today', '📅');
            const list = W.vbox('fusion-sm-galaxy-events');
            const source = D.eventSource();
            const events = D.todayEvents(source, this.settings).slice(0, 3);
            if (!events.length)
                list.add_child(W.label(source?.hasCalendars ? 'No events today.' : 'No calendars set up.', 'fusion-sm-item-desc'));
            for (const e of events) {
                const line = W.hbox('fusion-sm-galaxy-event');
                line.add_child(W.label(e.time, 'fusion-sm-galaxy-event-time'));
                line.add_child(W.label(e.summary, 'fusion-sm-item-desc', {x_expand: true}));
                list.add_child(line);
            }
            card.add_child(list);
            return card;
        }

        _noteWidget() {
            const card = this._widget('Quick note', '📝');
            const entry = helpers.notesEntry(this.settings, {style: 'fusion-sm-notes fusion-sm-galaxy-note', hint: 'Write something down…'});
            entry.y_expand = false;
            entry.set_height(NOTE_H);
            card.add_child(entry);
            return card;
        }

        _storageWidget() {
            const card = this._widget('Storage', '💾');
            const free = W.label('', 'fusion-sm-galaxy-storage-free');
            const [bar, setBar] = helpers.progressBar('fusion-sm-galaxy-storage-bar', {warnFull: true});
            const used = W.label('', 'fusion-sm-item-desc');
            card.add_child(free);
            card.add_child(bar);
            card.add_child(used);
            D.homeStorage().then(disk => {
                if (!disk || this._destroyed || !free.get_stage())
                    return;
                free.text = `${GLib.format_size(disk.free)} free`;
                used.text = `${GLib.format_size(disk.size - disk.free)} of ${GLib.format_size(disk.size)} used`;
                setBar(disk.size ? (disk.size - disk.free) / disk.size : 0);
            }).catch(() => {});
            return card;
        }

        _tipWidget() {
            const card = this._widget('Daily tip', '💡');
            const l = W.label(D.TIPS[D.tipOfTheDay()], 'fusion-sm-item-desc');
            l.clutter_text.line_wrap = true;
            card.add_child(l);
            return card;
        }

        /** Free widget place: opens the settings where Dashboard parts are switched on. */
        _freePlace() {
            const b = new St.Button({style_class: 'fusion-sm-galaxy-free', can_focus: true, track_hover: true, x_expand: true,
                y_expand: false, height: WIDGET_H, accessible_name: 'Add from dashboard setting'});
            const box = W.vbox('fusion-sm-galaxy-free-box', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(new St.Icon({icon_name: 'list-add-symbolic', icon_size: 22, style_class: 'fusion-sm-galaxy-free-icon',
                x_align: Clutter.ActorAlign.CENTER}));
            const l = W.label('Add from dashboard setting', 'fusion-sm-galaxy-free-label', {x_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            l.clutter_text.line_wrap = true;
            l.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
            box.add_child(l);
            b.set_child(box);
            b.connect('clicked', () => {
                this.ctx.close();
                this.ctx.ext.openPreferences();
            });
            return b;
        }

        /** The Dashboard widgets switched on (Today, Quick note, Storage, Daily tip), then free places. */
        _widgetRow() {
            const row = W.hbox('fusion-sm-galaxy-tile-row fusion-sm-galaxy-widgets', {x_expand: true, y_expand: false});
            row.layout_manager.homogeneous = true;
            const make = {calendar: () => this._calendarWidget(), note: () => this._noteWidget(),
                storage: () => this._storageWidget(), tip: () => this._tipWidget()};
            const shown = this.settings.get_strv('menu-dash-sections').filter(id => WIDGETS.includes(id)).slice(0, WIDGET_PLACES);
            shown.forEach(id => row.add_child(make[id]()));
            while (row.get_n_children() < WIDGET_PLACES)
                row.add_child(this._freePlace());
            return row;
        }

        _fillTiles() {
            const all = this._view === 'all';
            const apps = all ? this.model.apps : this.model.pinnedApps();
            this._tilesTitle.text = all ? 'All apps' : 'Pinned';
            for (const [b, on] of [[this._gridButton, !this._tilesAsList], [this._listButton, this._tilesAsList]]) {
                if (on)
                    b.add_style_pseudo_class('checked');
                else
                    b.remove_style_pseudo_class('checked');
            }
            const items = [];
            if (this._tilesAsList) {
                apps.forEach(app => items.push(this._appRow(app)));
            } else {
                for (let i = 0; i < apps.length; i += TILE_COLUMNS) {
                    // y_expand off: rows keep the tile height instead of sharing the panel's spare room.
                    const row = W.hbox('fusion-sm-galaxy-tile-row', {x_expand: true, y_expand: false});
                    row.layout_manager.homogeneous = true;
                    apps.slice(i, i + TILE_COLUMNS).forEach(app => row.add_child(this._tile(app)));
                    while (row.get_n_children() < TILE_COLUMNS)
                        row.add_child(new St.Widget({x_expand: true}));
                    items.push(row);
                }
            }
            if (!apps.length)
                items.push(this._pinnedOrHint(apps));
            this._widgetHolder.destroy_all_children();
            if (!all)
                this._widgetHolder.add_child(this._widgetRow());
            this._widgetHolder.visible = !all;
            this._fillList(this._tiles, this._tilesScroll, items);
        }

        _quickBar() {
            const bar = W.hbox('fusion-sm-galaxy-quick', {x_expand: true});
            // `open(button)` instead of `fn`: the button opens something inside the menu.
            const action = (icon, name, fn, accent = false, open = null) => {
                const b = new St.Button({style_class: 'fusion-sm-galaxy-quick-item', can_focus: true, track_hover: true, x_expand: true,
                    accessible_name: name});
                const box = W.hbox('fusion-sm-galaxy-quick-box', {x_align: Clutter.ActorAlign.CENTER});
                const glyph = new St.Icon({icon_name: icon, icon_size: accent ? 14 : 18, y_align: Clutter.ActorAlign.CENTER});
                box.add_child(accent ? new St.Bin({style_class: 'fusion-sm-galaxy-quick-accent', y_align: Clutter.ActorAlign.CENTER, child: glyph}) : glyph);
                const l = W.label(name, 'fusion-sm-galaxy-quick-label');
                l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                box.add_child(l);
                b.set_child(box);
                b.connect('clicked', () => (open ? open(b) : this._afterClose(fn)));
                bar.add_child(b);
            };
            if (appHubInstalled())
                action('system-software-install-symbolic', 'App Hub', () => openAppHub());
            action('applications-utilities-symbolic', 'Quick tools', () => {}, false, b => this.ctx.showActions(b, 'Quick tools', [
                ['screenshot-ui-area-symbolic', 'Region screenshot', () => this._afterClose(() => D.openScreenshot('area'))],
                ['camera-photo-symbolic', 'Capture whole screen', () => this._afterClose(() => D.openScreenshot('screen'))],
                ['media-record-symbolic', 'Record screen', () => this._afterClose(() => D.openScreenRecording())],
                ['color-select-symbolic', 'Colour picker', () => this._afterClose(() => D.pickColor())],
            ]));
            action('preferences-desktop-symbolic', 'Fusion Desk settings', () => this.ctx.ext.openPreferences());
            const terminal = this.model.shortcuts().find(sc => sc.name === 'Terminal')?.app;
            if (terminal)
                action('utilities-terminal-symbolic', 'Open Terminal', () => terminal.activate());
            const more = W.iconButton(this.ctx, 'go-next-symbolic', 'More', () => {
                this.ctx.showActions(more, '', [
                    ['document-new-symbolic', 'New file', () => this._afterClose(() => {
                        const editor = Gio.AppInfo.get_default_for_type('text/plain', false);
                        editor?.launch([], global.create_app_launch_context(0, -1));
                    })],
                    ['folder-symbolic', 'Files', () => this.ctx.openUri(GLib.filename_to_uri(GLib.get_home_dir(), null))],
                ]);
            }, {style: 'fusion-sm-round fusion-sm-galaxy-quick-more', size: 16, close: false});
            bar.add_child(more);
            return bar;
        }

        /** Run `fn` once the menu has faded out (screen tools must not see it). */
        _afterClose(fn) {
            this.ctx.close();
            if (this._laterId)
                GLib.source_remove(this._laterId);
            this._laterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._laterId = 0;
                fn();
                return GLib.SOURCE_REMOVE;
            });
        }

        // ---- Views -------------------------------------------------------------------------

        _show(view) {
            this._view = view;
            if (this.search?.text)
                this.search.text = '';
            this._markRail();
            for (const [id, b] of this._tabButtons) {
                if (id === this._tab && view === 'home')
                    b.add_style_pseudo_class('checked');
                else
                    b.remove_style_pseudo_class('checked');
            }
            this._tabs.visible = view === 'home';
            const titles = {home: 'Frequent Apps', all: 'Frequent Apps', places: 'Places', recent: 'Recent files', favourites: 'Favourites'};
            this._listTitle.text = titles[view];
            if (view === 'places') {
                this._fillList(this._list, this._listScroll, this.model.places().map(p => W.placeRow(this.ctx, p, {size: 24})));
            } else if (view === 'recent') {
                const files = this.model.recentFiles(30);
                this._fillList(this._list, this._listScroll,
                    files.length ? files.map(f => W.fileRow(this.ctx, f, {size: 28, when: true})) : [W.emptyLabel('No recent files.')]);
            } else if (view === 'favourites') {
                const apps = this.model.pinnedApps();
                this._fillList(this._list, this._listScroll, apps.length ? apps.map(a => this._appRow(a)) : [this._pinnedOrHint(apps)]);
            } else {
                this._fillHomeList();
            }
            this._fillTiles();
        }

        showResults(q) {
            this._listTitle.text = 'Search';
            this._tabs.hide();
            W.renderSearch(this.ctx, this._list, q);
            this._listScroll.vadjustment.value = 0;
        }

        hideResults() {
            this._show(this._view);
        }

        focusTarget() {
            return this._list;
        }

        /** MENU_H tall and MENU_W wide, or less on small screens. */
        _fit() {
            const lm = Main.layoutManager;
            const monitor = (this.ctx.menu.sourceActor && lm.findMonitorForActor(this.ctx.menu.sourceActor)) ?? lm.primaryMonitor;
            const area = monitor ? lm.getWorkAreaForMonitor(monitor.index) : null;
            this._scene.set_height(Math.min(MENU_H, area ? area.height - 24 : MENU_H));
            this._scene.set_width(Math.min(this.settings.get_int('menu-width') || MENU_W, area ? area.width - 24 : MENU_W));
        }

        onOpen() {
            super.onOpen();
            this._fit();
            this._syncMoon();
            this._queueScene();
        }

        reset() {
            this._show(this.defaultAll ? 'all' : 'home');
        }

        destroy() {
            this._destroyed = true;
            this.settings.disconnectObject(this);
            for (const id of [this._sceneId, this._laterId]) {
                if (id)
                    GLib.source_remove(id);
            }
            this._sceneId = this._laterId = 0;
            super.destroy();
        }
    };
}
