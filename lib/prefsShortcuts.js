// Preferences: keyboard shortcuts shown as keycaps next to the setting they
// belong to, and the full list on the About page (prefs process only).
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {watch} from './prefsRows.js';

const CSS = `
.fusion-keycap {
    min-width: 16px;
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 0.9em;
    font-weight: bold;
    background-color: alpha(currentColor, 0.08);
    box-shadow: inset 0 -2px alpha(currentColor, 0.15), inset 0 0 0 1px alpha(currentColor, 0.15);
}
`;
const MODS = [
    [Gdk.ModifierType.CONTROL_MASK, 'Ctrl'],
    [Gdk.ModifierType.SHIFT_MASK, 'Shift'],
    [Gdk.ModifierType.ALT_MASK, 'Alt'],
    [Gdk.ModifierType.SUPER_MASK, 'Super'],
];

let cssLoaded = false;
function loadCss() {
    if (cssLoaded)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    cssLoaded = true;
}

/** Key names of a GTK accelerator ("<Super>space" → ["Super", "Space"]), or [] when it is empty or invalid. */
export function accelKeys(accel) {
    if (!accel)
        return [];
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    if (!ok || !key)
        return [];
    return [...MODS.filter(([mask]) => mods & mask).map(([, name]) => name), Gtk.accelerator_get_label(key, 0)];
}

/** Keycaps for one shortcut: ["Super", "V"] → [Super] + [V]. */
export function keycaps(keys) {
    loadCss();
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
    keys.forEach((k, i) => {
        if (i)
            box.append(new Gtk.Label({label: '+', css_classes: ['dim-label']}));
        box.append(new Gtk.Label({label: k, css_classes: ['fusion-keycap']}));
    });
    return box;
}

/**
 * Show the shortcut of `row` next to it. `keysOf(s)` gives the key names
 * (re-read when one of `watchKeys` changes; [] hides them).
 */
export function withShortcut(row, s, keysOf, watchKeys = []) {
    const holder = new Gtk.Box({valign: Gtk.Align.CENTER});
    const sync = () => {
        for (let c = holder.get_first_child(); c; c = holder.get_first_child())
            holder.remove(c);
        const keys = keysOf(s);
        if (keys.length)
            holder.append(keycaps(keys));
    };
    sync();
    for (const key of watchKeys)
        watch(s, `changed::${key}`, row, sync);
    row.add_suffix(holder);
    // First among the suffixes, so the keys sit before a switch or an apply button.
    const box = holder.get_parent();
    if (box instanceof Gtk.Box)
        box.reorder_child_after(holder, null);
    return row;
}

const SUPER_KEY_LABELS = {MENU: 'Start menu', RUNNER: 'Runner', LAUNCHER: 'App launcher', OVERVIEW: 'Activities overview'};

/**
 * Every shortcut: [section, action, keys(s), where it is set, off(s) → reason or ''].
 * Settings-driven ones read their current value.
 */
const SHORTCUTS = [
    ['Start menu', s => `Open the ${SUPER_KEY_LABELS[s.get_string('super-key')]?.toLowerCase() ?? 'start menu'}`,
        () => ['Super'], 'Start Menu → Keyboard → Super key opens', () => ''],
    ['Start menu', () => 'Open the start menu (extra shortcut)', s => accelKeys(s.get_string('menu-hotkey')),
        'Start Menu → Keyboard', s => accelKeys(s.get_string('menu-hotkey')).length ? '' : 'Not set'],
    ['Start menu', () => 'Open the runner (quick search)', s => accelKeys(s.get_string('menu-runner-hotkey')),
        'Start Menu → Keyboard', s => accelKeys(s.get_string('menu-runner-hotkey')).length ? '' : 'Off'],
    ['Start menu', () => 'Move from the search field into the results', () => ['↓'], 'Also Tab', () => ''],
    ['Start menu', () => 'Open the first search result', () => ['Enter'], '', () => ''],
    ['Start menu', () => 'Close the menu', () => ['Esc'], '', () => ''],
    ['Taskbar', () => 'Open or focus the nth taskbar app', () => ['Super', '1…9'], 'Taskbar → Super+1…9 hotkeys',
        s => s.get_boolean('taskbar-hotkeys') ? '' : 'Off'],
    ['Taskbar', () => 'New window of the nth taskbar app', () => ['Ctrl', 'Super', '1…9'], 'Taskbar → Super+1…9 hotkeys',
        s => s.get_boolean('taskbar-hotkeys') ? '' : 'Off'],
    ['Windows', () => 'Keep the focused window always on top, or let it go', s => accelKeys(s.get_string('ontop-hotkey')),
        'System → Always on top shortcut', s => accelKeys(s.get_string('ontop-hotkey')).length ? '' : 'Off'],
    ['Desktop', () => 'Hide or show the desktop collections', () => ['Alt', 'O'], 'Desktop → Organize desktop',
        s => s.get_boolean('deepin-organizer') ? '' : 'Off'],
    ['Desktop', () => 'App launcher: move between apps', () => ['←↑↓→'], 'Typing anywhere searches', () => ''],
    ['Desktop', () => 'App launcher: clear the search, then close', () => ['Esc'], '', () => ''],
    ['Desktop', () => 'Close the control centre', () => ['Esc'], '', () => ''],
    ['Clipboard', () => 'Open the clipboard history', () => ['Super', 'V'], 'Widgets → Clipboard history',
        s => s.get_boolean('clipboard-super-v') ? '' : 'Off'],
    ['Clipboard', () => 'Copy the first match of the search', () => ['Enter'], 'In the clipboard history', () => ''],
    ['Clipboard', s => s.get_boolean('clipboard-auto-paste') ? 'Paste (sent for you after choosing an entry)'
        : 'Paste the chosen entry', () => ['Ctrl', 'V'], 'Widgets → Clipboard history → Paste on select', () => ''],
];
const WATCHED = ['ontop-hotkey', 'super-key', 'menu-hotkey', 'menu-runner-hotkey', 'taskbar-hotkeys', 'deepin-organizer',
    'clipboard-super-v', 'clipboard-auto-paste'];

/** About → Keyboard shortcuts: every shortcut by section, with its current keys. */
export function shortcutsGroup(s) {
    const g = new Adw.PreferencesGroup({
        title: 'Keyboard shortcuts',
        description: 'Every shortcut, with the place where it is set. The same keys are shown next to each setting.',
    });
    const sections = new Map();
    for (const [section, ...item] of SHORTCUTS) {
        if (!sections.has(section))
            sections.set(section, []);
        sections.get(section).push(item);
    }
    for (const [section, items] of sections) {
        const expander = new Adw.ExpanderRow({title: section, subtitle: `${items.length} shortcuts`, expanded: true});
        for (const [action, keys, where, off] of items) {
            const row = new Adw.ActionRow({title: action(s)});
            const sync = () => {
                row.title = action(s);
                const reason = off(s);
                row.subtitle = [reason, where].filter(Boolean).join(' · ');
                row.set_opacity(reason ? 0.55 : 1);
            };
            sync();
            withShortcut(row, s, keys, WATCHED);
            for (const key of WATCHED)
                watch(s, `changed::${key}`, row, sync);
            expander.add_row(row);
        }
        g.add(expander);
    }
    return g;
}
