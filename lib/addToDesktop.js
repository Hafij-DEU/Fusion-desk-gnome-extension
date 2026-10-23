// "Add to Desktop" for apps: a copy of the app's launcher in the desktop
// folder, made executable and marked trusted so a double click starts it
// (desktop icons, Fusion's desktop and file managers all honour that).
// The item appears in GNOME's app menus (app grid, dash, Fusion taskbar);
// the start menu adds its own. Written for Fusion Desk.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

function desktopDir() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
}

/** The app's launcher in the desktop folder (may not exist), or null for apps without a .desktop file. */
function launcherOf(app) {
    const id = app?.get_id();
    if (!id || !app.app_info?.get_filename?.())
        return null;
    return Gio.File.new_for_path(GLib.build_filenamev([desktopDir(), id]));
}

export function canAddToDesktop(app) {
    return launcherOf(app) !== null;
}

export function isOnDesktop(app) {
    return launcherOf(app)?.query_exists(null) ?? false;
}

/** Put the app on the desktop, or take it off again. */
export function toggleOnDesktop(app) {
    const dest = launcherOf(app);
    if (!dest)
        return;
    try {
        if (dest.query_exists(null)) {
            dest.delete(null);
            return;
        }
        GLib.mkdir_with_parents(desktopDir(), 0o755);
        Gio.File.new_for_path(app.app_info.get_filename()).copy(dest, Gio.FileCopyFlags.NONE, null, null);
        dest.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        Main.notifyError(`Could not change ${app.get_name()} on the desktop`, e.message);
        return;
    }
    try {
        dest.set_attribute_string('metadata::trusted', 'true', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        // No metadata store (gvfs missing): the launcher asks once before it runs.
    }
}

/** Adds "Add to Desktop" / "Remove from Desktop" to every GNOME app menu. */
export class AddToDesktopMenus {
    constructor() {
        this._items = new Set();
        const self = this;
        this._setApp = AppMenu.prototype.setApp;
        const original = this._setApp;
        AppMenu.prototype.setApp = function (app) {
            original.call(this, app);
            self._ensureItem(this);
        };
    }

    _ensureItem(menu) {
        // setApp(null) also runs while a menu is destroyed.
        if (menu._fusionDesktopItem || !menu._app)
            return;
        const item = new PopupMenu.PopupMenuItem('Add to Desktop');
        item.connect('activate', () => toggleOnDesktop(menu._app));
        // Just above "App Details", where GNOME keeps the app's own actions.
        const items = menu._getMenuItems();
        const at = items.indexOf(menu._detailsItem);
        menu.addMenuItem(item, at >= 0 ? at : undefined);
        menu._fusionDesktopItem = item;
        this._items.add(item);
        item.connect('destroy', () => this._items.delete(item));
        const sync = () => {
            item.visible = canAddToDesktop(menu._app);
            item.label.text = isOnDesktop(menu._app) ? 'Remove from Desktop' : 'Add to Desktop';
        };
        menu.connectObject('open-state-changed', (_m, open) => open && sync(), item);
        sync();
    }

    destroy() {
        AppMenu.prototype.setApp = this._setApp;
        for (const item of [...this._items]) {
            const menu = item._getTopMenu?.();
            if (menu)
                delete menu._fusionDesktopItem;
            item.destroy();
        }
        this._items.clear();
    }
}
