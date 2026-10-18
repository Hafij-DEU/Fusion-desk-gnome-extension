import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
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

        this._addDeepinPage(window, s);

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
        window.add(taskbar);

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

    /** Desktop mode (Fusion / Deepin / Windows-like) and the options of each. */
    _addDeepinPage(window, s) {
        const page = new Adw.PreferencesPage({title: _('Desktop'), icon_name: 'preferences-desktop-appearance-symbolic'});
        page.add(group(_('Desktop mode'), [
            comboRow(s, 'desktop-mode', _('Mode'), ['fusion', 'deepin', 'windows'],
                [_('Fusion: your panel'), _('Deepin: dock, launcher, control centre'), _('Windows-like: Fusion taskbar in Windows style')]),
        ], _('Switches live, no logout. Your Fusion settings stay as they are and come back with Fusion mode.')));

        page.add(group(_('Windows-like taskbar'), [
            comboRow(s, 'windows-align', _('Alignment'), ['CENTER', 'LEFT'], [_('Centre (Windows 11)'), _('Left (Windows 10)')]),
            comboRow(s, 'windows-search', _('Search'), ['BOX', 'ICON', 'HIDDEN'], [_('Search box'), _('Icon only'), _('Hidden')]),
            switchRow(s, 'windows-task-view', _('Task View button'), _('Opens all windows and workspaces')),
            switchRow(s, 'windows-combine', _('Combine taskbar buttons'), _('Off: one labelled button per window')),
            comboRow(s, 'windows-menu-style', _('Start menu'), ['AUTO', 'KEEP'], [_('Match the alignment'), _('Keep my layout')]),
            switchRow(s, 'windows-widgets', _('Keep Fusion widgets'), _('System monitor, media, clipboard, workspaces, App Hub, screenshot')),
            switchRow(s, 'windows-blur', _('Blur'), _('Blur behind the taskbar')),
        ], _('Used in Windows-like mode.')));

        page.add(group(_('Deepin dock'), [
            comboRow(s, 'deepin-dock-mode', _('Mode'), ['FASHION', 'EFFICIENT'],
                [_('Fashion: floating dock'), _('Efficient: full-width bar')]),
            comboRow(s, 'deepin-dock-position', _('Location'), ['BOTTOM', 'TOP'], [_('Bottom'), _('Top')]),
            comboRow(s, 'deepin-dock-hide', _('Status'), ['KEEP_SHOWN', 'KEEP_HIDDEN', 'SMART_HIDE'],
                [_('Keep shown'), _('Keep hidden'), _('Smart hide')]),
            spinRow(s, 'deepin-dock-size', _('Size'), 37, 100, 1, _('Pixels')),
        ]));

        const plugins = [
            ['multitask', _('Multitask view'), _('Opens the Activities overview')],
            ['tray', _('Status icons'), _('Network, sound, battery and other extensions\' icons; opens Quick Settings')],
            ['datetime', _('Date and time'), _('Opens the calendar and notifications')],
            ['trash', _('Trash'), ''],
            ['control', _('Control centre'), _('Side panel with toggles, notifications and Settings links')],
            ['power', _('Power'), ''],
            ['show-desktop', _('Show desktop'), _('Strip at the right edge, Efficient mode only')],
        ];
        const rows = plugins.map(([id, title, subtitle]) => {
            const row = new Adw.SwitchRow({title, subtitle});
            row.active = s.get_strv('deepin-dock-plugins').includes(id);
            row.connect('notify::active', () => {
                const list = s.get_strv('deepin-dock-plugins').filter(p => p !== id);
                if (row.active)
                    list.push(id);
                s.set_strv('deepin-dock-plugins', list);
            });
            return row;
        });
        page.add(group(_('Deepin dock plugins'), rows));

        page.add(group(_('Deepin launcher'), [
            comboRow(s, 'deepin-launcher-mode', _('Mode'), ['FULLSCREEN', 'WINDOWED'], [_('Fullscreen'), _('Windowed')]),
            switchRow(s, 'deepin-super-key', _('Super key opens the launcher')),
        ]));
        page.add(group(_('Deepin look'), [
            comboRow(s, 'deepin-theme', _('Colours'), ['AUTO', 'LIGHT', 'DARK'], [_('Follow system style'), _('Light'), _('Dark')]),
            switchRow(s, 'deepin-blur', _('Blur'), _('Blur behind the dock, launcher and control centre')),
            spinRow(s, 'deepin-opacity', _('Opacity'), 25, 100, 5, _('Percent')),
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
