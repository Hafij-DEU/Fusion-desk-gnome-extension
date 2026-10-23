// Preferences: the "Start Menu" page and the start menu colours sub-page (prefs process only).
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {importArcMenu} from './menu/arcmenuImport.js';
import {PRESETS, parseColor} from './menu/themes.js';
import {comboRow, dependsOn, entryRow, group, navRow, resetButton, spinRow, switchRow, watch} from './prefsRows.js';
import {accelKeys, withShortcut} from './prefsShortcuts.js';

export const LAYOUT_INFO = [
    // id (stored setting), title, group, description. Titles are neutral names on
    // purpose: no third-party product names or trademarks as layout names.
    ['eleven', 'Modern', 'Modern', 'Pinned grid, recommended files, all apps page'],
    ['grid', 'Launcher Grid', 'Modern', 'Big app grid with category chips'],
    ['runner', 'Runner', 'Modern', 'Search-first floating box'],
    ['windows', 'Classic', 'Traditional', 'Side rail, A–Z list and pinned tiles'],
    ['fusion', 'Fusion', 'Traditional', 'Categories, apps and places side by side'],
    ['mint', 'Sidebar', 'Traditional', 'Favourites bar, categories and app list'],
    ['plasma', 'Tabbed', 'Traditional', 'Tabs for favourites, apps, places and power'],
]

const POWER = [['lock', 'Lock'], ['switch-user', 'Switch User'], ['logout', 'Log Out'],
    ['suspend', 'Suspend'], ['restart', 'Restart'], ['poweroff', 'Power Off']];

// ---- Layout thumbnails --------------------------------------------------------

function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/** Schematic drawing of a layout in a w×h box. */
function drawLayout(id, cr, w, h, fg) {
    const set = a => cr.setSourceRGBA(fg.red, fg.green, fg.blue, a);
    const box = (x, y, bw, bh, a = 0.75, r = 2) => {
        set(a);
        roundRect(cr, x, y, bw, bh, r);
        cr.fill();
    };
    const lines = (x, y, n, lw, gap = 8) => {
        for (let i = 0; i < n; i++) {
            box(x, y + i * gap, 4, 4, 0.8, 1);
            box(x + 7, y + i * gap + 1, lw, 2, 0.45, 1);
        }
    };
    const grid = (x, y, cols, rows, size, gap) => {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++)
                box(x + c * (size + gap), y + r * (size + gap), size, size, 0.8, 2);
        }
    };
    // Frame
    set(0.35);
    cr.setLineWidth(1.5);
    roundRect(cr, 1, 1, w - 2, h - 2, 6);
    cr.stroke();
    const search = (x, y, sw) => {
        set(0.4);
        cr.setLineWidth(1);
        roundRect(cr, x, y, sw, 7, 3.5);
        cr.stroke();
    };

    switch (id) {
    case 'eleven':
        search(10, 7, w - 20);
        grid(12, 21, 6, 3, 11, 5);
        box(12, 72, 20, 2, 0.5);
        lines(12, 78, 2, 26);
        lines(w / 2 + 4, 78, 2, 26);
        box(1, h - 12, w - 2, 11, 0.12, 0);
        box(8, h - 9, 5, 5, 0.8, 2.5);
        box(w - 13, h - 9, 5, 5, 0.8, 2.5);
        break;
    case 'grid':
        search(w / 2 - 28, 7, 56);
        for (let i = 0; i < 5; i++)
            box(10 + i * 21, 19, 17, 5, 0.35, 2.5);
        grid(12, 30, 5, 3, 14, 7);
        box(1, h - 11, w - 2, 10, 0.12, 0);
        break;
    case 'runner':
        search(10, 14, w - 20);
        grid(14, 34, 5, 1, 12, 7);
        lines(14, 56, 3, w - 40);
        break;
    case 'windows':
        box(1, 1, 12, h - 2, 0.15, 0);
        [6, h - 30, h - 22, h - 14].forEach(y => box(4, y, 5, 5, 0.7, 2));
        search(17, 6, 40);
        lines(17, 18, 9, 30);
        grid(64, 8, 3, 4, 14, 4);
        break;
    case 'fusion':
        search(8, 6, w - 16);
        lines(8, 20, 8, 18);
        grid(38, 20, 3, 3, 11, 5);
        lines(w - 30, 20, 7, 16);
        box(w - 36, h - 9, 28, 4, 0.5);
        break;
    case 'mint':
        search(26, 6, w - 34);
        box(5, 6, 14, h - 12, 0.15, 3);
        for (let i = 0; i < 5; i++)
            box(8, 11 + i * 11, 8, 8, 0.75, 2);
        lines(26, 20, 8, 22);
        lines(64, 20, 8, 38);
        break;
    case 'plasma':
        box(1, 1, w - 2, 16, 0.12, 0);
        box(7, 5, 8, 8, 0.8, 4);
        search(20, 5, w - 28);
        grid(16, 23, 4, 3, 12, 9);
        box(1, h - 14, w - 2, 1, 0.3, 0);
        for (let i = 0; i < 4; i++)
            box(14 + i * 26, h - 10, 7, 6, 0.75, 2);
        break;
    }
}

function layoutThumb(id, width = 120, height = 96) {
    const area = new Gtk.DrawingArea({content_width: width, content_height: height, halign: Gtk.Align.CENTER});
    area.set_draw_func((a, cr, w, h) => drawLayout(id, cr, w, h, a.get_color()));
    return area;
}

function layoutCard(s, id, title, desc, onPick) {
    const button = new Gtk.Button({css_classes: ['card', 'fusion-layout-card'], tooltip_text: desc});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 12, margin_bottom: 10,
        margin_start: 12, margin_end: 12});
    box.append(layoutThumb(id));
    const name = new Gtk.Label({label: title, css_classes: ['heading']});
    box.append(name);
    button.set_child(box);
    const sync = () => {
        const current = s.get_string('menu-layout') === id;
        name.label = current ? `✓  ${title}` : title;
        if (current)
            name.add_css_class('accent');
        else
            name.remove_css_class('accent');
    };
    sync();
    watch(s, 'changed::menu-layout', button, sync);
    button.connect('clicked', () => {
        s.set_string('menu-layout', id);
        onPick?.();
    });
    return button;
}

function layoutPicker(window, s) {
    return page => {
        for (const groupName of ['Modern', 'Traditional']) {
            const g = new Adw.PreferencesGroup({title: `${groupName} layouts`});
            const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, column_spacing: 12, row_spacing: 12,
                max_children_per_line: 3, min_children_per_line: 2, homogeneous: true});
            for (const [id, title, grp, desc] of LAYOUT_INFO) {
                if (grp === groupName)
                    flow.append(layoutCard(s, id, title, desc, () => window.pop_subpage()));
            }
            g.add(flow);
            page.add(g);
        }
    };
}

// ---- Colours -----------------------------------------------------------------

function colorRow(s, key, title) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: true}), valign: Gtk.Align.CENTER});
    const sync = () => {
        const c = parseColor(s.get_string(key));
        if (c)
            button.rgba = new Gdk.RGBA({red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255, alpha: c[3]});
    };
    sync();
    watch(s, `changed::${key}`, button, sync);
    button.connect('notify::rgba', () => {
        const v = button.rgba.to_string();
        if (parseColor(v) && v !== s.get_string(key))
            s.set_string(key, v);
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** Start menu colours: shell theme or own colours, presets, border and corners (Appearance page). */
export function menuThemePage(s) {
    return page => {
        page.add(group('Colours', [
            comboRow(s, 'menu-theme', 'Menu colours', ['SHELL', 'CUSTOM'], ['Follow shell theme', 'Custom']),
            switchRow(s, 'menu-theme-follow-system', 'Light colours in light style', 'Custom theme switches to light colours while the system style is light'),
        ]));
        const presets = new Adw.PreferencesGroup({title: 'Presets', description: 'Click one to apply it as the custom theme.'});
        const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, column_spacing: 8, row_spacing: 8,
            max_children_per_line: 6, homogeneous: true});
        for (const [name, [bg, fg, accent, hover, border, bw, radius]] of Object.entries(PRESETS)) {
            const b = new Gtk.Button({label: name, css_classes: ['pill']});
            b.connect('clicked', () => {
                s.set_string('menu-bg-color', bg);
                s.set_string('menu-fg-color', fg);
                s.set_string('menu-accent-color', accent);
                s.set_string('menu-hover-color', hover);
                s.set_string('menu-border-color', border);
                s.set_int('menu-border-width', bw);
                s.set_int('menu-radius', radius);
                s.set_string('menu-theme', 'CUSTOM');
            });
            flow.append(b);
        }
        presets.add(flow);
        page.add(presets);
        page.add(group('Custom theme', [
            colorRow(s, 'menu-bg-color', 'Background'),
            colorRow(s, 'menu-fg-color', 'Text'),
            colorRow(s, 'menu-accent-color', 'Selected item'),
            colorRow(s, 'menu-hover-color', 'Hovered item'),
            colorRow(s, 'menu-border-color', 'Border'),
            spinRow(s, 'menu-border-width', 'Border width', 0, 6),
            spinRow(s, 'menu-radius', 'Corner radius', 0, 40),
        ], 'Used when "Menu colours" is Custom.'));
    };
}

// ---- Pictures ----------------------------------------------------------------------

function chooseImage(window, title, onPick) {
    const filter = new Gtk.FileFilter({name: 'Images'});
    ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].forEach(m => filter.add_mime_type(m));
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
    filters.append(filter);
    const dialog = new Gtk.FileDialog({title, filters, default_filter: filter});
    const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    if (pics)
        dialog.initial_folder = Gio.File.new_for_path(pics);
    dialog.open(window, null, (d, res) => {
        try {
            const file = d.open_finish(res);
            if (file?.get_path())
                onPick(file.get_path());
        } catch {
            // Cancelled.
        }
    });
}

// ---- Pinned apps ---------------------------------------------------------------

export function appInfo(id) {
    try {
        return GioUnix.DesktopAppInfo.new(id);
    } catch {
        return null;
    }
}

function pinnedPage(window, s) {
    return page => {
        page.add(group('Source', [
            comboRow(s, 'menu-pinned-source', 'Pinned apps come from', ['FAVORITES', 'OWN'],
                ['Taskbar favourites', 'Own list (below)'], 'Right-click any app in the menu to pin or unpin it'),
        ]));
        const list = new Adw.PreferencesGroup({title: 'Own pinned list'});
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: 'Add an app'});
        add.connect('clicked', () => chooseApp(window, id => {
            const ids = s.get_strv('menu-pinned');
            if (!ids.includes(id))
                s.set_strv('menu-pinned', [...ids, id]);
        }));
        list.set_header_suffix(add);
        page.add(list);

        let rows = [];
        const fill = () => {
            rows.forEach(r => list.remove(r));
            rows = [];
            const ids = s.get_strv('menu-pinned');
            ids.forEach((id, i) => {
                const info = appInfo(id);
                const row = new Adw.ActionRow({title: info?.get_display_name() ?? id, subtitle: info ? '' : 'Not installed'});
                if (info?.get_icon())
                    row.add_prefix(new Gtk.Image({gicon: info.get_icon(), pixel_size: 32}));
                const move = (step) => {
                    const l = s.get_strv('menu-pinned');
                    [l[i], l[i + step]] = [l[i + step], l[i]];
                    s.set_strv('menu-pinned', l);
                };
                const up = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive: i > 0});
                const down = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive: i < ids.length - 1});
                const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
                up.connect('clicked', () => move(-1));
                down.connect('clicked', () => move(1));
                del.connect('clicked', () => s.set_strv('menu-pinned', s.get_strv('menu-pinned').filter(x => x !== id)));
                [up, down, del].forEach(b => row.add_suffix(b));
                list.add(row);
                rows.push(row);
            });
        };
        fill();
        watch(s, 'changed::menu-pinned', page, fill);
    };
}

/** Searchable app list dialog; calls `onPick(desktopId)`. */
export function chooseApp(window, onPick) {
    const dialog = new Adw.Dialog({title: 'Add app', content_width: 420, content_height: 560});
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 8, margin_bottom: 8,
        margin_start: 12, margin_end: 12});
    const search = new Gtk.SearchEntry({placeholder_text: 'Search apps'});
    const listBox = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
    const apps = Gio.AppInfo.get_all().filter(a => a.should_show())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    for (const app of apps) {
        const row = new Adw.ActionRow({title: app.get_display_name(), activatable: true});
        row._name = app.get_display_name().toLowerCase();
        if (app.get_icon())
            row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}));
        row.connect('activated', () => {
            onPick(app.get_id());
            dialog.close();
        });
        listBox.append(row);
    }
    listBox.set_filter_func(row => !search.text || row._name.includes(search.text.toLowerCase()));
    search.connect('search-changed', () => listBox.invalidate_filter());
    box.append(search);
    box.append(new Gtk.ScrolledWindow({child: listBox, vexpand: true}));
    view.set_content(box);
    dialog.set_child(view);
    dialog.present(window);
}

// ---- Pages ---------------------------------------------------------------------

/** The Start Menu page: layout, size, position, contents, keys and the start button. */
// Web search engines for the start menu's last search result.
const WEB_ENGINES = [
    ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
    ['Google', 'https://www.google.com/search?q=%s'],
    ['Bing', 'https://www.bing.com/search?q=%s'],
    ['Brave Search', 'https://search.brave.com/search?q=%s'],
    ['Startpage', 'https://www.startpage.com/do/search?q=%s'],
    ['Ecosia', 'https://www.ecosia.org/search?q=%s'],
    ['Wikipedia', 'https://en.wikipedia.org/w/index.php?search=%s'],
];

/** Engine picker that fills menu-web-search; "Custom" keeps a hand-typed address, "Off" empties it. */
function webEngineRow(s) {
    const labels = [...WEB_ENGINES.map(([name]) => name), 'Custom address', 'Off'];
    const row = new Adw.ComboRow({title: 'Search engine', model: Gtk.StringList.new(labels)});
    const sync = () => {
        const url = s.get_string('menu-web-search');
        const i = WEB_ENGINES.findIndex(([, u]) => u === url);
        row.selected = !url ? labels.length - 1 : i >= 0 ? i : WEB_ENGINES.length;
    };
    sync();
    watch(s, 'changed::menu-web-search', row, sync);
    row.connect('notify::selected', () => {
        const i = row.selected;
        if (i < WEB_ENGINES.length && s.get_string('menu-web-search') !== WEB_ENGINES[i][1])
            s.set_string('menu-web-search', WEB_ENGINES[i][1]);
        else if (i === labels.length - 1 && s.get_string('menu-web-search'))
            s.set_string('menu-web-search', '');
    });
    return row;
}

export function addMenuPage(window, s) {
    const page = new Adw.PreferencesPage({title: 'Start Menu', icon_name: 'start-here-symbolic'});

    // Current layout + change.
    const current = new Adw.PreferencesGroup({title: 'Layout'});
    const card = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 18, css_classes: ['card'],
        margin_bottom: 6});
    const thumbBox = new Gtk.Box({margin_top: 12, margin_bottom: 12, margin_start: 14});
    const info = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, spacing: 4, hexpand: true});
    const title = new Gtk.Label({xalign: 0, css_classes: ['title-3']});
    const desc = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label']});
    info.append(title);
    info.append(desc);
    const change = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER, margin_end: 14, css_classes: ['pill']});
    change.connect('clicked', () => {
        const p = new Adw.PreferencesPage();
        layoutPicker(window, s)(p);
        const nav = new Adw.NavigationPage({title: 'Menu Layout', child: new Adw.ToolbarView({content: p})});
        nav.child.add_top_bar(new Adw.HeaderBar());
        window.push_subpage(nav);
    });
    card.append(thumbBox);
    card.append(info);
    card.append(change);
    const syncCard = () => {
        const id = s.get_string('menu-layout');
        const [, t, , d] = LAYOUT_INFO.find(l => l[0] === id) ?? LAYOUT_INFO[0];
        thumbBox.get_first_child()?.unparent();
        thumbBox.append(layoutThumb(id, 110, 88));
        title.label = t;
        desc.label = d;
    };
    syncCard();
    s.connect('changed::menu-layout', syncCard);
    current.add(card);
    page.add(current);

    const size = group('Size', [
        spinRow(s, 'menu-width', 'Width', 0, 2400, 10, 'Pixels, 0 = the layout\'s own width'),
        spinRow(s, 'menu-height', 'Height', 0, 2000, 10, 'Pixels'),
        spinRow(s, 'menu-font-size', 'Font size', 0, 24, 1, 'Points, 0 = shell default'),
        spinRow(s, 'menu-tile-icon-size', 'Grid icon size', 16, 96, 2, 'Pixels'),
        spinRow(s, 'menu-list-icon-size', 'List icon size', 16, 64, 2, 'Pixels'),
        spinRow(s, 'menu-pinned-columns', 'Pinned columns', 0, 12, 1, '0 = the layout\'s own number'),
    ], 'Every layout; smaller on small screens.');
    resetButton(s, size, ['menu-width', 'menu-height', 'menu-font-size', 'menu-tile-icon-size', 'menu-list-icon-size', 'menu-pinned-columns']);
    page.add(size);

    page.add(group('Position', [
        comboRow(s, 'menu-position', 'Open at', ['BUTTON', 'CENTER'], ['Start button', 'Screen centre']),
        spinRow(s, 'menu-gap', 'Space around the menu', -1, 40, 1, 'Pixels to the screen edge and panel; 0 = flush, -1 = theme default'),
        comboRow(s, 'menu-search-position', 'Search box', ['AUTO', 'TOP', 'BOTTOM'], ['Layout default', 'Top', 'Bottom'],
            'Bottom works with the Fusion, Classic, Sidebar and Launcher Grid layouts'),
    ]));

    page.add(group('Contents', [
        navRow(window, 'Pinned apps', 'Own list or taskbar favourites; add, order, remove', 'view-pin-symbolic', pinnedPage(window, s)),
        comboRow(s, 'menu-default-view', 'Open on', ['PINNED', 'ALL'], ['Pinned apps', 'All apps']),
        switchRow(s, 'menu-show-user', 'User avatar and name'),
        switchRow(s, 'menu-show-places', 'Places', 'Home, Documents, Downloads, …'),
        switchRow(s, 'menu-show-shortcuts', 'App shortcuts', 'Settings, Software, Terminal, Files'),
        comboRow(s, 'menu-recommended', 'Recommended', ['MIXED', 'APPS', 'FILES'],
            ['Apps and files', 'Apps only', 'Files only'], 'Modern layout: recently added and opened apps, recent files'),
        switchRow(s, 'menu-show-frequent', 'Frequently used apps'),
        switchRow(s, 'menu-show-recent', 'Recent files'),
        switchRow(s, 'menu-show-notes', 'Quick notes', 'Fusion layout'),
        switchRow(s, 'menu-show-apphub', 'App Hub panel', 'Updates, installs and disk space from App Hub (side rail, footer, category or tab)'),
        switchRow(s, 'menu-hover-categories', 'Switch categories on hover'),
        switchRow(s, 'menu-tooltips', 'Tooltips'),
        navRow(window, 'Search', 'Fuzzy app search, calculator, commands, files, web search', 'edit-find-symbolic', p => {
            p.add(group('Search', [
                switchRow(s, 'menu-search-fuzzy', 'Fuzzy app search',
                    'Finds apps despite typos or skipped letters ("firfox", "lbrwrt"); also in the app launcher'),
                switchRow(s, 'menu-search-calc', 'Calculator', 'Type 2+2*3'),
                switchRow(s, 'menu-search-commands', 'Run commands', 'Type >htop'),
                switchRow(s, 'menu-search-files', 'Recent files'),
                spinRow(s, 'menu-max-results', 'Maximum app results', 5, 100),
            ]));
            p.add(group('Web search', [
                webEngineRow(s),
                entryRow(s, 'menu-web-search', 'Search address (%s = what you typed, empty = off)'),
            ], 'The last search result opens your browser with what you typed.'));
        }),
        navRow(window, 'Power buttons', 'Which power buttons to show', 'system-shutdown-symbolic', p => {
            const g = new Adw.PreferencesGroup({title: 'Power buttons'});
            for (const [id, label] of POWER) {
                const row = new Adw.SwitchRow({title: label});
                row.active = s.get_strv('menu-power-options').includes(id);
                row.connect('notify::active', () => {
                    const l = s.get_strv('menu-power-options').filter(x => x !== id);
                    if (row.active)
                        l.push(id);
                    s.set_strv('menu-power-options', POWER.map(([pid]) => pid).filter(pid => l.includes(pid)));
                });
                g.add(row);
            }
            p.add(g);
        }),
    ]));

    page.add(group('Keyboard', [
        withShortcut(comboRow(s, 'super-key', 'Super key opens', ['MENU', 'RUNNER', 'LAUNCHER', 'OVERVIEW'],
            ['Start menu', 'Runner', 'App launcher', 'Activities overview'], 'App launcher: when it is on (Desktop page); else the start menu'),
        s, () => ['Super']),
        withShortcut(entryRow(s, 'menu-hotkey', 'Extra menu shortcut (e.g. <Super>space)'),
            s, () => accelKeys(s.get_string('menu-hotkey')), ['menu-hotkey']),
        withShortcut(entryRow(s, 'menu-runner-hotkey', 'Runner shortcut (e.g. <Super>r, empty = off)'),
            s, () => accelKeys(s.get_string('menu-runner-hotkey')), ['menu-runner-hotkey']),
    ]));

    // Start button: look, icon and size.
    const iconRow = new Adw.EntryRow({title: 'Icon name or image path', show_apply_button: true, text: s.get_string('menu-icon')});
    iconRow.connect('apply', () => s.set_string('menu-icon', iconRow.text.trim()));
    watch(s, 'changed::menu-icon', iconRow, () => {
        iconRow.text = s.get_string('menu-icon');
    });
    const browse = new Gtk.Button({label: 'Browse…', valign: Gtk.Align.CENTER});
    browse.connect('clicked', () => chooseImage(window, 'Choose a start button icon', path => s.set_string('menu-icon', path)));
    iconRow.add_suffix(browse);
    const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
        tooltip_text: 'Default icon'});
    reset.connect('clicked', () => s.reset('menu-icon'));
    iconRow.add_suffix(reset);
    page.add(group('Start button', [
        comboRow(s, 'menu-button-style', 'Display style', ['ICON', 'TEXT', 'ICON_TEXT'], ['Icon', 'Text', 'Icon and text']),
        ...dependsOn(s, ['menu-button-style'], () => s.get_string('menu-button-style') !== 'ICON', [
            entryRow(s, 'menu-label', 'Text'),
        ]),
        iconRow,
        spinRow(s, 'menu-button-icon-size', 'Icon size', 12, 64, 1, 'Pixels'),
        spinRow(s, 'menu-button-padding', 'Padding', -1, 40, 1, 'Pixels, -1 = default'),
        switchRow(s, 'menu-button-fill', 'Large click area', 'The whole panel height around the icon opens the menu'),
    ], 'Left click: start menu. Right click: settings, layout switch, power. Middle click: Activities. Move or hide it on the Panel page.'));

    // ArcMenu import
    const imp = new Adw.ActionRow({title: 'Import from ArcMenu', subtitle: 'Layout, pinned apps, theme, button icon and power options'});
    const impButton = new Gtk.Button({label: 'Import', valign: Gtk.Align.CENTER, css_classes: ['pill']});
    impButton.connect('clicked', () => {
        const done = importArcMenu(s);
        const toast = new Adw.Toast({title: done === null ? 'ArcMenu is not installed'
            : done.length ? `Imported: ${done.join(', ')}` : 'Nothing to import', timeout: 5});
        window.add_toast(toast);
    });
    imp.add_suffix(impButton);
    page.add(group('Import', [imp]));
    window.add(page);
}
