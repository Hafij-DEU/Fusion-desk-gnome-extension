// Desktop files, Deepin-style "Organize Desktop": the files in the desktop folder sorted
// into collections (folders, documents, pictures, …) drawn on the desktop
// layer. Collections can be moved by their title bar, resized (small /
// medium / large or by dragging the corner) and hidden with Alt+O.
// The Icons style shows them as plain desktop icons instead: a grid from the
// top-left corner, each icon dragged to any free cell and kept there.
// Clean-room reimplementation of the behaviour; no DDE code or assets.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Accelerators} from '../accelerators.js';
import {listInfos} from '../files.js';
import {addBlur, paintSurface, themeClass} from './common.js';

const N_ = s => s;
export const COLLECTIONS = [
    {id: 'places', label: N_('Computer'), icon: 'computer-symbolic'},
    {id: 'folders', label: N_('Folders'), icon: 'folder-symbolic'},
    {id: 'documents', label: N_('Documents'), icon: 'x-office-document-symbolic'},
    {id: 'pictures', label: N_('Pictures'), icon: 'image-x-generic-symbolic'},
    {id: 'videos', label: N_('Videos'), icon: 'video-x-generic-symbolic'},
    {id: 'music', label: N_('Music'), icon: 'audio-x-generic-symbolic'},
    {id: 'apps', label: N_('Apps'), icon: 'application-x-executable-symbolic'},
    {id: 'others', label: N_('Others'), icon: 'view-more-symbolic'},
];
const SIZES = {SMALL: [250, 210], MEDIUM: [370, 290], LARGE: [490, 410]};
const GAP = 20;
// Smallest gap between a collection and the screen edge.
const EDGE = 12;
const TITLE_H = 30;
const ICON = 48;
const CELL = 86;
// Icons style: grid cell and how far the pointer moves before a drag starts.
const ICON_W = 96;
const ICON_H = 100;
const DRAG_START = 8;
// Ubuntu's Desktop Icons (DING) draws one desktop window per monitor over
// the desktop layer. While the collections are shown those windows are
// hidden on screen (the extension itself keeps running) so the two desktops
// do not draw on top of each other; Alt+O brings them back.
const DESKTOP_ICONS_APP = 'com.rastersoft.ding';
const DESKTOP_ICONS_TITLE = /^@!\d+,\d+;/;

/**
 * True for the second primary press on `actor` within the double-click time
 * (GNOME 50 events no longer carry a click count).
 */
function isDoubleClick(actor, event) {
    const now = event.get_time();
    const last = actor._fusionLastPress ?? -Infinity;
    actor._fusionLastPress = now;
    if (now - last > Clutter.Settings.get_default().double_click_time)
        return false;
    actor._fusionLastPress = -Infinity;
    return true;
}

function isDesktopIconsWindow(win) {
    return win.get_window_type() === Meta.WindowType.DESKTOP ||
        win.get_gtk_application_id?.() === DESKTOP_ICONS_APP ||
        DESKTOP_ICONS_TITLE.test(win.get_title() ?? '');
}

const DOC_TYPES = /^(text\/|application\/(pdf|rtf|epub|x-mobipocket|msword|vnd\.(oasis|openxmlformats|ms-)|x-abiword|json|xml|x-tex))/;

/** Content type of a file (guessed from the name when the file is empty). */
function contentType(info) {
    const type = info.get_content_type() ?? '';
    // Empty files have no content to sniff: go by the name.
    if (!type || type === 'application/x-zerosize')
        return Gio.content_type_guess(info.get_name(), null)[0] ?? '';
    return type;
}

/** Collection id for a file. */
function collectionOf(info) {
    const type = contentType(info);
    if (info.get_file_type() === Gio.FileType.DIRECTORY)
        return 'folders';
    if (type === 'application/x-desktop')
        return 'apps';
    if (type.startsWith('image/'))
        return 'pictures';
    if (type.startsWith('video/'))
        return 'videos';
    if (type.startsWith('audio/'))
        return 'music';
    if (DOC_TYPES.test(type))
        return 'documents';
    return 'others';
}

export class Organizer {
    constructor(features) {
        this._ext = features.ext;
        this._settings = features.ext.settings;
        this._dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        this._files = new Map();
        this._boxes = new Map();
        this._cancel = new Gio.Cancellable();

        // Own layer above the wallpaper(s), below every window.
        this._layer = new St.Widget({name: 'fusionDesktopFiles', layout_manager: new Clutter.FixedLayout()});
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(this._layer);
        bg.connectObject('child-added', () => bg.set_child_above_sibling(this._layer, null), this);
        this._layer.visible = !this._settings.get_boolean('deepin-organizer-hidden');

        this._keys = new Accelerators();
        this._keys.add('<Alt>o', () => this.toggleHidden());
        this._hookBackgroundMenus();
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._hookBackgroundMenus();
            this._layout();
        }, this);

        if (this._dir && this._dir !== GLib.get_home_dir()) {
            const dir = Gio.File.new_for_path(this._dir);
            try {
                this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                this._monitor.connect('changed', () => this._queueScan());
            } catch (e) {
                console.debug(`Fusion Desk: cannot watch the desktop folder: ${e.message}`);
            }
            this._scan().catch(e => console.error('Fusion Desk: desktop scan failed', e));
        }
        // Computer collection: Home, Trash and mounted drives.
        this._volumes = Gio.VolumeMonitor.get();
        try {
            this._trashMonitor = Gio.File.new_for_uri('trash:///').monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._trashMonitor.connect('changed', () => this._queueScan());
        } catch (e) {
            // No trash backend (gvfs missing): the Trash icon just stays empty.
        }
        this._volumes.connectObject('mount-added', () => this._queueScan(),
            'mount-removed', () => this._queueScan(), 'mount-changed', () => this._queueScan(), this);

        this._dingActors = new Set();
        global.display.connectObject('window-created', (_d, win) => {
            win.connectObject('notify::title', () => this._syncDesktopIcons(), this);
            this._queueDesktopIconsSync();
        }, this);
        this._syncDesktopIcons();
    }

    // ---- Ubuntu's Desktop Icons ------------------------------------------------

    _queueDesktopIconsSync() {
        if (this._dingId)
            return;
        this._dingId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._dingId = 0;
            this._syncDesktopIcons();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Hide Desktop Icons' windows while the collections show; show them otherwise. */
    _syncDesktopIcons(forceShow = false) {
        const hide = !forceShow && this._layer?.visible;
        const actors = global.display.list_all_windows()
            .filter(isDesktopIconsWindow)
            .map(w => w.get_compositor_private())
            .filter(Boolean);
        for (const actor of actors) {
            if (hide && !this._dingActors.has(actor)) {
                this._dingActors.add(actor);
                // Mutter shows window actors again on some state changes.
                actor.connectObject('notify::visible', () => {
                    if (this._layer?.visible && actor.visible)
                        actor.hide();
                }, 'destroy', () => this._dingActors.delete(actor), this);
            }
            if (hide)
                actor.hide();
        }
        if (!hide) {
            for (const actor of this._dingActors) {
                actor.disconnectObject(this);
                actor.show();
            }
            this._dingActors.clear();
        }
    }

    // ---- desktop folder ------------------------------------------------------

    _queueScan() {
        if (this._scanId)
            return;
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._scanId = 0;
            this._scan().catch(e => console.error('Fusion Desk: desktop scan failed', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _scan() {
        const attrs = 'standard::name,standard::display-name,standard::type,standard::content-type,standard::icon,' +
            'standard::is-hidden,standard::is-backup,thumbnail::path,metadata::trusted';
        let files;
        try {
            files = (await listInfos(this._dir, attrs, this._cancel)).filter(i => !i.get_is_hidden() && !i.get_is_backup());
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Fusion Desk: desktop scan failed: ${e.message}`);
            return;
        }
        try {
            const trash = await Gio.File.new_for_uri('trash:///').query_info_async('trash::item-count',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancel);
            this._trashFull = trash.get_attribute_uint32('trash::item-count') > 0;
        } catch {
            this._trashFull = false;
        }
        if (!this._layer)
            return;
        this._files = new Map();
        for (const info of files.sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))) {
            const id = collectionOf(info);
            if (!this._files.has(id))
                this._files.set(id, []);
            this._files.get(id).push(info);
        }
        this._rebuild();
    }

    // ---- collections ---------------------------------------------------------

    _enabledCollections() {
        const on = new Set(this._settings.get_strv('deepin-organizer-collections'));
        return COLLECTIONS.filter(c => on.has(c.id) && (c.id === 'places' || this._files.get(c.id)?.length));
    }

    /** Home, Trash and mounted drives as [{name, gicon, uri}]. */
    _places() {
        const home = Gio.File.new_for_path(GLib.get_home_dir());
        const list = [
            {name: _('Home'), gicon: Gio.ThemedIcon.new('user-home'), uri: home.get_uri()},
            {name: _('Trash'), gicon: Gio.ThemedIcon.new(this._trashFull ? 'user-trash-full' : 'user-trash'), uri: 'trash:///'},
        ];
        for (const mount of this._volumes?.get_mounts() ?? []) {
            if (mount.is_shadowed())
                continue;
            list.push({name: mount.get_name(), gicon: mount.get_icon(), uri: mount.get_root().get_uri()});
        }
        return list;
    }

    _placeItem(place) {
        const item = new St.Button({
            style_class: 'fusion-desktop-file',
            can_focus: true,
            track_hover: true,
            accessible_name: place.name,
            width: CELL,
        });
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        col.add_child(new St.Icon({gicon: place.gicon, icon_size: ICON, x_align: Clutter.ActorAlign.CENTER}));
        const label = new St.Label({text: place.name, style_class: 'fusion-desktop-file-label'});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        label.set_width(CELL - 8);
        col.add_child(label);
        item.set_child(col);
        item.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY && isDoubleClick(item, event)) {
                try {
                    Gio.AppInfo.launch_default_for_uri(place.uri, global.create_app_launch_context(0, -1));
                } catch (e) {
                    console.warn(`Fusion Desk: cannot open ${place.uri}: ${e.message}`);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        item.connect('clicked', () => item.grab_key_focus());
        return item;
    }

    /** A JSON object kept in a string setting; {} when empty or unreadable. */
    _readJson(key) {
        try {
            return JSON.parse(this._settings.get_string(key) || '{}');
        } catch {
            return {};
        }
    }

    _geometry() {
        return this._readJson('deepin-organizer-geometry');
    }

    _saveGeometry(id, geom) {
        const all = this._geometry();
        all[id] = geom;
        this._settings.set_string('deepin-organizer-geometry', JSON.stringify(all));
    }

    _iconsStyle() {
        return this._settings.get_string('deepin-organizer-style') === 'ICONS';
    }

    _rebuild() {
        this._boxes.forEach(b => b.destroy());
        this._boxes.clear();
        if (this._iconsStyle()) {
            this._rebuildIcons();
            return;
        }
        for (const c of this._enabledCollections()) {
            const box = this._collection(c, c.id === 'places' ? this._places() : this._files.get(c.id));
            this._layer.add_child(box);
            this._boxes.set(c.id, box);
        }
        this._layout();
    }

    /** Saved positions, or columns from the top-left corner like Deepin. */
    _layout() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._layer)
            return;
        if (this._iconsStyle()) {
            this._layoutIcons();
            return;
        }
        const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const saved = this._geometry();
        const [dw, dh] = SIZES[this._settings.get_string('deepin-organizer-size')] ?? SIZES.MEDIUM;
        let x = work.x + GAP, y = work.y + GAP;
        for (const [id, box] of this._boxes) {
            const g = saved[id];
            let w = g?.w ?? dw, h = g?.h ?? dh;
            let bx, by;
            if (g) {
                bx = g.x;
                by = g.y;
            } else {
                if (y + h > work.y + work.height && y > work.y + GAP) {
                    y = work.y + GAP;
                    x += dw + GAP;
                }
                bx = x;
                by = y;
                y += h + GAP;
            }
            // Keep a gap from the screen edges (also after dragging there).
            w = Math.min(w, work.width - 2 * EDGE);
            h = Math.min(h, work.height - 2 * EDGE);
            bx = Math.max(work.x + EDGE, Math.min(bx, work.x + work.width - w - EDGE));
            by = Math.max(work.y + EDGE, Math.min(by, work.y + work.height - h - EDGE));
            box.set_position(bx, by);
            box.set_size(w, h);
        }
    }

    _collection(c, files) {
        const s = this._settings;
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `fusion-collection ${themeClass(s)}`,
            reactive: true,
        });
        paintSurface(box, s);
        addBlur(box, s, 30);

        const title = new St.BoxLayout({style_class: 'fusion-collection-title', reactive: true, height: TITLE_H});
        title.add_child(new St.Icon({icon_name: c.icon, icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
        title.add_child(new St.Label({text: `${_(c.label)} (${files.length})`, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const more = new St.Button({
            style_class: 'fusion-collection-more', can_focus: true, accessible_name: _('Collection size'),
            child: new St.Icon({icon_name: 'view-more-horizontal-symbolic', fallback_icon_name: 'view-more-symbolic', icon_size: 14}),
        });
        more.connect('clicked', () => this._openSizeMenu(more, c.id, box));
        title.add_child(more);
        box.add_child(title);
        this._makeDraggable(title, box, c.id, false);

        const scroll = new St.ScrollView({style_class: 'fusion-collection-scroll', y_expand: true, hscrollbar_policy: St.PolicyType.NEVER});
        const grid = new St.Viewport({
            layout_manager: new Clutter.FlowLayout({orientation: Clutter.Orientation.HORIZONTAL, column_spacing: 2, row_spacing: 2}),
            x_expand: true,
        });
        files.forEach(f => grid.add_child(f instanceof Gio.FileInfo ? this._fileItem(f) : this._placeItem(f)));
        scroll.set_child(grid);
        box.add_child(scroll);

        const grip = new St.Widget({style_class: 'fusion-collection-grip', reactive: true, width: 14, height: 14, x_align: Clutter.ActorAlign.END});
        box.add_child(grip);
        this._makeDraggable(grip, box, c.id, true);
        return box;
    }

    _fileItem(info) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, info.get_name()]));
        const item = new St.Button({
            style_class: 'fusion-desktop-file',
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: info.get_display_name(),
            width: CELL,
        });
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        const thumb = info.get_attribute_byte_string('thumbnail::path');
        let gicon = thumb ? new Gio.FileIcon({file: Gio.File.new_for_path(thumb)}) : info.get_icon();
        let name = info.get_display_name();
        if (contentType(info) === 'application/x-desktop') {
            // Launchers show the app's name and icon.
            const app = GioUnix.DesktopAppInfo.new_from_filename(file.get_path());
            name = app?.get_name() ?? name;
            gicon = app?.get_icon() ?? gicon;
        } else if (!thumb && info.get_content_type() === 'application/x-zerosize') {
            gicon = Gio.content_type_get_icon(contentType(info));
        }
        col.add_child(new St.Icon({gicon, icon_size: ICON, x_align: Clutter.ActorAlign.CENTER}));
        const label = new St.Label({text: name, style_class: 'fusion-desktop-file-label'});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        label.set_width(CELL - 8);
        col.add_child(label);
        item.set_child(col);

        // Double-click opens, like the Deepin desktop; right-click: file menu.
        item.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY && isDoubleClick(item, event)) {
                this._open(file, info);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        item.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._openFileMenu(item, file, info);
            else
                item.grab_key_focus();
        });
        return item;
    }

    _open(file, info) {
        const ctx = global.create_app_launch_context(0, -1);
        try {
            // Launchers run only when marked trusted ("Allow Launching"), as
            // desktop-icon apps do; otherwise they open as text.
            if (contentType(info) === 'application/x-desktop' &&
                info.get_attribute_string('metadata::trusted') === 'true') {
                GioUnix.DesktopAppInfo.new_from_filename(file.get_path())?.launch([], ctx);
                return;
            }
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), ctx);
        } catch (e) {
            console.warn(`Fusion Desk: cannot open ${file.get_path()}: ${e.message}`);
        }
    }

    _menuFor(source) {
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('fusion-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menus ??= new PopupMenu.PopupMenuManager(this._layer);
        this._menus.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        return menu;
    }

    _openFileMenu(source, file, info) {
        const menu = this._menuFor(source);
        menu.addAction(_('Open'), () => this._open(file, info));
        menu.addAction(_('Show in Files'), () => {
            Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Move to Trash'), () => file.trash_async(GLib.PRIORITY_DEFAULT, null, null));
        menu.open();
    }

    _openSizeMenu(source, id, box) {
        const menu = this._menuFor(source);
        for (const [key, label] of [['SMALL', _('Small')], ['MEDIUM', _('Medium')], ['LARGE', _('Large')]]) {
            menu.addAction(label, () => {
                const [w, h] = SIZES[key];
                this._saveGeometry(id, {x: box.x, y: box.y, w, h});
                this._layout();
            });
        }
        menu.open();
    }

    /** Move (title bar) or resize (corner grip) a collection with the pointer. */
    _makeDraggable(handle, box, id, resize) {
        handle.connect('button-press-event', (_a, event) => {
            const src = global.stage.get_event_actor(event);
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || src instanceof St.Button || src?.get_parent?.() instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = event.get_coords();
            const start = {x: box.x, y: box.y, w: box.width, h: box.height};
            const grab = global.stage.grab(handle);
            const motion = handle.connect('motion-event', (_h, ev) => {
                const [x, y] = ev.get_coords();
                if (resize)
                    box.set_size(Math.max(180, start.w + x - sx), Math.max(120, start.h + y - sy));
                else
                    box.set_position(Math.round(start.x + x - sx), Math.round(start.y + y - sy));
                return Clutter.EVENT_STOP;
            });
            const release = handle.connect('button-release-event', () => {
                handle.disconnect(motion);
                handle.disconnect(release);
                grab.dismiss();
                this._saveGeometry(id, {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)});
                this._layout();
                return Clutter.EVENT_STOP;
            });
            return Clutter.EVENT_STOP;
        });
    }

    // ---- Icons style -------------------------------------------------------------

    /** Home, Trash and drives (when the Computer collection is on), then the files by kind and name. */
    _rebuildIcons() {
        this._icons = [];
        const add = (key, actor) => {
            actor.add_style_class_name('fusion-desktop-icon');
            actor.set_width(ICON_W - 6);
            // Names centred under the icon, on up to two lines.
            const label = actor.get_child().get_last_child();
            label.set_width(ICON_W - 12);
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.line_alignment = Pango.Alignment.CENTER;
            this._layer.add_child(actor);
            this._boxes.set(key, actor);
            const entry = {key, actor, cell: null};
            this._icons.push(entry);
            this._makeIconDraggable(entry);
        };
        if (this._settings.get_strv('deepin-organizer-collections').includes('places'))
            this._places().forEach(p => add(`place:${p.uri}`, this._placeItem(p)));
        for (const c of COLLECTIONS) {
            for (const info of this._files.get(c.id) ?? [])
                add(info.get_name(), this._fileItem(info));
        }
        this._layoutIcons();
    }

    _iconGrid() {
        const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        return {
            work,
            cols: Math.max(1, Math.floor((work.width - 2 * EDGE) / ICON_W)),
            rows: Math.max(1, Math.floor((work.height - 2 * EDGE) / ICON_H)),
        };
    }

    _iconPositions() {
        return this._readJson('desktop-icon-positions');
    }

    /** Saved cells first, then every other icon in the next free cell, column by column. */
    _layoutIcons() {
        if (!this._icons?.length)
            return;
        const {work, cols, rows} = this._iconGrid();
        const saved = this._iconPositions();
        const used = new Set();
        const put = (entry, c, r) => {
            entry.cell = [c, r];
            used.add(`${c},${r}`);
            entry.actor.set_position(work.x + EDGE + c * ICON_W, work.y + EDGE + r * ICON_H);
        };
        const rest = [];
        for (const entry of this._icons) {
            const [c, r] = saved[entry.key] ?? [];
            if (Number.isInteger(c) && Number.isInteger(r) && c < cols && r < rows && !used.has(`${c},${r}`))
                put(entry, c, r);
            else
                rest.push(entry);
        }
        let next = 0;
        for (const entry of rest) {
            while (next < cols * rows && used.has(`${Math.floor(next / rows)},${next % rows}`))
                next++;
            // A full desktop stacks the rest in the last cell.
            const n = Math.min(next, cols * rows - 1);
            put(entry, Math.floor(n / rows), n % rows);
        }
    }

    /** Drag an icon to another cell; the nearest free one if that is taken. */
    _makeIconDraggable(entry) {
        const item = entry.actor;
        item.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = event.get_coords();
            const [ox, oy] = [item.x, item.y];
            let grab = null;
            const finish = drop => {
                item.disconnect(motion);
                item.disconnect(release);
                grab?.dismiss();
                item.opacity = 255;
                if (drop)
                    this._dropIcon(entry);
            };
            const motion = item.connect('motion-event', (_i, ev) => {
                if (!(ev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                    finish(!!grab);
                    return Clutter.EVENT_PROPAGATE;
                }
                const [x, y] = ev.get_coords();
                if (!grab) {
                    if (Math.hypot(x - sx, y - sy) < DRAG_START)
                        return Clutter.EVENT_PROPAGATE;
                    grab = global.stage.grab(item);
                    this._layer.set_child_above_sibling(item, null);
                    item.opacity = 200;
                }
                item.set_position(Math.round(ox + x - sx), Math.round(oy + y - sy));
                return Clutter.EVENT_STOP;
            });
            const release = item.connect('button-release-event', () => {
                const dragged = !!grab;
                finish(dragged);
                return dragged ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _dropIcon(entry) {
        const {work, cols, rows} = this._iconGrid();
        const want = [
            Math.max(0, Math.min(cols - 1, Math.round((entry.actor.x - work.x - EDGE) / ICON_W))),
            Math.max(0, Math.min(rows - 1, Math.round((entry.actor.y - work.y - EDGE) / ICON_H))),
        ];
        const taken = new Set(this._icons.filter(e => e !== entry && e.cell).map(e => e.cell.join(',')));
        let best = entry.cell, bestDist = Infinity;
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                const d = (c - want[0]) ** 2 + (r - want[1]) ** 2;
                if (d < bestDist && !taken.has(`${c},${r}`)) {
                    best = [c, r];
                    bestDist = d;
                }
            }
        }
        entry.cell = best;
        // Every icon keeps its cell, so new files never push the others around.
        const positions = {};
        for (const e of this._icons) {
            if (e.cell)
                positions[e.key] = e.cell;
        }
        this._settings.set_string('desktop-icon-positions', JSON.stringify(positions));
        this._layoutIcons();
    }

    _newFolder() {
        if (!this._dir)
            return;
        let name = _('New Folder');
        for (let i = 2; GLib.file_test(GLib.build_filenamev([this._dir, name]), GLib.FileTest.EXISTS); i++)
            name = `${_('New Folder')} ${i}`;
        try {
            Gio.File.new_for_path(GLib.build_filenamev([this._dir, name])).make_directory(null);
        } catch (e) {
            Main.notifyError(_('Could not create a folder'), e.message);
        }
    }

    // ---- desktop right-click menu ----------------------------------------------

    _hookBackgroundMenus() {
        this._unhookBackgroundMenus();
        this._hooked = [];
        for (const mgr of Main.layoutManager._bgManagers ?? []) {
            mgr.connectObject('changed', () => this._hookBackgroundMenus(), this);
            const menu = mgr.backgroundActor?._backgroundMenu;
            if (!menu)
                continue;
            const section = new PopupMenu.PopupMenuSection();
            if (this._iconsStyle()) {
                section.addAction(_('New Folder'), () => this._newFolder());
                section.addAction(_('Arrange icons'), () => this.organize());
                section.addAction(_('Show / hide icons (Alt+O)'), () => this.toggleHidden());
            } else {
                section.addAction(_('Organize desktop'), () => this.organize());
                section.addAction(_('Show / hide collections (Alt+O)'), () => this.toggleHidden());
            }
            section.addAction(_('View options'), () => this._ext.openPreferences());
            // GNOME hides a separator that ends a section, so it goes in the menu.
            const separator = new PopupMenu.PopupSeparatorMenuItem();
            menu.addMenuItem(section, 0);
            menu.addMenuItem(separator, 1);
            this._hooked.push({mgr, section, separator});
        }
    }

    _unhookBackgroundMenus() {
        for (const {mgr, section, separator} of this._hooked ?? []) {
            mgr.disconnectObject(this);
            section.destroy();
            separator.destroy();
        }
        this._hooked = [];
        for (const mgr of Main.layoutManager._bgManagers ?? [])
            mgr.disconnectObject(this);
    }

    /** One click: re-sort everything into the default columns. */
    organize() {
        this._settings.set_string('deepin-organizer-geometry', '{}');
        this._settings.set_string('desktop-icon-positions', '{}');
        this._settings.set_boolean('deepin-organizer-hidden', false);
        this._layer.show();
        this._syncDesktopIcons();
        this._scan().catch(e => console.error('Fusion Desk: desktop scan failed', e));
    }

    toggleHidden() {
        const hidden = !this._settings.get_boolean('deepin-organizer-hidden');
        this._settings.set_boolean('deepin-organizer-hidden', hidden);
        this._layer.visible = !hidden;
        this._syncDesktopIcons();
    }

    destroy() {
        this._cancel.cancel();
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._keys.destroy();
        if (this._dingId)
            GLib.source_remove(this._dingId);
        this._dingId = 0;
        global.display.disconnectObject(this);
        for (const win of global.display.list_all_windows())
            win.disconnectObject(this);
        this._syncDesktopIcons(true);
        this._trashMonitor?.cancel();
        this._trashMonitor = null;
        this._volumes?.disconnectObject(this);
        this._volumes = null;
        this._unhookBackgroundMenus();
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        this._boxes.clear();
        this._icons = [];
        this._menus = null;
        this._layer.destroy();
        this._layer = null;
    }
}
