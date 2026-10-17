// Clipboard history with search, private mode and optional persistence.
import Clutter from 'gi://Clutter';
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

const KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const PASTE_DELAY = 120; // ms, lets focus return to the window after the menu closes
const SUPER_V = /^<super>v$/i;
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk', 'clipboard.json']);
// Password managers (KeePassXC, KDE) mark secrets with this type; they are never recorded.
const SECRET_HINT = 'x-kde-passwordManagerHint';

const ClipboardButton = GObject.registerClass(
class FusionClipboard extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Fusion Clipboard', false);
        this._settings = ext.settings;
        // History lives in extension state so rebuilding the button keeps it.
        ext.state.clipboard ??= {items: this._load(), paused: false};
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
            this._store.items.length = 0;
            this._save();
            this._render();
        });

        this.menu.connect('open-state-changed', (_m, open) => {
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
        });

        global.display.get_selection().connectObject('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._fetch();
        }, this);
    }

    _fetch() {
        if (this._store.paused)
            return;
        const clipboard = St.Clipboard.get_default();
        if (clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD).includes(SECRET_HINT))
            return;
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._destroyed || !text || !text.trim() || this._store.paused)
                return;
            const items = this._store.items;
            const idx = items.indexOf(text);
            if (idx === 0)
                return;
            if (idx > 0)
                items.splice(idx, 1);
            items.unshift(text);
            items.length = Math.min(items.length, this._settings.get_int('clipboard-size'));
            this._save();
            if (this.menu.isOpen)
                this._render();
        });
    }

    _filtered() {
        const q = this._search.text.toLowerCase();
        return q ? this._store.items.filter(t => t.toLowerCase().includes(q)) : this._store.items;
    }

    _render() {
        this._list.destroy_all_children();
        const items = this._filtered();
        if (!items.length) {
            this._list.add_child(new St.Label({text: 'Nothing copied yet.', style_class: 'fusion-clip-empty'}));
            return;
        }
        for (const text of items) {
            const row = new St.BoxLayout({style_class: 'fusion-clip-row'});
            const button = new St.Button({style_class: 'fusion-clip-item', can_focus: true, track_hover: true, x_expand: true});
            const label = new St.Label({text: text.replace(/\s+/g, ' ').trim().slice(0, 200), x_expand: true, x_align: Clutter.ActorAlign.START});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            button.set_child(label);
            button.connect('clicked', () => this._select(text));
            const del = new St.Button({
                style_class: 'fusion-clip-delete',
                child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14}),
                accessible_name: 'Delete',
            });
            del.connect('clicked', () => {
                const i = this._store.items.indexOf(text);
                if (i >= 0)
                    this._store.items.splice(i, 1);
                this._save();
                this._render();
            });
            row.add_child(button);
            row.add_child(del);
            this._list.add_child(row);
        }
    }

    _select(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this.menu.close();
        if (this._settings.get_boolean('clipboard-auto-paste'))
            this._queuePaste();
    }

    /** Send Ctrl+V to the focused window once the menu grab is gone. */
    _queuePaste() {
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            this._pasteId = 0;
            if (!global.display.focus_window)
                return GLib.SOURCE_REMOVE;
            this._keyboard ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = GLib.get_monotonic_time();
            this._keyboard.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(t + 1, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(t + 2, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            this._keyboard.notify_keyval(t + 3, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            return GLib.SOURCE_REMOVE;
        });
    }

    _load() {
        if (!this._settings.get_boolean('clipboard-persist'))
            return [];
        try {
            const [, bytes] = GLib.file_get_contents(CACHE);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return Array.isArray(data) ? data.filter(x => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    _save() {
        const file = Gio.File.new_for_path(CACHE);
        if (!this._settings.get_boolean('clipboard-persist')) {
            if (file.query_exists(null))
                file.delete(null);
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
