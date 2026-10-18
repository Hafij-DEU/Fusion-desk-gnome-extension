// Deepin-style control centre: a panel that slides in from the right edge with
// quick toggles, sliders, notifications and links to GNOME Settings pages.
// Toggles and sliders mirror GNOME's own Quick Settings items, so they act on
// exactly the same system state. Clean-room; no DDE code or assets.
import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {addBlur, openSettingsPanel, paintSurface, themeClass} from './common.js';
import {SWITCHES, laptopDevice, readSwitch, writeSwitch} from './laptop.js';

const PANEL_WIDTH = 380;
const SLIDE_TIME = 250;
const MAX_NOTIFICATIONS = 30;


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
            // As tall as its content, up to the free screen height; notifications
            // grow it and scroll once it is full.
            reactive: true,
            width: PANEL_WIDTH,
            // Opens on the side of its button: left after the start button, else right.
            x: this._fromLeft ? 10 : m.width - PANEL_WIDTH - 10,
            y: atBottom ? 10 : reserved + 10,
            translation_x: this._offscreenX,
        });
        // Keep it next to the taskbar as its height changes.
        this._panel.connect('notify::height', panel => {
            panel.y = atBottom ? m.height - reserved - 10 - panel.height : reserved + 10;
        });
        paintSurface(this._panel, s, `max-height: ${m.height - reserved - 20}px;`);
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
        // Header with actions, media, system meters and Settings shortcuts at
        // the top; notifications in the flexible middle; calendar at the bottom.
        // (Toggles and sliders stay in GNOME's Quick Settings.)
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-box', y_expand: true});
        this._panel.add_child(box);

        box.add_child(this._header());
        box.add_child(this._media());
        box.add_child(this._meters());
        const laptop = this._laptop();
        if (laptop)
            box.add_child(laptop);
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

    _roundButton(icon, name, fn) {
        const b = new St.Button({
            style_class: 'fusion-deepin-round-button', can_focus: true, accessible_name: name,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: icon, icon_size: 16}),
        });
        b.connect('clicked', () => fn(b));
        return b;
    }

    _header() {
        const head = new St.BoxLayout({style_class: 'fusion-deepin-cc-header'});
        const user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        const avatar = new UserWidget.Avatar(user, {iconSize: 44, styleClass: 'fusion-deepin-cc-avatar'});
        avatar.update();
        const now = GLib.DateTime.new_now_local();
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        const name = (user?.is_loaded && user.get_real_name()) || GLib.get_real_name() || GLib.get_user_name();
        text.add_child(new St.Label({text: name, style_class: 'fusion-deepin-cc-name'}));
        text.add_child(new St.Label({text: `${now.format('%H:%M')} · ${now.format('%e %b').trim()}`, style_class: 'fusion-deepin-cc-date'}));
        const who = new St.BoxLayout({style_class: 'fusion-deepin-cc-who'});
        who.add_child(avatar);
        who.add_child(text);
        // Name and date: account settings.
        const whoButton = new St.Button({style_class: 'fusion-deepin-cc-datebutton', can_focus: true, x_expand: true,
            accessible_name: _('Accounts'), child: who});
        whoButton.connect('clicked', () => {
            this.close();
            openSettingsPanel('users');
        });
        head.add_child(whoButton);
        const sys = SystemActions.getDefault();
        head.add_child(this._roundButton('camera-photo-symbolic', _('Screenshot'), () => {
            this.close();
            Main.screenshotUI.open().catch(e => console.warn(`Fusion Desk: screenshot failed: ${e.message}`));
        }));
        head.add_child(this._roundButton('emblem-system-symbolic', _('Settings'), () => {
            this.close();
            openSettingsPanel();
        }));
        head.add_child(this._roundButton('system-lock-screen-symbolic', _('Lock'), () => {
            this.close();
            sys.activateLockScreen();
        }));
        head.add_child(this._roundButton('system-shutdown-symbolic', _('Power'), b => this._powerMenu(b)));
        return head;
    }

    _powerMenu(source) {
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('fusion-deepin-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menus ??= new PopupMenu.PopupMenuManager(this._root);
        this._menus.addMenu(menu);
        const sys = SystemActions.getDefault();
        const act = (label, icon, fn) => menu.addAction(label, () => {
            this.close();
            fn();
        }, icon);
        act(_('Suspend'), 'media-playback-pause-symbolic', () => sys.activateSuspend());
        act(_('Restart…'), 'system-reboot-symbolic', () => sys.activateRestart());
        act(_('Power Off…'), 'system-shutdown-symbolic', () => sys.activatePowerOff());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        act(_('Log Out'), 'system-log-out-symbolic', () => sys.activateLogout());
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    // ---- media ---------------------------------------------------------------

    /** GNOME's own player list (shared with its calendar), or one of ours. */
    _mediaSource() {
        const shared = Main.panel.statusArea.dateMenu?._messageList?._messageView?._mediaSource;
        if (shared)
            return shared;
        this._ownMedia ??= new Mpris.MprisSource();
        return this._ownMedia;
    }

    _media() {
        this._mediaCard = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-media'});
        const source = this._mediaSource();
        source.connectObject('player-added', () => this._fillMedia(), 'player-removed', () => this._fillMedia(), this);
        this._mediaWatched = [source];
        this._fillMedia();
        return this._mediaCard;
    }

    _fillMedia() {
        const card = this._mediaCard;
        if (!card)
            return;
        for (const p of this._mediaPlayers ?? [])
            p.disconnectObject(this);
        card.destroy_all_children();
        const players = this._mediaSource().players;
        this._mediaPlayers = players;
        card.visible = players.length > 0;
        if (!players.length)
            return;
        // Keep the chosen player; otherwise prefer one that is playing.
        if (!players.includes(this._player))
            this._player = players.find(p => p.status === 'Playing') ?? players[0];
        const player = this._player;

        if (players.length > 1) {
            // Switch between players (one chip per app).
            const chips = new St.BoxLayout({style_class: 'fusion-deepin-cc-media-chips'});
            const playerName = p => p.app?.get_name() ?? p._mprisProxy?.Identity ?? _('Player');
            for (const p of players) {
                const chip = new St.Button({
                    style_class: 'fusion-deepin-cc-media-chip', can_focus: true, toggle_mode: true, checked: p === player,
                    accessible_name: playerName(p),
                });
                const box = new St.BoxLayout({style_class: 'fusion-deepin-cc-media-chip-box'});
                box.add_child(p.app ? p.app.create_icon_texture(16) : new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 16}));
                const l = new St.Label({text: playerName(p), y_align: Clutter.ActorAlign.CENTER});
                l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(l);
                chip.set_child(box);
                chip.connect('clicked', () => {
                    this._player = p;
                    this._fillMedia();
                });
                chips.add_child(chip);
            }
            const scroll = new St.ScrollView({style_class: 'fusion-deepin-cc-media-chip-scroll', hscrollbar_policy: St.PolicyType.EXTERNAL,
                vscrollbar_policy: St.PolicyType.NEVER, x_expand: true, child: chips});
            card.add_child(scroll);
        }

        const row = new St.BoxLayout({style_class: 'fusion-deepin-cc-media-row'});
        const cover = new St.Button({style_class: 'fusion-deepin-cc-media-cover', can_focus: true, accessible_name: _('Show player')});
        const coverIcon = new St.Icon({icon_size: 56});
        cover.set_child(coverIcon);
        const info = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'fusion-deepin-cc-media-title'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const artist = new St.Label({style_class: 'fusion-deepin-cc-media-artist'});
        artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(title);
        info.add_child(artist);
        const controls = new St.BoxLayout({style_class: 'fusion-deepin-cc-media-controls', x_align: Clutter.ActorAlign.START});
        const ctl = (icon, name, fn, extra = '') => {
            const b = new St.Button({style_class: `fusion-deepin-cc-media-button ${extra}`, can_focus: true, accessible_name: name,
                child: new St.Icon({icon_name: icon, icon_size: 16})});
            b.connect('clicked', fn);
            controls.add_child(b);
            return b;
        };
        const prev = ctl('media-skip-backward-symbolic', _('Previous'), () => player.previous());
        const play = ctl('media-playback-start-symbolic', _('Play or pause'), () => player.playPause(), 'fusion-deepin-cc-media-play');
        const next = ctl('media-skip-forward-symbolic', _('Next'), () => player.next());
        info.add_child(controls);
        row.add_child(cover);
        row.add_child(info);
        card.add_child(row);
        cover.connect('clicked', () => {
            this.close();
            player.raise();
        });

        const sync = () => {
            if (!this._mediaCard)
                return;
            title.text = player.trackTitle || player.app?.get_name() || _('Unknown title');
            artist.text = (player.trackArtists ?? []).join(', ');
            artist.visible = !!artist.text;
            const url = player.trackCoverUrl;
            if (url)
                coverIcon.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(url)});
            else if (player.app)
                coverIcon.gicon = player.app.get_icon();
            else
                coverIcon.icon_name = 'audio-x-generic-symbolic';
            play.child.icon_name = player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            prev.reactive = player.canGoPrevious;
            next.reactive = player.canGoNext;
            prev.opacity = player.canGoPrevious ? 255 : 110;
            next.opacity = player.canGoNext ? 255 : 110;
            this._panel?.queue_redraw();
        };
        for (const p of players)
            p.connectObject('changed', () => (p === this._player ? sync() : null), this);
        sync();
    }

    // ---- laptop switches -----------------------------------------------------

    /** Battery care, camera, Fn lock and USB charging tiles (laptop driver). */
    _laptop() {
        if (!this._settings.get_boolean('laptop-controls'))
            return null;
        const device = laptopDevice();
        if (!device)
            return null;
        const grid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-laptop'});
        let row = null;
        let n = 0;
        for (const [file, label, icon] of SWITCHES) {
            const state = readSwitch(device, file);
            if (state === null)
                continue;
            if (n++ % 2 === 0) {
                row = new St.BoxLayout({style_class: 'fusion-deepin-cc-row', x_expand: true});
                grid.add_child(row);
            }
            const tile = new St.Button({style_class: 'fusion-deepin-cc-switch', can_focus: true, track_hover: true, x_expand: true,
                accessible_name: _(label)});
            const box = new St.BoxLayout({style_class: 'fusion-deepin-cc-switch-box'});
            box.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
            box.add_child(new St.Label({text: _(label), y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
            const dot = new St.Widget({style_class: 'fusion-deepin-cc-switch-dot', y_align: Clutter.ActorAlign.CENTER});
            box.add_child(dot);
            tile.set_child(box);
            const sync = () => {
                const on = readSwitch(device, file);
                if (on)
                    tile.add_style_pseudo_class('checked');
                else
                    tile.remove_style_pseudo_class('checked');
                this._panel?.queue_redraw();
            };
            tile.connect('clicked', () => {
                const on = readSwitch(device, file);
                tile.add_style_pseudo_class('busy');
                writeSwitch(device, file, !on, () => {
                    tile.remove_style_pseudo_class('busy');
                    if (this._panel)
                        sync();
                });
            });
            sync();
            row.add_child(tile);
        }
        return n ? grid : null;
    }

    // ---- system meters -------------------------------------------------------

    _meters() {
        const row = new St.BoxLayout({style_class: 'fusion-deepin-cc-meters'});
        const meter = (icon, label) => {
            const tile = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-deepin-cc-meter', x_expand: true});
            const head = new St.BoxLayout({style_class: 'fusion-deepin-cc-meter-head'});
            head.add_child(new St.Icon({icon_name: icon, icon_size: 14}));
            head.add_child(new St.Label({text: label, style_class: 'fusion-deepin-cc-meter-label', y_align: Clutter.ActorAlign.CENTER}));
            const value = new St.Label({text: '–', style_class: 'fusion-deepin-cc-meter-value'});
            const track = new St.Widget({style_class: 'fusion-deepin-cc-meter-track', layout_manager: new Clutter.BinLayout(), x_expand: true});
            const bar = new St.Widget({style_class: 'fusion-deepin-cc-meter-bar', x_align: Clutter.ActorAlign.START, y_expand: true});
            track.add_child(bar);
            tile.add_child(head);
            tile.add_child(value);
            tile.add_child(track);
            row.add_child(tile);
            return {tile, set: (pct, level = null) => {
                value.text = `${Math.round(pct)}%`;
                const w = track.width || 60;
                bar.width = Math.max(2, Math.round(w * Math.min(100, Math.max(0, pct)) / 100));
                // Usage meters warn when high; the battery when low.
                const warn = level ?? (pct >= 90 ? 'critical' : pct >= 75 ? 'low' : null);
                bar.style = warn === 'critical' ? 'background-color: #e5484d;' : warn === 'low' ? 'background-color: #e08a00;'
                    : warn === 'good' ? 'background-color: #2ea043;' : null;
            }};
        };
        this._cpu = meter('fusion-cpu-symbolic', _('CPU'));
        this._ram = meter('fusion-ram-symbolic', _('Memory'));
        this._disk = meter('drive-harddisk-symbolic', _('Disk'));
        const battery = Main.panel.statusArea.quickSettings?._system?._systemItem?.powerToggle;
        this._batt = battery?._proxy?.IsPresent ? meter('battery-full-symbolic', _('Battery')) : null;
        // Fusion's own CPU / RAM icons ship in icons/.
        const dir = `${this._deepin.ext.path}/icons`;
        for (const [m, file] of [[this._cpu, 'fusion-cpu-symbolic.svg'], [this._ram, 'fusion-ram-symbolic.svg']])
            m.tile.get_child_at_index(0).get_child_at_index(0).gicon = new Gio.FileIcon({file: Gio.File.new_for_path(`${dir}/${file}`)});
        this._lastCpu = null;
        this._updateMeters();
        this._metersId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._updateMeters();
            return GLib.SOURCE_CONTINUE;
        });
        return row;
    }

    async _updateMeters() {
        const read = path => new Promise(resolve => {
            Gio.File.new_for_path(path).load_contents_async(null, (f, res) => {
                try {
                    resolve(new TextDecoder().decode(f.load_contents_finish(res)[1]));
                } catch (e) {
                    resolve('');
                }
            });
        });
        const [stat, mem] = await Promise.all([read('/proc/stat'), read('/proc/meminfo')]);
        if (!this._panel)
            return;
        const cpu = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        if (cpu.length > 4) {
            const idle = cpu[3] + (cpu[4] ?? 0);
            const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0);
            if (this._lastCpu) {
                const dt = total - this._lastCpu.total;
                this._cpu.set(dt > 0 ? 100 * (1 - (idle - this._lastCpu.idle) / dt) : 0);
            }
            this._lastCpu = {idle, total};
        }
        const kb = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(mem)?.[1] ?? 0);
        const memTotal = kb('MemTotal');
        if (memTotal)
            this._ram.set(100 * (1 - kb('MemAvailable') / memTotal));
        Gio.File.new_for_path(GLib.get_home_dir()).query_filesystem_info_async('filesystem::size,filesystem::free',
            GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    const info = f.query_filesystem_info_finish(res);
                    const size = info.get_attribute_uint64('filesystem::size');
                    if (size && this._panel)
                        this._disk.set(100 * (1 - info.get_attribute_uint64('filesystem::free') / size));
                } catch (e) {
                    // Filesystem without size info: leave the dash.
                }
            });
        if (this._batt) {
            const p = Main.panel.statusArea.quickSettings?._system?._systemItem?.powerToggle?._proxy;
            if (p) {
                const pct = p.Percentage ?? 0;
                this._batt.set(pct, pct <= 10 ? 'critical' : pct <= 20 ? 'low' : 'good');
            }
        }
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
        // No space while empty; each notification adds its height until the
        // panel reaches the screen height, then the list scrolls.
        this._noteSection = section;
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
        if (this._noteSection)
            this._noteSection.visible = notes.length > 0;
        if (!notes.length)
            return;
        for (const n of notes)
            this._noteList.add_child(this._noteCard(n));
        this._panel?.queue_redraw();
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
        if (this._metersId) {
            GLib.source_remove(this._metersId);
            this._metersId = 0;
        }
        for (const obj of [...(this._mediaWatched ?? []), ...(this._mediaPlayers ?? [])])
            obj.disconnectObject(this);
        this._mediaWatched = this._mediaPlayers = null;
        this._mediaCard = null;
        this._menus = null;
        this._noteList = null;
        this._noteSection = null;
        this._clear = null;
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
