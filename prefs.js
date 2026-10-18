import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ELEMENT_NAMES, parseLayout} from './lib/layoutModel.js';
import {addMenuPages} from './lib/prefsMenu.js';
import {INDICATORS} from './lib/indicatorList.js';

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
        layout.add(group(_('Desktop mode'), [
            comboRow(s, 'desktop-mode', _('Mode'), ['fusion', 'deepin', 'windows'],
                [_('Fusion'), _('Deepin'), _('Windows-like')]),
        ], _('Your taskbar stays as it is. Deepin adds its launcher, control centre, Organize Desktop and glossy look (Deepin page); Windows-like adds a search box, Task View and Windows-style theming (Taskbar page). Switches live, no logout.')));
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
        taskbar.add(group(_('Windows-like extras'), [
            comboRow(s, 'windows-search', _('Search'), ['BOX', 'ICON', 'HIDDEN'], [_('Search box'), _('Icon only'), _('Hidden')]),
            switchRow(s, 'windows-task-view', _('Task View button'), _('Opens all windows and workspaces')),
            switchRow(s, 'windows-blur', _('Blur'), _('Blur behind the taskbar')),
        ], _('Used when Desktop mode is Windows-like (Layout page). They go right after the start button; rounded hover tiles and short running pills give the Windows look.')));
        window.add(taskbar);
        this._addDeepinPage(window, s);

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

    /** Deepin mode: what it adds to the taskbar and desktop, and its looks. */
    _addDeepinPage(window, s) {
        const page = new Adw.PreferencesPage({title: _('Deepin'), icon_name: 'preferences-desktop-appearance-symbolic'});

        // Pick Deepin parts for Fusion / Windows-like mode without switching to Deepin mode.
        const features = new Adw.ExpanderRow({
            title: _('Use Deepin features in Fusion mode'),
            subtitle: _('Also in Windows-like mode. Pick the features below; Deepin mode itself always has all of them.'),
            show_enable_switch: true,
        });
        s.bind('deepin-features-enabled', features, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        const picks = [
            ['launcher', _('Launcher'), _('Launcher button next to the start button (Super too, if "Super key opens the launcher" is on)')],
            ['control', _('Control centre'), _('Bell button in the tray with toggles, notifications and Settings shortcuts')],
            ['organizer', _('Organize desktop'), _('Desktop files in collections, Alt+O')],
            ['look', _('Glossy look'), _('Glossy glass and blur on the taskbar (Look settings below)')],
            ['floating', _('Floating taskbar'), _('Rounded taskbar with a gap from the screen edges')],
            ['accent', _('Accent colour'), _('The Deepin accent chosen below')],
            ['icons', _('Icon and cursor theme'), _('The themes chosen below')],
        ];
        for (const [id, title, subtitle] of picks) {
            const row = new Adw.SwitchRow({title, subtitle});
            row.active = s.get_strv('deepin-features').includes(id);
            row.connect('notify::active', () => {
                const list = s.get_strv('deepin-features').filter(f => f !== id);
                if (row.active)
                    list.push(id);
                s.set_strv('deepin-features', list);
            });
            features.add_row(row);
        }
        page.add(group(_('Without Deepin mode'), [features]));
        page.add(group(_('Taskbar additions'), [
            switchRow(s, 'deepin-launcher-button', _('Launcher button'), _('Next to the start button')),
            entryRow(s, 'deepin-launcher-icon', _('Launcher button icon (name or image path, empty = built-in)')),
            switchRow(s, 'deepin-control-button', _('Control centre button'), _('Quick toggles, notifications and Settings shortcuts in a side panel')),
            switchRow(s, 'deepin-super-key', _('Super key opens the launcher'), _('Off: Super keeps opening the start menu')),
        ], _('Used when Desktop mode is Deepin (Layout page). Your taskbar layout is not changed.')));

        const cols = [['folders', _('Folders')], ['documents', _('Documents')], ['pictures', _('Pictures')],
            ['videos', _('Videos')], ['music', _('Music')], ['apps', _('Apps')], ['others', _('Others')]];
        const colRows = cols.map(([id, title]) => {
            const row = new Adw.SwitchRow({title});
            row.active = s.get_strv('deepin-organizer-collections').includes(id);
            row.connect('notify::active', () => {
                const list = s.get_strv('deepin-organizer-collections').filter(c => c !== id);
                if (row.active)
                    list.push(id);
                s.set_strv('deepin-organizer-collections', list);
            });
            return row;
        });
        const organize = new Adw.ExpanderRow({
            title: _('Collections'),
            subtitle: _('Which file types get their own collection'),
        });
        colRows.forEach(r => organize.add_row(r));
        const reset = new Adw.ActionRow({title: _('Organize again'), subtitle: _('Put every collection back into the default columns')});
        const resetButton = new Gtk.Button({label: _('Organize'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => s.set_string('deepin-organizer-geometry', '{}'));
        reset.add_suffix(resetButton);
        page.add(group(_('Organize desktop'), [
            switchRow(s, 'deepin-organizer', _('Organize desktop'),
                _('Files in your Desktop folder are sorted into collections. Alt+O hides or shows them; right-click the desktop for more.')),
            comboRow(s, 'deepin-organizer-size', _('Collection size'), ['SMALL', 'MEDIUM', 'LARGE'], [_('Small'), _('Medium'), _('Large')]),
            organize,
            reset,
        ], _('Needs the Desktop Icons extension (Ubuntu\'s desktop icons) to be off; otherwise its icons cover the collections.')));

        page.add(group(_('Launcher'), [
            comboRow(s, 'deepin-launcher-mode', _('Mode'), ['FULLSCREEN', 'WINDOWED'], [_('Fullscreen'), _('Windowed')]),
        ]));
        page.add(group(_('Look'), [
            comboRow(s, 'deepin-theme', _('Colours'), ['AUTO', 'LIGHT', 'DARK'], [_('Follow system style'), _('Light'), _('Dark')]),
            switchRow(s, 'deepin-blur', _('Blur'), _('Behind the taskbar, launcher, control centre and collections')),
            spinRow(s, 'deepin-opacity', _('Opacity'), 25, 100, 5, _('Percent')),
            switchRow(s, 'deepin-gloss', _('Glossy glass'), _('Light top edge and soft gradient on the taskbar and Deepin panels')),
            switchRow(s, 'deepin-floating-taskbar', _('Floating taskbar'),
                _('Rounded, with a gap from the screen edges, like Deepin\'s Fashion dock. Your layout and widgets stay the same')),
            comboRow(s, 'deepin-accent', _('Accent colour'), ['', 'blue', 'teal', 'green', 'yellow', 'orange', 'pink', 'purple', 'slate'],
                [_('Keep system accent'), _('Blue'), _('Teal'), _('Green'), _('Yellow'), _('Orange'), _('Pink'), _('Purple'), _('Grey')]),
        ]));
        const icons = listThemes('icons');
        const cursors = listThemes('cursors');
        const iconRow = comboRow(s, 'deepin-icon-theme', _('Icon theme'), ['', ...icons], [_('Keep system theme'), ...icons]);
        const hasBloom = icons.some(t => /^bloom/i.test(t));
        iconRow.subtitle = hasBloom
            ? _('Deepin\'s own icons: pick a "bloom" theme')
            : _('Deepin\'s own icons come with the deepin-icon-theme package: sudo apt install deepin-icon-theme');
        page.add(group(_('Icons'), [
            iconRow,
            comboRow(s, 'deepin-cursor-theme', _('Cursor theme'), ['', ...cursors], [_('Keep system theme'), ...cursors]),
        ], _('Used only while Deepin mode is on; your own themes come back when you leave it.')));
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
