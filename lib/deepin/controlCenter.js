// Deepin-style control centre: a panel that slides in from the right edge with
// quick toggles, sliders, notifications and links to GNOME Settings pages.
// Toggles and sliders mirror GNOME's own Quick Settings items, so they act on
// exactly the same system state. Clean-room; no DDE code or assets.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {addBlur, openSettingsPanel, surfaceStyle, themeClass} from './common.js';

const PANEL_WIDTH = 380;
const SLIDE_TIME = 250;
const MAX_NOTIFICATIONS = 30;

// Quick Settings indicators whose toggles are mirrored, in display order.
const TOGGLE_SOURCES = ['_network', '_bluetooth', '_rfkill', '_nightLight', '_darkMode', '_doNotDisturb', '_powerProfiles', '_autoRotate'];
const SLIDER_SOURCES = ['_volumeOutput', '_brightness'];

const SETTINGS_LINKS = [
    ['network', 'network-wireless-symbolic', () => _('Network')],
    ['bluetooth', 'bluetooth-active-symbolic', () => _('Bluetooth')],
    ['display', 'video-display-symbolic', () => _('Display')],
    ['sound', 'audio-speakers-symbolic', () => _('Sound')],
    ['power', 'battery-full-symbolic', () => _('Power')],
    ['background', 'preferences-desktop-wallpaper-symbolic', () => _('Personalization')],
    ['notifications', 'preferences-system-notifications-symbolic', () => _('Notifications')],
    ['applications', 'view-app-grid-symbolic', () => _('Apps')],
    ['mouse', 'input-mouse-symbolic', () => _('Mouse')],
    ['keyboard', 'input-keyboard-symbolic', () => _('Keyboard')],
    ['users', 'system-users-symbolic', () => _('Accounts')],
    ['system', 'emblem-system-symbolic', () => _('System')],
];

export class ControlCenter {
    constructor(deepin) {
        this._deepin = deepin;
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
        this._deepin.launcher?.close();
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        const s = this._settings;
        const reserved = this._deepin.reservedHeight;
        const atBottom = this._deepin.atBottom;
        this._fromLeft = s.get_string('deepin-control-position') === 'START';
        this._offscreenX = (this._fromLeft ? -1 : 1) * (PANEL_WIDTH + 20);
        this._closeX = this._offscreenX;

        this._root = new St.Widget({
            reactive: true,
            x: m.x, y: m.y, width: m.width, height: m.height,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `fusion-deepin-cc ${themeClass(s)}`,
            style: surfaceStyle(s),
            reactive: true,
            width: PANEL_WIDTH,
            height: m.height - reserved - 20,
            // Opens on the side of its button: left after the start button, else right.
            x: this._fromLeft ? 10 : m.width - PANEL_WIDTH - 10,
            y: atBottom ? 10 : reserved + 10,
            translation_x: this._offscreenX,
        });
        addBlur(this._panel, s, 40);
        this._root.add_child(this._panel);
        Main.uiGroup.add_child(this._root);

        this._buildContent();

        this._root.connect('button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this._root) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        this.isOpen = true;
        this._panel.grab_key_focus();
        this._panel.ease({translation_x: 0, duration: SLIDE_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const root = this._root;
        const panel = this._panel;
        this._disconnectSources();
        this._root = this._panel = null;
        panel.ease({
            translation_x: this._closeX,
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => root.destroy(),
        });
    }

    // ---- content ------------------------------------------------------------

    _buildContent() {
        // Fixed top (toggles, sliders, Settings links), notifications in the
        // flexible middle, month calendar at the bottom.
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-box', y_expand: true});
        this._panel.add_child(box);

        box.add_child(this._header());
        box.add_child(this._toggles());
        const sliders = this._sliders();
        if (sliders)
            box.add_child(sliders);
        box.add_child(this._settingsGrid());
        box.add_child(this._notificationSection());
        box.add_child(this._calendar());
    }

    // ---- calendar ------------------------------------------------------------

    _calendar() {
        const card = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-calendar'});
        const head = new St.BoxLayout({style_class: 'fusion-deepin-cc-cal-head'});
        const arrow = (icon, name, step) => {
            const b = new St.Button({style_class: 'fusion-deepin-cc-cal-arrow', can_focus: true, accessible_name: name,
                child: new St.Icon({icon_name: icon, icon_size: 14})});
            b.connect('clicked', () => this._showMonth(step));
            return b;
        };
        this._calTitle = new St.Button({style_class: 'fusion-deepin-cc-cal-title', can_focus: true, x_expand: true,
            accessible_name: _('Today'), label: ''});
        this._calTitle.connect('clicked', () => this._showMonth(0, true));
        head.add_child(this._calTitle);
        head.add_child(arrow('go-previous-symbolic', _('Previous month'), -1));
        head.add_child(arrow('go-next-symbolic', _('Next month'), 1));
        card.add_child(head);
        this._calGrid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-cal-grid'});
        card.add_child(this._calGrid);
        this._showMonth(0, true);
        return card;
    }

    /** Move the calendar by `step` months (or back to this month). */
    _showMonth(step, today = false) {
        const now = GLib.DateTime.new_now_local();
        if (today || !this._calMonth)
            this._calMonth = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0);
        else
            this._calMonth = this._calMonth.add_months(step);
        const first = this._calMonth;
        this._calTitle.label = first.format('%B %Y');
        this._calGrid.destroy_all_children();

        // Week starts on the locale's first day (0 = Sunday).
        const weekStart = Shell.util_get_week_start();
        const row = () => {
            const r = new St.BoxLayout({style_class: 'fusion-deepin-cc-cal-row', x_expand: true});
            this._calGrid.add_child(r);
            return r;
        };
        const names = row();
        // 2026-10-04 is a Sunday: build weekday names from it.
        const sunday = GLib.DateTime.new_local(2026, 10, 4, 12, 0, 0);
        for (let i = 0; i < 7; i++) {
            const day = sunday.add_days((weekStart + i) % 7);
            names.add_child(new St.Label({text: day.format('%a').slice(0, 2), style_class: 'fusion-deepin-cc-cal-dayname', x_expand: true}));
        }
        const offset = (first.get_day_of_week() % 7 - weekStart + 7) % 7;
        for (let w = 0; w < 6; w++) {
            const r = row();
            for (let d = 0; d < 7; d++) {
                const date = first.add_days(w * 7 + d - offset);
                const classes = ['fusion-deepin-cc-cal-day'];
                if (date.get_month() !== first.get_month())
                    classes.push('other-month');
                if (date.get_year() === now.get_year() && date.get_day_of_year() === now.get_day_of_year())
                    classes.push('today');
                r.add_child(new St.Label({text: `${date.get_day_of_month()}`, style_class: classes.join(' '), x_expand: true}));
            }
        }
    }

    _header() {
        const head = new St.BoxLayout({style_class: 'fusion-deepin-cc-header'});
        const now = GLib.DateTime.new_now_local();
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({text: now.format('%H:%M'), style_class: 'fusion-deepin-cc-time'}));
        text.add_child(new St.Label({text: now.format('%A, %e %B'), style_class: 'fusion-deepin-cc-date'}));
        // Time and date bring the calendar below back to this month.
        const dateButton = new St.Button({style_class: 'fusion-deepin-cc-datebutton', can_focus: true, x_expand: true,
            accessible_name: _('Calendar'), child: text});
        dateButton.connect('clicked', () => this._showMonth(0, true));
        head.add_child(dateButton);
        const gear = new St.Button({
            style_class: 'fusion-deepin-round-button', can_focus: true, accessible_name: _('Settings'),
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        gear.connect('clicked', () => {
            this.close();
            openSettingsPanel();
        });
        head.add_child(gear);
        return head;
    }

    /** GNOME Quick Settings items of the given indicators. */
    _quickItems(sources) {
        const qs = Main.panel.statusArea.quickSettings;
        const items = [];
        for (const name of sources) {
            for (const item of qs?.[name]?.quickSettingsItems ?? [])
                items.push(item);
        }
        return items;
    }

    _toggles() {
        this._toggleGrid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-toggles'});
        const toggles = this._quickItems(TOGGLE_SOURCES).filter(t => 'checked' in t && !t.slider);
        this._mirrored = [];
        this._tiles = toggles.map(t => this._mirrorToggle(t));
        this._layoutToggles();
        return this._toggleGrid;
    }

    /** Rows of three visible tiles, so hidden toggles (no Wi-Fi hardware, …) leave no gaps. */
    _layoutToggles() {
        const grid = this._toggleGrid;
        if (!grid)
            return;
        this._tiles.forEach(t => t.get_parent()?.remove_child(t));
        grid.destroy_all_children();
        let row = null;
        this._tiles.filter(t => t.visible).forEach((tile, i) => {
            if (i % 3 === 0) {
                row = new St.BoxLayout({style_class: 'fusion-deepin-cc-row'});
                grid.add_child(row);
            }
            row.add_child(tile);
        });
        // Hidden tiles stay parented so their visibility can come back.
        const parking = new St.Widget({visible: false});
        this._tiles.filter(t => !t.visible).forEach(t => parking.add_child(t));
        grid.add_child(parking);
    }

    _mirrorToggle(toggle) {
        const tile = new St.Button({
            style_class: 'fusion-deepin-cc-tile',
            can_focus: true,
            track_hover: true,
            width: 108,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        const icon = new St.Icon({icon_size: 20, style_class: 'fusion-deepin-cc-tile-icon'});
        const label = new St.Label({style_class: 'fusion-deepin-cc-tile-label', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(icon);
        box.add_child(label);
        tile.set_child(box);
        const sync = () => {
            if (!this._panel)
                return;
            const visible = toggle.visible && toggle.reactive !== false;
            if (tile.visible !== visible) {
                tile.visible = visible;
                if (this._tiles?.includes(tile))
                    this._layoutToggles();
            }
            label.text = toggle.title ?? toggle.label ?? '';
            if (toggle.gicon)
                icon.gicon = toggle.gicon;
            else
                icon.icon_name = toggle.icon_name ?? toggle.iconName ?? 'emblem-default-symbolic';
            if (toggle.checked)
                tile.add_style_pseudo_class('checked');
            else
                tile.remove_style_pseudo_class('checked');
        };
        toggle.connectObject('notify::checked', sync, 'notify::visible', sync, 'notify::title', sync,
            'notify::gicon', sync, 'notify::icon-name', sync, this);
        this._mirrored.push(toggle);
        // Same as clicking GNOME's own toggle (it owns the system state).
        tile.connect('clicked', () => toggle.emit('clicked', Clutter.BUTTON_PRIMARY));
        sync();
        return tile;
    }

    _sliders() {
        const items = this._quickItems(SLIDER_SOURCES).filter(i => i.slider instanceof Slider);
        if (!items.length)
            return null;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-sliders'});
        for (const item of items) {
            const row = new St.BoxLayout({style_class: 'fusion-deepin-cc-slider-row'});
            const icon = new St.Icon({icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
            const slider = new Slider(item.slider.value);
            slider.x_expand = true;
            slider.accessible_name = item.slider.accessible_name ?? '';
            row.add_child(icon);
            row.add_child(slider);
            const sync = () => {
                if (!this._panel)
                    return;
                row.visible = item.visible;
                if (item.gicon)
                    icon.gicon = item.gicon;
                else
                    icon.icon_name = item.iconName ?? item.icon_name ?? 'audio-volume-high-symbolic';
                if (!this._dragging)
                    slider.value = item.slider.value;
            };
            item.connectObject('notify::visible', sync, 'notify::gicon', sync, 'notify::icon-name', sync, this);
            item.slider.connectObject('notify::value', sync, this);
            this._mirrored.push(item, item.slider);
            slider.connect('drag-begin', () => (this._dragging = true));
            slider.connect('drag-end', () => (this._dragging = false));
            // GNOME's slider applies the volume / brightness for us.
            slider.connect('notify::value', () => {
                if (Math.abs(item.slider.value - slider.value) > 0.001)
                    item.slider.value = slider.value;
            });
            box.add_child(row);
            sync();
        }
        // Hide the whole block when no slider applies (no sound card, no backlight).
        const syncBox = () => (box.visible = box.get_children().some(r => r.visible));
        box.get_children().forEach(r => r.connect('notify::visible', syncBox));
        syncBox();
        return box;
    }

    // ---- notifications ---------------------------------------------------------

    _notificationSection() {
        const section = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-notifications'});
        const head = new St.BoxLayout({style_class: 'fusion-deepin-cc-section-head'});
        head.add_child(new St.Label({text: _('Notifications'), style_class: 'fusion-deepin-cc-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const clear = new St.Button({label: _('Clear all'), style_class: 'fusion-deepin-link-button', can_focus: true});
        clear.connect('clicked', () => {
            for (const n of this._notifications())
                n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        });
        head.add_child(clear);
        section.add_child(head);
        this._clear = clear;
        // The notifications get the space left between the links and the calendar.
        section.y_expand = true;
        const scroll = new St.ScrollView({style_class: 'fusion-deepin-cc-note-scroll', y_expand: true, hscrollbar_policy: St.PolicyType.NEVER});
        this._noteList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-note-list'});
        scroll.set_child(this._noteList);
        section.add_child(scroll);

        const queue = () => this._queueNotes();
        Main.messageTray.connectObject('source-added', (_t, src) => {
            this._watchSource(src);
            queue();
        }, 'source-removed', queue, this);
        this._sources = new Set();
        Main.messageTray.getSources().forEach(src => this._watchSource(src));
        this._fillNotes();
        return section;
    }

    _watchSource(src) {
        if (this._sources.has(src))
            return;
        this._sources.add(src);
        const queue = () => this._queueNotes();
        src.connectObject('notification-added', queue, 'notification-removed', queue, this);
    }

    _notifications() {
        const list = [];
        for (const src of Main.messageTray.getSources())
            list.push(...(src.notifications ?? []));
        return list.sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0));
    }

    _queueNotes() {
        if (this._notesId)
            return;
        this._notesId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._notesId = 0;
            this._fillNotes();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fillNotes() {
        if (!this._noteList)
            return;
        this._noteList.destroy_all_children();
        const notes = this._notifications().slice(0, MAX_NOTIFICATIONS);
        if (this._clear)
            this._clear.visible = notes.length > 0;
        if (!notes.length) {
            this._noteList.add_child(new St.Label({text: _('No recent notifications'), style_class: 'fusion-deepin-empty-hint', x_align: Clutter.ActorAlign.CENTER}));
            return;
        }
        for (const n of notes)
            this._noteList.add_child(this._noteCard(n));
    }

    _noteCard(n) {
        const card = new St.Button({style_class: 'fusion-deepin-cc-note', can_focus: true, track_hover: true, x_expand: true});
        const row = new St.BoxLayout({x_expand: true});
        const gicon = n.gicon ?? n.source?.icon;
        row.add_child(new St.Icon({gicon, icon_size: 32, y_align: Clutter.ActorAlign.START, style_class: 'fusion-deepin-cc-note-icon'}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const title = new St.Label({text: n.title ?? '', style_class: 'fusion-deepin-cc-note-title'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const body = new St.Label({text: (n.body ?? '').replace(/<[^>]*>/g, ''), style_class: 'fusion-deepin-cc-note-body'});
        body.clutter_text.line_wrap = true;
        body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        if (n.body)
            text.add_child(body);
        row.add_child(text);
        const close = new St.Button({
            style_class: 'fusion-deepin-note-close', can_focus: true, accessible_name: _('Dismiss'),
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
        });
        close.connect('clicked', () => n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
        row.add_child(close);
        card.set_child(row);
        card.connect('clicked', () => {
            this.close();
            n.activate();
        });
        return card;
    }

    _settingsGrid() {
        const section = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-links'});
        section.add_child(new St.Label({text: _('Control Center'), style_class: 'fusion-deepin-cc-title'}));
        let row = null;
        SETTINGS_LINKS.forEach(([panel, icon, label], i) => {
            if (i % 4 === 0) {
                row = new St.BoxLayout({style_class: 'fusion-deepin-cc-row', x_expand: true});
                section.add_child(row);
            }
            const b = new St.Button({style_class: 'fusion-deepin-cc-link', can_focus: true, track_hover: true, width: 81});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new St.Icon({icon_name: icon, icon_size: 20}));
            const l = new St.Label({text: label(), style_class: 'fusion-deepin-cc-link-label', x_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(l);
            b.set_child(box);
            b.connect('clicked', () => {
                this.close();
                openSettingsPanel(panel);
            });
            row.add_child(b);
        });
        return section;
    }

    // ---- teardown ------------------------------------------------------------

    _disconnectSources() {
        if (this._notesId) {
            GLib.source_remove(this._notesId);
            this._notesId = 0;
        }
        Main.messageTray.disconnectObject(this);
        for (const src of this._sources ?? [])
            src.disconnectObject(this);
        this._sources = null;
        for (const obj of this._mirrored ?? [])
            obj.disconnectObject(this);
        this._mirrored = null;
        this._noteList = null;
        this._clear = null;
        this._toggleGrid = null;
        this._tiles = null;
    }

    _teardown() {
        this._disconnectSources();
        this._root?.destroy();
        this._root = this._panel = null;
    }

    destroy() {
        Main.overview.disconnectObject(this);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.isOpen = false;
        this._teardown();
    }
}
