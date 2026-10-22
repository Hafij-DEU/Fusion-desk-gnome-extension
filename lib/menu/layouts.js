// Start menu layouts. Each builds `this.actor` from the shared widgets and
// handles its own views; MenuHost picks one from the `menu-layout` setting.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as W from './widgets.js';
import {fileKind} from './model.js';
import {AppHubPanel, appHubInstalled, hubBadgeIcon} from './appHub.js';
import * as D from './dashboard.js';
import {CosmicScene, StarMotion} from './cosmos.js';
import {DashWeather, REFRESH_SECONDS} from './weather.js';
import {watchSystemStyle} from '../style.js';

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

/** Equal columns of file cards. */
function cardGrid(ctx, files, columns = 2, cardOpts = {}) {
    const grid = W.vbox('fusion-sm-recommended');
    for (let i = 0; i < files.length; i += columns) {
        const row = W.hbox('fusion-sm-rec-row', {x_expand: true});
        row.layout_manager.homogeneous = true;
        files.slice(i, i + columns).forEach(f => row.add_child(W.fileCard(ctx, f, cardOpts)));
        while (row.get_n_children() < columns)
            row.add_child(new St.Widget({x_expand: true}));
        grid.add_child(row);
    }
    return grid;
}

/** Recent files grouped into Today, Yesterday, This week and Earlier card grids. */
function recentGroups(ctx, files, columns = 2, cardOpts = {}) {
    const groups = new Map([['Today', []], ['Yesterday', []], ['This week', []], ['Earlier', []]]);
    const now = GLib.DateTime.new_now_local();
    for (const f of files) {
        const when = f.modified ? GLib.DateTime.new_from_iso8601(f.modified, null)?.to_local() : null;
        const days = when ? Math.floor((Date.parse(now.format('%F')) - Date.parse(when.format('%F'))) / 86400000) : 99;
        groups.get(days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : 'Earlier').push(f);
    }
    const items = [];
    for (const [name, list] of groups) {
        if (!list.length)
            continue;
        items.push(W.label(name, 'fusion-sm-heading fusion-sm-group-heading'));
        items.push(cardGrid(ctx, list, columns, cardOpts));
    }
    return items.length ? items : [W.emptyLabel('No recent files.')];
}

/** Multi-line entry for the quick notes, saved shortly after each change. */
function notesEntry(settings, {style = 'fusion-sm-notes', hint = 'Quick notes — saved automatically'} = {}) {
    const entry = new St.Entry({style_class: style, can_focus: true, x_expand: true, y_expand: true, hint_text: hint});
    const text = entry.clutter_text;
    text.single_line_mode = false;
    text.activatable = false;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    entry.text = settings.get_string('notes');
    let saveId = 0;
    text.connect('text-changed', () => {
        if (saveId)
            GLib.source_remove(saveId);
        saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            saveId = 0;
            settings.set_string('notes', entry.text);
            return GLib.SOURCE_REMOVE;
        });
    });
    entry.connect('destroy', () => {
        if (saveId) {
            GLib.source_remove(saveId);
            saveId = 0;
            settings.set_string('notes', entry.text);
        }
    });
    return entry;
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
            views.push(['Notes', 'accessories-text-editor-symbolic', () => [notesEntry(this.settings)]]);
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
        // Recommended: "Recommended  [All Docs Images Media]  More ›", a
        // "Jump back in" strip of apps, then recent file cards.
        this._recFilter = 'all';
        this._recHeading = W.hbox('fusion-sm-heading-row fusion-sm-rec-heading', {x_expand: true});
        this._recHeading.add_child(W.label('Recommended', 'fusion-sm-heading', {x_expand: true}));
        this._recChips = W.hbox('fusion-sm-rec-chips');
        this._recChipButtons = new Map();
        for (const [id, name] of [['all', 'All'], ['docs', 'Documents'], ['images', 'Images'], ['media', 'Media']]) {
            const chip = new St.Button({style_class: 'fusion-sm-chip fusion-sm-chip-small', label: name,
                can_focus: true, track_hover: true, toggle_mode: false});
            chip.connect('clicked', () => {
                this._recFilter = id;
                this._fillRecommended();
            });
            this._recChipButtons.set(id, chip);
            this._recChips.add_child(chip);
        }
        this._recHeading.add_child(this._recChips);
        const more = new St.Button({style_class: 'fusion-sm-pill', label: 'More  ›', can_focus: true, track_hover: true});
        more.connect('clicked', () => this._showRecent());
        this._recMore = more;
        this._recHeading.add_child(more);
        this._home.add_child(this._recHeading);
        this._rec = W.vbox('fusion-sm-recommended');
        this._home.add_child(this._rec);
        this.actor.add_child(this._home);

        this._recentPage = W.vbox('fusion-sm-page', {y_expand: true, visible: false});
        this._recentPage.add_child(W.heading('Recent files', {label: '‹  Back', cb: () => this._showHome()}));
        this._recentList = W.vbox('fusion-sm-recent-list');
        this._recentScroll = W.scrollView(this._recentList);
        this._recentPage.add_child(this._recentScroll);
        this.actor.add_child(this._recentPage);

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
        return [this._home, this._all, this._recentPage, this._hubPage].filter(Boolean);
    }

    hideResults() {
        super.hideResults();
        this._all.visible = this._showingAll;
        this._recentPage.visible = !!this._showingRecent && !this._hubPage;
        this._home.visible = !this._showingAll && !this._showingRecent && !this._hubPage;
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
        this._recentPage.hide();
    }

    _closeHub() {
        this._hubPage?.destroy();
        this._hubPage = null;
        this._all.visible = !!this._showingAll;
        this._recentPage.visible = !!this._showingRecent;
        this._home.visible = !this._showingAll && !this._showingRecent;
    }

    _showRecent() {
        this._showingRecent = true;
        this._showingAll = false;
        const files = this.model.recentFiles(40).filter(f => this._recFilter === 'all' || fileKind(f.contentType ?? '') === this._recFilter);
        this._fillList(this._recentList, this._recentScroll, recentGroups(this.ctx, files));
        this._home.hide();
        this._all.hide();
        this._recentPage.show();
        W.firstButton(this._recentList)?.grab_key_focus();
    }

    _showAll() {
        this._showingAll = true;
        this._showingRecent = false;
        this._recentPage.hide();
        this._fillList(this._allList, this._allScroll, [W.alphaList(this.ctx, this.model.apps)]);
        this._home.hide();
        this._all.show();
        W.firstButton(this._allList)?.grab_key_focus();
    }

    _showHome() {
        this._showingAll = false;
        this._showingRecent = false;
        this._recentPage.hide();
        this._recentList.destroy_all_children();
        this._all.hide();
        this._allList.destroy_all_children();
        this._home.show();
    }

    /**
     * "Jump back in" strip (apps usually opened at this hour, newly installed
     * and recently opened ones) and recent file cards, filtered by the chips.
     */
    _fillRecommended() {
        const mode = this.settings.get_string('menu-recommended');
        const STRIP = 6;
        this._rec.destroy_all_children();

        const strip = [];
        if (mode !== 'FILES') {
            const seen = new Set();
            const add = (apps, badge) => apps.forEach(app => {
                if (strip.length < STRIP && !seen.has(app)) {
                    seen.add(app);
                    strip.push([app, badge]);
                }
            });
            add(this.model.usuallyNow(2), 'Usually now');
            add(this.model.newApps(2), 'New');
            const opened = this.settings.get_strv('menu-recent-apps');
            this.model.recentApps(STRIP * 2).forEach(app =>
                add([app], opened.includes(app.get_id()) ? 'Recent' : 'Frequent'));
        }
        if (strip.length) {
            const row = W.hbox('fusion-sm-jump', {x_expand: true});
            strip.forEach(([app, badge]) => row.add_child(W.jumpTile(this.ctx, app, badge)));
            this._rec.add_child(row);
        }

        const allFiles = mode === 'APPS' ? [] : this.model.recentFiles(40);
        const files = allFiles.filter(f => this._recFilter === 'all' || fileKind(f.contentType ?? '') === this._recFilter);
        const cardCount = mode === 'FILES' ? 6 : 4;
        if (files.length)
            this._rec.add_child(cardGrid(this.ctx, files.slice(0, cardCount)));
        else if (allFiles.length)
            this._rec.add_child(W.emptyLabel('Nothing of this kind lately.'));

        for (const [id, chip] of this._recChipButtons) {
            if (id === this._recFilter)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        }
        this._recChips.visible = allFiles.length > 0;
        this._recMore.visible = allFiles.length > 0;
        this._recHeading.visible = this._rec.visible = strip.length > 0 || allFiles.length > 0;
    }

    reset() {
        this._hubPage?.destroy();
        this._hubPage = null;
        this._power.hide();
        const apps = this.model.pinnedApps();
        this._fillList(this._pinned, this._pinnedScroll, [this._pinnedOrHint(apps) ?? W.appGrid(this.ctx, apps, this.columns)]);

        this._recFilter = 'all';
        this._fillRecommended();
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

// ---- Dashboard: pinned apps, clock, weather, recent files and widgets ----------

const RECENT_COLUMNS = 4;
const FROST_BLUR = 14; // blur radius of the picture behind the cards
const PINNED_ICON = 46;
const SPACE_SCALE = 1.0; // Space picture width / menu width
const SPACE_HORIZON = 0.68; // height of the lake line in the overlay
const SPACE_PLANET = 0.40; // height of the planet's top in the overlay
const SPACE_PLANET_GAP = 6; // planet top below the banner's top edge
const SPACE_TOP = 70; // picture top before the banner is placed
const LOW_BLUR = 18; // blur radius of the scene below the banner
const FOOTER_BLUR = 26; // blur radius of the panorama in the footer
const FOOTER_ZOOM = 1.6; // the footer shows the middle of the panorama, larger
const LOW_BLUR_GAP = 4; // the blur starts this far below the banner
const BANNER_PLANET = 0.50; // planet middle in the banner picture (share of its width)
const BANNER_PLANET_AT = 0.44; // where it sits in the banner (between clock and cards)
const HERO_FOCUS = [0.5, 0.58]; // part of the picture the banner centres on
const FOOTER_FOCUS = [0.53, 0.55]; // and the footer strip (the planet)
const RECENT_CARDS = 8; // two rows
const MENU_HEIGHT = 980; // the mockup's 1232×1277 proportions, scaled to fit 1080p

/** Thin progress bar: [actor, set(share 0–1)]. */
function progressBar(style = '', {warnFull = false} = {}) {
    const bar = new St.BoxLayout({style_class: `fusion-hub-bar ${style}`, x_expand: true});
    const fill = new St.Widget({style_class: 'fusion-hub-bar-fill'});
    bar.add_child(fill);
    let share = 0, id = 0;
    // Size the fill after layout, not during the allocation that changed the width.
    const queue = () => {
        if (id)
            return;
        id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            id = 0;
            fill.set_width(Math.round(bar.width * share));
            return GLib.SOURCE_REMOVE;
        });
    };
    bar.connect('notify::width', queue);
    bar.connect('destroy', () => {
        if (id)
            GLib.source_remove(id);
        id = 0;
    });
    return [bar, value => {
        share = Math.max(0, Math.min(1, value));
        if (warnFull && share > 0.9)
            fill.add_style_class_name('full');
        else
            fill.remove_style_class_name('full');
        queue();
    }];
}

/** "PDF · 2 min ago" under a recent file card. */
function fileMeta(file) {
    const ext = /\.([^./]{1,6})$/.exec(file.name ?? '')?.[1]?.toUpperCase();
    return [ext, W.timeAgo(file.modified)].filter(Boolean).join('  ·  ');
}

class DashboardLayout extends BaseLayout {
    static title = 'Dashboard';
    static size = [946, 0]; // height set on open: MENU_HEIGHT, or less on small screens
    static columns = 6;
    static searchMovable = false;

    /** Own grid size (menu-pinned-columns is for the other layouts). */
    get columns() {
        return this.settings.get_int('menu-dash-pinned-columns');
    }

    get rows() {
        return this.settings.get_int('menu-dash-pinned-rows');
    }

    constructor(ctx) {
        super(ctx, 'dashboard');
        const s = this.settings;
        this._pinPage = 0;
        this._recFilter = 'all';
        this._tip = D.tipOfTheDay();
        this._items = {}; // menu-dash-sections id -> actor

        // Background: the picture (cover), blurred to frosted glass, under a
        // tint that holds the page; the clock banner shows it sharp.
        this._picture = new St.Widget({style_class: 'fusion-sm-dash-picture', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true});
        this._frost = new St.Widget({style_class: 'fusion-sm-dash-frost', x_expand: true, y_expand: true});
        this._picture.add_child(this._frost);
        this._tint = W.vbox('fusion-sm-dash-tint', {x_expand: true, y_expand: true});
        this._picture.add_child(this._tint);
        this._picture.connect('notify::width', () => this._designed && this._picture.get_stage() && this._syncPicture());
        this.actor.add_child(this._picture);

        this._tint.add_child(this._makeSearch('Search for apps, settings and documents'));
        this.search.add_style_class_name('fusion-sm-dash-top');
        this._body = W.vbox('fusion-sm-dash-body', {y_expand: true});
        this._tint.add_child(this._body);

        this._home = W.vbox('fusion-sm-dash-home');
        this._homeScroll = W.scrollView(this._home, 'fusion-sm-scroll fusion-sm-dash-scroll');
        this._body.add_child(this._homeScroll);
        this._home.add_child(this._pinnedSection());
        this._home.add_child(this._heroRow());
        this._home.add_child(this._actionRow());
        this._home.add_child(this._recentSection());
        this._home.add_child(this._widgetRow());

        this._recentPage = W.vbox('fusion-sm-page', {y_expand: true, visible: false});
        this._recentPage.add_child(W.heading('Recent files', {label: '‹  Back', cb: () => this._showHome()}));
        this._recentList = W.vbox('fusion-sm-recent-list');
        this._recentScroll = W.scrollView(this._recentList);
        this._recentPage.add_child(this._recentScroll);
        this._body.add_child(this._recentPage);

        this._all = W.vbox('fusion-sm-page', {y_expand: true, visible: false});
        this._all.add_child(W.heading('All apps', {label: '‹  Back', cb: () => this._showHome()}));
        this._allList = W.vbox();
        this._allScroll = W.scrollView(this._allList);
        this._all.add_child(this._allScroll);
        this._body.add_child(this._all);

        this._body.add_child(this._makeResults());
        for (const page of [this._recentPage, this._all, this._resultsScroll])
            page.add_style_class_name('fusion-sm-dash-panel');
        this._tint.add_child(this._footer());

        this._weather = new DashWeather(s, () => this._syncWeather());
        this._syncWeather();

        // Background and light / dark tone.
        this._bgGen = 0;
        s.connectObject('changed::menu-dash-background', () => this._applyBackground(),
            'changed::menu-dash-image', () => this._applyBackground(),
            'changed::menu-radius', () => this._syncPicture(),
            'changed::menu-border-width', () => this._syncPicture(),
            'changed::menu-theme', () => this._syncPicture(),
            'changed::menu-weather-unit', () => this._syncWeather(),
            'changed::menu-pinned-files', () => this._fillRecent(),
            'changed::menu-dash-sections', () => {
                this._syncSections();
                this._fillRecent();
            },
            'changed::menu-dash-clock', () => {
                this._tick();
                this._fillEvents();
            },
            'changed::menu-dash-pinned-rows', () => this._showPinnedPage(0),
            'changed::menu-dash-pinned-columns', () => this._showPinnedPage(0),
            'changed::notes', () => {
                if (this._note && !this._note.clutter_text.has_key_focus() && this._note.text !== s.get_string('notes'))
                    this._note.text = s.get_string('notes');
            }, this);
        this._unwatchWallpaper = D.watchWallpaper(() => this._applyBackground());
        this._unwatchStyle = watchSystemStyle(() => this._applyBackground());
        this.actor.connect('style-changed', () => this._syncTone());
        this._applyBackground();

        this.ctx.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                this._stopTimers();
        }, this);
    }

    // ---- Sections ----------------------------------------------------------------

    _pill(text, cb) {
        const b = new St.Button({style_class: 'fusion-sm-pill', label: text, can_focus: true, track_hover: true});
        b.connect('clicked', () => cb());
        return b;
    }

    _card(style, params = {}) {
        return W.vbox(`fusion-sm-dash-card ${style}`, params);
    }

    _cardTitle(text, extra = [], icon = null) {
        const row = W.hbox('fusion-sm-dash-card-head', {x_expand: true});
        // An emoji ("📅") gives a colour icon, anything else is a symbolic icon name.
        if (icon && /^[\x00-\x7f]/.test(icon))
            row.add_child(new St.Icon({icon_name: icon, icon_size: 16, style_class: 'fusion-sm-dash-title-icon', y_align: Clutter.ActorAlign.CENTER}));
        else if (icon)
            row.add_child(W.label(icon, 'fusion-sm-dash-emoji'));
        row.add_child(W.label(text, 'fusion-sm-dash-title', {x_expand: true}));
        extra.forEach(a => row.add_child(a));
        return row;
    }

    /** Pinned apps in pages (rows × columns from the settings): dots or the scroll wheel turn the page. */
    _pinnedSection() {
        const box = W.vbox('fusion-sm-dash-section fusion-sm-dash-top fusion-sm-dash-pinned-box');
        this._pager = W.hbox('fusion-sm-dash-pager', {y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._cardTitle('Pinned', [this._pager, this._pill('All apps  ›', () => this._showAll())], 'view-app-grid-symbolic'));
        this._pinned = W.vbox('fusion-sm-grid fusion-sm-dash-pinned', {reactive: true});
        this._pinned.connect('scroll-event', (_a, event) => this._onPinnedScroll(event));
        box.add_child(this._pinned);
        this._items.pinned = box;
        return box;
    }

    _onPinnedScroll(event) {
        let step = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            step = Math.abs(d) < 0.5 ? 0 : Math.sign(d);
        }
        const now = GLib.get_monotonic_time();
        if (step && now - (this._lastFlip ?? 0) > 250000) {
            this._lastFlip = now;
            this._showPinnedPage(this._pinPage + step);
        }
        return Clutter.EVENT_STOP;
    }

    _showPinnedPage(page) {
        const apps = this.model.pinnedApps();
        const cols = this.columns;
        const per = cols * this.rows;
        const pages = Math.max(1, Math.ceil(apps.length / per));
        this._pinPage = Math.max(0, Math.min(page, pages - 1));
        this._pinned.destroy_all_children();
        this._pager.destroy_all_children();
        if (!apps.length) {
            this._pinned.add_child(this._pinnedOrHint(apps));
            return;
        }
        const slice = apps.slice(this._pinPage * per, (this._pinPage + 1) * per);
        // Every page keeps the same height: unused cells hold invisible tiles.
        const rows = pages > 1 ? this.rows : Math.ceil(slice.length / cols);
        for (let r = 0; r < rows; r++) {
            const row = W.hbox('fusion-sm-grid-row', {x_expand: true});
            row.layout_manager.homogeneous = true;
            for (let c = 0; c < cols; c++) {
                const app = slice[r * cols + c];
                const tile = W.appTile(this.ctx, app ?? apps[0], {style: 'fusion-sm-tile fusion-sm-dash-tile',
                    size: Math.max(this.ctx.tileSize, PINNED_ICON)});
                tile.x_expand = true;
                if (!app) {
                    tile.opacity = 0;
                    tile.reactive = tile.can_focus = false;
                }
                row.add_child(tile);
            }
            this._pinned.add_child(row);
        }
        if (pages > 1) {
            for (let i = 0; i < pages; i++) {
                const dot = new St.Button({style_class: 'fusion-sm-dash-dot', can_focus: true, track_hover: true,
                    accessible_name: `Pinned page ${i + 1}`, y_align: Clutter.ActorAlign.CENTER});
                if (i === this._pinPage)
                    dot.add_style_pseudo_class('checked');
                dot.connect('clicked', () => this._showPinnedPage(i));
                this._pager.add_child(dot);
            }
        }
    }

    /** Banner over the picture: clock, date and a short quote, weather and greeting cards. */
    _heroRow() {
        this._hero = new St.Widget({style_class: 'fusion-sm-dash-hero-box', layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._heroPicture = new St.Widget({style_class: 'fusion-sm-dash-hero-picture', x_expand: true, y_expand: true});
        this._hero.add_child(this._heroPicture);
        const row = this._heroRow = W.hbox('fusion-sm-dash-hero', {x_expand: true, y_expand: true});
        this._hero.add_child(row);
        // The sharp picture lines up with the frosted one behind the page.
        this._hero.connect('notify::allocation', () => this._queueHeroPicture());
        const clock = this._items.clock = W.vbox('fusion-sm-dash-clock', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        // "11:00" big with a smaller "PM" beside it.
        const timeRow = W.hbox('fusion-sm-dash-time-row');
        this._time = W.label('', 'fusion-sm-dash-time');
        this._ampm = W.label('', 'fusion-sm-dash-ampm', {y_align: Clutter.ActorAlign.END});
        timeRow.add_child(this._time);
        timeRow.add_child(this._ampm);
        this._date = W.label('', 'fusion-sm-dash-date');
        this._quote = W.label('', 'fusion-sm-dash-quote');
        this._quote.clutter_text.line_wrap = true;
        clock.add_child(timeRow);
        clock.add_child(this._date);
        clock.add_child(this._quote);
        row.add_child(clock);

        this._weatherCard = new St.Button({style_class: 'fusion-sm-dash-glass fusion-sm-dash-weather', can_focus: true,
            track_hover: true, accessible_name: 'Weather', y_align: Clutter.ActorAlign.CENTER, x_expand: false});
        this._weatherCard.connect('clicked', () => {
            if (!this._weather.city || this._weather.state === 'notfound') {
                this.ctx.close();
                this.ctx.ext.openPreferences();
                return;
            }
            const app = this.model.lookup('org.gnome.Weather.desktop');
            if (app)
                this.ctx.launch(app);
        });
        row.add_child(this._weatherCard);
        this._items.weather = this._weatherCard;

        const greet = this._items.greeting = W.vbox('fusion-sm-dash-glass fusion-sm-dash-greet', {y_align: Clutter.ActorAlign.CENTER, x_expand: false});
        this._greet = W.label('', 'fusion-sm-dash-greet-hello');
        this._greetName = W.label('', 'fusion-sm-dash-greet-name');
        this._cheer = W.label('', 'fusion-sm-dash-cheer');
        this._cheer.clutter_text.line_wrap = true;
        greet.add_child(this._greet);
        greet.add_child(this._greetName);
        greet.add_child(this._cheer);
        row.add_child(greet);
        return this._hero;
    }

    _syncWeather() {
        const card = this._weatherCard;
        const w = this._weather;
        const report = w.report;
        const box = W.hbox('fusion-sm-dash-weather-box', {x_expand: true});
        const text = W.vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        if (w.state === 'none' || (w.state === 'notfound' && !report)) {
            box.add_child(new St.Icon({icon_name: 'mark-location-symbolic', icon_size: 28, style_class: 'fusion-sm-dash-weather-icon',
                y_align: Clutter.ActorAlign.CENTER}));
            text.add_child(W.label(w.state === 'none' ? 'Set your city' : 'City not found', 'fusion-sm-item-name'));
            text.add_child(W.label('Weather: in Fusion Desk settings', 'fusion-sm-item-desc'));
        } else {
            box.add_child(W.label(D.weatherEmoji(report?.icon ?? ''), 'fusion-sm-dash-weather-emoji'));
            text.add_child(W.label(w.formatTemp(report) || '–', 'fusion-sm-dash-temp'));
            const status = w.state === 'loading' && !report ? 'Loading…'
                : w.state === 'error' && !report ? 'No weather data' : report?.sky ?? '';
            if (status)
                text.add_child(W.label(status, 'fusion-sm-item-name'));
            text.add_child(W.label(w.city, 'fusion-sm-item-desc'));
        }
        box.add_child(text);
        box.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 12, style_class: 'fusion-sm-dash-chevron',
            y_align: Clutter.ActorAlign.END}));
        card.set_child(box);
    }

    /** Continue working, capture screen, resume downloads, quick tools. */
    _actionRow() {
        // Three equal action cards, then a narrower tools card.
        const row = this._actions = W.hbox('fusion-sm-dash-row', {x_expand: true});
        const cards = W.hbox('fusion-sm-dash-row', {x_expand: true});
        cards.layout_manager.homogeneous = true;
        row.add_child(cards);
        this._continue = this._items.continue = this._actionCard('x-office-document-symbolic', 'Continue working', '',
            () => {}, {color: 'blue'});
        cards.add_child(this._continue);
        this._items.capture = this._actionCard('camera-photo-symbolic', 'Capture screen', 'Screenshot or record your screen',
            () => this._afterClose(() => D.openScreenshot('screen')), {close: false, color: 'purple'});
        cards.add_child(this._items.capture);
        const draco = this.model.lookup(D.DRACO_ID);
        this._downloads = this._actionCard('folder-download-symbolic', 'Resume downloads', '', () => {
            if (draco)
                this.ctx.launch(draco);
        }, {color: 'dark', gicon: draco?.get_icon() ?? null});
        const [bar, setBar] = progressBar('fusion-sm-dash-progress');
        this._downloads._text.add_child(bar);
        this._setDownloadBar = setBar;
        this._items.downloads = this._downloads;
        cards.add_child(this._downloads);

        const tools = this._items.tools = W.vbox('fusion-sm-dash-card fusion-sm-dash-top fusion-sm-dash-tools');
        const head = W.hbox('fusion-sm-dash-action-box');
        head.add_child(new St.Bin({style_class: 'fusion-sm-dash-bubble fusion-sm-dash-bubble-blue', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 18})}));
        head.add_child(W.label('Quick tools', 'fusion-sm-item-name', {x_expand: true}));
        tools.add_child(head);
        const buttons = W.hbox('fusion-sm-dash-tool-row');
        const tool = (icon, name, action, gicon = null) => buttons.add_child(W.iconButton(this.ctx, icon, name,
            () => this._afterClose(action), {style: 'fusion-sm-dash-tool', close: false, gicon}));
        tool('edit-cut-symbolic', 'Region screenshot', () => D.openScreenshot('area'));
        tool('color-select-symbolic', 'Colour picker', () => D.pickColor());
        for (const {name, app} of D.screenApps())
            tool(null, name, () => app.activate(), app.get_icon());
        tools.add_child(buttons);
        row.add_child(tools);
        return row;
    }

    _actionCard(icon, title, subtitle, action, {close = true, color = 'blue', gicon = null} = {}) {
        const button = new St.Button({style_class: 'fusion-sm-dash-card fusion-sm-dash-top fusion-sm-dash-action', can_focus: true,
            track_hover: true, x_expand: true, accessible_name: title});
        const box = W.hbox('fusion-sm-dash-action-box', {x_expand: true});
        const glyph = new St.Icon({icon_size: gicon ? 26 : 18});
        if (gicon)
            glyph.gicon = gicon;
        else
            glyph.icon_name = icon;
        button._art = new St.Bin({style_class: `fusion-sm-dash-bubble fusion-sm-dash-bubble-${color}`, y_align: Clutter.ActorAlign.CENTER,
            child: glyph});
        box.add_child(button._art);
        const text = button._text = W.vbox('fusion-sm-dash-action-text', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        text.add_child(W.label(title, 'fusion-sm-item-name'));
        button._sub = W.label(subtitle, 'fusion-sm-item-desc');
        button._sub.clutter_text.line_wrap = true;
        text.add_child(button._sub);
        box.add_child(text);
        box.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 12, style_class: 'fusion-sm-dash-chevron',
            y_align: Clutter.ActorAlign.CENTER}));
        button.set_child(box);
        button._action = action;
        button.connect('clicked', () => {
            if (close)
                this.ctx.close();
            button._action();
        });
        return button;
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

    _fillContinue() {
        const file = this._continueFile = this.model.recentFiles(40).find(f => ['documents', 'pdf', 'markdown'].includes(D.dashKind(f)));
        this._syncSections();
        if (!file)
            return;
        this._continue._sub.text = file.name;
        this._continue._action = () => this.ctx.openUriNow(file.uri);
    }

    async _fillDownloads() {
        const d = this._downloadInfo = this._shown('downloads') ? await D.unfinishedDownloads() : null;
        if (this._destroyed)
            return;
        this._syncSections();
        if (d) {
            const what = `${d.count} unfinished`;
            this._downloads._sub.text = d.done >= 0 ? `${what}  ·  ${Math.floor(d.done * 100)}%` : what;
            this._setDownloadBar(Math.max(d.done, 0));
        }
    }

    _recentSection() {
        const box = W.vbox('fusion-sm-dash-section fusion-sm-dash-top');
        this._chips = W.hbox('fusion-sm-rec-chips fusion-sm-dash-chips');
        this._chipButtons = new Map();
        for (const [id, name] of D.FILE_FILTERS) {
            const chip = new St.Button({style_class: 'fusion-sm-chip fusion-sm-chip-small', label: name, can_focus: true, track_hover: true});
            chip.connect('clicked', () => {
                // Fewer cards must not shrink the open menu.
                this._freeze();
                this._recFilter = id;
                this._fillRecent();
            });
            this._chipButtons.set(id, chip);
            this._chips.add_child(chip);
        }
        this._viewAll = this._pill('View all  ›', () => this._showRecent());
        const head = this._cardTitle('Recent files', [this._chips, this._viewAll], 'document-open-recent-symbolic');
        head.get_child_at_index(1).x_expand = false;
        this._chips.x_expand = true;
        box.add_child(head);
        this._recent = W.vbox('fusion-sm-dash-recent');
        box.add_child(this._recent);
        this._items.recent = box;
        return box;
    }

    /** Two rows of recent files, one when the action row is on (the menu keeps its height). */
    get _recentCards() {
        const actions = ['continue', 'capture', 'downloads', 'tools'].some(id => this._shown(id));
        return actions ? RECENT_COLUMNS : RECENT_CARDS;
    }

    /** Recent files of the chosen kind, pinned ones first. */
    _filteredFiles(n = 40) {
        const pins = this.settings.get_strv('menu-pinned-files');
        const files = this.model.recentFiles(n).filter(f => this._recFilter === 'all' || D.dashKind(f) === this._recFilter);
        const rank = f => (pins.includes(f.uri) ? pins.indexOf(f.uri) : pins.length + 1);
        return files.map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f);
    }

    _togglePinFile(file) {
        const pins = this.settings.get_strv('menu-pinned-files');
        this.settings.set_strv('menu-pinned-files', pins.includes(file.uri) ? pins.filter(u => u !== file.uri) : [file.uri, ...pins].slice(0, 20));
    }

    /** ⋮ on a file card: open, open folder, pin, copy path. */
    _fileMenu(button, file) {
        const pinned = this.settings.get_strv('menu-pinned-files').includes(file.uri);
        this.ctx.showActions(button, file.name, [
            ['document-open-symbolic', 'Open', () => this.ctx.openUri(file.uri)],
            ['folder-open-symbolic', 'Open folder', () => this.ctx.openUri(GLib.filename_to_uri(GLib.path_get_dirname(file.path), null))],
            ['view-pin-symbolic', pinned ? 'Unpin' : 'Pin to top', () => this._togglePinFile(file), true],
            ['edit-copy-symbolic', 'Copy path', () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, file.path ?? file.uri), true],
        ]);
    }

    get _cardOpts() {
        return {meta: fileMeta, iconSize: 36, actions: {
            pinned: f => this.settings.get_strv('menu-pinned-files').includes(f.uri),
            onPin: f => this._togglePinFile(f),
            onMenu: (b, f) => this._fileMenu(b, f),
        }};
    }

    _fillRecent() {
        this._recent.destroy_all_children();
        const all = this.model.recentFiles(40);
        const files = this._filteredFiles();
        if (files.length)
            this._recent.add_child(cardGrid(this.ctx, files.slice(0, this._recentCards), RECENT_COLUMNS, this._cardOpts));
        else
            this._recent.add_child(W.emptyLabel(all.length ? 'Nothing of this kind lately.' : 'No recent files.'));
        for (const [id, chip] of this._chipButtons) {
            if (id === this._recFilter)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        }
        this._chips.visible = this._viewAll.visible = all.length > 0;
    }

    /** Today's events, quick note, tip of the day and storage. */
    _widgetRow() {
        const row = this._widgets = W.hbox('fusion-sm-dash-row fusion-sm-dash-widgets', {x_expand: true, y_expand: true});
        row.layout_manager.homogeneous = true;

        const events = this._items.calendar = this._card('fusion-sm-dash-widget fusion-sm-dash-bottom', {x_expand: true});
        const calendar = this.model.lookup('org.gnome.Calendar.desktop');
        events.add_child(this._cardTitle('Today', calendar ? [this._pill('View all  ›', () => this.ctx.launch(calendar))] : [],
            '📅'));
        this._events = W.vbox('fusion-sm-dash-events');
        events.add_child(W.scrollView(this._events, 'fusion-sm-scroll fusion-sm-dash-widget-scroll'));
        row.add_child(events);

        const note = this._items.note = this._card('fusion-sm-dash-widget fusion-sm-dash-bottom', {x_expand: true});
        const add = W.iconButton(this.ctx, 'list-add-symbolic', 'Write a note', () => {
            this._note.grab_key_focus();
            this._note.clutter_text.set_cursor_position(-1);
        }, {style: 'fusion-sm-round fusion-sm-dash-mini', size: 12, close: false});
        note.add_child(this._cardTitle('Quick note', [add], '📝'));
        this._note = notesEntry(this.settings, {style: 'fusion-sm-notes fusion-sm-dash-note', hint: 'Write something down…'});
        // Natural height, so the text starts at the top; a click below it still focuses it.
        this._note.y_expand = false;
        const view = new St.Viewport({layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            x_expand: true, reactive: true});
        view.add_child(this._note);
        view.connect('button-press-event', () => {
            this._note.grab_key_focus();
            this._note.clutter_text.set_cursor_position(-1);
            return Clutter.EVENT_PROPAGATE;
        });
        const noteScroll = W.scrollView(view, 'fusion-sm-scroll fusion-sm-dash-widget-scroll fusion-sm-dash-note-box');
        // Keep the cursor in view while typing in the scrolled note.
        this._note.clutter_text.connect('cursor-changed', t => {
            const [ok, , y, lineHeight] = t.position_to_coords(t.cursor_position);
            if (!ok)
                return;
            const adj = noteScroll.vadjustment;
            if (y < adj.value)
                adj.value = y;
            else if (y + lineHeight > adj.value + adj.page_size)
                adj.value = y + lineHeight - adj.page_size;
        });
        note.add_child(noteScroll);
        row.add_child(note);

        const tip = this._items.tip = this._card('fusion-sm-dash-widget fusion-sm-dash-bottom', {x_expand: true});
        const prev = W.iconButton(this.ctx, 'go-previous-symbolic', 'Previous tip', () => this._showTip(this._tip - 1),
            {style: 'fusion-sm-round fusion-sm-dash-mini', size: 12, close: false});
        const next = W.iconButton(this.ctx, 'go-next-symbolic', 'Next tip', () => this._showTip(this._tip + 1),
            {style: 'fusion-sm-round fusion-sm-dash-mini', size: 12, close: false});
        this._tipCount = W.label('', 'fusion-sm-dash-tip-count');
        tip.add_child(this._cardTitle('Daily tip', [prev, this._tipCount, next], '💡'));
        this._tipLabel = W.label('', 'fusion-sm-dash-tip');
        this._tipLabel.clutter_text.line_wrap = true;
        tip.add_child(this._tipLabel);
        row.add_child(tip);
        this._showTip(this._tip);
        row.add_child(this._storageCard());
        row.add_child(this._slotCard());
        return row;
    }

    /** Free widget place: points to the settings where parts are switched on. */
    _slotCard() {
        const slot = this._items.slot = new St.Button({style_class: 'fusion-sm-dash-card fusion-sm-dash-widget fusion-sm-dash-bottom fusion-sm-dash-slot',
            can_focus: true, track_hover: true, x_expand: true, accessible_name: 'Add from dashboard setting'});
        const box = W.vbox('fusion-sm-dash-slot-box', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({icon_name: 'list-add-symbolic', icon_size: 20, style_class: 'fusion-sm-dash-slot-icon',
            x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(W.label('Add from dashboard setting', 'fusion-sm-item-desc', {x_align: Clutter.ActorAlign.CENTER}));
        slot.set_child(box);
        slot.connect('clicked', () => {
            this.ctx.close();
            this.ctx.ext.openPreferences();
        });
        return slot;
    }

    /** Free space on the disk that holds the home folder. */
    _storageCard() {
        const card = this._items.storage = this._card('fusion-sm-dash-widget fusion-sm-dash-bottom fusion-sm-dash-storage', {x_expand: true});
        const analyzer = this.model.lookup('org.gnome.baobab.desktop');
        card.add_child(this._cardTitle('Storage', analyzer ? [this._pill('Details  ›', () => this.ctx.launch(analyzer))] : [],
            '💾'));
        this._storageFree = W.label('', 'fusion-sm-dash-storage-free');
        card.add_child(this._storageFree);
        const [bar, setBar] = progressBar('fusion-sm-dash-storage-bar', {warnFull: true});
        this._setStorageBar = setBar;
        card.add_child(bar);
        this._storageUsed = W.label('', 'fusion-sm-item-desc');
        card.add_child(this._storageUsed);
        return card;
    }

    async _fillStorage() {
        if (!this._shown('storage'))
            return;
        const disk = await D.homeStorage();
        if (this._destroyed || !disk)
            return;
        this._storageFree.text = `${GLib.format_size(disk.free)} free`;
        this._storageUsed.text = `${GLib.format_size(disk.size - disk.free)} of ${GLib.format_size(disk.size)} used`;
        this._setStorageBar(disk.size ? (disk.size - disk.free) / disk.size : 0);
    }

    // ---- Shown parts --------------------------------------------------------------

    _shown(id) {
        return this.settings.get_strv('menu-dash-sections').includes(id);
    }

    /** Show the parts picked in the settings (and that have something to show); hide empty rows. */
    _syncSections() {
        const has = {continue: !!this._continueFile, downloads: !!this._downloadInfo,
            recent: this.settings.get_boolean('menu-show-recent')};
        for (const [id, actor] of Object.entries(this._items))
            actor.visible = this._shown(id) && (has[id] ?? true);
        const cards = this._actions.get_first_child();
        cards.visible = cards.get_children().some(c => c.visible);
        for (const row of [this._heroRow, this._actions, this._widgets])
            row.visible = row.get_children().some(c => c.visible);
        this._hero.visible = this._heroRow.visible;
    }

    _showTip(i) {
        this._tip = (i + D.TIPS.length) % D.TIPS.length;
        this._tipLabel.text = D.TIPS[this._tip];
        this._tipCount.text = `${this._tip + 1}/${D.TIPS.length}`;
    }

    _fillEvents() {
        const source = D.eventSource();
        if (source !== this._eventSrc) {
            this._eventSrc?.disconnectObject?.(this);
            this._eventSrc = source;
            source?.connectObject('changed', () => this.ctx.menu.isOpen && this._fillEvents(), this);
        }
        this._events.destroy_all_children();
        const events = D.todayEvents(source, this.settings);
        if (!events.length) {
            this._events.add_child(W.label(source?.hasCalendars ? 'No events today.' : 'No calendars set up.', 'fusion-sm-item-desc'));
            return;
        }
        events.forEach((e, i) => {
            const line = W.hbox('fusion-sm-dash-event');
            line.add_child(new St.Widget({style_class: `fusion-sm-dash-event-dot fusion-sm-dash-event-dot-${i % 4}`,
                y_align: Clutter.ActorAlign.CENTER}));
            line.add_child(W.label(e.time, 'fusion-sm-dash-event-time'));
            line.add_child(W.label(e.summary, 'fusion-sm-dash-event-name', {x_expand: true}));
            this._events.add_child(line);
        });
    }

    _footer() {
        const s = this.settings;
        // Like the banner, the footer shows a strip of the sharp picture.
        this._footerBox = new St.Widget({style_class: 'fusion-sm-dash-footer-box', layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._footerPicture = new St.Widget({style_class: 'fusion-sm-dash-footer-picture', x_expand: true, y_expand: true});
        this._footerBox.add_child(this._footerPicture);
        const footer = W.hbox('fusion-sm-dash-footer fusion-sm-dash-bottom', {x_expand: true, y_expand: true});
        this._footerBox.add_child(footer);
        this._footerBox.connect('notify::allocation', () => this._queueHeroPicture());
        if (s.get_boolean('menu-show-user')) {
            footer.add_child(W.userChip(this.ctx, {size: 36, name: false}));
            const who = W.vbox('', {y_align: Clutter.ActorAlign.CENTER});
            who.add_child(W.label(this.model.userName, 'fusion-sm-dash-footer-name'));
            this._footerGreet = W.label('', 'fusion-sm-item-desc');
            who.add_child(this._footerGreet);
            footer.add_child(who);
        }
        footer.add_child(new St.Widget({x_expand: true}));
        const group = W.hbox('fusion-sm-dash-footer-group', {y_align: Clutter.ActorAlign.CENTER});
        const button = (icon, name, action, close = true) =>
            group.add_child(W.iconButton(this.ctx, icon, name, action, {style: 'fusion-sm-round fusion-sm-dash-footer-button', size: 18, close}));
        if (s.get_boolean('menu-show-places')) {
            for (const p of this.model.places().filter(x => ['Documents', 'Downloads', 'Pictures'].includes(x.name)))
                button(p.icon, p.name, () => this.ctx.openUriNow(p.uri));
        }
        if (s.get_boolean('menu-show-shortcuts')) {
            const settingsApp = this.model.lookup('org.gnome.Settings.desktop');
            if (settingsApp)
                button('emblem-system-symbolic', 'Settings', () => settingsApp.activate());
        }
        button('view-app-grid-symbolic', 'All apps', () => this._showAll(), false);
        this._power = W.powerRow(this.ctx, {style: 'fusion-sm-power-row fusion-sm-dash-power'});
        this._power.hide();
        group.add_child(this._power);
        button('system-shutdown-symbolic', 'Power', () => {
            this._power.visible = !this._power.visible;
        }, false);
        footer.add_child(group);
        return this._footerBox;
    }

    // ---- Background --------------------------------------------------------------

    async _applyBackground() {
        const gen = ++this._bgGen;
        const path = D.backgroundPath(this.settings, this.ctx.ext.path);
        // The built-in Space pictures are already small: used as they are.
        const space = this.settings.get_string('menu-dash-background') === 'SPACE';
        const picture = path && !space ? await D.scaledPicture(path) : path;
        if (gen !== this._bgGen || this._destroyed)
            return;
        this._pictureUri = picture ? GLib.filename_to_uri(picture, null) : null;
        this._overlayUri = space ? GLib.filename_to_uri(D.spaceOverlay(this.ctx.ext.path), null) : null;
        this._overlaySize = space ? D.pictureSize(D.spaceOverlay(this.ctx.ext.path)) : null;
        this._bannerUri = space ? GLib.filename_to_uri(D.spaceBanner(this.ctx.ext.path), null) : null;
        this._bannerSize = space ? D.pictureSize(D.spaceBanner(this.ctx.ext.path)) : null;
        this._pictureSize = picture ? D.pictureSize(picture) : null;
        this._syncPicture();
    }

    /** Corner radius of the menu surface, so the picture fits inside it. */
    _radius() {
        return this._corners().map(c => `${c}px`).join(' ');
    }

    /** Corner radii [top-left, top-right, bottom-right, bottom-left] of the menu surface. */
    _corners() {
        const s = this.settings;
        const custom = s.get_string('menu-theme') === 'CUSTOM';
        const r = Math.max(0, custom ? s.get_int('menu-radius') - s.get_int('menu-border-width') : 17);
        const menu = this.ctx.menu.actor;
        if (menu.has_style_class_name('fusion-sm-flush-bottom'))
            return [r, r, r, 0];
        if (menu.has_style_class_name('fusion-sm-flush-top'))
            return [0, r, r, r];
        return [r, r, r, r];
    }

    _syncPicture() {
        if (this._destroyed)
            return;
        const cosmic = this.settings.get_string('menu-dash-background') === 'COSMIC';
        const on = !!this._pictureUri || cosmic;
        const radius = `border-radius: ${this._radius()};`;
        // The drawn scene replaces the picture; it never takes input.
        if (cosmic && !this._cosmos) {
            this._cosmos = new CosmicScene();
            this._picture.insert_child_at_index(this._cosmos.actor, 0);
            if (this.ctx.menu.isOpen)
                this._cosmos.start();
        } else if (!cosmic && this._cosmos) {
            this._cosmos.destroy();
            this._cosmos = null;
        }
        this._cosmos?.setRadius(this._corners());
        // Space: sky picture, moving stars, then the planet overlay.
        const space = !cosmic && !!this._overlayUri;
        if (space && !this._overlay) {
            this._spaceStars = new StarMotion();
            this._overlay = new St.Widget({style_class: 'fusion-sm-dash-overlay', x_expand: true, y_expand: true, reactive: false});
            this._picture.insert_child_above(this._spaceStars.actor, this._frost);
            this._picture.insert_child_above(this._overlay, this._spaceStars.actor);
            // Below the banner the scene is blurred: a copy of sky and overlay
            // in a strip at the bottom, with a blur effect on it.
            this._lowBlur = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
                y_align: Clutter.ActorAlign.END, reactive: false});
            this._lowSky = new St.Widget({x_expand: true, y_expand: true, reactive: false});
            this._lowOverlay = new St.Widget({x_expand: true, y_expand: true, reactive: false});
            this._lowBlur.add_child(this._lowSky);
            this._lowBlur.add_child(this._lowOverlay);
            this._lowBlur.add_effect_with_name('fusion-dash-low-blur',
                new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: LOW_BLUR, brightness: 1.0}));
            this._lowBlur.hide();
            this._picture.insert_child_above(this._lowBlur, this._overlay);
            if (this.ctx.menu.isOpen)
                this._spaceStars.start();
        } else if (!space && this._overlay) {
            this._spaceStars.destroy();
            this._overlay.destroy();
            this._lowBlur.destroy();
            this._spaceStars = this._overlay = this._lowBlur = this._lowSky = this._lowOverlay = null;
        }
        // The built-in Space picture is placed as in the design: sharp, a
        // little wider than the menu, from the top, so the mountains sit
        // behind the last pinned row and the planet in the banner; a deep
        // blue fill continues below it. Other pictures cover and frost.
        this._designed = cosmic || (on && this.settings.get_string('menu-dash-background') === 'SPACE' && !!this._pictureSize);
        if (cosmic) {
            this.actor.add_style_class_name('fusion-sm-dash-on');
            this.actor.add_style_class_name('fusion-sm-dash-space');
            this._picture.set_style(null);
            this._frost.set_style(null);
            this._frost.remove_effect_by_name('fusion-dash-frost');
        } else if (this._designed) {
            this.actor.add_style_class_name('fusion-sm-dash-on');
            this.actor.add_style_class_name('fusion-sm-dash-space');
            this._placeSpace();
            this._picture.set_style(radius);
            this._frost.remove_effect_by_name('fusion-dash-frost');
        } else if (on) {
            this.actor.add_style_class_name('fusion-sm-dash-on');
            this.actor.remove_style_class_name('fusion-sm-dash-space');
            this._picture.set_style(null);
            this._frost.set_style(`background-image: url("${this._pictureUri}"); background-size: cover; background-position: center; ${radius}`);
            if (!this._frost.get_effect('fusion-dash-frost')) {
                this._frost.add_effect_with_name('fusion-dash-frost',
                    new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: FROST_BLUR, brightness: 1.0}));
            }
        } else {
            this.actor.remove_style_class_name('fusion-sm-dash-on');
            this.actor.remove_style_class_name('fusion-sm-dash-space');
            this._picture.set_style(null);
            this._frost.set_style(null);
            this._frost.remove_effect_by_name('fusion-dash-frost');
        }
        this._tint.set_style(radius);
        this._queueHeroPicture();
    }

    /** The scene's (or Space picture's) horizon on the banner's bottom edge. */
    _placeHorizon() {
        if (!this._cosmos) {
            this._placeSpace();
            return;
        }
        if (!this._hero.mapped || !this._hero.visible || !this._picture.get_stage() || !this._picture.height)
            return;
        const [, py] = this._picture.get_transformed_position();
        const [, hy] = this._hero.get_transformed_position();
        this._cosmos.setHorizon((hy - py + this._hero.height) / this._picture.height);
    }

    /** Space picture at menu width, its horizon on the banner's bottom edge. */
    _placeSpace() {
        // The menu width (the picture's own width is not final before layout).
        const pw = this.settings.get_int('menu-width') || DashboardLayout.size[0];
        const radius = `border-radius: ${this._radius()};`;
        // Sky: covers the whole menu, from the top, centred (St takes no "center top").
        const [sw, sh] = this._pictureSize;
        const skyScale = Math.max(pw / sw, MENU_HEIGHT / sh);
        const [kw, kh] = [Math.ceil(sw * skyScale), Math.ceil(sh * skyScale)];
        this._frost.set_style(`background-image: url("${this._pictureUri}"); background-size: ${kw}px ${kh}px; ` +
            `background-position: ${Math.round((pw - kw) / 2)}px 0px; ${radius}`);
        if (!this._overlay)
            return;
        // Overlay, as in the design: the planet's top touches the banner's
        // top edge, so its dome fills the banner, the side mountains rise
        // behind the last pinned row and the lake runs behind the action row.
        const size = this._overlaySize ?? this._pictureSize;
        const w = Math.round(pw * SPACE_SCALE);
        const h = Math.round(w * size[1] / size[0]);
        let y = SPACE_TOP;
        if (this._hero.mapped && this._hero.visible) {
            const [, py] = this._picture.get_transformed_position();
            const [, hy] = this._hero.get_transformed_position();
            y = Math.round(hy - py + SPACE_PLANET_GAP - SPACE_PLANET * h);
            if (!Number.isFinite(y))
                y = SPACE_TOP;
        }
        this._overlay.set_style(`background-image: url("${this._overlayUri}"); background-size: ${w}px ${h}px; ` +
            `background-position: ${Math.round((pw - w) / 2)}px ${y}px; ${radius}`);
        // Blurred strip from the banner's bottom edge to the bottom of the menu.
        if (this._hero.mapped && this._hero.visible && this._picture.get_stage()) {
            const [, py] = this._picture.get_transformed_position();
            const [, hy] = this._hero.get_transformed_position();
            const top = Math.round(hy - py + this._hero.height + LOW_BLUR_GAP);
            const low = Math.round((this._picture.height || MENU_HEIGHT) - top);
            if (Number.isFinite(top) && low > 0) {
                const [, , br, bl] = this._corners();
                const corners = `border-radius: 0 0 ${br}px ${bl}px;`;
                this._lowBlur.height = low;
                this._lowSky.set_style(`background-image: url("${this._pictureUri}"); background-size: ${kw}px ${kh}px; ` +
                    `background-position: ${Math.round((pw - kw) / 2)}px ${-top}px; ${corners}`);
                this._lowOverlay.set_style(`background-image: url("${this._overlayUri}"); background-size: ${w}px ${h}px; ` +
                    `background-position: ${Math.round((pw - w) / 2)}px ${y - top}px; ${corners}`);
                this._lowBlur.show();
            }
        }
        // Sizes are only asked for once the menu is on the stage (St would complain).
        const ph = this._picture.get_stage() ? this._picture.height : MENU_HEIGHT;
        this._spaceStars.setHorizon((y + SPACE_HORIZON * h) / (ph || MENU_HEIGHT));
    }

    _queueHeroPicture() {
        if (this._heroId)
            return;
        this._heroId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._heroId = 0;
            this._syncHeroPicture();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The banner shows the picture sharp, at the size of the frosted one,
     * centred on its focus point (the horizon / planet of the Space picture).
     */
    _syncHeroPicture() {
        const size = this._pictureSize;
        for (const [box, picture, focus] of [[this._hero, this._heroPicture, HERO_FOCUS], [this._footerBox, this._footerPicture, FOOTER_FOCUS]]) {
            // The designed Space picture is sharp already; the banner shows its
            // own panorama picture (Space) or stays see-through (Cosmic).
            if (this._designed && box === this._hero)
                this._placeHorizon();
            // Footer: the banner panorama, fully blurred, under glossy glass.
            if (box === this._footerBox && this._bannerUri && this._overlay && box.mapped && !this._destroyed) {
                const [iw, ih] = this._bannerSize;
                const scale = Math.max(box.width / iw, box.height / ih) * FOOTER_ZOOM;
                const [w, h] = [Math.ceil(iw * scale), Math.ceil(ih * scale)];
                picture.set_style(`background-image: url("${this._bannerUri}"); background-size: ${w}px ${h}px; ` +
                    `background-position: ${Math.round((box.width - w) / 2)}px ${Math.round((box.height - h) * 0.45)}px; border-radius: 18px;`);
                if (!picture.get_effect('fusion-dash-footer-blur')) {
                    picture.add_effect_with_name('fusion-dash-footer-blur',
                        new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: FOOTER_BLUR, brightness: 1.0}));
                }
                picture.show();
                continue;
            }
            picture.remove_effect_by_name('fusion-dash-footer-blur');
            if (box === this._hero && this._bannerUri && this._overlay && box.mapped && !this._destroyed) {
                const [iw, ih] = this._bannerSize;
                const scale = Math.max(box.width / iw, box.height / ih);
                const [w, h] = [Math.ceil(iw * scale), Math.ceil(ih * scale)];
                picture.set_style(`background-image: url("${this._bannerUri}"); background-size: ${w}px ${h}px; ` +
                    `background-position: ${Math.round(Math.max(box.width - w, Math.min(0, box.width * BANNER_PLANET_AT - w * BANNER_PLANET)))}px ` +
                    `${Math.round((box.height - h) / 2)}px;`);
                picture.show();
                continue;
            }
            if (this._destroyed || !this._pictureUri || !size || !box.mapped || (this._designed && box === this._hero)) {
                // Hidden too: St keeps painting the old picture after the style is cleared.
                picture.set_style(null);
                picture.hide();
                continue;
            }
            // Same "cover" fit as the frosted picture.
            const fromOverlay = !!this._overlayUri && box === this._footerBox;
            const src = fromOverlay && this._overlaySize ? this._overlaySize : size;
            const [pw, ph] = [this._picture.width, this._picture.height];
            const scale = Math.max(pw / src[0], ph / src[1]);
            const [w, h] = [Math.ceil(src[0] * scale), Math.ceil(src[1] * scale)];
            const [bw, bh] = [box.width, box.height];
            const clamp = (v, min) => Math.round(Math.max(min, Math.min(0, v)));
            const x = clamp(bw / 2 - focus[0] * w, bw - w);
            const y = clamp(bh / 2 - focus[1] * h, bh - h);
            // The footer strip shows the planet: from the overlay when there is one.
            const uri = this._overlayUri && box === this._footerBox ? this._overlayUri : this._pictureUri;
            picture.set_style(`background-image: url("${uri}"); background-size: ${w}px ${h}px; ` +
                `background-position: ${x}px ${y}px;`);
            picture.show();
        }
    }

    /** Light text gets a dark tint and dark cards, dark text light ones. */
    _syncTone() {
        if (!this.actor.get_stage())
            return;
        const c = this.actor.get_theme_node().get_foreground_color();
        const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
        const lightText = (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) / scale > 0.5;
        if (lightText === this._lightText)
            return;
        this._lightText = lightText;
        this.actor.remove_style_class_name(lightText ? 'fusion-sm-dash-light' : 'fusion-sm-dash-dark');
        this.actor.add_style_class_name(lightText ? 'fusion-sm-dash-dark' : 'fusion-sm-dash-light');
    }

    // ---- Pages -----------------------------------------------------------------------

    mainViews() {
        return [this._homeScroll, this._all, this._recentPage];
    }

    /** Keep the menu height while another page shows (pages are shorter than home). */
    _freeze() {
        if (this._homeScroll.visible && this._body.height > 0)
            this._body.height = this._body.height;
    }

    _unfreeze() {
        this._body.height = -1;
    }

    showResults(q) {
        this._freeze();
        super.showResults(q);
    }

    hideResults() {
        super.hideResults();
        this._all.visible = !!this._showingAll;
        this._recentPage.visible = !!this._showingRecent;
        this._homeScroll.visible = !this._showingAll && !this._showingRecent;
        if (this._homeScroll.visible)
            this._unfreeze();
    }

    _showRecent() {
        this._freeze();
        this._showingRecent = true;
        this._showingAll = false;
        this._fillList(this._recentList, this._recentScroll, recentGroups(this.ctx, this._filteredFiles(), 3, this._cardOpts));
        this._homeScroll.hide();
        this._all.hide();
        this._recentPage.show();
        W.firstButton(this._recentList)?.grab_key_focus();
    }

    _showAll() {
        this._freeze();
        this._showingAll = true;
        this._showingRecent = false;
        this._recentPage.hide();
        this._fillList(this._allList, this._allScroll, [W.alphaList(this.ctx, this.model.apps)]);
        this._homeScroll.hide();
        this._all.show();
        W.firstButton(this._allList)?.grab_key_focus();
    }

    _showHome() {
        this._showingAll = false;
        this._showingRecent = false;
        this._recentPage.hide();
        this._recentList.destroy_all_children();
        this._all.hide();
        this._allList.destroy_all_children();
        this._homeScroll.show();
        this._unfreeze();
    }

    // ---- Open / refresh ---------------------------------------------------------------

    _tick() {
        const now = GLib.DateTime.new_now_local();
        const twelve = D.twelveHour(this.settings);
        this._time.text = now.format(twelve ? '%-l:%M' : '%H:%M');
        this._ampm.text = twelve ? now.format('%p') : '';
        this._ampm.visible = twelve;
        this._date.text = now.format('%a, %-d %b %Y');
        const [hello] = D.greeting();
        this._greet.text = `${hello},`;
        this._greetName.text = D.firstName();
        if (this._footerGreet)
            this._footerGreet.text = `${hello}!`;
    }

    _startClock() {
        this._tick();
        const wait = 60 - new Date().getSeconds();
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
            this._clockId = 0;
            this._startClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimers() {
        this._cosmos?.stop();
        this._spaceStars?.stop();
        for (const id of [this._clockId, this._weatherId])
            if (id)
                GLib.source_remove(id);
        this._clockId = this._weatherId = 0;
    }

    onOpen() {
        super.onOpen();
        this._stopTimers();
        this._startClock();
        if (this._shown('weather'))
            this._weather.refresh();
        // While the menu stays open, the weather refreshes every 30 minutes.
        this._weatherId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            if (this._shown('weather'))
                this._weather.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._syncPicture();
        this._syncTone();
        this._fitHeight();
        this._queueHeroPicture();
        this._cosmos?.start();
        this._spaceStars?.start();
    }

    /** MENU_HEIGHT tall, or the screen's work area minus a margin when that is smaller. */
    _fitHeight() {
        const lm = Main.layoutManager;
        const monitor = (this.ctx.menu.sourceActor && lm.findMonitorForActor(this.ctx.menu.sourceActor)) ?? lm.primaryMonitor;
        const area = monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null;
        const h = Math.min(MENU_HEIGHT, area ? area.height - 24 : MENU_HEIGHT);
        this._picture.set_height(h);
    }

    reset() {
        this._power.hide();
        this._quote.text = `“${D.quote()}”`;
        this._cheer.text = D.encouragement();
        this._tick();
        this._showPinnedPage(0);
        this._recFilter = 'all';
        this._fillRecent();
        this._fillContinue();
        this._fillDownloads();
        this._fillEvents();
        this._fillStorage();
        this._syncSections();
        if (this.defaultAll)
            this._showAll();
        else
            this._showHome();
    }

    destroy() {
        this._destroyed = true;
        this._stopTimers();
        for (const id of [this._laterId, this._heroId])
            if (id)
                GLib.source_remove(id);
        this._laterId = this._heroId = 0;
        this.settings.disconnectObject(this);
        this.ctx.menu.disconnectObject(this);
        this._eventSrc?.disconnectObject?.(this);
        this._unwatchWallpaper();
        this._unwatchStyle();
        this._cosmos?.destroy();
        this._spaceStars?.destroy();
        this._cosmos = this._spaceStars = null;
        this._weather.destroy();
        super.destroy();
    }
}

export const LAYOUTS = {
    eleven: ElevenLayout,
    dashboard: DashboardLayout,
    windows: WindowsLayout,
    fusion: FusionLayout,
    mint: MintLayout,
    grid: GridLayout,
    plasma: PlasmaLayout,
    runner: RunnerLayout,
};
