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
import {scaleTree, useScaledStyles} from './scale.js';
import {appHubInstalled, openAppHub} from './appHub.js';

const MENU_W = 1120, MENU_H = 980; // the design's 1341×1173, scaled to fit 1080p
const PANEL_BLUR = 12;
const LEFT_BLUR = 10; // rail and app list
const PINNED_BLUR = 3; // the scene stays almost sharp behind the pinned tiles
// Pinned tiles: columns, icon and name size, width and height (settings menu-galaxy-*).
const TILE_KEYS = ['columns', 'icon-size', 'text-size', 'tile-width', 'tile-height'];
const FREQUENT = 8;
const WIDGET_H = 236; // Today and Quick note
const NOTE_SAVE_MS = 400;
const WIDGET_BLUR = 22;
// Dashboard widgets the Galaxy layout can show under its tiles (setting menu-dash-sections);
// Storage sits in the Pinned header instead.
const WIDGETS = ['calendar', 'note', 'tip'];
const WIDGET_PLACES = 2;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Days of the week as GLib numbers them (1 = Monday … 7 = Sunday).
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WORK_DAYS = [1, 2, 3, 4, 5];
// Entries saved before weekdays could be picked.
const OLD_REPEATS = {once: [], daily: ALL_DAYS, weekdays: WORK_DAYS};
const DOTS = ['#3ec6ff', '#b57bff', '#ffd166', '#4cd08a'];

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

/**
 * Width and height from the menu size settings, 0 where the layout's own
 * size applies. The height setting has a default for the other layouts, so
 * Dashboard and Galaxy only follow it once it was changed.
 */
export function menuSize(settings) {
    const height = settings.get_user_value('menu-height') ? settings.get_int('menu-height') : 0;
    return [settings.get_int('menu-width'), height];
}

/** `helpers`: notesEntry and progressBar from layouts.js (shared with the Dashboard). */
/** Width and root font size times `k` in the inline style (the host sets the unscaled ones). */
export function fitFont(actor, settings, k, width) {
    const base = settings.get_int('menu-font-size');
    let style = (actor.get_style() ?? '').replace(/(^|\s)(width|font-size):[^;]*;/g, ' ');
    style += ` width: ${width}px;`;
    if (base || k !== 1)
        style += ` font-size: ${Math.round((base || 11) * k * 10) / 10}pt;`;
    actor.set_style(style.trim());
}

export function galaxyLayout(BaseLayout, helpers) {
    return class GalaxyLayout extends BaseLayout {
        static title = 'Galaxy';
        static size = [MENU_W, 0]; // height set on open
        static columns = 4;
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
            // The scene is laid out at full size and shrunk as a whole (setting
            // menu-dash-scale), so everything keeps its proportions; the
            // holder takes the shrunk size in the menu.
            // Clipped: the blur behind each panel must not spill past the menu.
            this._scene = new St.Widget({style_class: 'fusion-sm-galaxy-scene', layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true});
            this._holder = new St.Widget({layout_manager: new Clutter.FixedLayout()});
            this._holder.add_child(this._scene);
            this.actor.add_child(this._holder);
            this._scale = 1;
            this._body = W.hbox('fusion-sm-galaxy-body', {x_expand: true, y_expand: true});
            this._scene.add_child(this._body);
            // Rail and app list share one panel; the pinned panel is nearly clear glass.
            const left = W.hbox('fusion-sm-galaxy-left', {y_expand: true});
            const railBox = W.vbox('fusion-sm-galaxy-rail', {y_expand: true});
            railBox.add_child(this._rail());
            const appsBox = W.vbox('fusion-sm-galaxy-apps', {y_expand: true});
            appsBox.add_child(this._appsPane());
            left.add_child(railBox);
            left.add_child(appsBox);
            this._body.add_child(this._panel(left, 'fusion-sm-galaxy-left-panel', {}, LEFT_BLUR));
            // Right: the pinned panel, then widgets and the bar straight on the scene (no panel).
            const right = W.vbox('fusion-sm-galaxy-right', {x_expand: true, y_expand: true});
            const pinned = this._pinnedPane();
            right.add_child(this._panel(pinned, 'fusion-sm-galaxy-pinned', {x_expand: true}, PINNED_BLUR));
            right.add_child(this._widgetHolder);
            right.add_child(this._quickBarBox);
            this._body.add_child(right);
            this._scene.connect('notify::allocation', () => this._queueScene());

            // One look, as designed: deep blue glass whatever the system style.
            this.actor.add_style_class_name('fusion-sm-galaxy-dark');
            this.settings.connectObject('changed::menu-dash-sections', () => this.ctx.menu.isOpen && this._fillTiles(),
                'changed::menu-dash-scale', () => this._rebuild(),
                ...TILE_KEYS.flatMap(k => [`changed::menu-galaxy-${k}`, () => this.ctx.menu.isOpen && this._fillTiles()]),
                'changed::notes', () => this._syncNoteText(),
                'changed::menu-routine', () => !this._routineForm && this._fillEvents(),
                'changed::menu-dash-clock', () => this._fillEvents(), this);
            // Smaller sizes at their source (sharp text): stylesheet copy, code sizes.
            this._k = this.settings.get_int('menu-dash-scale') / 100;
            if (this._k !== 1) {
                this.actor.add_style_class_name('fusion-sm-scaled');
                this._releaseStyles = useScaledStyles(ctx.ext.path, this._k);
                scaleTree(this.actor, this._k);
            }
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
        _panel(content, style, params = {}, radius = PANEL_BLUR) {
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true, ...params});
            const blur = new St.Widget({style_class: 'fusion-sm-galaxy-blur', x_expand: true, y_expand: true});
            blur.add_effect_with_name('fusion-galaxy-blur', new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius, brightness: 1.0}));
            const glass = W.vbox(`fusion-sm-galaxy-panel ${style}`, {x_expand: true, y_expand: true});
            glass.add_child(content);
            holder.add_child(blur);
            holder.add_child(glass);
            holder._blur = blur;
            this._panels.push(holder);
            return holder;
        }

        /** `actor` (a widget card) on a blurred copy of the wallpaper; follows the scene like the panels. */
        _blurred(actor, radius = WIDGET_BLUR) {
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: false});
            const blur = new St.Widget({style_class: 'fusion-sm-galaxy-blur', x_expand: true, y_expand: true});
            blur.add_effect_with_name('fusion-galaxy-blur', new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius, brightness: 0.9}));
            holder.add_child(blur);
            holder.add_child(actor);
            holder._blur = blur;
            this._panels.push(holder);
            holder.connect('destroy', () => {
                this._panels = this._panels.filter(p => p !== holder);
            });
            holder.connect('notify::allocation', () => this._queueScene());
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
            // Stage positions are shrunk by the scale: back to the scene's own units.
            const [scx, scy] = this._scene.get_transformed_position();
            const k = this._scale || 1;
            for (const panel of this._panels) {
                const [px, py] = panel.get_transformed_position();
                panel._blur.set_style(`${bg(Math.round(x0 - (px - scx) / k), Math.round(y0 - (py - scy) / k))} border-radius: 22px;`);
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
            this._tilesTitle.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            head.add_child(this._tilesTitle);
            head.add_child(new St.Widget({x_expand: true}));
            // Storage beside the title; a click opens the detailed card below.
            this._storagePill = this._storageHeader();
            head.add_child(this._storagePill);
            const toggle = W.hbox('fusion-sm-galaxy-toggle');
            this._gridButton = W.iconButton(this.ctx, 'view-grid-symbolic', 'Tiles', () => this._setTilesList(false),
                {style: 'fusion-sm-galaxy-toggle-button', size: 16, close: false});
            this._listButton = W.iconButton(this.ctx, 'view-list-symbolic', 'List', () => this._setTilesList(true),
                {style: 'fusion-sm-galaxy-toggle-button', size: 16, close: false});
            toggle.add_child(this._gridButton);
            toggle.add_child(this._listButton);
            head.add_child(toggle);
            pane.add_child(head);

            this._tiles = W.vbox('fusion-sm-galaxy-tiles');
            this._tilesScroll = W.scrollView(this._tiles, 'fusion-sm-scroll fusion-sm-galaxy-tiles-scroll');
            pane.add_child(this._tilesScroll);
            // Widgets and the bar are placed under the panel by the constructor.
            this._widgetHolder = W.vbox('fusion-sm-galaxy-widget-holder', {x_expand: true});
            this._quickBarBox = this._quickBar();
            return pane;
        }

        _setTilesList(list) {
            this._tilesAsList = list;
            this._fillTiles();
        }

        _tile(app) {
            const s = this.settings;
            const tile = W.appTile(this.ctx, app, {size: s.get_int('menu-galaxy-icon-size'), wrap: true,
                style: 'fusion-sm-tile fusion-sm-galaxy-tile'});
            const width = s.get_int('menu-galaxy-tile-width');
            tile.x_expand = !width;
            if (width)
                tile.set_width(width); // scaled with the menu when the tile joins it
            tile.set_height(s.get_int('menu-galaxy-tile-height')); // the same for every tile
            tile.y_expand = false;
            const name = tile.get_child().get_children().find(c => c.has_style_class_name?.('fusion-sm-tile-label'));
            const style = [];
            if (s.get_int('menu-galaxy-text-size') !== 100)
                style.push(`font-size: ${s.get_int('menu-galaxy-text-size') / 100}em;`);
            if (width)
                style.push(`max-width: ${Math.round((width - 12) * this._k)}px;`);
            name?.set_style(style.join(' ') || null);
            return tile;
        }

        /** A Dashboard-style widget card: title with icon, then its content. */
        _widget(title, emoji, extra = [], subtitle = null) {
            const card = W.vbox('fusion-sm-galaxy-widget', {x_expand: true, y_expand: false, height: WIDGET_H});
            const head = W.hbox('fusion-sm-galaxy-widget-head', {x_expand: true});
            head.add_child(W.label(emoji, 'fusion-sm-galaxy-widget-emoji'));
            const titles = W.vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            card._title = W.label(title, 'fusion-sm-galaxy-widget-title');
            titles.add_child(card._title);
            if (subtitle !== null) {
                card._subtitle = W.label(subtitle, 'fusion-sm-galaxy-widget-sub');
                titles.add_child(card._subtitle);
            }
            head.add_child(titles);
            extra.forEach(a => head.add_child(a));
            card.add_child(head);
            return card;
        }

        // ---- Today: own events and routines -----------------------------------------

        /**
         * Events and routines stored in `menu-routine` (bad entries are skipped):
         * {id, title, description, time "HH:MM", date "YYYY-MM-DD", days}. No
         * days: once, on `date`; days: every one of those weekdays from `date` on.
         */
        _routines() {
            const out = [];
            for (const text of this.settings.get_strv('menu-routine')) {
                try {
                    const r = JSON.parse(text);
                    const days = Array.isArray(r?.days) ? r.days.filter(d => ALL_DAYS.includes(d)) : OLD_REPEATS[r?.repeat];
                    if (r && typeof r.title === 'string' && TIME_RE.test(r.time ?? '') && ISO_RE.test(r.date ?? '') && days) {
                        out.push({id: r.id, title: r.title, description: typeof r.description === 'string' ? r.description : '',
                            time: r.time, date: r.date, days: ALL_DAYS.filter(d => days.includes(d))});
                    }
                } catch {
                    // A broken entry: ignore it.
                }
            }
            return out;
        }

        _saveRoutines(list) {
            try {
                this.settings.set_strv('menu-routine', list.map(r => JSON.stringify(r)));
                return true;
            } catch (e) {
                console.error('Fusion Desk: saving the routine failed', e);
                return false;
            }
        }

        /** Entries on the day `offset` days from today, by time. */
        _routinesOn(offset) {
            const date = this._dayDate(offset);
            const iso = date.format('%F');
            const weekday = date.get_day_of_week();
            return this._routines().filter(r => r.days.length ? r.days.includes(weekday) && r.date <= iso : r.date === iso)
                .sort((a, b) => a.time.localeCompare(b.time));
        }

        /** Local midnight `offset` days from today. */
        _dayDate(offset) {
            const [day] = D.dayRange(offset);
            return GLib.DateTime.new_from_unix_local(Math.floor(day.getTime() / 1000));
        }

        /** "14:30" or "2:30 PM", following the Dashboard clock setting. */
        _timeText(hhmm) {
            const [h, m] = hhmm.split(':').map(Number);
            const t = GLib.DateTime.new_local(2000, 1, 1, h, m, 0);
            return t.format(D.twelveHour(this.settings) ? '%-l:%M %p' : '%H:%M');
        }

        /** "Every day", "Weekdays", "Weekends" or "Mon, Wed, Fri"; '' for once. */
        _daysText(days) {
            const same = list => days.length === list.length && list.every(d => days.includes(d));
            if (!days.length)
                return '';
            if (same(ALL_DAYS))
                return 'Every day';
            if (same(WORK_DAYS))
                return 'Weekdays';
            if (same([6, 7]))
                return 'Weekends';
            return days.map(d => this._weekdayName(d)).join(', ');
        }

        /** Short weekday name in the user's language (1 = Monday). */
        _weekdayName(d) {
            return GLib.DateTime.new_local(2024, 1, d, 12, 0, 0).format('%a'); // 1 January 2024 was a Monday
        }

        _isoDate(iso) {
            const [y, m, d] = iso.split('-').map(Number);
            return GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        }

        /** "Friday, October 23 · 6:00 AM" or "Mon, Wed · from Oct 23 · 6:00 AM". */
        _whenText(r) {
            const date = this._isoDate(r.date);
            const time = this._timeText(r.time);
            if (!r.days.length)
                return `${date.format('%A, %B %-d, %Y')} · ${time}`;
            return `${this._daysText(r.days)} · from ${date.format('%b %-d')} · ${time}`;
        }

        _calendarWidget() {
            this._dayOffset ??= 0;
            const nav = (icon, name, step) => {
                const b = W.iconButton(this.ctx, icon, name, () => {
                    this._dayOffset += step;
                    this._openRoutine = null;
                    this._fillEvents();
                }, {style: 'fusion-sm-round fusion-sm-galaxy-day-nav', size: 14, close: false});
                b.y_align = Clutter.ActorAlign.CENTER; // round, not stretched to the row
                return b;
            };
            const card = this._widget('Today', '📅', [nav('go-previous-symbolic', 'Previous day', -1),
                nav('go-next-symbolic', 'Next day', 1)], '');
            this._eventCard = card;
            this._eventList = W.vbox('fusion-sm-galaxy-events', {x_expand: true, y_expand: true});
            card.add_child(this._eventList);
            const addButton = new St.Button({style_class: 'fusion-sm-galaxy-open', can_focus: true, track_hover: true, x_expand: true,
                accessible_name: 'Add event or routine'});
            const line = W.hbox('fusion-sm-galaxy-open-box', {x_expand: true});
            line.add_child(new St.Icon({icon_name: 'list-add-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
            line.add_child(W.label('Add event or routine', 'fusion-sm-galaxy-open-label', {x_expand: true}));
            addButton.set_child(line);
            addButton.connect('clicked', () => this._editRoutine(null));
            card.add_child(addButton);
            this._fillEvents();
            return card;
        }

        /** Open the editor in the widget row: a new entry (null) or `r`. */
        _editRoutine(r) {
            this._routineForm = {edit: r};
            this._fillWidgets();
        }

        _closeEditor() {
            this._routineForm = false;
            this._fillWidgets();
        }

        _fillEvents() {
            if (!this._eventList || !this._eventList.get_parent())
                return;
            const offset = this._dayOffset ?? 0;
            const names = {'-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow'};
            const when = this._dayDate(offset);
            this._eventCard._title.text = names[offset] ?? when.format('%A');
            this._eventCard._subtitle.text = when.format('%A, %B %-d');
            this._eventList.destroy_all_children();
            const items = this._routinesOn(offset);
            if (!items.length) {
                const l = W.label('Nothing planned. Add an event or a daily routine below.', 'fusion-sm-galaxy-empty');
                l.clutter_text.line_wrap = true;
                this._eventList.add_child(l);
                return;
            }
            const list = W.vbox('fusion-sm-galaxy-event-list', {x_expand: true});
            items.forEach((r, i) => list.add_child(this._routineRow(r, i)));
            this._eventList.add_child(W.scrollView(list, 'fusion-sm-scroll fusion-sm-galaxy-event-scroll'));
        }

        /** One entry; a click shows its description, date and weekdays, with Edit. */
        _routineRow(r, i) {
            const open = this._openRoutine === r.id;
            const row = new St.Button({style_class: 'fusion-sm-galaxy-event', can_focus: true, track_hover: true, x_expand: true,
                accessible_name: `${r.title}, ${this._whenText(r)}`});
            const box = W.vbox('fusion-sm-galaxy-event-box', {x_expand: true});
            const line = W.hbox('fusion-sm-galaxy-event-line', {x_expand: true});
            line.add_child(new St.Widget({style_class: 'fusion-sm-galaxy-event-dot', y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: ${DOTS[i % DOTS.length]};`}));
            line.add_child(W.label(this._timeText(r.time), 'fusion-sm-galaxy-event-time', {y_align: Clutter.ActorAlign.CENTER}));
            const text = W.vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(W.label(r.title, 'fusion-sm-galaxy-event-name'));
            const repeat = this._daysText(r.days);
            if (repeat)
                text.add_child(W.label(repeat, 'fusion-sm-galaxy-event-repeat'));
            line.add_child(text);
            line.add_child(new St.Icon({icon_name: open ? 'pan-up-symbolic' : 'pan-down-symbolic', icon_size: 12,
                style_class: 'fusion-sm-galaxy-event-more', y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(line);
            if (open) {
                const detail = W.vbox('fusion-sm-galaxy-event-detail', {x_expand: true});
                detail.add_child(W.label(this._whenText(r), 'fusion-sm-galaxy-event-when'));
                const desc = W.label(r.description || 'No description', r.description ? 'fusion-sm-galaxy-event-desc'
                    : 'fusion-sm-galaxy-event-desc fusion-sm-galaxy-event-nodesc');
                desc.clutter_text.line_wrap = true;
                detail.add_child(desc);
                const actions = W.hbox('fusion-sm-galaxy-form-line', {x_align: Clutter.ActorAlign.END});
                const chip = (icon, label, fn) => {
                    const b = new St.Button({style_class: 'fusion-sm-galaxy-chip fusion-sm-galaxy-chip-small', can_focus: true,
                        track_hover: true, accessible_name: label});
                    const c = W.hbox('fusion-sm-galaxy-chip-box');
                    c.add_child(new St.Icon({icon_name: icon, icon_size: 12, y_align: Clutter.ActorAlign.CENTER}));
                    c.add_child(W.label(label, '', {y_align: Clutter.ActorAlign.CENTER}));
                    b.set_child(c);
                    b.connect('clicked', fn);
                    return b;
                };
                actions.add_child(chip('edit-delete-symbolic', 'Remove', () => {
                    this._saveRoutines(this._routines().filter(x => x.id !== r.id));
                    this._openRoutine = null;
                    this._fillEvents();
                }));
                actions.add_child(chip('document-edit-symbolic', 'Edit', () => this._editRoutine(r)));
                detail.add_child(actions);
                box.add_child(detail);
            }
            row.set_child(box);
            row.connect('clicked', () => {
                this._openRoutine = open ? null : r.id;
                this._fillEvents();
            });
            return row;
        }

        /**
         * The event editor, across the widget row: title, description, date,
         * time (12- or 24-hour, as the clock setting) and the weekdays it repeats on.
         */
        _routineEditor(r) {
            const twelve = D.twelveHour(this.settings);
            let date = r ? this._isoDate(r.date) : this._dayDate(this._dayOffset ?? 0);
            const days = new Set(r?.days ?? []);
            const next = GLib.DateTime.new_now_local().add_hours(1);
            let [hour, minute] = r ? r.time.split(':').map(Number) : [next.get_hour(), 0];
            let pm = hour >= 12;

            const card = this._widget(r ? 'Edit event' : 'New event', '🗓️', [], '');
            card.add_style_class_name('fusion-sm-galaxy-routine-card');
            const form = W.vbox('fusion-sm-galaxy-routine-form', {x_expand: true, y_expand: true});
            card.add_child(form);
            const entry = (hint, text, extra = '') => new St.Entry({style_class: `fusion-sm-galaxy-input ${extra}`, hint_text: hint,
                text, can_focus: true, x_expand: !extra});

            // Title and description
            const names = W.hbox('fusion-sm-galaxy-form-line', {x_expand: true});
            const title = entry('Event name, e.g. Research meeting', r?.title ?? '');
            const description = entry('Description (optional)', r?.description ?? '');
            names.add_child(title);
            names.add_child(description);
            form.add_child(names);

            // Date and time
            const when = W.hbox('fusion-sm-galaxy-form-line', {x_expand: true});
            const dateLabel = W.label('', 'fusion-sm-galaxy-date-label', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            const step = (icon, name, n) => {
                const b = W.iconButton(this.ctx, icon, name, () => {
                    date = date.add_days(n);
                    sync();
                }, {style: 'fusion-sm-round fusion-sm-galaxy-day-nav', size: 12, close: false});
                b.y_align = Clutter.ActorAlign.CENTER;
                return b;
            };
            const datePicker = W.hbox('fusion-sm-galaxy-stepper', {x_expand: true});
            datePicker.add_child(W.label('Date', 'fusion-sm-galaxy-form-label', {y_align: Clutter.ActorAlign.CENTER}));
            datePicker.add_child(step('go-previous-symbolic', 'Day before', -1));
            datePicker.add_child(dateLabel);
            datePicker.add_child(step('go-next-symbolic', 'Day after', 1));
            when.add_child(datePicker);
            const timeBox = W.hbox('fusion-sm-galaxy-stepper');
            timeBox.add_child(W.label('Time', 'fusion-sm-galaxy-form-label', {y_align: Clutter.ActorAlign.CENTER}));
            const shownHour = () => twelve ? (hour % 12 || 12) : hour;
            const hourEntry = entry(twelve ? '9' : '09', String(shownHour()).padStart(twelve ? 1 : 2, '0'), 'fusion-sm-galaxy-num-input');
            const minuteEntry = entry('00', String(minute).padStart(2, '0'), 'fusion-sm-galaxy-num-input');
            timeBox.add_child(hourEntry);
            timeBox.add_child(W.label(':', 'fusion-sm-galaxy-form-label', {y_align: Clutter.ActorAlign.CENTER}));
            timeBox.add_child(minuteEntry);
            const ampm = new St.Button({style_class: 'fusion-sm-galaxy-chip fusion-sm-galaxy-ampm', can_focus: true, track_hover: true,
                accessible_name: 'AM or PM'});
            ampm.connect('clicked', () => {
                pm = !pm;
                sync();
            });
            if (twelve)
                timeBox.add_child(ampm);
            when.add_child(timeBox);
            form.add_child(when);

            // Weekdays it repeats on (none: only on the date)
            const repeatLine = W.hbox('fusion-sm-galaxy-form-line fusion-sm-galaxy-days', {x_expand: true});
            repeatLine.add_child(W.label('Repeat', 'fusion-sm-galaxy-form-label', {y_align: Clutter.ActorAlign.CENTER}));
            const dayButtons = ALL_DAYS.map(d => {
                const b = new St.Button({style_class: 'fusion-sm-galaxy-chip fusion-sm-galaxy-day', label: this._weekdayName(d),
                    can_focus: true, track_hover: true, toggle_mode: true, accessible_name: `Repeat on ${this._weekdayName(d)}`});
                b.connect('clicked', () => {
                    if (days.has(d))
                        days.delete(d);
                    else
                        days.add(d);
                    sync();
                });
                repeatLine.add_child(b);
                return b;
            });
            const presets = [['Once', []], ['Every day', ALL_DAYS], ['Weekdays', WORK_DAYS]].map(([label, list]) => {
                const b = new St.Button({style_class: 'fusion-sm-galaxy-chip fusion-sm-galaxy-preset', label, can_focus: true,
                    track_hover: true});
                b.connect('clicked', () => {
                    days.clear();
                    list.forEach(d => days.add(d));
                    sync();
                });
                b._days = list;
                return b;
            });
            form.add_child(repeatLine);

            // Repeat presets, message and buttons
            const buttons = W.hbox('fusion-sm-galaxy-form-line', {x_expand: true});
            presets.forEach(b => buttons.add_child(b));
            const message = W.label('', 'fusion-sm-galaxy-form-error', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            buttons.add_child(message);
            const cancel = new St.Button({style_class: 'fusion-sm-galaxy-chip', label: 'Cancel', can_focus: true, track_hover: true});
            const save = new St.Button({style_class: 'fusion-sm-galaxy-chip fusion-sm-galaxy-chip-primary', label: r ? 'Save' : 'Add',
                can_focus: true, track_hover: true});
            cancel.connect('clicked', () => this._closeEditor());
            buttons.add_child(cancel);
            buttons.add_child(save);
            form.add_child(buttons);

            /** Hour and minute from the entries, or null with a message. */
            const readTime = () => {
                const h = hourEntry.text.trim(), m = minuteEntry.text.trim() || '0';
                if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m))
                    return null;
                let hh = Number(h);
                const mm = Number(m);
                if (mm > 59 || (twelve ? hh < 1 || hh > 12 : hh > 23))
                    return null;
                if (twelve)
                    hh = hh % 12 + (pm ? 12 : 0);
                return [hh, mm];
            };
            const sync = () => {
                const list = ALL_DAYS.filter(d => days.has(d));
                dateLabel.text = date.format(list.length ? 'From %a, %b %-d' : '%A, %b %-d');
                ampm.label = pm ? 'PM' : 'AM';
                dayButtons.forEach((b, i) => b.set_checked(days.has(ALL_DAYS[i])));
                presets.forEach(b => b.set_checked(b._days.length === list.length && b._days.every(d => days.has(d))));
                const t = readTime();
                const repeat = this._daysText(list);
                card._subtitle.text = [repeat || date.format('%A, %B %-d'), t ? this._timeText(`${t[0]}:${t[1]}`) : null]
                    .filter(Boolean).join(' · ');
                message.text = '';
            };
            // Scroll on the hour or minute to change it.
            const scroll = (e, field) => e.connect('scroll-event', (_a, ev) => {
                const dir = ev.get_scroll_direction();
                let n = dir === Clutter.ScrollDirection.UP ? 1 : dir === Clutter.ScrollDirection.DOWN ? -1 : 0;
                if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = ev.get_scroll_delta();
                    n = dy < 0 ? 1 : dy > 0 ? -1 : 0;
                }
                const t = readTime();
                if (!n || !t)
                    return Clutter.EVENT_PROPAGATE;
                [hour, minute] = t;
                if (field === 'h') {
                    hour = (hour + n + 24) % 24;
                } else {
                    minute = (Math.floor(minute / 5) * 5 + n * 5 + 60) % 60;
                }
                pm = hour >= 12;
                hourEntry.text = String(shownHour()).padStart(twelve ? 1 : 2, '0');
                minuteEntry.text = String(minute).padStart(2, '0');
                sync();
                return Clutter.EVENT_STOP;
            });
            scroll(hourEntry, 'h');
            scroll(minuteEntry, 'm');
            hourEntry.clutter_text.connect('text-changed', () => sync());
            minuteEntry.clutter_text.connect('text-changed', () => sync());

            const add = () => {
                const name = title.text.trim();
                if (!name) {
                    message.text = 'Type a name for the event.';
                    title.grab_key_focus();
                    return;
                }
                const t = readTime();
                if (!t) {
                    message.text = twelve ? 'Time: hour 1–12, minutes 00–59.' : 'Time: hour 0–23, minutes 00–59.';
                    hourEntry.grab_key_focus();
                    return;
                }
                const list = ALL_DAYS.filter(d => days.has(d));
                const item = {id: r?.id ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, title: name,
                    description: description.text.trim(), time: t.map(n => String(n).padStart(2, '0')).join(':'),
                    date: date.format('%F'), days: list};
                const others = this._routines().filter(x => x.id !== item.id);
                if (!this._saveRoutines([...others, item])) {
                    message.text = 'Could not save the event.';
                    return;
                }
                // Show the day it is on.
                if (!list.length) {
                    const [today] = D.dayRange(0);
                    this._dayOffset = Math.round((date.to_unix() * 1000 - today.getTime()) / 86400000);
                }
                this._openRoutine = item.id;
                this._closeEditor();
            };
            save.connect('clicked', add);
            title.clutter_text.connect('activate', () => description.grab_key_focus());
            description.clutter_text.connect('activate', () => hourEntry.grab_key_focus());
            hourEntry.clutter_text.connect('activate', () => minuteEntry.grab_key_focus());
            minuteEntry.clutter_text.connect('activate', add);
            sync();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (title.get_stage())
                    title.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
            return card;
        }

        // ---- Quick note ---------------------------------------------------------------

        /** Editable note, saved to the `notes` setting shortly after each change (kept across restarts). */
        _noteWidget() {
            const card = this._widget('Quick note', '📝');
            const entry = this._note = new St.Entry({style_class: 'fusion-sm-notes fusion-sm-galaxy-note', can_focus: true,
                x_expand: true, y_expand: true, hint_text: 'Write something down…'});
            const text = entry.clutter_text;
            text.single_line_mode = false;
            text.activatable = false;
            text.line_wrap = true;
            text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            entry.text = this.settings.get_string('notes');
            // A click anywhere in the box (not only on the text) starts editing.
            entry.reactive = true;
            entry.connect('button-press-event', () => {
                if (!text.has_key_focus()) {
                    text.grab_key_focus();
                    text.set_cursor_position(-1);
                }
                return Clutter.EVENT_PROPAGATE;
            });
            card.add_child(entry);
            const status = W.hbox('fusion-sm-galaxy-note-status');
            this._noteIcon = new St.Icon({icon_name: 'object-select-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
            this._noteState = W.label('Saved automatically', 'fusion-sm-item-desc');
            status.add_child(this._noteIcon);
            status.add_child(this._noteState);
            card.add_child(status);
            text.connect('text-changed', () => {
                if (this._noteLoading)
                    return;
                this._setNoteState('Saving…', 'content-loading-symbolic');
                if (this._noteId)
                    GLib.source_remove(this._noteId);
                this._noteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTE_SAVE_MS, () => {
                    this._noteId = 0;
                    this._saveNote();
                    return GLib.SOURCE_REMOVE;
                });
            });
            // Unsaved typing is written when the card goes away (menu rebuilt or closed for good).
            entry.connect('destroy', () => {
                if (this._noteId) {
                    GLib.source_remove(this._noteId);
                    this._noteId = 0;
                    this._saveNote(entry.text);
                }
                if (this._note === entry)
                    this._note = null;
            });
            return card;
        }

        _saveNote(value = this._note?.text) {
            if (value === undefined)
                return;
            try {
                if (this.settings.get_string('notes') !== value)
                    this.settings.set_string('notes', value);
                this._setNoteState('Saved automatically', 'object-select-symbolic');
            } catch (e) {
                console.error('Fusion Desk: saving the quick note failed', e);
                this._setNoteState('Could not save the note', 'dialog-warning-symbolic');
            }
        }

        _setNoteState(text, icon) {
            if (!this._note)
                return;
            this._noteState.text = text;
            this._noteIcon.icon_name = icon;
        }

        /** The note changed elsewhere (another menu, the Dashboard): show it unless typing here. */
        _syncNoteText() {
            if (!this._note || this._noteId || this._note.clutter_text.has_key_focus())
                return;
            const value = this.settings.get_string('notes');
            if (this._note.text !== value) {
                this._noteLoading = true;
                this._note.text = value;
                this._noteLoading = false;
            }
        }

        // ---- Storage ------------------------------------------------------------------

        /** Compact storage in the Pinned header: drive icon, free space, bar, used of total. */
        _storageHeader() {
            const button = new St.Button({style_class: 'fusion-sm-galaxy-storage-pill', can_focus: true, track_hover: true,
                accessible_name: 'Storage (click for details)'});
            const box = W.hbox('fusion-sm-galaxy-storage-pill-box');
            box.add_child(new St.Icon({icon_name: 'drive-harddisk', fallback_icon_name: 'drive-harddisk-symbolic', icon_size: 28,
                y_align: Clutter.ActorAlign.CENTER}));
            const text = W.vbox('', {y_align: Clutter.ActorAlign.CENTER});
            text.add_child(W.label('Storage', 'fusion-sm-galaxy-pill-title'));
            this._pillFree = W.label('…', 'fusion-sm-galaxy-pill-free');
            this._pillFree.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            text.add_child(this._pillFree);
            box.add_child(text);
            const right = W.vbox('fusion-sm-galaxy-pill-right', {y_align: Clutter.ActorAlign.CENTER});
            const [bar, setBar] = helpers.progressBar('fusion-sm-galaxy-storage-bar', {warnFull: true});
            this._pillBar = setBar;
            bar.width = 100;
            right.add_child(bar);
            this._pillUsed = W.label('', 'fusion-sm-galaxy-pill-used');
            this._pillUsed.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            right.add_child(this._pillUsed);
            box.add_child(right);
            button.set_child(box);
            button.connect('clicked', () => {
                this._storageOpen = !this._storageOpen;
                this._fillTiles();
            });
            return button;
        }

        async _fillStorageHeader() {
            this._storagePill.visible = this.settings.get_strv('menu-dash-sections').includes('storage');
            if (!this._storagePill.visible)
                return;
            const disk = await D.homeStorage();
            if (this._destroyed || !this._pillFree.get_stage())
                return;
            if (!disk || !disk.size) {
                this._pillFree.text = 'Unavailable';
                this._pillUsed.text = '';
                this._pillBar(0);
                return;
            }
            this._pillFree.text = `${GLib.format_size(disk.free)} free`;
            this._pillUsed.text = `${GLib.format_size(disk.size - disk.free)} of ${GLib.format_size(disk.size)} used`;
            this._pillBar((disk.size - disk.free) / disk.size);
        }

        /** Storage in detail: free of total, one bar in parts and a legend (as on the Dashboard). */
        _storageDetail() {
            const card = W.vbox('fusion-sm-galaxy-widget fusion-sm-galaxy-storage', {x_expand: true, y_expand: false, height: WIDGET_H});
            const head = W.hbox('fusion-sm-galaxy-storage-head', {x_expand: true});
            head.add_child(new St.Icon({icon_name: 'drive-harddisk', fallback_icon_name: 'drive-harddisk-symbolic', icon_size: 30,
                y_align: Clutter.ActorAlign.CENTER}));
            const text = W.vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(W.label('Storage', 'fusion-sm-galaxy-widget-title'));
            const free = W.label('', 'fusion-sm-galaxy-storage-free');
            text.add_child(free);
            head.add_child(text);
            const analyzer = this.model.lookup('org.gnome.baobab.desktop');
            if (analyzer) {
                head.add_child(W.iconButton(this.ctx, 'go-next-symbolic', 'Disk Usage Analyzer', () => analyzer.activate(),
                    {style: 'fusion-sm-round fusion-sm-galaxy-storage-more', size: 14}));
            }
            card.add_child(head);
            const stack = W.hbox('fusion-sm-dash-stack', {x_expand: true});
            const parts = new Map();
            for (const [id] of [...D.STORAGE_KINDS, ['free']]) {
                const part = new St.Widget({style_class: `fusion-sm-dash-part fusion-sm-dash-part-${id}`, width: 0});
                parts.set(id, part);
                stack.add_child(part);
            }
            card.add_child(stack);
            const legend = W.hbox('fusion-sm-dash-legend', {x_expand: true});
            legend.layout_manager.homogeneous = true;
            const sizes = new Map();
            for (const [id, name] of D.STORAGE_KINDS) {
                const item = W.vbox('fusion-sm-dash-legend-item', {x_expand: true});
                const line = W.hbox('fusion-sm-dash-legend-line');
                line.add_child(new St.Widget({style_class: `fusion-sm-dash-swatch fusion-sm-dash-part-${id}`, y_align: Clutter.ActorAlign.CENTER}));
                const n = W.label(name, 'fusion-sm-dash-legend-name');
                n.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                line.add_child(n);
                item.add_child(line);
                const size = W.label('…', 'fusion-sm-dash-legend-size');
                size.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                sizes.set(id, size);
                item.add_child(size);
                legend.add_child(item);
            }
            card.add_child(legend);

            let shares = {free: 1}, partsId = 0;
            const layout = () => {
                if (partsId)
                    return;
                partsId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    partsId = 0;
                    const width = stack.width;
                    let left = width;
                    const ids = [...parts.keys()];
                    ids.forEach((id, n) => {
                        const w = n === ids.length - 1 ? Math.max(0, left) : Math.round(width * (shares[id] ?? 0));
                        parts.get(id).width = w;
                        left -= w;
                    });
                    return GLib.SOURCE_REMOVE;
                });
            };
            stack.connect('notify::width', layout);
            stack.connect('destroy', () => {
                if (partsId)
                    GLib.source_remove(partsId);
                partsId = 0;
            });
            const fill = async () => {
                const [disk, measured] = await Promise.all([D.homeStorage(),
                    D.storageBreakdown(() => this.ctx.menu.isOpen && card.get_stage() && fill())]);
                if (!disk || this._destroyed || !card.get_stage())
                    return;
                const used = disk.size - disk.free;
                free.text = `${GLib.format_size(disk.free)} free of ${GLib.format_size(disk.size)}`;
                const part = {...(measured ?? {})};
                const known = ['apps', 'documents', 'images', 'videos'].reduce((sum, k) => sum + (part[k] ?? 0), 0);
                part.other = measured ? Math.max(0, used - known) : used;
                shares = {free: disk.free / disk.size};
                for (const [id] of D.STORAGE_KINDS) {
                    shares[id] = (part[id] ?? 0) / disk.size;
                    sizes.get(id).text = measured || id === 'other' ? GLib.format_size(part[id] ?? 0) : '…';
                }
                layout();
            };
            fill().catch(() => {});
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

        /**
         * Today and Quick note (or Daily tip) under the tiles, two places, in
         * the order of the Dashboard content setting. The storage pill's
         * detailed card takes the row while it is open.
         */
        _widgetRow() {
            const row = W.hbox('fusion-sm-galaxy-tile-row fusion-sm-galaxy-widgets', {x_expand: true, y_expand: false});
            row.layout_manager.homogeneous = true;
            this._eventList = null;
            if (this._storageOpen) {
                const detail = new St.Button({style_class: 'fusion-sm-galaxy-widget-button', can_focus: true, track_hover: true,
                    x_expand: true, accessible_name: 'Storage details (click to close)'});
                detail.set_child(this._storageDetail());
                detail.connect('clicked', () => {
                    this._storageOpen = false;
                    this._fillTiles();
                });
                row.add_child(this._blurred(detail));
                return row;
            }
            if (this._routineForm) {
                row.add_child(this._blurred(this._routineEditor(this._routineForm.edit)));
                return row;
            }
            const make = {calendar: () => this._calendarWidget(), note: () => this._noteWidget(), tip: () => this._tipWidget()};
            const ids = this.settings.get_strv('menu-dash-sections').filter(x => WIDGETS.includes(x)).slice(0, WIDGET_PLACES);
            ids.forEach(id => row.add_child(this._blurred(make[id]())));
            for (let n = ids.length; n < WIDGET_PLACES; n++)
                row.add_child(this._blurred(this._freePlace()));
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
                const columns = this.settings.get_int('menu-galaxy-columns');
                const width = this.settings.get_int('menu-galaxy-tile-width');
                for (let i = 0; i < apps.length; i += columns) {
                    // y_expand off: rows keep the tile height instead of sharing the panel's spare room.
                    // Tiles of a set width: rows centred, the last one padded to the same width.
                    const row = W.hbox('fusion-sm-galaxy-tile-row', {x_expand: !width, y_expand: false,
                        x_align: width ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL});
                    row.layout_manager.homogeneous = true;
                    apps.slice(i, i + columns).forEach(app => row.add_child(this._tile(app)));
                    while (row.get_n_children() < columns)
                        row.add_child(new St.Widget(width ? {width} : {x_expand: true}));
                    items.push(row);
                }
            }
            if (!apps.length)
                items.push(this._pinnedOrHint(apps));
            this._fillWidgets();
            this._fillList(this._tiles, this._tilesScroll, items);
        }

        _fillWidgets() {
            const all = this._view === 'all';
            this._widgetHolder.destroy_all_children();
            if (!all)
                this._widgetHolder.add_child(this._widgetRow());
            this._widgetHolder.visible = !all;
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

        /**
         * The menu size setting (every layout), else MENU_W × MENU_H times the
         * size percent; less on small screens.
         */
        _fit() {
            const lm = Main.layoutManager;
            const monitor = (this.ctx.menu.sourceActor && lm.findMonitorForActor(this.ctx.menu.sourceActor)) ?? lm.primaryMonitor;
            const area = monitor ? lm.getWorkAreaForMonitor(monitor.index) : null;
            const k = this._k;
            const [setW, setH] = menuSize(this.settings);
            const h = Math.round(Math.min(setH || MENU_H * k, area?.height - 24 || Infinity));
            const w = Math.round(Math.min(setW || MENU_W * k, area?.width - 24 || Infinity));
            this._scene.set_size(w, h);
            this._holder.set_size(w, h);
            this.actor.set_width(w);
            fitFont(this.actor, this.settings, k, w);
            this._queueScene();
        }

        /** The size setting changed: build the layout again (now, or when the menu closes). */
        _rebuild() {
            this.ctx._dirty = true;
            if (!this.ctx.menu.isOpen)
                this.ctx._rebuildIfDirty?.();
        }

        onOpen() {
            super.onOpen();
            this._fit();
            this._fillStorageHeader().catch(e => console.warn(`Fusion Desk: storage: ${e.message}`));
            this._syncMoon();
            this._queueScene();
        }

        reset() {
            this._storageOpen = false;
            this._dayOffset = 0;
            this._routineForm = false;
            this._openRoutine = null;
            this._show(this.defaultAll ? 'all' : 'home');
        }

        destroy() {
            this._destroyed = true;
            this._releaseStyles?.();
            if (this._noteId) {
                GLib.source_remove(this._noteId);
                this._noteId = 0;
                this._saveNote();
            }
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
