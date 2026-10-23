// Clipboard history with search, private mode and optional persistence.
// Copied images are kept too: each is saved once as a file (named by its
// checksum) and the history holds a link to it, so it can be pasted later or
// its file path copied.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {listDir, readText} from './files.js';

const KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const PASTE_DELAY = 60; // ms between checks that focus is back in the window after the menu closed
const PASTE_WAIT = 1500; // ms, give up when the window never gets focus back
// Evdev key codes: they work whatever the keyboard layout (keyvals fail on layouts without a Latin V).
const KEY_CTRL = 29, KEY_SHIFT = 42, KEY_V = 47;
// Terminals paste with Ctrl+Shift+V (Ctrl+V is a control character there).
const TERMINAL = /terminal|ptyxis|kgx|console|tilix|kitty|alacritty|konsole|xterm|terminator|wezterm|foot|blackbox|guake|tilda|warp/i;
const SUPER_V = /^<super>v$/i;
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk', 'clipboard.json']);
// Password managers (KeePassXC, KDE) mark secrets with this type; they are never recorded.
const SECRET_HINT = 'x-kde-passwordManagerHint';
const IMAGES = GLib.build_filenamev([GLib.get_user_data_dir(), 'fusion-desk', 'clipboard-images']);
// Preferred image types, best first; any other image/* is taken as a last resort.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
const TEXT_TYPES = ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'STRING', 'TEXT'];
const MAX_IMAGE = 25 * 1024 * 1024; // bytes

/** History entries are strings (text) or {image, mime, width, height} (a saved image). */
const isImage = entry => typeof entry === 'object';
const sameEntry = (a, b) => (isImage(a) && isImage(b) ? a.image === b.image : a === b);
const searchText = entry => (isImage(entry) ? `image ${entry.width}×${entry.height}` : entry);

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');

function deleteFile(path) {
    Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
}

const ClipboardButton = GObject.registerClass(
class FusionClipboard extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Fusion Clipboard', false);
        this._settings = ext.settings;
        // History lives in extension state so rebuilding the button keeps it.
        if (!ext.state.clipboard) {
            ext.state.clipboard = {items: [], paused: false};
            this._load(ext.state.clipboard);
        }
        this._store = ext.state.clipboard;

        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));
        this.menu.actor.add_style_class_name('fusion-clip-menu');

        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._search = new St.Entry({hint_text: 'Search clipboard…', can_focus: true, x_expand: true, style_class: 'fusion-clip-search'});
        this._search.clutter_text.connect('text-changed', () => this._render());
        this._search.clutter_text.connect('activate', () => {
            const first = this._filtered()[0];
            if (first !== undefined)
                this._select(first);
        });
        searchItem.add_child(this._search);
        this.menu.addMenuItem(searchItem);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-clip-list'});
        const scroll = new St.ScrollView({
            style_class: 'fusion-clip-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.set_child(this._list);
        const wrap = new PopupMenu.PopupMenuSection();
        wrap.actor.add_child(scroll);
        this.menu.addMenuItem(wrap);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._pausedItem = new PopupMenu.PopupSwitchMenuItem('Private mode (pause recording)', this._store.paused);
        this._pausedItem.connect('toggled', (_i, state) => {
            this._store.paused = state;
        });
        this.menu.addMenuItem(this._pausedItem);
        this.menu.addAction('Clear history', () => {
            const images = this._store.items.filter(isImage);
            this._store.items.length = 0;
            images.forEach(e => this._forgetImage(e));
            this._save();
            this._render();
        });

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open) {
                this._search.text = '';
                this._render();
                if (this._focusId)
                    GLib.source_remove(this._focusId);
                this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._focusId = 0;
                    this._search.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);

        global.display.get_selection().connectObject('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._fetch();
        }, this);
    }

    _fetch() {
        if (this._store.paused)
            return;
        const clipboard = St.Clipboard.get_default();
        const mimes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (mimes.includes(SECRET_HINT))
            return;
        // Text wins when both are offered (office apps add a picture of the selection).
        const image = !mimes.some(m => TEXT_TYPES.includes(m)) && this._settings.get_boolean('clipboard-images') &&
            (IMAGE_TYPES.find(m => mimes.includes(m)) ?? mimes.find(m => m.startsWith('image/') && !m.includes('svg')));
        if (image) {
            clipboard.get_content(St.ClipboardType.CLIPBOARD, image, (_c, bytes) => {
                if (!this._destroyed && !this._store.paused)
                    this._keepImage(image, bytes).catch(e => console.warn(`Fusion Desk: clipboard image not kept: ${e.message}`));
            });
            return;
        }
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._destroyed || !text || !text.trim() || this._store.paused)
                return;
            // The file path of an image entry, copied from its link button.
            if (text === this._ownLink)
                return;
            this._add(text);
        });
    }

    /** Save the image once (by checksum) and put a link to it at the top. */
    async _keepImage(mime, bytes) {
        const size = bytes?.get_size() ?? 0;
        if (!size || size > MAX_IMAGE)
            return;
        const sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'img';
        const path = GLib.build_filenamev([IMAGES, `${sum}.${ext}`]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(IMAGES, 0o700);
            await Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE, null);
        }
        if (this._destroyed || this._store.paused)
            return;
        const [, width = 0, height = 0] = GdkPixbuf.Pixbuf.get_file_info(path) ?? [];
        this._add({image: path, mime, width, height});
    }

    /** Put `entry` at the top of the history (moving it if it is already there). */
    _add(entry) {
        const items = this._store.items;
        const idx = items.findIndex(e => sameEntry(e, entry));
        if (idx === 0)
            return;
        if (idx >= 0)
            items.splice(idx, 1);
        items.unshift(entry);
        this._trim();
        this._save();
        if (this.menu.isOpen)
            this._render();
    }

    /** Keep the history at its size; files of images that fall off are deleted. */
    _trim() {
        const items = this._store.items;
        const dropped = items.splice(this._settings.get_int('clipboard-size'));
        dropped.filter(isImage).forEach(e => this._forgetImage(e));
    }

    _forgetImage(entry) {
        if (!this._store.items.some(e => sameEntry(e, entry)))
            deleteFile(entry.image);
    }

    _remove(entry) {
        const i = this._store.items.findIndex(e => sameEntry(e, entry));
        if (i >= 0)
            this._store.items.splice(i, 1);
        if (isImage(entry))
            this._forgetImage(entry);
        this._save();
        this._render();
    }

    _filtered() {
        const q = this._search.text.toLowerCase();
        return q ? this._store.items.filter(e => searchText(e).toLowerCase().includes(q)) : this._store.items;
    }

    _render() {
        this._list.destroy_all_children();
        const items = this._filtered();
        if (!items.length) {
            this._list.add_child(new St.Label({text: 'Nothing copied yet.', style_class: 'fusion-clip-empty'}));
            return;
        }
        for (const entry of items) {
            const row = new St.BoxLayout({style_class: 'fusion-clip-row'});
            const button = new St.Button({style_class: 'fusion-clip-item', can_focus: true, track_hover: true, x_expand: true});
            if (isImage(entry)) {
                const box = new St.BoxLayout({style_class: 'fusion-clip-image', x_expand: true});
                box.add_child(new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path(entry.image)),
                    icon_size: 56, style_class: 'fusion-clip-thumb'}));
                box.add_child(new St.Label({text: entry.width ? `Image · ${entry.width} × ${entry.height}` : 'Image',
                    y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
                button.set_child(box);
            } else {
                const label = new St.Label({text: entry.replace(/\s+/g, ' ').trim().slice(0, 200), x_expand: true, x_align: Clutter.ActorAlign.START});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                button.set_child(label);
            }
            button.connect('clicked', () => this._select(entry));
            row.add_child(button);
            if (isImage(entry)) {
                const link = new St.Button({
                    style_class: 'fusion-clip-link',
                    child: new St.Icon({icon_name: 'insert-link-symbolic', icon_size: 14}),
                    accessible_name: 'Copy the file path',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                link.connect('clicked', () => this._copyLink(entry));
                row.add_child(link);
            }
            const del = new St.Button({
                style_class: 'fusion-clip-delete',
                child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14}),
                accessible_name: 'Delete',
                y_align: Clutter.ActorAlign.CENTER,
            });
            del.connect('clicked', () => this._remove(entry));
            row.add_child(del);
            this._list.add_child(row);
        }
    }

    _select(entry) {
        if (isImage(entry)) {
            this._selectImage(entry);
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry);
        this.menu.close();
        if (this._settings.get_boolean('clipboard-auto-paste'))
            this._queuePaste();
    }

    /** Put the saved image back on the clipboard, ready to paste. */
    async _selectImage(entry) {
        this.menu.close();
        let bytes;
        try {
            [bytes] = await Gio.File.new_for_path(entry.image).load_bytes_async(null);
        } catch {
            Main.notify('Clipboard', 'This image is gone from disk.');
            this._remove(entry);
            return;
        }
        if (this._destroyed)
            return;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, entry.mime, bytes);
        if (this._settings.get_boolean('clipboard-auto-paste'))
            this._queuePaste();
    }

    /** Copy the image's file path, to paste it as a link (file pickers, terminals, chats). */
    _copyLink(entry) {
        this._ownLink = entry.image;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.image);
        this.menu.close();
    }

    /**
     * Paste into the focused window as soon as the menu has let go of the
     * keyboard and the window has focus again (checked every PASTE_DELAY).
     */
    _queuePaste() {
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        const deadline = GLib.get_monotonic_time() + PASTE_WAIT * 1000;
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            const win = global.display.focus_window;
            if (!win || Main.modalCount > 0 || this.menu.isOpen) {
                if (GLib.get_monotonic_time() < deadline)
                    return GLib.SOURCE_CONTINUE;
                this._pasteId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._pasteId = 0;
            this._sendPaste(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Ctrl+V, or Ctrl+Shift+V in a terminal. */
    _sendPaste(win) {
        const ids = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id(), win.get_sandboxed_app_id()];
        const keys = ids.some(id => id && TERMINAL.test(id)) ? [KEY_CTRL, KEY_SHIFT, KEY_V] : [KEY_CTRL, KEY_V];
        this._keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        let t = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_key(t++, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._keyboard.notify_key(t++, key, Clutter.KeyState.RELEASED);
    }

    /** Restore the saved history (only when "Remember after restart" is on). */
    async _load(store) {
        if (!this._settings.get_boolean('clipboard-persist')) {
            // Nothing is remembered: images from an earlier session are not needed.
            for (const name of await listDir(IMAGES))
                deleteFile(GLib.build_filenamev([IMAGES, name]));
            return;
        }
        const text = await readText(CACHE);
        if (!text || this._destroyed)
            return;
        try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
                // Keep anything copied while the file was loading in front.
                const valid = x => typeof x === 'string' || (typeof x?.image === 'string' &&
                    GLib.path_get_dirname(x.image) === IMAGES && typeof x.mime === 'string' &&
                    GLib.file_test(x.image, GLib.FileTest.EXISTS));
                const saved = data.filter(x => valid(x) && !store.items.some(e => sameEntry(e, x)));
                store.items.push(...saved);
                this._trim();
            }
        } catch {
            // Corrupt cache: start empty.
        }
        if (this.menu.isOpen)
            this._render();
    }

    _save() {
        const file = Gio.File.new_for_path(CACHE);
        if (!this._settings.get_boolean('clipboard-persist')) {
            // Remembering is off: remove any old copy (errors just mean there is none).
            file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
                try {
                    f.delete_finish(res);
                } catch {
                    // Nothing saved.
                }
            });
            return;
        }
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE), 0o700);
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._store.items)));
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.error('Fusion Desk: saving clipboard failed', e);
                }
            });
        } catch (e) {
            console.error('Fusion Desk: saving clipboard failed', e);
        }
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        if (this._focusId)
            GLib.source_remove(this._focusId);
        this._keyboard = null;
        global.display.get_selection().disconnectObject(this);
        this.menu.disconnectObject(this);
        this._search = this._list = this._pausedItem = null;
        super._onDestroy();
    }
});

/**
 * Super+V opens the clipboard history. GNOME binds Super+V (and Super+M) to the
 * notification list, so that binding is taken over while we run and its other
 * accelerators keep opening the notification list.
 */
class SuperVBinding {
    constructor(onClipboard) {
        this._actions = new Map();
        const kb = new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA});
        const trayAccels = kb.get_strv('toggle-message-tray');
        Main.wm.removeKeybinding('toggle-message-tray');
        this._removedTray = true;

        const toggleCalendar = () => Main.panel.toggleCalendar();
        const grab = (accel, handler) => {
            const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
            if (action === Meta.KeyBindingAction.NONE) {
                console.warn(`Fusion Desk: could not bind ${accel}`);
                return;
            }
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
            this._actions.set(action, handler);
        };
        grab('<Super>v', onClipboard);
        for (const accel of trayAccels) {
            if (!SUPER_V.test(accel))
                grab(accel, toggleCalendar);
        }
        global.display.connectObject('accelerator-activated', (_d, action) => {
            this._actions.get(action)?.();
        }, this);
    }

    destroy() {
        global.display.disconnectObject(this);
        for (const action of this._actions.keys()) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        }
        this._actions.clear();
        if (this._removedTray) {
            Main.wm.addKeybinding('toggle-message-tray',
                new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA}),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                Main.wm._toggleCalendar.bind(Main.wm));
        }
    }
}

export class ClipboardHistory {
    constructor(ext) {
        this._button = new ClipboardButton(ext);
        Main.panel.addToStatusArea('fusion-clipboard', this._button, 0, 'right');
        // The icon can be hidden; history and Super+V keep working without it.
        this._iconVisible = ext.settings.get_boolean('clipboard-visible');
        if (this._iconVisible) {
            this.actor = this._button.container;
        } else {
            this._button.container.hide();
            this.actor = null;
        }
        this._button.menu.connectObject('open-state-changed', (_m, open) => {
            if (open && this._anchor)
                this._button.menu._boxPointer.setPosition(this._anchor, 0.5);
        }, this);
        if (ext.settings.get_boolean('clipboard-super-v'))
            this._superV = new SuperVBinding(() => this._toggle());
    }

    _toggle() {
        if (Main.overview.visible)
            Main.overview.hide();
        if (!this._iconVisible && !this._button.menu.isOpen) {
            // No icon to point at: open next to the mouse pointer, like Win+V.
            this._anchor ??= new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
            if (!this._anchor.get_parent())
                Main.uiGroup.add_child(this._anchor);
            const [x, y] = global.get_pointer();
            this._anchor.set_position(x, y);
        }
        this._button.menu.toggle();
    }

    destroy() {
        this._superV?.destroy();
        this._button.menu.disconnectObject(this);
        this._button.destroy();
        this._anchor?.destroy();
    }
}
