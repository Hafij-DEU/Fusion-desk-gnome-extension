// Start menu layouts. Each builds `this.actor` from the shared widgets and
// handles its own views; MenuHost picks one from the `menu-layout` setting.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as W from './widgets.js';
import {fileKind} from './model.js';
import {AppHubPanel, appHubInstalled, hubBadgeIcon} from './appHub.js';
import * as D from './dashboard.js';
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
function cardGrid(ctx, files, columns = 2) {
    const grid = W.vbox('fusion-sm-recommended');
    for (let i = 0; i < files.length; i += columns) {
        const row = W.hbox('fusion-sm-rec-row', {x_expand: true});
        row.layout_manager.homogeneous = true;
        files.slice(i, i + columns).forEach(f => row.add_child(W.fileCard(ctx, f)));
        while (row.get_n_children() < columns)
            row.add_child(new St.Widget({x_expand: true}));
        grid.add_child(row);
    }
    return grid;
}

/** Recent files grouped into Today, Yesterday, This week and Earlier card grids. */
function recentGroups(ctx, files, columns = 2) {
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
        items.push(cardGrid(ctx, list, columns));
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

const PINNED_ROWS = 2;
const RECENT_CARDS = 6;

class DashboardLayout extends BaseLayout {
    static title = 'Dashboard';
    static size = [940, 0]; // natural height, compact enough for a 1080p screen
    static columns = 6;
    static searchMovable = false;

    constructor(ctx) {
        super(ctx, 'dashboard');
        const s = this.settings;
        this._pinPage = 0;
        this._recFilter = 'all';
        this._tip = D.tipOfTheDay();
        this._items = {}; // menu-dash-sections id -> actor

        // Background picture (cover) under a frosted tint that holds the page.
        this._picture = new St.Widget({style_class: 'fusion-sm-dash-picture', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true});
        this._tint = W.vbox('fusion-sm-dash-tint', {x_expand: true, y_expand: true});
        this._picture.add_child(this._tint);
        this.actor.add_child(this._picture);

        this._tint.add_child(this._makeSearch('Search apps, settings and documents'));
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
            'changed::menu-dash-sections', () => this._syncSections(),
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

    _cardTitle(text, extra = []) {
        const row = W.hbox('fusion-sm-dash-card-head', {x_expand: true});
        row.add_child(W.label(text, 'fusion-sm-heading', {x_expand: true}));
        extra.forEach(a => row.add_child(a));
        return row;
    }

    /** Pinned apps in pages of two rows: dots or the scroll wheel turn the page. */
    _pinnedSection() {
        const box = W.vbox('fusion-sm-dash-section');
        const head = W.hbox('fusion-sm-heading-row', {x_expand: true});
        head.add_child(W.label('Pinned', 'fusion-sm-heading', {x_expand: true}));
        this._pager = W.hbox('fusion-sm-dash-pager', {y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._pager);
        head.add_child(this._pill('All apps  ›', () => this._showAll()));
        box.add_child(head);
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
        const per = cols * PINNED_ROWS;
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
        const rows = pages > 1 ? PINNED_ROWS : Math.ceil(slice.length / cols);
        for (let r = 0; r < rows; r++) {
            const row = W.hbox('fusion-sm-grid-row', {x_expand: true});
            row.layout_manager.homogeneous = true;
            for (let c = 0; c < cols; c++) {
                const app = slice[r * cols + c];
                const tile = W.appTile(this.ctx, app ?? apps[0], {style: 'fusion-sm-tile fusion-sm-dash-tile'});
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

    /** Clock with date and a short quote, weather, greeting. */
    _heroRow() {
        const row = this._hero = W.hbox('fusion-sm-dash-row', {x_expand: true});
        const clock = this._items.clock = this._card('fusion-sm-dash-clock', {x_expand: true});
        this._time = W.label('', 'fusion-sm-dash-time');
        this._date = W.label('', 'fusion-sm-dash-date');
        this._quote = W.label('', 'fusion-sm-dash-quote');
        clock.add_child(this._time);
        clock.add_child(this._date);
        clock.add_child(this._quote);
        row.add_child(clock);

        this._weatherCard = new St.Button({style_class: 'fusion-sm-dash-card fusion-sm-dash-weather', can_focus: true,
            track_hover: true, accessible_name: 'Weather'});
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

        const greet = this._items.greeting = this._card('fusion-sm-dash-greet');
        const line = W.hbox('fusion-sm-dash-greet-line');
        this._greetIcon = new St.Icon({style_class: 'fusion-sm-dash-greet-icon', icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._greetIcon);
        this._greet = W.label('', 'fusion-sm-dash-greet-title');
        line.add_child(this._greet);
        greet.add_child(line);
        this._cheer = W.label('', 'fusion-sm-dash-cheer');
        this._cheer.clutter_text.line_wrap = true;
        greet.add_child(this._cheer);
        row.add_child(greet);
        return row;
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
            box.add_child(new St.Icon({icon_name: report?.icon ?? 'weather-few-clouds-symbolic', icon_size: 36,
                style_class: 'fusion-sm-dash-weather-icon', y_align: Clutter.ActorAlign.CENTER}));
            text.add_child(W.label(report?.temp || '–', 'fusion-sm-dash-temp'));
            const status = w.state === 'loading' && !report ? 'Loading…'
                : w.state === 'error' && !report ? 'No weather data' : report?.sky ?? '';
            if (status)
                text.add_child(W.label(status, 'fusion-sm-item-name'));
            text.add_child(W.label(w.city, 'fusion-sm-item-desc'));
        }
        box.add_child(text);
        card.set_child(box);
    }

    /** Continue working, capture screen, resume downloads, quick tools. */
    _actionRow() {
        const row = this._actions = W.hbox('fusion-sm-dash-row', {x_expand: true});
        row.layout_manager.homogeneous = true;
        this._continue = this._items.continue = this._actionCard('document-open-recent-symbolic', 'Continue working', '', () => {});
        row.add_child(this._continue);
        this._items.capture = this._actionCard('camera-photo-symbolic', 'Capture screen', 'Screenshot or recording',
            () => this._afterClose(() => D.openScreenshot('screen')), {close: false});
        row.add_child(this._items.capture);
        this._downloads = this._actionCard('folder-download-symbolic', 'Resume downloads', '', () => {
            const app = this.model.lookup(D.DRACO_ID);
            if (app)
                this.ctx.launch(app);
        });
        this._items.downloads = this._downloads;
        row.add_child(this._downloads);

        const tools = this._items.tools = this._card('fusion-sm-dash-tools', {x_expand: true});
        tools.add_child(W.label('Quick tools', 'fusion-sm-item-name'));
        const buttons = W.hbox('fusion-sm-dash-tool-row');
        const tool = (icon, name, action, gicon = null) => buttons.add_child(W.iconButton(this.ctx, icon, name,
            () => this._afterClose(action), {style: 'fusion-sm-round fusion-sm-dash-tool', close: false, gicon}));
        tool('screenshot-ui-area-symbolic', 'Region screenshot', () => D.openScreenshot('area'));
        tool('color-select-symbolic', 'Colour picker', () => D.pickColor());
        for (const {name, app} of D.screenApps())
            tool(null, name, () => app.activate(), app.get_icon());
        tools.add_child(buttons);
        row.add_child(tools);
        return row;
    }

    _actionCard(icon, title, subtitle, action, {close = true} = {}) {
        const button = new St.Button({style_class: 'fusion-sm-dash-card fusion-sm-dash-action', can_focus: true, track_hover: true,
            x_expand: true, accessible_name: title});
        const box = W.hbox('fusion-sm-dash-action-box', {x_expand: true});
        button._art = new St.Bin({style_class: 'fusion-sm-dash-bubble', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: icon, icon_size: 18})});
        box.add_child(button._art);
        const text = W.vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        text.add_child(W.label(title, 'fusion-sm-item-name'));
        button._sub = W.label(subtitle, 'fusion-sm-item-desc');
        text.add_child(button._sub);
        box.add_child(text);
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
        this._continue._sub.text = `${file.name} · ${W.timeAgo(file.modified)}`;
        this._continue._art.child = new St.Icon({gicon: file.gicon, icon_size: 22});
        this._continue._action = () => this.ctx.openUriNow(file.uri);
    }

    async _fillDownloads() {
        const d = this._downloadInfo = this._shown('downloads') ? await D.unfinishedDownloads() : null;
        if (this._destroyed)
            return;
        this._syncSections();
        if (d) {
            const what = d.count === 1 ? '1 unfinished' : `${d.count} unfinished`;
            this._downloads._sub.text = d.done >= 0 ? `${what} · ${Math.floor(d.done * 100)}%` : what;
        }
    }

    _recentSection() {
        const box = W.vbox('fusion-sm-dash-section');
        const head = W.hbox('fusion-sm-heading-row fusion-sm-rec-heading', {x_expand: true});
        head.add_child(W.label('Recent files', 'fusion-sm-heading', {x_expand: true}));
        this._chips = W.hbox('fusion-sm-rec-chips');
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
        head.add_child(this._chips);
        this._viewAll = this._pill('View all  ›', () => this._showRecent());
        head.add_child(this._viewAll);
        box.add_child(head);
        this._recent = W.vbox('fusion-sm-dash-recent');
        box.add_child(this._recent);
        this._items.recent = box;
        return box;
    }

    _filteredFiles(n = 40) {
        return this.model.recentFiles(n).filter(f => this._recFilter === 'all' || D.dashKind(f) === this._recFilter);
    }

    _fillRecent() {
        this._recent.destroy_all_children();
        const all = this.model.recentFiles(40);
        const files = this._filteredFiles();
        if (files.length)
            this._recent.add_child(cardGrid(this.ctx, files.slice(0, RECENT_CARDS), 3));
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
        const row = this._widgets = W.hbox('fusion-sm-dash-row', {x_expand: true});
        row.layout_manager.homogeneous = true;

        const events = this._items.calendar = this._card('fusion-sm-dash-widget', {x_expand: true});
        const calendar = this.model.lookup('org.gnome.Calendar.desktop');
        events.add_child(this._cardTitle('Today', calendar ? [this._pill('Calendar', () => this.ctx.launch(calendar))] : []));
        this._events = W.vbox('fusion-sm-dash-events');
        events.add_child(W.scrollView(this._events, 'fusion-sm-scroll fusion-sm-dash-widget-scroll'));
        row.add_child(events);

        const note = this._items.note = this._card('fusion-sm-dash-widget', {x_expand: true});
        note.add_child(this._cardTitle('Quick note'));
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
        const noteScroll = W.scrollView(view, 'fusion-sm-scroll fusion-sm-dash-widget-scroll');
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

        const tip = this._items.tip = this._card('fusion-sm-dash-widget', {x_expand: true});
        const prev = W.iconButton(this.ctx, 'go-previous-symbolic', 'Previous tip', () => this._showTip(this._tip - 1),
            {style: 'fusion-sm-round fusion-sm-dash-mini', size: 12, close: false});
        const next = W.iconButton(this.ctx, 'go-next-symbolic', 'Next tip', () => this._showTip(this._tip + 1),
            {style: 'fusion-sm-round fusion-sm-dash-mini', size: 12, close: false});
        tip.add_child(this._cardTitle('Tip of the day', [prev, next]));
        this._tipLabel = W.label('', 'fusion-sm-dash-tip');
        this._tipLabel.clutter_text.line_wrap = true;
        tip.add_child(this._tipLabel);
        row.add_child(tip);
        this._showTip(this._tip);
        row.add_child(this._storageCard());
        return row;
    }

    /** Free space on the disk that holds the home folder. */
    _storageCard() {
        const card = this._items.storage = this._card('fusion-sm-dash-widget fusion-sm-dash-storage', {x_expand: true});
        const analyzer = this.model.lookup('org.gnome.baobab.desktop');
        card.add_child(this._cardTitle('Storage', analyzer ? [this._pill('Details', () => this.ctx.launch(analyzer))] : []));
        this._storageFree = W.label('', 'fusion-sm-dash-storage-free');
        card.add_child(this._storageFree);
        this._storageBar = new St.BoxLayout({style_class: 'fusion-hub-bar fusion-sm-dash-storage-bar', x_expand: true});
        this._storageFill = new St.Widget({style_class: 'fusion-hub-bar-fill'});
        this._storageBar.add_child(this._storageFill);
        // Size the fill after layout, not during the allocation that changed the width.
        this._storageBar.connect('notify::width', () => this._queueStorageBar());
        card.add_child(this._storageBar);
        this._storageUsed = W.label('', 'fusion-sm-item-desc');
        card.add_child(this._storageUsed);
        return card;
    }

    _queueStorageBar() {
        if (this._barId)
            return;
        this._barId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._barId = 0;
            this._storageFill.set_width(Math.round(this._storageBar.width * (this._usedShare ?? 0)));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _fillStorage() {
        if (!this._shown('storage'))
            return;
        const disk = await D.homeStorage();
        if (this._destroyed || !disk)
            return;
        this._usedShare = disk.size ? (disk.size - disk.free) / disk.size : 0;
        this._storageFree.text = `${GLib.format_size(disk.free)} free`;
        this._storageUsed.text = `${GLib.format_size(disk.size - disk.free)} of ${GLib.format_size(disk.size)} used`;
        if (this._usedShare > 0.9)
            this._storageFill.add_style_class_name('full');
        else
            this._storageFill.remove_style_class_name('full');
        this._queueStorageBar();
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
        for (const row of [this._hero, this._actions, this._widgets])
            row.visible = row.get_children().some(c => c.visible);
    }

    _showTip(i) {
        this._tip = (i + D.TIPS.length) % D.TIPS.length;
        this._tipLabel.text = D.TIPS[this._tip];
    }

    _fillEvents() {
        const source = D.eventSource();
        if (source !== this._eventSrc) {
            this._eventSrc?.disconnectObject?.(this);
            this._eventSrc = source;
            source?.connectObject('changed', () => this.ctx.menu.isOpen && this._fillEvents(), this);
        }
        this._events.destroy_all_children();
        const events = D.todayEvents(source);
        if (!events.length) {
            this._events.add_child(W.label(source?.hasCalendars ? 'No events today.' : 'No calendars set up.', 'fusion-sm-item-desc'));
            return;
        }
        for (const e of events) {
            const line = W.hbox('fusion-sm-dash-event');
            line.add_child(W.label(e.time, 'fusion-sm-dash-event-time'));
            line.add_child(W.label(e.summary, 'fusion-sm-dash-event-name', {x_expand: true}));
            this._events.add_child(line);
        }
    }

    _footer() {
        const s = this.settings;
        const footer = W.hbox('fusion-sm-footer-bar fusion-sm-dash-footer');
        if (s.get_boolean('menu-show-user'))
            footer.add_child(W.userChip(this.ctx, {size: 28}));
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
        footer.add_child(W.iconButton(this.ctx, 'view-app-grid-symbolic', 'All apps', () => this._showAll(), {close: false}));
        this._power = W.powerRow(this.ctx);
        this._power.hide();
        footer.add_child(this._power);
        footer.add_child(W.iconButton(this.ctx, 'system-shutdown-symbolic', 'Power', () => {
            this._power.visible = !this._power.visible;
        }, {close: false}));
        return footer;
    }

    // ---- Background --------------------------------------------------------------

    async _applyBackground() {
        const gen = ++this._bgGen;
        const path = D.backgroundPath(this.settings);
        const picture = path ? await D.scaledPicture(path) : null;
        if (gen !== this._bgGen || this._destroyed)
            return;
        this._pictureUri = picture ? GLib.filename_to_uri(picture, null) : null;
        this._syncPicture();
    }

    /** Corner radius of the menu surface, so the picture fits inside it. */
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

    _syncPicture() {
        if (this._destroyed)
            return;
        const on = !!this._pictureUri;
        const radius = `border-radius: ${this._radius()};`;
        if (on) {
            this.actor.add_style_class_name('fusion-sm-dash-on');
            this._picture.set_style(`background-image: url("${this._pictureUri}"); background-size: cover; background-position: center; ${radius}`);
        } else {
            this.actor.remove_style_class_name('fusion-sm-dash-on');
            this._picture.set_style(null);
        }
        this._tint.set_style(radius);
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
        this._fillList(this._recentList, this._recentScroll, recentGroups(this.ctx, this._filteredFiles(), 3));
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
        this._time.text = now.format(D.clockPattern());
        this._date.text = now.format('%A, %-d %B');
        const [hello, icon] = D.greeting();
        this._greet.text = `${hello}, ${D.firstName()}`;
        this._greetIcon.icon_name = icon;
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
    }

    reset() {
        this._power.hide();
        this._quote.text = D.quote();
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
        for (const id of [this._laterId, this._barId])
            if (id)
                GLib.source_remove(id);
        this._laterId = this._barId = 0;
        this.settings.disconnectObject(this);
        this.ctx.menu.disconnectObject(this);
        this._eventSrc?.disconnectObject?.(this);
        this._unwatchWallpaper();
        this._unwatchStyle();
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
