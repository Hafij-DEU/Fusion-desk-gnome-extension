import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ELEMENT_NAMES, parseLayout} from './lib/layoutModel.js';
import {addMenuPage, appListGroup, menuThemePage} from './lib/prefsMenu.js';
import {comboRow, dependsOn, dependsOnSwitch, entryRow, group, navRow, spinRow, switchRow} from './lib/prefsRows.js';
import {INDICATORS} from './lib/indicatorList.js';
import {PRESETS, applyPreset} from './lib/presets.js';
import {shortcutsGroup, withShortcut} from './lib/prefsShortcuts.js';
import {laptopDevice, readSwitch, writeSwitch} from './lib/desktop/laptop.js';
import {helperInstalled} from './lib/chargeLimit.js';
import {readSnapshot, restoreSnapshot, saveSnapshot, savedLabel} from './lib/snapshot.js';

const BOXES = ['left', 'center', 'right'];
const BOX_LABELS = ['Left', 'Center', 'Right'];
// Elements whose visibility is controlled elsewhere (GNOME built-ins).
const ALWAYS_VISIBLE = new Set(['quick', 'date']);

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

// Glass, colours and wallpaper back to the shipped look (Appearance → Reset look).
const LOOK_KEYS = ['panel-theme', 'glass-effect', 'glass-material', 'glass-style', 'glass-opacity', 'glass-rim',
    'glass-glare', 'glass-shadow', 'glass-light-follows', 'accent-gradient', 'accent-gradient-style',
    'accent-gradient-strength', 'icons-follow-accent', 'tray-app-icons', 'wallpaper-blur', 'wallpaper-blur-strength'];

export default class FusionDeskPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(720, 820);
        window.search_enabled = true;

        this._addPanelPage(window, s);
        this._addAppearancePage(window, s);
        this._addTaskbarPage(window, s);
        addMenuPage(window, s);
        this._addDesktopPage(window, s);
        this._addWidgetsPage(window, s);
        this._addSystemPage(window, s);
        this._addAboutPage(window, s);
    }

    /** Panel position, shape, pills, auto-hide and the order of its items. */
    _addPanelPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Panel', icon_name: 'view-grid-symbolic'});
        page.add(this._mySetupGroup(window, s));
        page.add(group('Panel', [
            comboRow(s, 'panel-position', 'Position', ['BOTTOM', 'TOP'], ['Bottom', 'Top']),
            comboRow(s, 'panel-style', 'Style', ['PILLS', 'FLAT'], ['Pills (grouped, modern)', 'Flat']),
            spinRow(s, 'panel-height', 'Height', 24, 96, 1, 'Pixels'),
            spinRow(s, 'panel-opacity', 'Background opacity', 0, 100, 5, 'Percent'),
            switchRow(s, 'deepin-floating-taskbar', 'Floating', 'Rounded, with a gap from the screen edges'),
            switchRow(s, 'multi-monitor', 'Panels on all monitors', 'Each extra monitor gets a start button and a taskbar with its own windows'),
            switchRow(s, 'hide-overview-dash', 'Hide overview dash', 'The taskbar replaces the dash in Activities'),
        ]));
        page.add(group('Pills', dependsOn(s, ['panel-style'], () => s.get_string('panel-style') === 'PILLS', [
            spinRow(s, 'pill-margin', 'Space above and below', 0, 20, 1, 'Pixels between each pill and the panel edge (the clock uses 4 less)'),
            spinRow(s, 'pill-gap', 'Space beside each pill', 0, 24, 1, 'Pixels on each side, so twice this between two pills'),
            spinRow(s, 'pill-padding', 'Inner padding', 0, 30, 1, 'Pixels at the pill’s rounded ends'),
            spinRow(s, 'pill-spacing', 'Icon spacing', 0, 30, 1, 'Pixels between the icons inside the tray and system monitor pills'),
        ]), 'For the Pills style: system tray, clock and system monitor.'));
        page.add(group('Auto-hide', [
            switchRow(s, 'intellihide', 'Intellihide', 'Hide the panel when a window overlaps it; push the pointer against the screen edge to reveal'),
            ...dependsOnSwitch(s, 'intellihide', [
                comboRow(s, 'intellihide-mode', 'Hide for', ['ALL', 'FOCUSED', 'MAXIMIZED'],
                    ['Any window', 'Focused window', 'Maximized windows']),
            ]),
            switchRow(s, 'dynamic-opacity', 'Dynamic opacity', 'Panel turns opaque when a window touches it'),
        ]));
        const elements = new Adw.PreferencesGroup({
            title: 'Elements',
            description: 'Order, visibility and box of each panel item. Items in the right box line up after other extensions’ icons.',
        });
        page.add(elements);
        this._fillElements(elements, s);
        s.connect('changed::layout', () => this._fillElements(elements, s));
        window.add(page);
    }

    /** Style presets, glass, colours, wallpaper and system themes. */
    _addAppearancePage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'preferences-desktop-appearance-symbolic'});

        // One-click presets: they only switch the settings on these pages.
        const presetRow = new Adw.ActionRow({
            title: 'Style',
            subtitle: 'Classic: taskbar only. Studio: app launcher, control centre, desktop organizer, floating panel. Workbench: search and Task View buttons. Centered: start button, search and apps in the middle, control centre on the left (moves the start button).',
        });
        const presetBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const presetButtons = PRESETS.map(([id, label]) => {
            const b = new Gtk.Button({label});
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
        const lookRow = new Adw.ActionRow({title: 'Default look',
            subtitle: 'Frosted glass, aurora gradient and wallpaper blur; your layout and features stay'});
        const lookButton = new Gtk.Button({label: 'Reset look', valign: Gtk.Align.CENTER});
        lookButton.connect('clicked', () => LOOK_KEYS.forEach(k => s.reset(k)));
        lookRow.add_suffix(lookButton);
        page.add(group('Style presets', [presetRow, lookRow], 'Pick one as a starting point, then change anything below or on the other pages.'));

        page.add(group('Glass', [
            comboRow(s, 'glass-effect', 'Glass effect', ['OFF', 'SOFT', 'STRONG'], ['Off (solid)', 'Soft', 'Strong']),
            ...dependsOn(s, ['glass-effect'], () => s.get_string('glass-effect') !== 'OFF', [
                comboRow(s, 'glass-material', 'Material', ['GLASS', 'GLOSS'], ['Clear glass (subtle shine)', 'Gloss (strong shine, bevel)']),
                comboRow(s, 'glass-style', 'Glass style', ['CLEAR', 'FROSTED', 'GEL', 'TINTED', 'SMOKE', 'HALO'],
                    ['Clear', 'Frosted', 'Gel', 'Tinted', 'Smoke', 'Halo']),
                spinRow(s, 'glass-opacity', 'Opacity', 10, 100, 5, 'Percent; below 100 the desktop shows blurred through them'),
                switchRow(s, 'glass-rim', 'Rim highlight', 'Thin light edge; a sharp bevel with gloss'),
                switchRow(s, 'glass-glare', 'Corner glare', 'Light reflections in the corners'),
                switchRow(s, 'glass-shadow', 'Soft shadow', 'Diffused shadow for depth'),
                switchRow(s, 'glass-light-follows', 'Light follows pointer', 'A soft light spot moves with the pointer'),
            ]),
        ], 'Taskbar, menus, start menu, control centre, launcher and desktop collections. Off: solid, no blur.'));

        page.add(group('Colours', [
            comboRow(s, 'panel-theme', 'Taskbar', ['AUTO', 'DARK', 'LIGHT'], ['Follow system style', 'Dark', 'Light']),
            comboRow(s, 'deepin-theme', 'Launcher, control centre and collections', ['AUTO', 'LIGHT', 'DARK'], ['Follow system style', 'Light', 'Dark']),
            navRow(window, 'Start menu', 'Shell theme or own colours, presets, border and corners', 'applications-graphics-symbolic', menuThemePage(s)),
            switchRow(s, 'icons-follow-accent', 'Accent-coloured icons', 'Start button, Show Applications and status icons take the system accent colour'),
            comboRow(s, 'tray-app-icons', 'App tray icons', ['MATCH', 'ORIGINAL'], ['Plain icons like status icons', 'Original colours']),
        ]));

        page.add(group('Accent gradient', [
            switchRow(s, 'accent-gradient', 'Accent gradient', 'Taskbar, start menu, launcher and control centre fade from the system accent colour'),
            ...dependsOnSwitch(s, 'accent-gradient', [
                comboRow(s, 'accent-gradient-style', 'Gradient', ['CORNER', 'TOP', 'SIDE', 'CENTER', 'AURORA', 'SUNSET', 'OCEAN', 'BERRY'],
                    ['From the corner', 'From the top', 'From the side', 'Glow in the middle',
                        'Aurora (accent + shifted hue)', 'Sunset (accent + warm orange)', 'Ocean (accent + teal)', 'Berry (accent + pink)']),
                spinRow(s, 'accent-gradient-strength', 'Strength', 10, 100, 5, 'Percent'),
            ]),
        ]));

        page.add(group('Wallpaper', [
            switchRow(s, 'wallpaper-blur', 'Blur wallpaper', 'While windows are open; sharp when the desktop is empty'),
            ...dependsOnSwitch(s, 'wallpaper-blur', [
                spinRow(s, 'wallpaper-blur-strength', 'Strength', 5, 100, 5, 'Percent'),
            ]),
            switchRow(s, 'overview-blur', 'Blur the overview',
                'Blurred wallpaper behind Activities and the app grid, frosted app folders'),
            ...dependsOnSwitch(s, 'overview-blur', [
                spinRow(s, 'overview-blur-strength', 'Overview strength', 10, 100, 5, 'Percent'),
            ]),
        ]));

        const icons = listThemes('icons');
        const cursors = listThemes('cursors');
        this._addWindowBlurGroup(page, window, s);

        page.add(group('System accent and themes', [
            comboRow(s, 'deepin-accent', 'Accent colour', ['', 'blue', 'teal', 'green', 'yellow', 'orange', 'pink', 'purple', 'slate'],
                ['Keep mine', 'Blue', 'Teal', 'Green', 'Yellow', 'Orange', 'Pink', 'Purple', 'Grey']),
            comboRow(s, 'deepin-icon-theme', 'Icon theme', ['', ...icons], ['Keep mine', ...icons]),
            comboRow(s, 'deepin-cursor-theme', 'Cursor theme', ['', ...cursors], ['Keep mine', ...cursors]),
        ], 'Fusion Desk switches GNOME to these while it runs; yours come back when you pick "Keep mine" or turn the extension off.'));
        window.add(page);
    }

    /** Taskbar buttons, running indicators, mouse actions, search and Task View. */
    _addTaskbarPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Taskbar', icon_name: 'view-app-grid-symbolic'});
        page.add(group('Taskbar', [
            spinRow(s, 'taskbar-icon-size', 'Icon size', 16, 64, 1, 'Pixels'),
            entryRow(s, 'apps-icon', 'Show Applications icon (name or image path)'),
            switchRow(s, 'taskbar-show-favorites', 'Show pinned apps'),
            switchRow(s, 'taskbar-isolate-workspaces', 'Isolate workspaces', 'Only show windows on the current workspace'),
            switchRow(s, 'taskbar-group-apps', 'Group windows by app', 'Off: one button per window with its title; pinned apps stay as launchers'),
            switchRow(s, 'taskbar-labels', 'Show window titles', 'Next to running app icons'),
            switchRow(s, 'taskbar-previews', 'Window previews on hover'),
            switchRow(s, 'taskbar-tooltips', 'App name tooltips'),
            withShortcut(switchRow(s, 'taskbar-hotkeys', 'Super+1…9 hotkeys', 'Activate taskbar apps; Ctrl+Super+N opens a new window'),
                s, () => ['Super', '1…9']),
        ]));
        page.add(group('Running indicators', [
            comboRow(s, 'taskbar-indicator-style', 'Style', ['DASHES', 'DOTS', 'SQUARES', 'LINE', 'NONE'],
                ['Dashes', 'Dots', 'Squares', 'Line', 'None']),
            ...dependsOn(s, ['taskbar-indicator-style'], () => s.get_string('taskbar-indicator-style') !== 'NONE', [
                comboRow(s, 'taskbar-indicator-position', 'Position', ['BOTTOM', 'TOP'], ['Bottom', 'Top']),
                entryRow(s, 'taskbar-indicator-color', 'Colour (CSS, e.g. #4f8cff; empty = system accent)'),
            ]),
        ]));
        page.add(group('Mouse', [
            comboRow(s, 'taskbar-click-action', 'Click', ['CYCLE', 'MINIMIZE', 'PREVIEW'],
                ['Raise, minimize, cycle windows', 'Raise or minimize all', 'Show window previews']),
            comboRow(s, 'taskbar-middle-click', 'Middle click', ['NEW_WINDOW', 'MINIMIZE', 'QUIT'],
                ['New window', 'Minimize', 'Quit']),
            comboRow(s, 'taskbar-scroll-action', 'Scroll on icon', ['CYCLE', 'WORKSPACE', 'NOTHING'],
                ['Cycle windows', 'Switch workspace', 'Nothing']),
            switchRow(s, 'taskbar-preview-close-middle', 'Middle-click a preview closes the window'),
        ], 'Right-click an icon for the app menu (pin / unpin, windows, always on top, quit).'));
        page.add(group('Search and Task View', [
            switchRow(s, 'windows-extras-in-fusion', 'Search and Task View buttons', 'Right after the start button, with rounded hover tiles'),
            ...dependsOnSwitch(s, 'windows-extras-in-fusion', [
                comboRow(s, 'windows-search', 'Search', ['BOX', 'ICON', 'HIDDEN'], ['Search box', 'Icon only', 'Hidden']),
                switchRow(s, 'windows-task-view', 'Task View button', 'Opens all windows and workspaces'),
            ]),
        ]));
        window.add(page);
    }

    /** App launcher, control centre and desktop organizer. */
    _addDesktopPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Desktop', icon_name: 'user-desktop-symbolic'});
        page.add(group('App launcher', [
            comboRow(s, 'deepin-start', 'Launcher', ['FUSION', 'BOTH', 'DEEPIN'],
                ['Off (start menu only)', 'Start menu + launcher button', 'Start button opens the launcher']),
            ...dependsOn(s, ['deepin-start'], () => s.get_string('deepin-start') !== 'FUSION', [
                comboRow(s, 'deepin-launcher-mode', 'Style', ['FULLSCREEN', 'WINDOWED'], ['Fullscreen grid with categories', 'Small window']),
                entryRow(s, 'deepin-launcher-icon', 'Launcher button icon (name or image path, empty = built-in)'),
            ]),
        ], 'Blurred app grid with categories and search, or a small window with a category / A–Z list and favourites. The Super key can open it (Start Menu → Keyboard).'));

        page.add(group('Control centre', [
            switchRow(s, 'deepin-control-button', 'Control centre', 'Side panel with quick actions, media player, system meters, Settings shortcuts, notifications and a calendar'),
            ...dependsOnSwitch(s, 'deepin-control-button', [
                comboRow(s, 'deepin-control-position', 'Button', ['START', 'LEFT', 'TRAY', 'CLOCK'],
                    ['After the start button (opens on the left)', 'At the left edge (opens on the left)', 'In the tray (opens on the right)', 'On the clock (opens on the right)']),
            ]),
        ]));

        const cols = [['places', 'Computer (Home, Trash, drives)'], ['folders', 'Folders'], ['documents', 'Documents'], ['pictures', 'Pictures'],
            ['videos', 'Videos'], ['music', 'Music'], ['apps', 'Apps'], ['others', 'Others']];
        const organize = new Adw.ExpanderRow({title: 'Collections', subtitle: 'Which file types get their own collection'});
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
        const reset = new Adw.ActionRow({title: 'Arrange again', subtitle: 'Put every icon or collection back into the default columns'});
        const resetButton = new Gtk.Button({label: 'Arrange', valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => {
            s.set_string('deepin-organizer-geometry', '{}');
            s.set_string('desktop-icon-positions', '{}');
        });
        reset.add_suffix(resetButton);
        const collections = () => s.get_boolean('deepin-organizer') && s.get_string('deepin-organizer-style') !== 'ICONS';
        page.add(group('Desktop files', [
            withShortcut(switchRow(s, 'deepin-organizer', 'Show desktop files',
                'Files in your Desktop folder on the desktop. Alt+O hides or shows them; right-click the desktop for more.'),
            s, () => ['Alt', 'O']),
            ...dependsOnSwitch(s, 'deepin-organizer', [
                comboRow(s, 'deepin-organizer-style', 'Style', ['ICONS', 'COLLECTIONS'],
                    ['Icons (drag each one where you like)', 'Collections (sorted into boxes)']),
            ]),
            ...dependsOn(s, ['deepin-organizer', 'deepin-organizer-style'], collections, [
                comboRow(s, 'deepin-organizer-size', 'Collection size', ['SMALL', 'MEDIUM', 'LARGE'], ['Small', 'Medium', 'Large']),
                organize,
            ]),
            ...dependsOnSwitch(s, 'deepin-organizer', [reset]),
            switchRow(s, 'add-to-desktop', 'Add to Desktop in app menus',
                'Right-click an app in the app grid, dash, taskbar or start menu to put its launcher on the desktop'),
        ], 'Replaces the Desktop Icons extension: its icons are hidden while Fusion shows your files, and come back with Alt+O.'));
        window.add(page);
    }

    /** Panel widgets: system monitor, clock, media controls, clipboard. */
    _addWidgetsPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Widgets', icon_name: 'applications-utilities-symbolic'});
        page.add(group('System monitor', [
            switchRow(s, 'sysmon-cpu', 'CPU usage'),
            switchRow(s, 'sysmon-ram', 'Memory usage'),
            switchRow(s, 'sysmon-net', 'Network speed'),
            switchRow(s, 'sysmon-temp', 'CPU temperature'),
            spinRow(s, 'sysmon-interval', 'Refresh interval', 1, 10, 1, 'Seconds'),
        ]));
        page.add(group('Clock', [
            switchRow(s, 'clock-custom', 'Custom format'),
            ...dependsOnSwitch(s, 'clock-custom', [
                entryRow(s, 'clock-format', 'Format (strftime, \\n = new line)'),
            ]),
        ], 'Examples: %H:%M   ·   %I:%M %p\\n%d/%m/%Y   ·   %a %d %b  %H:%M'));
        page.add(group('Media controls', dependsOnSwitch(s, 'media-visible', [
            spinRow(s, 'media-title-length', 'Title length', 0, 60, 1, 'Characters of the song title, 0 = buttons only'),
            switchRow(s, 'media-audio-fallback', 'Apps without media controls',
                'Show any app playing sound (e.g. the Opera snap) with its title, a mute button and click-to-show; play/pause needs the app\'s own support'),
        ]), 'Previous / play-pause / next for the playing app. Show, hide or move them on the Panel page.'));
        page.add(group('Clipboard history', [
            spinRow(s, 'clipboard-size', 'Entries to keep', 5, 200),
            withShortcut(switchRow(s, 'clipboard-super-v', 'Super+V opens history', 'Super+M still opens the notification list'),
                s, () => ['Super', 'V']),
            withShortcut(switchRow(s, 'clipboard-auto-paste', 'Paste on select',
                'Choosing an entry (text or image) pastes it straight into the focused window by sending Ctrl+V through a virtual keyboard'),
            s, () => ['Ctrl', 'V']),
            switchRow(s, 'clipboard-images', 'Keep copied images',
                'Saved as files in ~/.local/share/fusion-desk/clipboard-images; choose one to paste it again, or its link button to copy the file path'),
            switchRow(s, 'clipboard-persist', 'Remember after restart', 'Stored unencrypted in ~/.cache/fusion-desk'),
        ]));
        page.add(group('Other extensions', [
            switchRow(s, 'avoid-duplicates', 'Hide widgets other extensions already show',
                'e.g. Fusion’s system monitor hides while GNOME’s System Monitor extension is on'),
        ]));
        window.add(page);
    }

    /** Battery, charging, status icons, keep awake and windows that stay on top. */
    _addSystemPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'System', icon_name: 'battery-good-symbolic'});
        const usbCharging = this._usbChargingRow();
        page.add(group('Battery', [
            comboRow(s, 'battery-style', 'Battery look', ['COLOR', 'GNOME'], ['Coloured, percentage inside', 'GNOME icon']),
            switchRow(s, 'battery-standalone', 'Own battery button', 'Next to the system menu; click for time left, power draw, health, power mode and charging mode'),
            ...(usbCharging ? [usbCharging] : []),
        ], 'Coloured fill: green when full or charging (with a bolt), accent when normal, orange when low, red when almost empty.'));
        page.add(this._chargeLimitGroup(s));
        page.add(group('Keep awake', [
            switchRow(s, 'caffeine-visible', 'Caffeine toggle', 'In Quick Settings: keeps the screen awake and blocks suspend'),
        ]));

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
        page.add(status);
        this._addOnTopGroups(page, window, s);
        page.add(group('Behaviour', [
            switchRow(s, 'tweak-focus-attention', 'Bring apps that ask for attention to the front',
                'Instead of the “… is ready” notification, for example when a link opens in a browser'),
            switchRow(s, 'tweak-workspace-popup', 'Workspace switcher popup', 'The workspace overlay shown while switching'),
            comboRow(s, 'tweak-animation-speed', 'Animation speed', ['FAST', 'NORMAL', 'SLOW'], ['Faster', 'Normal', 'Slower']),
        ], 'Off while Just Perfection is on, which has the same options.'));
        window.add(page);
    }

    /**
     * The laptop's "always-on USB" switch: the USB-A port stays powered while
     * the laptop sleeps or is off. Null when the laptop has no such switch.
     */
    _usbChargingRow() {
        const device = laptopDevice();
        if (!device || readSwitch(device, 'usb_charging') === null)
            return null;
        const note = 'Keeps the USB port powered while the laptop sleeps or is shut down, so a phone keeps charging (asks for your password). How fast it charges is fixed by the port itself.';
        const row = new Adw.SwitchRow({title: 'Charge phones while asleep or off', subtitle: note});
        row.active = readSwitch(device, 'usb_charging');
        let syncing = false;
        row.connect('notify::active', () => {
            if (syncing)
                return;
            const want = row.active;
            row.sensitive = false;
            writeSwitch(device, 'usb_charging', want, (_ok, rejected) => {
                row.sensitive = true;
                const now = readSwitch(device, 'usb_charging');
                if (now !== want) {
                    syncing = true;
                    row.active = !!now;
                    syncing = false;
                }
                row.subtitle = rejected ? 'This laptop\'s firmware does not accept this switch' : note;
            });
        });
        return row;
    }

    /** Charge limit: switch, level and the one-time helper setup (asks for the password once). */
    _chargeLimitGroup(s) {
        const setupRow = new Adw.ActionRow({title: 'One-time setup'});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        setupRow.add_suffix(button);
        const sync = () => {
            const ok = helperInstalled();
            setupRow.subtitle = ok
                ? 'Done: Fusion Desk can change the charging mode without asking for your password'
                : 'Installs a small helper so Fusion Desk can change the charging mode without a password (asks for it once)';
            button.label = ok ? 'Remove' : 'Set up';
            if (ok)
                button.remove_css_class('suggested-action');
            else
                button.add_css_class('suggested-action');
        };
        button.connect('clicked', () => {
            const dir = GLib.build_filenamev([this.path, 'lib', 'charge']);
            const args = helperInstalled() ? ['remove'] : ['install', dir];
            button.sensitive = false;
            try {
                const proc = Gio.Subprocess.new(['pkexec', '/bin/sh', GLib.build_filenamev([dir, 'setup.sh']), ...args], Gio.SubprocessFlags.NONE);
                proc.wait_async(null, () => {
                    button.sensitive = true;
                    sync();
                    // Tells the running extension to start (or stop) using the helper.
                    s.set_boolean('charge-helper-ready', helperInstalled());
                });
            } catch (e) {
                button.sensitive = true;
            }
        });
        sync();
        return group('Charge limit', [
            switchRow(s, 'charge-limit', 'Stop charging at a level', 'Keeps the battery healthier when the laptop is mostly plugged in'),
            ...dependsOnSwitch(s, 'charge-limit', [
                spinRow(s, 'charge-limit-percent', 'Level', 60, 100, 5, 'Percent'),
            ]),
            setupRow,
        ], 'Laptops with an adjustable limit get it set directly. Others charge normally up to the level, then switch to battery protection, so it cannot go below the laptop\'s own protection level (often 60 or 80%).');
    }

    /** Blurred, see-through windows: switch, look and the app list. */
    _addWindowBlurGroup(page, window, s) {
        page.add(group('Blurred app windows', [
            switchRow(s, 'window-blur', 'Blur behind app windows', 'The apps below turn see-through, with the desktop blurred behind them'),
            ...dependsOnSwitch(s, 'window-blur', [
                spinRow(s, 'window-blur-opacity', 'Window opacity', 50, 100, 5, 'Percent; lower shows more of the blur'),
                spinRow(s, 'window-blur-strength', 'Blur strength', 10, 100, 5, 'Percent'),
            ]),
        ], 'Full-screen windows stay solid. Off while Blur my Shell is on.'));
        // The defaults list several terminals; only the installed ones are shown.
        page.add(appListGroup(window, s, 'window-blur-apps', {title: 'Apps with blurred windows', hideMissing: true}));
    }

    /** Picture-in-picture and always-on-top apps. */
    _addOnTopGroups(page, window, s) {
        // Extra titles: a comma-separated list stored as a string array.
        const pipTitles = new Adw.EntryRow({title: 'Other picture-in-picture titles (comma-separated)', show_apply_button: true});
        pipTitles.text = s.get_strv('pip-extra-titles').join(', ');
        pipTitles.connect('apply', () => s.set_strv('pip-extra-titles',
            pipTitles.text.split(',').map(t => t.trim()).filter(Boolean)));
        page.add(group('Picture-in-picture', [
            switchRow(s, 'pip-on-top', 'Always on top', 'Picture-in-picture windows of every app stay above other windows'),
            ...dependsOnSwitch(s, 'pip-on-top', [
                switchRow(s, 'pip-all-workspaces', 'On every workspace', 'They follow you when you switch workspaces'),
                pipTitles,
            ]),
        ], 'Automatic: works with browsers (Firefox, Chrome, Brave, Edge, Opera, LibreWolf), Telegram and any app whose small video window is titled "Picture-in-Picture", or ends in "— Picture in picture", "- PiP" or "- Mini player". Add other titles for apps that name it differently, or press Alt+Enter on any window.'));

        // Apps whose every window stays on top (also: right-click the app on the taskbar).
        page.add(appListGroup(window, s, 'ontop-apps', {
            title: 'Always on top apps',
            description: 'Windows of these apps always stay above other windows. Also: right-click an app on the taskbar → Always on top.',
        }));
    }

    /** Save all settings as "my setup" and bring them back with one click. */
    _mySetupGroup(window, s) {
        const g = new Adw.PreferencesGroup({
            title: 'My setup',
            description: 'Save everything you set up here, then bring it all back with one click if something changes.',
        });
        const restoreRow = new Adw.ActionRow({title: 'Restore my setup'});
        const restore = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        restoreRow.add_suffix(restore);
        restoreRow.activatable_widget = restore;
        const saveRow = new Adw.ActionRow({title: 'Save current settings as my setup',
            subtitle: 'Stored in ~/.config/fusion-desk/my-setup.json (kept when settings are reset)'});
        const save = new Gtk.Button({label: 'Save', valign: Gtk.Align.CENTER});
        saveRow.add_suffix(save);
        saveRow.activatable_widget = save;

        const toast = text => window.add_toast(new Adw.Toast({title: text, timeout: 3}));
        const sync = () => {
            const data = readSnapshot();
            restore.sensitive = !!data;
            restoreRow.subtitle = data ? `Saved ${savedLabel(data)}` : 'Nothing saved yet: save your setup first';
        };
        sync();

        const doSave = () => {
            try {
                saveSnapshot(s);
                sync();
                toast('Your setup is saved');
            } catch (e) {
                toast(`Could not save: ${e.message}`);
            }
        };
        save.connect('clicked', () => {
            if (!readSnapshot()) {
                doSave();
                return;
            }
            const dialog = new Adw.AlertDialog({heading: 'Replace your saved setup?',
                body: `The setup saved ${savedLabel()} will be replaced by the current settings.`});
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('save', 'Replace');
            dialog.set_response_appearance('save', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, id) => id === 'save' && doSave());
            dialog.present(window);
        });
        restore.connect('clicked', () => {
            if (restoreSnapshot(s))
                toast('Your setup is back');
        });
        g.add(restoreRow);
        g.add(saveRow);
        return g;
    }

    _addAboutPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        const head = new Adw.PreferencesGroup();
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER, margin_bottom: 12});
        box.append(new Gtk.Label({label: 'Fusion Desk', css_classes: ['title-1']}));
        const v = this.metadata['version-name'] ?? this.metadata.version;
        const version = v ? `Version ${v} · ` : '';
        box.append(new Gtk.Label({label: `${version}Developed by Md. Hafijur Rahman`, css_classes: ['dim-label']}));
        box.append(new Gtk.LinkButton({uri: this.metadata.url ?? 'https://github.com/Hafij-DEU', label: 'GitHub'}));
        box.append(new Gtk.Label({label: 'This app was generated with AI. Developer support may not be available.',
            css_classes: ['dim-label'], wrap: true, justify: Gtk.Justification.CENTER}));
        head.add(box);
        page.add(head);
        page.add(shortcutsGroup(s));
        const link = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
            return row;
        };
        page.add(group('Design inspiration', [
            link('Dash to Panel', 'Jason DeRose, Charles Gagnon and contributors · GPL-2.0', 'https://github.com/home-sweet-gnome/dash-to-panel'),
            link('ArcMenu', 'Andrew Zaech, LinxGem33 and contributors · GPL-2.0', 'https://gitlab.com/arcmenu/ArcMenu'),
            link('Vitals / Resource Monitor', 'Panel system readouts', 'https://github.com/corecoding/Vitals'),
            link('Clipboard History', 'SUPERCILEX and contributors', 'https://github.com/SUPERCILEX/gnome-clipboard-history'),
            link('Caffeine', 'eonpatapon and contributors', 'https://github.com/eonpatapon/gnome-shell-extension-caffeine'),
            link('Date Menu Formatter', 'Marcin Jakubowski', 'https://github.com/marcinjakubowski/date-menu-formatter'),
        ], 'Written from scratch; no code from these projects is included. Thank you to their authors.'));
        page.add(group('License', [
            new Adw.ActionRow({title: 'GNU General Public License v2.0 or later',
                subtitle: 'Free software: you may share and change it under the GPL. It comes with no warranty.'}),
            new Adw.ActionRow({title: 'Trademarks',
                subtitle: 'Product names belong to their owners. Fusion Desk is not affiliated with Microsoft, KDE, Linux Mint, Apple or the authors above.'}),
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
