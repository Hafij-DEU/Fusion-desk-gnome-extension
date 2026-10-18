import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ELEMENT_NAMES, parseLayout} from './lib/layoutModel.js';
import {addMenuPages} from './lib/prefsMenu.js';
import {INDICATORS} from './lib/indicatorList.js';
import {PRESETS, applyPreset} from './lib/presets.js';

const BOXES = ['left', 'center', 'right'];
const BOX_LABELS = ['Left', 'Center', 'Right'];
// Elements whose visibility is controlled elsewhere (GNOME built-ins).
const ALWAYS_VISIBLE = new Set(['quick', 'date']);

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, min, max, step = 1, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    // Show escaped newlines so multi-line clock formats stay editable on one line.
    row.text = settings.get_string(key).replace(/\n/g, '\\n');
    row.connect('apply', () => settings.set_string(key, row.text.replace(/\\n/g, '\n')));
    return row;
}

function comboRow(settings, key, title, values, labels) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
    const sync = () => {
        row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    return row;
}

/** Installed icon themes ('icons') or cursor themes ('cursors'), sorted by name. */
function listThemes(kind) {
    const dirs = [
        GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
        ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'icons'])),
    ];
    const found = new Set();
    for (const dir of dirs) {
        let en;
        try {
            en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            continue;
        }
        for (let info; (info = en.next_file(null));) {
            const name = info.get_name();
            const path = GLib.build_filenamev([dir, name]);
            if (kind === 'cursors') {
                if (GLib.file_test(GLib.build_filenamev([path, 'cursors']), GLib.FileTest.IS_DIR))
                    found.add(name);
                continue;
            }
            const index = GLib.build_filenamev([path, 'index.theme']);
            if (name === 'default' || !GLib.file_test(index, GLib.FileTest.EXISTS))
                continue;
            try {
                const [, bytes] = GLib.file_get_contents(index);
                if (/^Directories\s*=/m.test(new TextDecoder().decode(bytes)))
                    found.add(name);
            } catch (e) {
                // Unreadable theme: skip it.
            }
        }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
}

function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    return g;
}

export default class FusionDeskPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(720, 820);
        window.search_enabled = true;

        // ---- Layout page ---------------------------------------------------
        const layout = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});
        layout.add(group('Panel', [
            comboRow(s, 'panel-position', 'Position', ['BOTTOM', 'TOP'], ['Bottom', 'Top']),
            comboRow(s, 'panel-style', 'Style', ['PILLS', 'FLAT'], ['Pills (grouped, modern)', 'Flat']),
            spinRow(s, 'panel-height', 'Height', 24, 96, 1, 'Pixels'),
            spinRow(s, 'panel-opacity', 'Background opacity', 0, 100, 5, 'Percent'),
            switchRow(s, 'multi-monitor', 'Panels on all monitors', 'Each extra monitor gets a start button and a taskbar with its own windows'),
            switchRow(s, 'hide-overview-dash', 'Hide overview dash', 'The taskbar replaces the dash in Activities'),
        ]));
        layout.add(group('Auto-hide', [
            switchRow(s, 'intellihide', 'Intellihide', 'Hide the panel when a window overlaps it; push the pointer against the screen edge to reveal'),
            comboRow(s, 'intellihide-mode', 'Hide for', ['ALL', 'FOCUSED', 'MAXIMIZED'],
                ['Any window', 'Focused window', 'Maximized windows']),
            switchRow(s, 'dynamic-opacity', 'Dynamic opacity', 'Panel turns opaque when a window touches it'),
        ]));

        const elements = new Adw.PreferencesGroup({
            title: 'Elements',
            description: 'Order, visibility and box of each panel item. Items in the right box line up after other extensions’ icons.',
        });
        layout.add(elements);

        layout.add(group('Battery', [
            comboRow(s, 'battery-style', 'Battery look', ['COLOR', 'GNOME'], ['Coloured, percentage inside', 'GNOME icon']),
            switchRow(s, 'battery-standalone', 'Own battery button', 'Next to the system menu; click for time left, power draw, health, power mode and charging mode'),
        ], 'Coloured fill: green when full or charging (with a bolt), accent when normal, orange when low, red when almost empty.'));
        // Status icons (top-right system menu), one switch each.
        const status = new Adw.PreferencesGroup({title: 'Status icons',
            description: 'Show or hide each icon of the system menu. The Quick Settings menu itself is unchanged.'});
        for (const [id, label, note] of INDICATORS) {
            const row = new Adw.SwitchRow({title: label, subtitle: note});
            const sync = () => {
                row.active = !s.get_strv('hidden-indicators').includes(id);
            };
            sync();
            s.connect('changed::hidden-indicators', sync);
            row.connect('notify::active', () => {
                const list = s.get_strv('hidden-indicators').filter(x => x !== id);
                if (!row.active)
                    list.push(id);
                if (list.join() !== s.get_strv('hidden-indicators').join())
                    s.set_strv('hidden-indicators', list);
            });
            status.add(row);
        }
        layout.add(status);
        this._fillElements(elements, s);
        s.connect('changed::layout', () => this._fillElements(elements, s));
        window.add(layout);
        this._addAppearancePage(window, s);

        // ---- Taskbar page --------------------------------------------------
        const taskbar = new Adw.PreferencesPage({title: 'Taskbar', icon_name: 'view-app-grid-symbolic'});
        taskbar.add(group('Taskbar', [
            spinRow(s, 'taskbar-icon-size', 'Icon size', 16, 64),
            entryRow(s, 'apps-icon', 'Show Applications icon (name or image path)'),
            switchRow(s, 'taskbar-show-favorites', 'Show pinned apps'),
            switchRow(s, 'taskbar-isolate-workspaces', 'Isolate workspaces', 'Only show windows on the current workspace'),
            switchRow(s, 'taskbar-previews', 'Window previews on hover'),
            switchRow(s, 'taskbar-group-apps', 'Group windows by app', 'Off: one button per window with its title; pinned apps stay as launchers'),
            switchRow(s, 'taskbar-labels', 'Show window titles', 'Next to running app icons'),
            switchRow(s, 'taskbar-tooltips', 'App name tooltips'),
            switchRow(s, 'taskbar-hotkeys', 'Super+1…9 hotkeys', 'Activate taskbar apps; Ctrl+Super+N opens a new window'),
        ]));
        taskbar.add(group('Running indicators', [
            comboRow(s, 'taskbar-indicator-style', 'Style', ['DASHES', 'DOTS', 'SQUARES', 'LINE', 'NONE'],
                ['Dashes', 'Dots', 'Squares', 'Line', 'None']),
            comboRow(s, 'taskbar-indicator-position', 'Position', ['BOTTOM', 'TOP'], ['Bottom', 'Top']),
            entryRow(s, 'taskbar-indicator-color', 'Color (CSS, e.g. #4f8cff; empty = system accent)'),
        ]));
        taskbar.add(group('Mouse', [
            comboRow(s, 'taskbar-click-action', 'Click', ['CYCLE', 'MINIMIZE', 'PREVIEW'],
                ['Raise, minimize, cycle windows', 'Raise or minimize all', 'Show window previews']),
            comboRow(s, 'taskbar-middle-click', 'Middle click', ['NEW_WINDOW', 'MINIMIZE', 'QUIT'],
                ['New window', 'Minimize', 'Quit']),
            comboRow(s, 'taskbar-scroll-action', 'Scroll on icon', ['CYCLE', 'WORKSPACE', 'NOTHING'],
                ['Cycle windows', 'Switch workspace', 'Nothing']),
            switchRow(s, 'taskbar-preview-close-middle', 'Middle-click a preview closes the window'),
        ], 'Right-click an icon for the app menu (pin / unpin, windows, quit).'));
        taskbar.add(group(_('Search and Task View'), [
            switchRow(s, 'windows-extras-in-fusion', _('Search and Task View buttons'), _('Right after the start button, with rounded hover tiles')),
            comboRow(s, 'windows-search', _('Search'), ['BOX', 'ICON', 'HIDDEN'], [_('Search box'), _('Icon only'), _('Hidden')]),
            switchRow(s, 'windows-task-view', _('Task View button'), _('Opens all windows and workspaces')),
            switchRow(s, 'windows-blur', _('Blur'), _('Blur behind the taskbar while these buttons are shown')),
        ]));
        window.add(taskbar);
        this._addDesktopPage(window, s);

        // ---- Start Menu + Menu Button pages (lib/prefsMenu.js) ------------
        addMenuPages(window, s, this);

        // ---- Widgets page --------------------------------------------------
        const widgets = new Adw.PreferencesPage({title: 'Widgets', icon_name: 'applications-utilities-symbolic'});
        widgets.add(group('Duplicates', [
            switchRow(s, 'avoid-duplicates', 'Hide widgets other extensions already show',
                'e.g. Fusion\u2019s system monitor hides while GNOME\u2019s System Monitor extension is on'),
        ]));
        widgets.add(group('System monitor', [
            switchRow(s, 'sysmon-cpu', 'CPU usage'),
            switchRow(s, 'sysmon-ram', 'Memory usage'),
            switchRow(s, 'sysmon-net', 'Network speed'),
            switchRow(s, 'sysmon-temp', 'CPU temperature'),
            spinRow(s, 'sysmon-interval', 'Refresh interval', 1, 10, 1, 'Seconds'),
        ]));
        widgets.add(group('Clock', [
            switchRow(s, 'clock-custom', 'Custom format'),
            entryRow(s, 'clock-format', 'Format (strftime, \\n = new line)'),
        ], 'Examples: %H:%M   ·   %I:%M %p\\n%d/%m/%Y   ·   %a %d %b  %H:%M'));
        widgets.add(group('Media controls', [
            switchRow(s, 'media-visible', 'Show media controls', 'Previous / play-pause / next for the playing app'),
            spinRow(s, 'media-title-length', 'Title length', 0, 60, 1, 'Characters of the song title, 0 = buttons only'),
            switchRow(s, 'media-audio-fallback', 'Apps without media controls',
                'Show any app playing sound (e.g. the Opera snap) with its title, a mute button and click-to-show; play/pause needs the app\'s own support'),
        ], 'Move them on the Layout page (default: left, after the start menu).'));
        widgets.add(group('Clipboard history', [
            spinRow(s, 'clipboard-size', 'Entries to keep', 5, 200),
            switchRow(s, 'clipboard-super-v', 'Super+V opens history', 'Super+M still opens the notification list'),
            switchRow(s, 'clipboard-auto-paste', 'Paste on select',
                'Off by default. Choosing an entry also pastes it by sending Ctrl+V to the focused window through a virtual keyboard'),
            switchRow(s, 'clipboard-persist', 'Remember after restart', 'Stored unencrypted in ~/.cache/fusion-desk'),
        ]));
        widgets.add(group('Quick Settings', [
            switchRow(s, 'caffeine-visible', 'Caffeine toggle', 'Keeps the screen awake and blocks suspend'),
        ]));
        window.add(widgets);

        // ---- About page ----------------------------------------------------
        const about = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        const head = new Adw.PreferencesGroup();
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER, margin_bottom: 12});
        box.append(new Gtk.Label({label: 'Fusion Desk', css_classes: ['title-1']}));
        const v = this.metadata['version-name'] ?? this.metadata.version;
        const version = v ? `Version ${v} · ` : '';
        box.append(new Gtk.Label({label: `${version}by Md Hafijur Rahman`, css_classes: ['dim-label']}));
        box.append(new Gtk.LinkButton({uri: this.metadata.url ?? 'https://github.com/Hafij-DEU', label: 'Project page'}));
        head.add(box);
        about.add(head);
        const link = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
            return row;
        };
        about.add(group('Design inspiration', [
            link('Dash to Panel', 'Jason DeRose, Charles Gagnon and contributors · GPL-2.0', 'https://github.com/home-sweet-gnome/dash-to-panel'),
            link('ArcMenu', 'Andrew Zaech, LinxGem33 and contributors · GPL-2.0', 'https://gitlab.com/arcmenu/ArcMenu'),
            link('Vitals / Resource Monitor', 'Panel system readouts', 'https://github.com/corecoding/Vitals'),
            link('Clipboard History', 'SUPERCILEX and contributors', 'https://github.com/SUPERCILEX/gnome-clipboard-history'),
            link('Caffeine', 'eonpatapon and contributors', 'https://github.com/eonpatapon/gnome-shell-extension-caffeine'),
            link('Date Menu Formatter', 'Marcin Jakubowski', 'https://github.com/marcinjakubowski/date-menu-formatter'),
        ], 'Written from scratch; no code from these projects is included. Thank you to their authors.'));
        about.add(group('License', [
            new Adw.ActionRow({title: 'GNU General Public License v2.0 or later',
                subtitle: 'Free software: you may share and change it under the GPL. It comes with no warranty.'}),
            new Adw.ActionRow({title: 'Trademarks',
                subtitle: 'Product names belong to their owners. Fusion Desk is not affiliated with Microsoft, KDE, Linux Mint, Apple or the authors above.'}),
        ]));
        window.add(about);
    }

    /** Style presets, colours, glass and themes. */
    _addAppearancePage(window, s) {
        const page = new Adw.PreferencesPage({title: _('Appearance'), icon_name: 'preferences-desktop-appearance-symbolic'});

        // One-click presets: they only switch the settings on these pages.
        const presetRow = new Adw.ActionRow({
            title: _('Style'),
            subtitle: _('Classic: taskbar only. Studio: app launcher, control centre, desktop organizer, floating taskbar. Workbench: search and Task View buttons.'),
        });
        const presetBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const presetButtons = PRESETS.map(([id, label]) => {
            const b = new Gtk.Button({label: _(label)});
            b.connect('clicked', () => applyPreset(s, id));
            presetBox.append(b);
            return [id, b];
        });
        const syncPresets = () => presetButtons.forEach(([id, b]) => {
            if (s.get_string('desktop-mode') === id)
                b.add_css_class('suggested-action');
            else
                b.remove_css_class('suggested-action');
        });
        syncPresets();
        s.connect('changed::desktop-mode', syncPresets);
        presetRow.add_suffix(presetBox);
        page.add(group(_('Style presets'), [presetRow], _('Pick one as a starting point, then change anything below or on the Desktop page.')));

        const glassRows = [
            comboRow(s, 'glass-material', _('Material'), ['GLASS', 'GLOSS'], [_('Clear glass (subtle shine)'), _('Gloss (strong shine, bevel)')]),
            comboRow(s, 'glass-style', _('Glass style'), ['CLEAR', 'FROSTED', 'GEL', 'TINTED', 'SMOKE', 'HALO'],
                [_('Clear'), _('Frosted'), _('Gel'), _('Tinted'), _('Smoke'), _('Halo')]),
            spinRow(s, 'glass-opacity', _('Opacity'), 10, 100, 5, _('Menus, start menu, control centre and launcher; below 100 they blur what is behind. The taskbar keeps its own')),
            switchRow(s, 'glass-rim', _('Rim highlight'), _('Thin light edge; a sharp bevel with gloss')),
            switchRow(s, 'glass-glare', _('Corner glare'), _('Light reflections in the corners')),
            switchRow(s, 'glass-shadow', _('Soft shadow'), _('Diffused shadow for depth')),
            switchRow(s, 'glass-light-follows', _('Light follows pointer'), _('A soft light spot moves with the pointer')),
        ];
        const syncGlass = () => {
            const on = s.get_string('glass-effect') !== 'OFF';
            glassRows.forEach(r => r.set_sensitive(on));
        };
        s.connect('changed::glass-effect', syncGlass);
        syncGlass();
        page.add(group(_('Glass'), [
            comboRow(s, 'glass-effect', _('Glass effect'), ['OFF', 'SOFT', 'STRONG'], [_('Off'), _('Soft'), _('Strong')]),
            ...glassRows,
        ], _('Taskbar, menus, start menu, control centre and launcher. Lower the opacity to see the blurred desktop through them; 100 is solid.')));

        const blurScale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 5, upper: 100, step_increment: 5, page_increment: 10}),
            draw_value: true, digits: 0, hexpand: true, valign: Gtk.Align.CENTER, width_request: 200,
        });
        s.bind('wallpaper-blur-strength', blurScale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        const blurStrength = new Adw.ActionRow({title: _('Strength')});
        blurStrength.add_suffix(blurScale);
        s.bind('wallpaper-blur', blurStrength, 'sensitive', Gio.SettingsBindFlags.GET);
        page.add(group(_('Wallpaper'), [
            switchRow(s, 'wallpaper-blur', _('Blur wallpaper'), _('While windows are open; sharp when the desktop is empty')),
            blurStrength,
        ]));

        page.add(group(_('Colours'), [
            comboRow(s, 'panel-theme', _('Taskbar colours'), ['AUTO', 'DARK', 'LIGHT'], [_('Follow system style'), _('Dark'), _('Light')]),
            switchRow(s, 'accent-gradient', _('Accent gradient'), _('Taskbar, start menu, launcher and control centre fade from the system accent colour')),
            switchRow(s, 'icons-follow-accent', _('Accent-coloured icons'), _('Start button, Show Applications and status icons take the system accent colour')),
            comboRow(s, 'tray-app-icons', _('App tray icons'), ['MATCH', 'ORIGINAL'], [_('Plain icons like status icons'), _('Original colours')]),
            switchRow(s, 'deepin-floating-taskbar', _('Floating taskbar'), _('Rounded, with a gap from the screen edges; layout and widgets stay the same')),
        ]));

        const icons = listThemes('icons');
        const cursors = listThemes('cursors');
        page.add(group(_('System accent and themes'), [
            comboRow(s, 'deepin-accent', _('Accent colour'), ['', 'blue', 'teal', 'green', 'yellow', 'orange', 'pink', 'purple', 'slate'],
                [_('Keep mine'), _('Blue'), _('Teal'), _('Green'), _('Yellow'), _('Orange'), _('Pink'), _('Purple'), _('Grey')]),
            comboRow(s, 'deepin-icon-theme', _('Icon theme'), ['', ...icons], [_('Keep mine'), ...icons]),
            comboRow(s, 'deepin-cursor-theme', _('Cursor theme'), ['', ...cursors], [_('Keep mine'), ...cursors]),
        ], _('Fusion Desk switches GNOME to these while it runs; yours come back when you pick "Keep mine" or turn the extension off. A glossy icon theme suggestion is in the README.')));
        window.add(page);
    }

    /** App launcher, control centre and desktop organizer. */
    _addDesktopPage(window, s) {
        const page = new Adw.PreferencesPage({title: _('Desktop'), icon_name: 'user-desktop-symbolic'});
        page.add(group(_('App launcher'), [
            comboRow(s, 'deepin-start', _('Launcher'), ['FUSION', 'BOTH', 'DEEPIN'],
                [_('Off (start menu only)'), _('Start menu + launcher button'), _('Start button opens the launcher')]),
            comboRow(s, 'deepin-launcher-mode', _('Style'), ['FULLSCREEN', 'WINDOWED'], [_('Fullscreen grid with categories'), _('Small window')]),
            switchRow(s, 'deepin-super-key', _('Super key opens the launcher'), _('Off: Super keeps opening the start menu')),
            entryRow(s, 'deepin-launcher-icon', _('Launcher button icon (name or image path, empty = built-in)')),
        ], _('Blurred app grid with categories and search, or a small window with a category / A–Z list and favourites.')));

        page.add(group(_('Control centre'), [
            switchRow(s, 'deepin-control-button', _('Control centre'), _('Side panel with quick actions, media player, system meters, Settings shortcuts, notifications and a calendar')),
            comboRow(s, 'deepin-control-position', _('Button'), ['START', 'TRAY', 'CLOCK'],
                [_('After the start button (opens on the left)'), _('In the tray (opens on the right)'), _('On the clock (opens on the right)')]),
        ]));

        const cols = [['places', _('Computer (Home, Trash, drives)')], ['folders', _('Folders')], ['documents', _('Documents')], ['pictures', _('Pictures')],
            ['videos', _('Videos')], ['music', _('Music')], ['apps', _('Apps')], ['others', _('Others')]];
        const organize = new Adw.ExpanderRow({title: _('Collections'), subtitle: _('Which file types get their own collection')});
        for (const [id, title] of cols) {
            const row = new Adw.SwitchRow({title});
            row.active = s.get_strv('deepin-organizer-collections').includes(id);
            row.connect('notify::active', () => {
                const list = s.get_strv('deepin-organizer-collections').filter(c => c !== id);
                if (row.active)
                    list.push(id);
                s.set_strv('deepin-organizer-collections', list);
            });
            organize.add_row(row);
        }
        const reset = new Adw.ActionRow({title: _('Organize again'), subtitle: _('Put every collection back into the default columns')});
        const resetButton = new Gtk.Button({label: _('Organize'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => s.set_string('deepin-organizer-geometry', '{}'));
        reset.add_suffix(resetButton);
        page.add(group(_('Organize desktop'), [
            switchRow(s, 'deepin-organizer', _('Organize desktop'),
                _('Files in your Desktop folder sorted into collections. Alt+O hides or shows them; right-click the desktop for more.')),
            comboRow(s, 'deepin-organizer-size', _('Collection size'), ['SMALL', 'MEDIUM', 'LARGE'], [_('Small'), _('Medium'), _('Large')]),
            organize,
            reset,
        ], _('Works with the Desktop Icons extension: its icons are hidden while the collections show, and come back with Alt+O.')));

        page.add(group(_('Launcher, control centre and collections look'), [
            comboRow(s, 'deepin-theme', _('Colours'), ['AUTO', 'LIGHT', 'DARK'], [_('Follow system style'), _('Light'), _('Dark')]),
            switchRow(s, 'deepin-blur', _('Blur'), _('Blur behind them')),
            spinRow(s, 'deepin-opacity', _('Opacity'), 25, 100, 5, _('Percent, while the Glass effect is off')),
            switchRow(s, 'deepin-gloss', _('Glossy'), _('Lighter top and bright edge, also with Glass effect off')),
        ]));
        window.add(page);
    }

    _fillElements(groupWidget, s) {
        for (const row of this._elementRows ?? [])
            groupWidget.remove(row);
        this._elementRows = [];

        const items = parseLayout(s.get_strv('layout'));
        const save = () => s.set_strv('layout', items.map(i => `${i.id}:${i.box}`));

        items.forEach((item, idx) => {
            const row = new Adw.ActionRow({title: ELEMENT_NAMES[item.id] ?? item.id});

            const moves = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
            const up = new Gtk.Button({icon_name: 'go-up-symbolic', sensitive: idx > 0, tooltip_text: 'Move up'});
            const down = new Gtk.Button({icon_name: 'go-down-symbolic', sensitive: idx < items.length - 1, tooltip_text: 'Move down'});
            up.connect('clicked', () => {
                [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
                save();
            });
            down.connect('clicked', () => {
                [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
                save();
            });
            moves.append(up);
            moves.append(down);
            row.add_prefix(moves);

            if (!ALWAYS_VISIBLE.has(item.id)) {
                const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Visible'});
                s.bind(`${item.id}-visible`, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
                row.add_suffix(sw);
            }

            const box = new Gtk.DropDown({model: Gtk.StringList.new(BOX_LABELS), valign: Gtk.Align.CENTER});
            box.selected = BOXES.indexOf(item.box);
            box.connect('notify::selected', () => {
                item.box = BOXES[box.selected];
                save();
            });
            row.add_suffix(box);

            groupWidget.add(row);
            this._elementRows.push(row);
        });
    }
}
