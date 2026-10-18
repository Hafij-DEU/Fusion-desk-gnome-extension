// Windows-like mode: extra Windows-style buttons (search, Task View) and
// theming for the user's own Fusion taskbar, which otherwise stays as it is.
// Ideas only; no Windows code, icons or logos.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** Search field (or icon) next to the start button; opens the start menu. */
export class WindowsSearch {
    constructor(ext) {
        const style = ext.settings.get_string('windows-search');
        this.actor = null;
        if (style === 'HIDDEN')
            return;
        const icon = new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16});
        let child = icon;
        if (style === 'BOX') {
            child = new St.BoxLayout({style_class: 'fusion-win-search-box', x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
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
