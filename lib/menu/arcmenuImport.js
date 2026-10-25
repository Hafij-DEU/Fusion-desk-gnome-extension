// Copies an ArcMenu setup (layout, pinned apps, theme, button, power options)
// into Fusion Desk settings. Used by prefs (Gio / GLib only).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseColor} from './themes.js';

const UUID = 'arcmenu@arcmenu.com';
const SCHEMA = 'org.gnome.shell.extensions.arcmenu';

// ArcMenu layout -> closest Fusion layout.
const LAYOUT_MAP = {
    windows: 'windows', eleven: 'eleven', insider: 'eleven', unity: 'eleven', enterprise: 'eleven',
    mint: 'mint', budgie: 'mint', whisker: 'mint', brisk: 'fusion', arcmenu: 'fusion', redmond: 'fusion',
    plasma: 'plasma', tognee: 'plasma', runner: 'runner', raven: 'runner',
    gnomemenu: 'grid', elementary: 'grid', chromebook: 'grid', pop: 'grid', az: 'grid', sleek: 'eleven', zest: 'eleven',
};

// ArcMenu power-options index -> Fusion power id.
const POWER_MAP = {0: 'poweroff', 1: 'restart', 2: 'lock', 3: 'logout', 4: 'suspend', 7: 'switch-user'};

/** ArcMenu's GSettings (from its installed schema), or null if not installed. */
function openArcMenuSettings() {
    const dirs = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', UUID, 'schemas']),
        ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'gnome-shell', 'extensions', UUID, 'schemas'])),
    ];
    for (const dir of dirs) {
        if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(SCHEMA, false);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch {
            // Broken schema dir; try the next one.
        }
    }
    return null;
}

/**
 * Import ArcMenu settings into `fusion`. Returns a list of what was copied,
 * or null when ArcMenu is not installed.
 */
export function importArcMenu(fusion) {
    const arc = openArcMenuSettings();
    if (!arc)
        return null;
    const has = key => arc.settings_schema.has_key(key);
    const userSet = key => arc.get_user_value(key) !== null;
    const done = [];

    if (has('menu-layout')) {
        const layout = LAYOUT_MAP[arc.get_string('menu-layout')];
        if (layout) {
            fusion.set_string('menu-layout', layout);
            done.push(`layout (${layout})`);
        }
    }

    if (has('pinned-apps')) {
        const ids = arc.get_value('pinned-apps').deepUnpack()
            .map(entry => entry.id)
            .filter(id => id && id.endsWith('.desktop'));
        if (ids.length) {
            fusion.set_strv('menu-pinned', ids);
            fusion.set_string('menu-pinned-source', 'OWN');
            done.push(`${ids.length} pinned apps`);
        }
    }

    if (has('menu-height') && userSet('menu-height')) {
        fusion.set_int('menu-height', Math.max(300, Math.min(2000, arc.get_int('menu-height'))));
        done.push('menu height');
    }

    if (has('override-menu-theme') && arc.get_boolean('override-menu-theme')) {
        const copy = (from, to) => {
            if (has(from) && parseColor(arc.get_string(from)))
                fusion.set_string(to, arc.get_string(from));
        };
        copy('menu-background-color', 'menu-bg-color');
        copy('menu-foreground-color', 'menu-fg-color');
        copy('menu-border-color', 'menu-border-color');
        copy('menu-item-hover-bg-color', 'menu-hover-color');
        copy('menu-item-active-bg-color', 'menu-accent-color');
        if (has('menu-border-width'))
            fusion.set_int('menu-border-width', Math.min(6, arc.get_int('menu-border-width')));
        if (has('menu-border-radius'))
            fusion.set_int('menu-radius', Math.min(40, arc.get_int('menu-border-radius')));
        if (has('menu-font-size'))
            fusion.set_int('menu-font-size', Math.min(24, arc.get_int('menu-font-size')));
        fusion.set_string('menu-theme', 'CUSTOM');
        done.push('colour theme');
    }

    if (has('menu-button-icon')) {
        const icon = arc.get_string('menu-button-icon');
        if (icon.startsWith('/') && GLib.file_test(icon, GLib.FileTest.EXISTS)) {
            fusion.set_string('menu-icon', icon);
            done.push('button icon');
        }
    }
    if (has('menu-button-icon-size') && userSet('menu-button-icon-size'))
        fusion.set_int('menu-button-icon-size', Math.max(12, Math.min(64, arc.get_int('menu-button-icon-size'))));
    if (has('menu-button-appearance')) {
        const style = {Icon: 'ICON', Text: 'TEXT', Icon_Text: 'ICON_TEXT', Text_Icon: 'ICON_TEXT'}[arc.get_string('menu-button-appearance')];
        if (style)
            fusion.set_string('menu-button-style', style);
    }
    if (has('menu-button-text') && arc.get_string('menu-button-text'))
        fusion.set_string('menu-label', arc.get_string('menu-button-text'));

    if (has('power-options')) {
        const power = arc.get_value('power-options').deepUnpack()
            .filter(([, on]) => on).map(([i]) => POWER_MAP[i]).filter(Boolean);
        if (power.length) {
            fusion.set_strv('menu-power-options', power);
            done.push('power options');
        }
    }
    if (has('activate-on-hover'))
        fusion.set_boolean('menu-hover-categories', arc.get_boolean('activate-on-hover'));
    if (has('show-user-avatar'))
        fusion.set_boolean('menu-show-user', arc.get_boolean('show-user-avatar'));
    return done;
}
