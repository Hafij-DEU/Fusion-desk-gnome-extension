// Start menu layouts. Each builds `this.actor` from the shared widgets and
// handles its own views; MenuHost picks one from the `menu-layout` setting.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as W from './widgets.js';
import {AppHubPanel, appHubInstalled, hubBadgeIcon} from './appHub.js';

class BaseLayout {
    static searchMovable = true;
    static searchBottom = false; // default when menu-search-position is AUTO

    constructor(ctx, id) {
        this.ctx = ctx;
        this.model = ctx.model;
        this.settings = ctx.settings;
        this.actor = W.vbox(`fusion-sm fusion-sm-${id}`);
        this._catButtons = new Map();
    }

    get columns() {
        return this.settings.get_int('menu-pinned-columns') || this.constructor.columns;
    }

    get hover() {
        return this.settings.get_boolean('menu-hover-categories');
    }

    /** App Hub panel: only while App Hub is installed (and the setting is on). */
    get showHub() {
        return this.settings.get_boolean('menu-show-apphub') && appHubInstalled();
    }

    /** Search entry wired to showResults()/hideResults(). */
    _makeSearch(hint) {
        const entry = this.search = W.searchEntry(hint);
        entry.clutter_text.connect('text-changed', () => {
            const q = entry.text.trim();
            if (q)
                this.showResults(q);
            else
                this.hideResults();
        });
        entry.clutter_text.connect('activate', () => {
            const first = W.firstButton(this._resultsBox ?? this.actor);
            first?.emit('clicked', Clutter.BUTTON_PRIMARY);
        });
        entry.clutter_text.connect('key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab) {
                W.firstButton(this.focusTarget())?.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return entry;
    }

    /** Results list living in its own scroll view (hidden until a query). */
    _makeResults() {
        this._resultsBox = W.vbox('fusion-sm-results');
        this._resultsScroll = W.scrollView(this._resultsBox, 'fusion-sm-scroll fusion-sm-results-scroll', {visible: false});
        return this._resultsScroll;
    }

    showResults(q) {
        W.renderSearch(this.ctx, this._resultsBox, q);
        this._resultsScroll.vadjustment.value = 0;
        this._resultsScroll.show();
        for (const a of this.mainViews())
            a.hide();
    }

    hideResults() {
        this._resultsScroll.hide();
        this._resultsBox.destroy_all_children();
        for (const a of this.mainViews())
            a.show();
    }

    /** Actors hidden while search results show. */
    mainViews() {
        return [];
    }

    focusTarget() {
        return this._resultsScroll?.visible ? this._resultsBox : this.actor;
    }

    /** Move the search entry to the bottom when the user asked for it. */
    _placeSearch() {
        const pos = this.settings.get_string('menu-search-position');
        const bottom = pos === 'BOTTOM' || (pos === 'AUTO' && this.constructor.searchBottom);
        if (!this.constructor.searchMovable || !bottom)
            return;
        const parent = this.search.get_parent();
        parent.remove_child(this.search);
        parent.add_child(this.search);
        this.search.add_style_class_name('fusion-sm-search-bottom');
    }

    _catButton(name, icon, onSelect, {style = 'fusion-sm-cat', vertical = false} = {}) {
        const button = new St.Button({style_class: style, can_focus: true, track_hover: true, x_expand: !vertical && style !== 'fusion-sm-chip',
            accessible_name: name});
        const box = vertical ? W.vbox('fusion-sm-cat-box', {x_align: Clutter.ActorAlign.CENTER})
            : W.hbox('fusion-sm-cat-box', {x_expand: true});
        const i = new St.Icon({icon_name: icon, icon_size: 16, fallback_icon_name: 'applications-other-symbolic'});
        if (vertical)
            i.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(i);
        const text = W.label(name, 'fusion-sm-cat-label', vertical ? {x_align: Clutter.ActorAlign.CENTER} : {});
        if (style === 'fusion-sm-chip')
            text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(text);
        button.set_child(box);
        const select = () => {
            if (this.search?.text)
                this.search.text = '';
            this._select(name);
            onSelect();
        };
        button.connect('clicked', select);
        button.connect('key-focus-in', select);
        if (this.hover) {
            button.connect('notify::hover', () => {
                if (button.hover && this._current !== name)
                    select();
            });
        }
        this._catButtons.set(name, button);
        return button;
    }

    _select(name) {
        this._current = name;
        for (const [n, b] of this._catButtons) {
            if (n === name)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
    }

    _fillList(box, scroll, items) {
        box.destroy_all_children();
        scroll.vadjustment.value = 0;
        items.forEach(a => box.add_child(a));
    }

    _pinnedOrHint(apps) {
        return apps.length ? null : W.emptyLabel('Right-click any app to pin it here.');
    }

    get defaultAll() {
        return this.settings.get_string('menu-default-view') === 'ALL';
    }

    onOpen() {
        if (this.search)
            this.search.text = '';
        this.reset();
    }

    /** Back to the default view (called on open and when pins change). */
    reset() {}

    destroy() {
        this.actor.destroy();
    }
}

// ---- Fusion: categories | content | places ----------------------------------

class FusionLayout extends BaseLayout {
    static title = 'Fusion';
    static size = [900, 600];
    static columns = 5;

    /** Pinned columns that fit beside the category (180px) and places (190px) columns. */
    get columns() {
        const width = this.settings.get_int('menu-width') || this.constructor.size[0];
        const fit = Math.max(2, Math.floor((width - 180 - 190 - 70) / 98));
        const wanted = this.settings.get_int('menu-pinned-columns') || this.constructor.columns;
        return Math.min(wanted, fit);
    }

    constructor(ctx) {
        super(ctx, 'fusion');
        const s = this.settings;
        this.actor.add_child(this._makeSearch());

        const body = W.hbox('fusion-sm-body', {y_expand: true});
        this.actor.add_child(body);

        this._cats = W.vbox('fusion-sm-cats');
        body.add_child(W.scrollView(this._cats, 'fusion-sm-scroll fusion-sm-cat-scroll', {x_expand: false}));

        this._content = W.vbox('fusion-sm-content');
        this._contentScroll = W.scrollView(this._content, 'fusion-sm-scroll fusion-sm-content-scroll');
        body.add_child(this._contentScroll);
        this._resultsBox = this._content;

        if (s.get_boolean('menu-show-user') || s.get_boolean('menu-show-places') || s.get_boolean('menu-show-shortcuts'))
            body.add_child(this._buildSide());

        const footer = W.hbox('fusion-sm-footer');
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(W.powerRow(this.ctx));
        this.actor.add_child(footer);
        this._placeSearch();
    }

    _buildSide() {
        const s = this.settings;
        const side = W.vbox('fusion-sm-side');
        if (s.get_boolean('menu-show-user'))
            side.add_child(W.userChip(this.ctx, {size: 40}));
        if (s.get_boolean('menu-show-places'))
            this.model.places().forEach(p => side.add_child(W.placeRow(this.ctx, p)));
        if (s.get_boolean('menu-show-shortcuts')) {
            side.add_child(new St.Widget({style_class: 'fusion-sm-sep'}));
            this.model.shortcuts().forEach(sc => side.add_child(W.shortcutRow(this.ctx, sc)));
        }
        side.add_child(W.actionRow(this.ctx, 'Fusion Desk settings', 'preferences-system-symbolic', null,
            () => this.ctx.ext.openPreferences(), {size: 16}));
        return W.scrollView(side, 'fusion-sm-scroll fusion-sm-side-scroll', {x_expand: false});
    }

    _views() {
        const s = this.settings;
        const views = [
            ['Pinned', 'view-pin-symbolic', () => {
                const apps = this.model.pinnedApps();
                return [this._pinnedOrHint(apps) ?? W.appGrid(this.ctx, apps, this.columns)];
            }],
            ['All Apps', 'view-app-grid-symbolic', () => [W.alphaList(this.ctx, this.model.apps)]],
        ];
        if (s.get_boolean('menu-show-frequent'))
            views.push(['Frequent', 'document-open-recent-symbolic', () => this.model.frequentApps(12).map(a => W.appRow(this.ctx, a))]);
        if (s.get_boolean('menu-show-recent'))
            views.push(['Recent Files', 'folder-recent-symbolic', () => {
                const files = this.model.recentFiles(25);
                return files.length ? files.map(f => W.fileRow(this.ctx, f)) : [W.emptyLabel('No recent files.')];
            }]);
        if (s.get_boolean('menu-show-notes'))
            views.push(['Notes', 'accessories-text-editor-symbolic', () => [this._notes()]]);
        if (this.showHub)
            views.push(['App Hub', 'system-software-install-symbolic', () => [new AppHubPanel(this.ctx, {scroll: false}).actor]]);
        for (const c of this.model.categories())
            views.push([c.name, c.icon, () => c.apps.map(a => W.appRow(this.ctx, a))]);
        return views;
    }

    reset() {
        this._cats.destroy_all_children();
        this._catButtons.clear();
        const views = this._views();
        for (const [name, icon, build] of views)
            this._cats.add_child(this._catButton(name, icon, () => this._fillList(this._content, this._contentScroll, build())));
        const first = this.defaultAll || !this.model.pinnedApps().length ? views[1] : views[0];
        this._select(first[0]);
        this._fillList(this._content, this._contentScroll, first[2]());
    }

    showResults(q) {
        this._select('@search');
        W.renderSearch(this.ctx, this._content, q);
        this._contentScroll.vadjustment.value = 0;
    }

    hideResults() {
        this.reset();
    }

    focusTarget() {
        return this._content;
    }

    _notes() {
        const entry = new St.Entry({style_class: 'fusion-sm-notes', can_focus: true, x_expand: true, y_expand: true,
            hint_text: 'Quick notes — saved automatically'});
        const text = entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        entry.text = this.settings.get_string('notes');
        text.connect('text-changed', () => {
            if (this._notesId)
                GLib.source_remove(this._notesId);
            this._notesId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._notesId = 0;
                this.settings.set_string('notes', entry.text);
                return GLib.SOURCE_REMOVE;
            });
        });
        entry.connect('destroy', () => {
            if (this._notesId) {
                GLib.source_remove(this._notesId);
                this._notesId = 0;
                this.settings.set_string('notes', entry.text);
            }
        });
        return entry;
    }
}

// ---- Eleven: pinned grid + recommended, "All apps" page --------------------

class ElevenLayout extends BaseLayout {
    static title = 'Modern';
    static size = [660, 700];
    static columns = 6;
    static searchMovable = false;

    constructor(ctx) {
        super(ctx, 'eleven');
        this.actor.add_child(this._makeSearch('Search for apps, settings and documents'));

        this._home = W.vbox('fusion-sm-page', {y_expand: true});
        this._home.add_child(W.heading('Pinned', {label: 'All apps  ›', cb: () => this._showAll()}));
        this._pinned = W.vbox('fusion-sm-pinned');
        this._pinnedScroll = W.scrollView(this._pinned, 'fusion-sm-scroll fusion-sm-pinned-scroll');
        this._home.add_child(this._pinnedScroll);
        this._recHeading = W.heading('Recommended');
        this._home.add_child(this._recHeading);
        this._rec = W.vbox('fusion-sm-recommended');
        this._home.add_child(this._rec);
        this.actor.add_child(this._home);

        this._all = W.vbox('fusion-sm-page', {y_expand: true, visible: false});
        this._all.add_child(W.heading('All apps', {label: '‹  Back', cb: () => this._showHome()}));
        this._allList = W.vbox();
        this._allScroll = W.scrollView(this._allList);
        this._all.add_child(this._allScroll);
        this.actor.add_child(this._all);

        this.actor.add_child(this._makeResults());
        this.actor.add_child(this._footer());
    }

    _footer() {
        const s = this.settings;
        const footer = W.hbox('fusion-sm-footer-bar');
        if (s.get_boolean('menu-show-user'))
            footer.add_child(W.userChip(this.ctx, {size: 32}));
        footer.add_child(new St.Widget({x_expand: true}));
        if (s.get_boolean('menu-show-places')) {
            for (const p of this.model.places().filter(x => ['Documents', 'Downloads', 'Pictures'].includes(x.name)))
                footer.add_child(W.iconButton(this.ctx, p.icon, p.name, () => this.ctx.openUriNow(p.uri)));
        }
        if (s.get_boolean('menu-show-shortcuts')) {
            const settingsApp = this.model.lookup('org.gnome.Settings.desktop');
            if (settingsApp)
                footer.add_child(W.iconButton(this.ctx, 'emblem-system-symbolic', 'Settings', () => settingsApp.activate()));
        }
        if (this.showHub) {
            const hub = W.iconButton(this.ctx, null, 'App Hub', () => this._showHub(), {close: false});
            hub.set_child(hubBadgeIcon(16));
            footer.add_child(hub);
        }
        // Power: one button that unfolds the enabled power actions.
        this._power = W.powerRow(this.ctx);
        this._power.hide();
        footer.add_child(this._power);
        footer.add_child(W.iconButton(this.ctx, 'system-shutdown-symbolic', 'Power', () => {
            this._power.visible = !this._power.visible;
        }, {close: false}));
        return footer;
    }

    mainViews() {
        return [this._home, this._all, this._hubPage].filter(Boolean);
    }

    hideResults() {
        super.hideResults();
        this._all.visible = this._showingAll;
        this._home.visible = !this._showingAll && !this._hubPage;
    }

    _showHub() {
        if (this._hubPage) {
            this._closeHub();
            return;
        }
        this._hubPage = W.vbox('fusion-sm-page', {y_expand: true});
        this._hubPage.add_child(W.heading('', {label: '‹  Back', cb: () => this._closeHub()}));
        this._hubPage.add_child(new AppHubPanel(this.ctx).actor);
        this.actor.insert_child_above(this._hubPage, this._all);
        this._home.hide();
        this._all.hide();
    }

    _closeHub() {
        this._hubPage?.destroy();
        this._hubPage = null;
        this._all.visible = !!this._showingAll;
        this._home.visible = !this._showingAll;
    }

    _showAll() {
        this._showingAll = true;
        this._fillList(this._allList, this._allScroll, [W.alphaList(this.ctx, this.model.apps)]);
        this._home.hide();
        this._all.show();
        W.firstButton(this._allList)?.grab_key_focus();
    }

    _showHome() {
        this._showingAll = false;
        this._all.hide();
        this._allList.destroy_all_children();
        this._home.show();
    }

    reset() {
        this._hubPage?.destroy();
        this._hubPage = null;
        this._power.hide();
        const apps = this.model.pinnedApps();
        this._fillList(this._pinned, this._pinnedScroll, [this._pinnedOrHint(apps) ?? W.appGrid(this.ctx, apps, this.columns)]);

        // Recommended (two per row, 6 slots): newly installed apps, recently
        // opened apps and recent files. Apps and files: up to two rows of apps.
        const mode = this.settings.get_string('menu-recommended');
        const SLOTS = 6;
        const recApps = []; // [app, note]
        if (mode !== 'FILES') {
            const fresh = this.model.newApps(2);
            fresh.forEach(app => recApps.push([app, 'Recently added']));
            const opened = this.settings.get_strv('menu-recent-apps');
            for (const app of this.model.recentApps(SLOTS)) {
                if (!fresh.includes(app))
                    recApps.push([app, opened.includes(app.get_id()) ? 'Recently opened' : 'Frequently used']);
            }
        }
        const files = mode === 'APPS' ? [] : this.model.recentFiles(SLOTS);
        const appSlots = mode === 'APPS' ? SLOTS : mode === 'FILES' ? 0 : Math.max(4, SLOTS - files.length);
        const items = recApps.slice(0, appSlots).map(([app, note]) => W.appRow(this.ctx, app, {size: 28, note}));
        files.slice(0, SLOTS - items.length).forEach(f => items.push(W.fileRow(this.ctx, f, {size: 28, when: true})));
        this._rec.destroy_all_children();
        for (let i = 0; i < items.length; i += 2) {
            // Two equal columns, so rows line up whatever the text length.
            const row = W.hbox('fusion-sm-rec-row', {x_expand: true});
            row.layout_manager.homogeneous = true;
            items.slice(i, i + 2).forEach(b => {
                b.x_expand = true;
                row.add_child(b);
            });
            if (row.get_n_children() < 2)
                row.add_child(new St.Widget({x_expand: true}));
            this._rec.add_child(row);
        }
        this._recHeading.visible = this._rec.visible = items.length > 0;
        if (this.defaultAll)
            this._showAll();
        else
            this._showHome();
    }
}

// ---- Windows: rail | most used + A–Z | pinned tiles ------------------------

class WindowsLayout extends BaseLayout {
    static title = 'Classic';
    static size = [780, 720];
    static columns = 4;
    static searchBottom = true;

    constructor(ctx) {
        super(ctx, 'windows');
        const body = W.hbox('fusion-sm-body', {y_expand: true});
        this.actor.add_child(body);

        body.add_child(this._rail());

        const apps = W.vbox('fusion-sm-win-apps');
        this._appsCol = apps;
        apps.add_child(this._makeSearch('Search…'));
        this._list = W.vbox();
        this._listScroll = W.scrollView(this._list);
        apps.add_child(this._listScroll);
        apps.add_child(this._makeResults());
        body.add_child(apps);

        const tiles = this._right = W.vbox('fusion-sm-win-tiles', {x_expand: true});
        this._pinnedHeading = W.heading('Pinned');
        tiles.add_child(this._pinnedHeading);
        this._tiles = W.vbox();
        this._tilesScroll = W.scrollView(this._tiles);
        tiles.add_child(this._tilesScroll);
        body.add_child(tiles);
        this._placeSearch();
    }

    _railItem(icon, text, action, {close = true, iconActor = null} = {}) {
        const button = new St.Button({style_class: 'fusion-sm-rail-item', can_focus: true, track_hover: true,
            accessible_name: text});
        const box = W.hbox('fusion-sm-rail-box');
        box.add_child(iconActor ?? new St.Icon({icon_name: icon, icon_size: 18, fallback_icon_name: 'image-missing-symbolic'}));
        const l = W.label(text, 'fusion-sm-rail-label', {visible: false});
        box.add_child(l);
        this._railLabels.push(l);
        button.set_child(box);
        button.connect('clicked', () => {
            if (close)
                this.ctx.close();
            action();
        });
        this.ctx.addTooltip(button, text);
        return button;
    }

    _rail() {
        const s = this.settings;
        this._railLabels = [];
        const rail = W.vbox('fusion-sm-rail');
        this._expandItem = this._railItem('open-menu-symbolic', 'Expand', () => this._toggleExtras(), {close: false});
        rail.add_child(this._expandItem);
        rail.add_child(new St.Widget({y_expand: true}));
        if (this.showHub) {
            this._hubItem = this._railItem(null, 'App Hub', () => this._toggleHub(), {close: false, iconActor: hubBadgeIcon(18)});
            rail.add_child(this._hubItem);
        }
        if (s.get_boolean('menu-show-places')) {
            // Files: home folder; the expanded rail lists the other places too.
            for (const p of this.model.places().filter(x => x.name === 'Home'))
                rail.add_child(this._railItem('folder-symbolic', 'Files', () => this.ctx.openUriNow(p.uri)));
        }
        if (s.get_boolean('menu-show-shortcuts')) {
            const settingsApp = this.model.lookup('org.gnome.Settings.desktop');
            if (settingsApp)
                rail.add_child(this._railItem('emblem-system-symbolic', 'Settings', () => settingsApp.activate()));
        }
        // Power: a large labelled list next to the button.
        const power = this._railItem('system-shutdown-symbolic', 'Power', () => {
            this.ctx.showActions(power, 'Power', this.model.powerActions().map(a => [a.icon, a.name, () => {
                this.ctx.close();
                a.activate();
            }]), {style: 'fusion-sm-power-pop', iconSize: 20});
        }, {close: false});
        rail.add_child(power);
        return rail;
    }

    mainViews() {
        return [this._extras ?? this._listScroll];
    }

    /** "Expand": shortcuts, places, drives and bookmarks in place of the app list. */
    _toggleExtras(open = !this._extras) {
        this._extras?.destroy();
        this._extras = null;
        this._expandItem.remove_style_pseudo_class('checked');
        if (!open) {
            this._listScroll.show();
            return;
        }
        const ctx = this.ctx;
        const box = W.vbox('fusion-sm-extras');
        box.add_child(W.heading('', {label: '‹  Back', cb: () => this._toggleExtras(false)}));
        const section = (title, rows) => {
            if (!rows.length)
                return;
            box.add_child(W.heading(title));
            rows.forEach(r => box.add_child(r));
        };
        const shortcuts = this.model.shortcuts().map(sc => W.shortcutRow(ctx, sc));
        shortcuts.push(W.actionRow(ctx, 'Activities Overview', 'view-fullscreen-symbolic', null, () => Main.overview.show(), {size: 16}));
        section('Application Shortcuts', shortcuts);
        section('Places', this.model.places().map(p => W.placeRow(ctx, p)));
        section('Devices', this.model.devices().map(d => {
            // Eject sits next to (not inside) the row button so its click stays separate.
            const row = W.hbox('fusion-sm-device-row', {x_expand: true});
            row.add_child(W.actionRow(ctx, d.name, null, null, () => ctx.openUriNow(d.uri), {gicon: d.gicon, size: 16}));
            if (d.mount.can_eject() || d.mount.can_unmount()) {
                const eject = new St.Button({style_class: 'fusion-sm-round', can_focus: true, accessible_name: `Eject ${d.name}`,
                    child: new St.Icon({icon_name: 'media-eject-symbolic', icon_size: 14}), y_align: Clutter.ActorAlign.CENTER});
                eject.connect('clicked', () => {
                    this.model.ejectOrUnmount(d.mount);
                    row.destroy();
                });
                row.add_child(eject);
            }
            return row;
        }));
        section('Bookmarks', this.model.bookmarks().map(b =>
            W.actionRow(ctx, b.name, 'folder-symbolic', null, () => ctx.openUriNow(b.uri), {size: 16})));
        this._extras = W.scrollView(box);
        this._listScroll.hide();
        this._resultsScroll.hide();
        this._appsCol.insert_child_above(this._extras, this._listScroll);
        this._expandItem.add_style_pseudo_class('checked');
    }

    /** Swap the right side between pinned tiles and the App Hub panel. */
    _toggleHub(open = !this._hub) {
        if (this._hub) {
            this._hub.destroy();
            this._hub = null;
        }
        if (open) {
            this._hub = new AppHubPanel(this.ctx);
            this._right.add_child(this._hub.actor);
            this._hubItem?.add_style_pseudo_class('checked');
        } else {
            this._hubItem?.remove_style_pseudo_class('checked');
        }
        this._pinnedHeading.visible = this._tilesScroll.visible = !open;
    }

    reset() {
        this._toggleHub(false);
        this._toggleExtras(false);
        this._railLabels.forEach(l => l.hide());
        const items = [];
        if (this.settings.get_boolean('menu-show-frequent')) {
            const freq = this.model.frequentApps(8);
            if (freq.length) {
                items.push(W.heading('Frequent Apps'));
                freq.forEach(a => items.push(W.appRow(this.ctx, a, {desc: false})));
            }
        }
        items.push(W.alphaList(this.ctx, this.model.apps));
        this._fillList(this._list, this._listScroll, items);

        const apps = this.model.pinnedApps();
        this._fillList(this._tiles, this._tilesScroll,
            [this._pinnedOrHint(apps) ?? W.appGrid(this.ctx, apps, this.columns, {style: 'fusion-sm-tile fusion-sm-wintile', wrap: true})]);
    }
}

// ---- Mint: favourites bar | categories | apps --------------------------------

class MintLayout extends BaseLayout {
    static title = 'Sidebar';
    static size = [700, 560];
    static columns = 4;

    constructor(ctx) {
        super(ctx, 'mint');
        const top = W.hbox('fusion-sm-mint-top');
        if (this.settings.get_boolean('menu-show-user'))
            top.add_child(W.userChip(this.ctx, {size: 28}));
        top.add_child(this._makeSearch());
        this.actor.add_child(top);

        const body = W.hbox('fusion-sm-body', {y_expand: true});
        this.actor.add_child(body);

        this._favbar = W.vbox('fusion-sm-favbar');
        body.add_child(this._favbar);

        this._cats = W.vbox('fusion-sm-cats');
        this._catScroll = W.scrollView(this._cats, 'fusion-sm-scroll fusion-sm-cat-scroll', {x_expand: false});
        body.add_child(this._catScroll);

        this._list = W.vbox('fusion-sm-content');
        this._listScroll = W.scrollView(this._list, 'fusion-sm-scroll fusion-sm-content-scroll');
        body.add_child(this._listScroll);
        this._resultsBox = this._list;
        this._placeSearch();
    }

    reset() {
        this._favbar.destroy_all_children();
        for (const app of this.model.pinnedApps().slice(0, 9))
            this._favbar.add_child(W.appTile(this.ctx, app, {size: 28, labels: false, style: 'fusion-sm-fav'}));
        this._favbar.add_child(new St.Widget({y_expand: true}));
        for (const a of this.model.powerActions().filter(x => ['lock', 'logout', 'poweroff'].includes(x.id)))
            this._favbar.add_child(W.iconButton(this.ctx, a.icon, a.name, a.activate, {style: 'fusion-sm-fav'}));

        this._cats.destroy_all_children();
        this._catButtons.clear();
        const show = items => this._fillList(this._list, this._listScroll, items);
        const views = [
            ['All Applications', 'view-app-grid-symbolic', () => this.model.apps.map(a => W.appRow(this.ctx, a))],
            ['Favorites', 'starred-symbolic', () => this.model.pinnedApps().map(a => W.appRow(this.ctx, a))],
        ];
        if (this.settings.get_boolean('menu-show-frequent'))
            views.push(['Frequent', 'document-open-recent-symbolic', () => this.model.frequentApps(12).map(a => W.appRow(this.ctx, a))]);
        if (this.settings.get_boolean('menu-show-recent'))
            views.push(['Recent Files', 'folder-recent-symbolic', () => this.model.recentFiles(25).map(f => W.fileRow(this.ctx, f))]);
        if (this.settings.get_boolean('menu-show-places'))
            views.push(['Places', 'folder-symbolic', () => this.model.places().map(p => W.placeRow(this.ctx, p, {size: this.ctx.listSize}))]);
        if (this.showHub)
            views.push(['App Hub', 'system-software-install-symbolic', () => [new AppHubPanel(this.ctx, {scroll: false}).actor]]);
        for (const c of this.model.categories())
            views.push([c.name, c.icon, () => c.apps.map(a => W.appRow(this.ctx, a))]);
        for (const [name, icon, build] of views)
            this._cats.add_child(this._catButton(name, icon, () => show(build())));
        const first = this.defaultAll ? views[0] : views[1];
        this._select(first[0]);
        show(first[2]());
    }

    showResults(q) {
        this._select('@search');
        W.renderSearch(this.ctx, this._list, q);
    }

    hideResults() {
        this.reset();
    }

    focusTarget() {
        return this._list;
    }
}

// ---- Grid: launcher-style app grid with category chips -----------------------

class GridLayout extends BaseLayout {
    static title = 'Launcher Grid';
    static size = [820, 640];
    static columns = 6;

    constructor(ctx) {
        super(ctx, 'grid');
        const top = W.hbox('fusion-sm-grid-top', {x_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._makeSearch('Search'));
        this.actor.add_child(top);

        this._chips = W.hbox('fusion-sm-chips');
        this._chipScroll = new St.ScrollView({style_class: 'fusion-sm-chip-scroll', hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER, overlay_scrollbars: true, x_expand: true});
        this._chipScroll.set_child(this._chips);
        this.actor.add_child(this._chipScroll);

        this._grid = W.vbox('fusion-sm-biggrid');
        this._gridScroll = W.scrollView(this._grid);
        this.actor.add_child(this._gridScroll);
        this.actor.add_child(this._makeResults());

        const footer = W.hbox('fusion-sm-footer-bar');
        if (this.settings.get_boolean('menu-show-user'))
            footer.add_child(W.userChip(this.ctx, {size: 28}));
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(W.powerRow(this.ctx));
        this.actor.add_child(footer);
        this._placeSearch();
    }

    mainViews() {
        return [this._chipScroll, this._gridScroll];
    }

    reset() {
        this._chips.destroy_all_children();
        this._catButtons.clear();
        const size = Math.round(this.ctx.tileSize * 1.3);
        const show = apps => this._fillList(this._grid, this._gridScroll,
            [apps.length ? W.appGrid(this.ctx, apps, this.columns, {size, style: 'fusion-sm-tile fusion-sm-bigtile'}) : W.emptyLabel('Nothing here yet.')]);
        const views = [
            ['All', 'view-app-grid-symbolic', () => this.model.apps],
            ['Pinned', 'view-pin-symbolic', () => this.model.pinnedApps()],
        ];
        if (this.settings.get_boolean('menu-show-frequent'))
            views.push(['Frequent', 'document-open-recent-symbolic', () => this.model.frequentApps(18)]);
        for (const c of this.model.categories())
            views.push([c.name, c.icon, () => c.apps]);
        for (const [name, icon, apps] of views)
            this._chips.add_child(this._catButton(name, icon, () => show(apps()), {style: 'fusion-sm-chip'}));
        const first = this.defaultAll || !this.model.pinnedApps().length ? views[0] : views[1];
        this._select(first[0]);
        show(first[2]());
    }
}

// ---- Runner: Spotlight-style search box ---------------------------------------

class RunnerLayout extends BaseLayout {
    static title = 'Runner';
    static size = [680, 0];
    static columns = 6;
    static searchMovable = false;

    constructor(ctx) {
        super(ctx, 'runner');
        this.actor.add_child(this._makeSearch('Search apps, files, math, >command…'));
        this._frequent = W.vbox('fusion-sm-runner-frequent');
        this.actor.add_child(this._frequent);
        this.actor.add_child(this._makeResults());
    }

    mainViews() {
        return [this._frequent];
    }

    reset() {
        this._frequent.destroy_all_children();
        const apps = this.settings.get_boolean('menu-show-frequent') ? this.model.frequentApps(this.columns) : [];
        const list = apps.length ? apps : this.model.pinnedApps().slice(0, this.columns);
        if (list.length) {
            this._frequent.add_child(W.heading(apps.length ? 'Frequent' : 'Pinned'));
            this._frequent.add_child(W.appGrid(this.ctx, list, this.columns));
        }
    }
}

// ---- Plasma: header, content, tab bar ---------------------------------------------

class PlasmaLayout extends BaseLayout {
    static title = 'Tabbed';
    static size = [600, 640];
    static columns = 4;
    static searchMovable = false;

    constructor(ctx) {
        super(ctx, 'plasma');
        const header = W.hbox('fusion-sm-plasma-header');
        if (this.settings.get_boolean('menu-show-user'))
            header.add_child(W.userChip(this.ctx, {size: 36}));
        header.add_child(this._makeSearch('Search…'));
        this.actor.add_child(header);

        this._view = W.hbox('fusion-sm-plasma-view', {y_expand: true});
        this.actor.add_child(this._view);
        this.actor.add_child(this._makeResults());

        this._tabs = W.hbox('fusion-sm-tabs');
        this.actor.add_child(this._tabs);
    }

    mainViews() {
        return [this._view];
    }

    _tab(name, icon, build) {
        return this._catButton(name, icon, () => {
            this._view.destroy_all_children();
            this._view.add_child(build());
        }, {style: 'fusion-sm-tab', vertical: true});
    }

    _apps() {
        const pane = W.hbox('fusion-sm-body', {x_expand: true, y_expand: true});
        const cats = W.vbox('fusion-sm-cats');
        const list = W.vbox('fusion-sm-content');
        const listScroll = W.scrollView(list, 'fusion-sm-scroll fusion-sm-content-scroll');
        const entries = [['All Applications', 'view-app-grid-symbolic', () => this.model.apps]];
        if (this.settings.get_boolean('menu-show-frequent'))
            entries.push(['Frequent', 'document-open-recent-symbolic', () => this.model.frequentApps(12)]);
        for (const c of this.model.categories())
            entries.push([c.name, c.icon, () => c.apps]);
        const buttons = [];
        for (const [name, icon, apps] of entries) {
            const b = new St.Button({style_class: 'fusion-sm-cat', can_focus: true, track_hover: true, x_expand: true});
            const box = W.hbox('fusion-sm-cat-box');
            box.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
            box.add_child(W.label(name, 'fusion-sm-cat-label'));
            b.set_child(box);
            const pick = () => {
                buttons.forEach(x => x.remove_style_pseudo_class('checked'));
                b.add_style_pseudo_class('checked');
                this._fillList(list, listScroll, apps().map(a => W.appRow(this.ctx, a)));
            };
            b.connect('clicked', pick);
            if (this.hover)
                b.connect('notify::hover', () => b.hover && pick());
            buttons.push(b);
            cats.add_child(b);
        }
        pane.add_child(W.scrollView(cats, 'fusion-sm-scroll fusion-sm-cat-scroll', {x_expand: false}));
        pane.add_child(listScroll);
        buttons[0]?.emit('clicked', Clutter.BUTTON_PRIMARY);
        return pane;
    }

    _places() {
        const box = W.vbox('fusion-sm-content');
        this.model.places().forEach(p => box.add_child(W.placeRow(this.ctx, p, {size: this.ctx.listSize})));
        const files = this.model.recentFiles(12);
        if (files.length) {
            box.add_child(W.heading('Recent files'));
            files.forEach(f => box.add_child(W.fileRow(this.ctx, f)));
        }
        return W.scrollView(box);
    }

    _power() {
        const box = W.vbox('fusion-sm-content');
        for (const a of this.model.powerActions())
            box.add_child(W.actionRow(this.ctx, a.name, a.icon, null, a.activate));
        box.add_child(new St.Widget({style_class: 'fusion-sm-sep'}));
        box.add_child(W.actionRow(this.ctx, 'Fusion Desk settings', 'preferences-system-symbolic', null,
            () => this.ctx.ext.openPreferences()));
        return W.scrollView(box);
    }

    reset() {
        this._tabs.destroy_all_children();
        this._catButtons.clear();
        const fav = this._tab('Favorites', 'starred-symbolic', () => {
            const apps = this.model.pinnedApps();
            return W.scrollView(this._pinnedOrHint(apps) ?? W.appGrid(this.ctx, apps, this.columns));
        });
        const all = this._tab('Applications', 'view-app-grid-symbolic', () => this._apps());
        this._tabs.add_child(fav);
        this._tabs.add_child(all);
        this._tabs.add_child(this._tab('Places', 'folder-symbolic', () => this._places()));
        if (this.showHub)
            this._tabs.add_child(this._tab('App Hub', 'system-software-install-symbolic', () => new AppHubPanel(this.ctx).actor));
        this._tabs.add_child(this._tab('Power', 'system-shutdown-symbolic', () => this._power()));
        (this.defaultAll ? all : fav).emit('clicked', Clutter.BUTTON_PRIMARY);
    }
}

export const LAYOUTS = {
    eleven: ElevenLayout,
    windows: WindowsLayout,
    fusion: FusionLayout,
    mint: MintLayout,
    grid: GridLayout,
    plasma: PlasmaLayout,
    runner: RunnerLayout,
};
