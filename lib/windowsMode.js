// Windows-like mode: Fusion's own taskbar (same modules, same start menu),
// restyled to look like a Windows taskbar. Nothing else runs next to it.
// Layout ideas only; no Windows code, icons or logos.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const WIDGET_VISIBILITY = [
    'workspaces-visible', 'media-visible', 'sysmon-visible',
    'clipboard-visible', 'apphub-visible', 'screenshot-visible',
];

/** Fusion settings as seen by the modules while Windows-like mode is on. */
function overrides(raw) {
    const center = raw.get_string('windows-align') === 'CENTER';
    const combine = raw.get_boolean('windows-combine');
    const o = {
        'panel-position': 'BOTTOM',
        'panel-style': 'FLAT',
        'panel-height': 48,
        'hide-overview-dash': true,
        'activities-visible': false,
        'apps-visible': false,
        'title-visible': false,
        'menu-visible': true,
        'taskbar-visible': true,
        'desktop-visible': true,
        'taskbar-icon-size': 24,
        'taskbar-group-apps': combine,
        'taskbar-labels': !combine,
        // Short pill under each app (Windows 11) or a line (Windows 10).
        'taskbar-indicator-style': center ? 'DASHES' : 'LINE',
        'taskbar-indicator-position': 'BOTTOM',
        'menu-button-style': 'ICON',
        'menu-button-fill': false,
        'menu-button-icon-size': 24,
    };
    if (!raw.get_boolean('windows-widgets'))
        WIDGET_VISIBILITY.forEach(k => (o[k] = false));
    if (raw.get_string('windows-menu-style') === 'AUTO') {
        o['menu-layout'] = center ? 'eleven' : 'windows';
        o['menu-position'] = center ? 'CENTER' : 'BUTTON';
        o['menu-gap'] = center ? 12 : 0;
    }
    return o;
}

/**
 * Settings proxy: the Windows-like values above win, everything else (and
 * every signal) comes from the real settings, so the user's own Fusion
 * setup is untouched and returns when the mode is switched off.
 */
export function windowsSettings(raw) {
    return new Proxy(raw, {
        get(target, prop) {
            if (prop === 'get_int' || prop === 'get_boolean' || prop === 'get_string') {
                return key => {
                    const o = overrides(target);
                    return key in o ? o[key] : target[prop](key);
                };
            }
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}

/** Element placement for the Windows-like taskbar ([{id, box}]). */
export function windowsLayout(raw) {
    const center = raw.get_string('windows-align') === 'CENTER';
    const main = ['menu', 'winsearch', 'taskview', 'taskbar'];
    const extrasRight = ['sysmon', 'clipboard', 'apphub', 'screenshot'];
    const tray = ['quick', 'date', 'desktop'];
    const boxes = center
        ? {left: ['activities', 'workspaces', 'media', 'title', 'apps'], center: main, right: [...extrasRight, ...tray]}
        : {left: ['activities', ...main, 'title', 'apps'], center: ['media'], right: ['workspaces', ...extrasRight, ...tray]};
    const out = [];
    for (const [box, ids] of Object.entries(boxes))
        ids.forEach(id => out.push({id, box}));
    return out;
}

/** Search field (or icon) next to the start button; opens the start menu. */
export class WindowsSearch {
    constructor(ext) {
        const style = ext.rawSettings.get_string('windows-search');
        this.actor = null;
        if (style === 'HIDDEN')
            return;
        const icon = new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16});
        let child = icon;
        if (style === 'BOX') {
            child = new St.BoxLayout({style_class: 'fusion-win-search-box', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
            child.add_child(icon);
            child.add_child(new St.Label({text: _('Search'), y_align: Clutter.ActorAlign.CENTER}));
        }
        this.actor = new St.Button({
            style_class: `fusion-win-search ${style === 'BOX' ? 'fusion-win-search-wide' : 'fusion-win-search-icon'}`,
            can_focus: true,
            track_hover: true,
            accessible_name: _('Search'),
            y_align: Clutter.ActorAlign.CENTER,
            child,
        });
        this.actor.connect('clicked', () => ext.toggleStartMenu());
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
    }
}

/** Task View button: all windows and workspaces (GNOME's overview). */
export class TaskView {
    constructor() {
        this.actor = new St.Button({
            style_class: 'fusion-win-taskview',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Task View'),
            y_align: Clutter.ActorAlign.FILL,
            child: new St.Icon({icon_name: 'focus-windows-symbolic', fallback_icon_name: 'view-dual-symbolic', icon_size: 20}),
        });
        this.actor.connect('clicked', () => Main.overview.toggle());
    }

    destroy() {
        this.actor.destroy();
    }
}
