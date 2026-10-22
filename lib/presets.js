// One-click style presets, shared by the shell (right-click menu) and prefs.
// A preset only writes ordinary settings; every feature keeps its own switch.
// No gnome-shell imports here.
import {parseLayout} from './layoutModel.js';

/** [id, label] — ids are stored in desktop-mode (kept from older versions). */
export const PRESETS = [
    ['fusion', 'Classic'],
    ['deepin', 'Studio'],
    ['windows', 'Workbench'],
    ['centered', 'Centered'],
];

const VALUES = {
    // Classic: the plain Fusion taskbar.
    fusion: {
        'deepin-start': 'FUSION', 'deepin-control-button': false, 'deepin-organizer': false,
        'deepin-floating-taskbar': false, 'windows-extras-in-fusion': false,
    },
    // Studio: app launcher, control centre, desktop organizer, floating taskbar.
    deepin: {
        'deepin-start': 'BOTH', 'deepin-control-button': true, 'deepin-organizer': true,
        'deepin-floating-taskbar': true, 'windows-extras-in-fusion': false,
    },
    // Workbench: search box and Task View next to the start button.
    windows: {
        'deepin-start': 'FUSION', 'deepin-control-button': false, 'deepin-organizer': false,
        'deepin-floating-taskbar': false, 'windows-extras-in-fusion': true,
    },
    // Centered: start button, search, Task View and apps together in the
    // middle of a flat bottom bar; control centre at the left edge; tray
    // icons behind the hidden-icons arrow.
    centered: {
        'deepin-start': 'FUSION', 'deepin-control-button': true, 'deepin-control-position': 'LEFT', 'deepin-organizer': false,
        'deepin-floating-taskbar': false, 'windows-extras-in-fusion': true,
        'windows-search': 'BOX', 'windows-task-view': true,
        'panel-position': 'BOTTOM', 'panel-style': 'FLAT', 'menu-layout': 'eleven',
        'apps-visible': false, 'activities-visible': false, 'overflow-visible': true, 'desktop-visible': true,
        layout: centerStartButton,
    },
};

/** Start button first in the centre box, everything else where it was. */
function centerStartButton(strv) {
    const items = parseLayout(strv).filter(i => i.id !== 'menu');
    const firstCenter = items.findIndex(i => i.box === 'center');
    items.splice(firstCenter >= 0 ? firstCenter : items.length, 0, {id: 'menu', box: 'center'});
    return items.map(i => `${i.id}:${i.box}`);
}

/** Apply a preset's settings and remember it as the current style. */
export function applyPreset(settings, id) {
    const values = VALUES[id];
    if (!values)
        return;
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'function')
            settings.set_strv(key, value(settings.get_strv(key)));
        else if (typeof value === 'boolean')
            settings.set_boolean(key, value);
        else
            settings.set_string(key, value);
    }
    settings.set_string('desktop-mode', id);
}

/**
 * One-time move from the old "desktop modes" (features only worked inside a
 * mode) to independent settings, keeping what the user had on screen.
 */
export function migrateDesktopModes(settings) {
    if (settings.get_boolean('features-migrated'))
        return;
    const isSet = key => settings.get_user_value(key) !== null;
    const keep = (key, oldDefault) => {
        if (isSet(key))
            return;
        if (typeof oldDefault === 'boolean')
            settings.set_boolean(key, oldDefault);
        else
            settings.set_string(key, oldDefault);
    };
    const mode = settings.get_string('desktop-mode');
    if (mode === 'deepin') {
        // Old defaults inside the mode: launcher button, control centre, organizer on.
        keep('deepin-start', 'BOTH');
        keep('deepin-control-button', true);
        keep('deepin-organizer', true);
    } else if (mode === 'windows') {
        settings.set_boolean('windows-extras-in-fusion', true);
        settings.set_string('deepin-start', 'FUSION');
        settings.set_boolean('deepin-control-button', false);
        settings.set_boolean('deepin-organizer', false);
        settings.set_boolean('deepin-floating-taskbar', false);
    } else if (settings.get_boolean('deepin-features-enabled')) {
        // Fusion mode with picked features: exactly the picked ones were on.
        const picked = settings.get_strv('deepin-features');
        if (!picked.includes('launcher'))
            settings.set_string('deepin-start', 'FUSION');
        else if (settings.get_string('deepin-start') === 'FUSION' || !isSet('deepin-start'))
            settings.set_string('deepin-start', 'BOTH');
        settings.set_boolean('deepin-control-button', picked.includes('control'));
        settings.set_boolean('deepin-organizer', picked.includes('organizer'));
        settings.set_boolean('deepin-floating-taskbar', picked.includes('floating'));
    } else {
        // Plain Fusion mode: none of these were on screen.
        settings.set_string('deepin-start', 'FUSION');
        settings.set_boolean('deepin-control-button', false);
        settings.set_boolean('deepin-organizer', false);
        settings.set_boolean('deepin-floating-taskbar', false);
    }
    // Accent colour and icon themes used to apply only inside the mode.
    if (mode !== 'deepin' && !(settings.get_boolean('deepin-features-enabled') && settings.get_strv('deepin-features').includes('accent')))
        settings.reset('deepin-accent');
    if (mode !== 'deepin' && !(settings.get_boolean('deepin-features-enabled') && settings.get_strv('deepin-features').includes('icons'))) {
        settings.reset('deepin-icon-theme');
        settings.reset('deepin-cursor-theme');
    }
    settings.set_boolean('features-migrated', true);
}
