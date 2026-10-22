// Building blocks shared by the start menu layouts. `ctx` is the MenuHost:
// it owns the model, closes the menu and opens the app context popover.
import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';

const ALL_BUTTONS = St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE;

export function vbox(style = '', params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: style, ...params});
}

export function hbox(style = '', params = {}) {
    return new St.BoxLayout({style_class: style, ...params});
}

export function scrollView(child, style = 'fusion-sm-scroll', params = {}) {
    const scroll = new St.ScrollView({
        style_class: style,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        y_expand: true,
        ...params,
    });
    scroll.set_child(child);
    return scroll;
}

export function label(text, style, params = {}) {
    const l = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

/** Section title with an optional pill button on the right ("All apps ›"). */
export function heading(text, action = null) {
    const row = hbox('fusion-sm-heading-row', {x_expand: true});
    row.add_child(label(text, 'fusion-sm-heading', {x_expand: true}));
    if (action) {
        const b = new St.Button({style_class: 'fusion-sm-pill', can_focus: true, track_hover: true, label: action.label});
        b.connect('clicked', () => action.cb());
        row.add_child(b);
    }
    return row;
}

function bindApp(ctx, button, app) {
    button.app = app;
    button.connect('clicked', (_b, mouse) => {
        if (mouse === Clutter.BUTTON_SECONDARY)
            ctx.showAppMenu(button, app);
        else
            ctx.launch(app, mouse === Clutter.BUTTON_MIDDLE);
    });
    button.connect('popup-menu', () => ctx.showAppMenu(button, app));
}

export function appTile(ctx, app, {size = ctx.tileSize, labels = true, style = 'fusion-sm-tile', wrap = false} = {}) {
    const button = new St.Button({style_class: style, can_focus: true, track_hover: true, button_mask: ALL_BUTTONS,
        accessible_name: app.get_name(), y_align: Clutter.ActorAlign.FILL});
    // Fills the tile from the top (spacer below): icons line up across a row
    // even when names wrap onto more lines (St.Button centres a smaller child).
    const box = vbox('fusion-sm-tile-box', {y_align: Clutter.ActorAlign.FILL, y_expand: true});
    const icon = app.create_icon_texture(size);
    icon.x_align = Clutter.ActorAlign.CENTER;
    box.add_child(icon);
    if (labels) {
        const l = label(app.get_name(), 'fusion-sm-tile-label', {x_align: Clutter.ActorAlign.CENTER});
        if (wrap) {
            // Names may wrap onto two lines.
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            l.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        }
        box.add_child(l);
    }
    box.add_child(new St.Widget({y_expand: true}));
    button.set_child(box);
    bindApp(ctx, button, app);
    return button;
}

export function appRow(ctx, app, {desc = true, note = null, size = ctx.listSize} = {}) {
    const button = new St.Button({style_class: 'fusion-sm-item', can_focus: true, track_hover: true, x_expand: true,
        button_mask: ALL_BUTTONS, accessible_name: app.get_name()});
    const box = hbox('fusion-sm-item-box', {x_expand: true});
    box.add_child(app.create_icon_texture(size));
    const text = vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    text.add_child(label(app.get_name(), 'fusion-sm-item-name'));
    const d = note ?? (desc ? app.get_description() : null);
    if (d)
        text.add_child(label(d, 'fusion-sm-item-desc'));
    box.add_child(text);
    if (ctx.model.isPinned(app)) {
        box.add_child(new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 12, style_class: 'fusion-sm-pin',
            y_align: Clutter.ActorAlign.CENTER}));
    }
    button.set_child(box);
    bindApp(ctx, button, app);
    return button;
}

/** "Just now", "12 min ago", "Today 19:52", "Yesterday", "3 Oct" from an ISO time. */
export function timeAgo(iso) {
    const when = iso ? GLib.DateTime.new_from_iso8601(iso, null)?.to_local() : null;
    if (!when)
        return '';
    const now = GLib.DateTime.new_now_local();
    const minutes = Math.floor(now.difference(when) / 60e6);
    if (minutes < 1)
        return 'Just now';
    if (minutes < 60)
        return `${minutes} min ago`;
    const day = d => d.format('%F');
    if (day(when) === day(now))
        return `Today ${when.format('%H:%M')}`;
    if (day(when) === day(now.add_days(-1)))
        return 'Yesterday';
    return when.format(when.get_year() === now.get_year() ? '%-d %b' : '%-d %b %Y');
}

/** "Screenshots", "Home" … : the folder a file sits in. */
function folderName(path) {
    const dir = GLib.path_get_dirname(path ?? '');
    return dir === GLib.get_home_dir() ? 'Home' : GLib.path_get_basename(dir);
}

/** App tile for the "Jump back in" strip, with a small reason badge. */
export function jumpTile(ctx, app, badge) {
    const button = new St.Button({style_class: 'fusion-sm-tile fusion-sm-jump-tile', can_focus: true, track_hover: true,
        button_mask: ALL_BUTTONS, accessible_name: `${app.get_name()} (${badge})`});
    const box = vbox('fusion-sm-jump-box', {x_align: Clutter.ActorAlign.CENTER});
    const icon = app.create_icon_texture(34);
    icon.x_align = Clutter.ActorAlign.CENTER;
    box.add_child(icon);
    box.add_child(label(app.get_name(), 'fusion-sm-jump-name', {x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(label(badge, `fusion-sm-badge fusion-sm-badge-${badge.toLowerCase().replace(/\W+/g, '-')}`,
        {x_align: Clutter.ActorAlign.CENTER}));
    button.set_child(box);
    bindApp(ctx, button, app);
    return button;
}

/**
 * Recent file card: picture thumbnail (or file icon) with the opening app's
 * icon as a badge, name, "Today 19:52 · Screenshots", and a folder button
 * that shows on hover.
 */
export function fileCard(ctx, file) {
    const button = new St.Button({style_class: 'fusion-sm-item fusion-sm-card', can_focus: true, track_hover: true,
        x_expand: true, accessible_name: file.name});
    const box = hbox('fusion-sm-item-box', {x_expand: true});

    const art = new St.Widget({style_class: 'fusion-sm-card-art', layout_manager: new Clutter.BinLayout()});
    if (file.thumb) {
        const uri = GLib.filename_to_uri(file.thumb, null);
        art.add_child(new St.Bin({style_class: 'fusion-sm-thumb', x_expand: true, y_expand: true,
            style: `background-image: url("${uri}");`}));
    } else {
        art.add_child(new St.Icon({gicon: file.gicon, icon_size: 32,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
    }
    const opener = file.contentType ? ctx.model.openerIcon(file.contentType) : null;
    if (opener) {
        // Corner badge: BinLayout aligns a child only inside the area it expands into.
        art.add_child(new St.Bin({style_class: 'fusion-sm-opener', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
            child: new St.Icon({gicon: opener, icon_size: 14})}));
    }
    box.add_child(art);

    const text = vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    text.add_child(label(file.name, 'fusion-sm-item-name'));
    const when = timeAgo(file.modified);
    text.add_child(label([when, folderName(file.path)].filter(Boolean).join(' · '), 'fusion-sm-item-desc'));
    box.add_child(text);

    const folder = iconButton(ctx, 'folder-open-symbolic', 'Open folder',
        () => ctx.openUri(GLib.filename_to_uri(GLib.path_get_dirname(file.path), null)),
        {style: 'fusion-sm-round fusion-sm-card-folder'});
    folder.opacity = 0;
    button.connect('notify::hover', () => folder.ease({opacity: button.hover ? 255 : 0, duration: 120}));
    box.add_child(folder);

    button.set_child(box);
    button.connect('clicked', () => ctx.openUri(file.uri));
    return button;
}

export function fileRow(ctx, file, {size = ctx.listSize, when = false} = {}) {
    const button = new St.Button({style_class: 'fusion-sm-item', can_focus: true, track_hover: true, x_expand: true,
        accessible_name: file.name});
    const box = hbox('fusion-sm-item-box', {x_expand: true});
    box.add_child(new St.Icon({gicon: file.gicon, icon_size: size}));
    const text = vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    text.add_child(label(file.name, 'fusion-sm-item-name'));
    const folder = GLib.path_get_dirname(file.path ?? '').replace(GLib.get_home_dir(), '~');
    const ago = when ? timeAgo(file.modified) : '';
    const dir = label(ago ? `${ago} · ${folder}` : folder, 'fusion-sm-item-desc');
    dir.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    text.add_child(dir);
    box.add_child(text);
    button.set_child(box);
    button.connect('clicked', () => ctx.openUri(file.uri));
    return button;
}

export function actionRow(ctx, title, iconName, subtitle, action, {gicon = null, size = ctx.listSize} = {}) {
    const button = new St.Button({style_class: 'fusion-sm-item', can_focus: true, track_hover: true, x_expand: true,
        accessible_name: title});
    const box = hbox('fusion-sm-item-box', {x_expand: true});
    const icon = new St.Icon({icon_size: size, fallback_icon_name: 'system-run-symbolic'});
    if (gicon)
        icon.gicon = gicon;
    else
        icon.icon_name = iconName;
    box.add_child(icon);
    const text = vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    text.add_child(label(title, 'fusion-sm-item-name'));
    if (subtitle)
        text.add_child(label(subtitle, 'fusion-sm-item-desc'));
    box.add_child(text);
    button.set_child(box);
    button.connect('clicked', () => {
        ctx.close();
        action();
    });
    return button;
}

/** Round icon-only button; `name` doubles as tooltip and accessible name. */
export function iconButton(ctx, iconName, name, action, {style = 'fusion-sm-round', size = 16, gicon = null, close = true} = {}) {
    const icon = new St.Icon({icon_size: size, fallback_icon_name: 'image-missing-symbolic'});
    if (gicon)
        icon.gicon = gicon;
    else
        icon.icon_name = iconName;
    const button = new St.Button({style_class: style, can_focus: true, track_hover: true, accessible_name: name, child: icon});
    button.connect('clicked', () => {
        if (close)
            ctx.close();
        action();
    });
    ctx.addTooltip(button, name);
    return button;
}

export function searchEntry(hint = 'Search apps, files, math, >command…') {
    const entry = new St.Entry({
        style_class: 'fusion-sm-search',
        hint_text: hint,
        can_focus: true,
        x_expand: true,
        primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'fusion-sm-search-icon'}),
    });
    return entry;
}

/** Avatar (+ name). Clicking opens the Users settings. */
export function userChip(ctx, {size = 32, name = true, style = 'fusion-sm-user'} = {}) {
    const user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
    const button = new St.Button({style_class: style, can_focus: true, track_hover: true, accessible_name: ctx.model.userName});
    const box = hbox('fusion-sm-user-box');
    const avatar = new Avatar(user, {iconSize: size, styleClass: 'fusion-sm-avatar'});
    avatar.update();
    user.connectObject('notify::is-loaded', () => avatar.update(), 'changed', () => avatar.update(), avatar);
    box.add_child(avatar);
    if (name)
        box.add_child(label(ctx.model.userName, 'fusion-sm-username'));
    button.set_child(box);
    button.connect('clicked', () => {
        ctx.close();
        ctx.model.lookup('org.gnome.Settings.desktop')?.activate();
    });
    return button;
}

/** Row of round power buttons for the enabled power actions. */
export function powerRow(ctx, {style = 'fusion-sm-power-row'} = {}) {
    const row = hbox(style);
    for (const a of ctx.model.powerActions())
        row.add_child(iconButton(ctx, a.icon, a.name, a.activate));
    return row;
}

export function placeRow(ctx, place, {size = 16} = {}) {
    return actionRow(ctx, place.name, place.icon, null, () => ctx.openUriNow(place.uri), {size});
}

export function shortcutRow(ctx, {name, app}, {size = 16} = {}) {
    return actionRow(ctx, name, null, null, () => app.activate(), {gicon: app.get_icon(), size});
}

export function appGrid(ctx, apps, columns, opts = {}) {
    const grid = vbox('fusion-sm-grid');
    let row = null;
    apps.forEach((app, i) => {
        if (i % columns === 0) {
            row = hbox('fusion-sm-grid-row');
            grid.add_child(row);
        }
        row.add_child(appTile(ctx, app, opts));
    });
    return grid;
}

/** All apps A–Z with a letter header before each group. */
export function alphaList(ctx, apps, opts = {}) {
    const list = vbox('fusion-sm-list');
    let letter = null;
    for (const app of apps) {
        const first = app.get_name().charAt(0).toUpperCase();
        const l = /[A-Z]/.test(first) ? first : '#';
        if (l !== letter) {
            letter = l;
            list.add_child(label(l, 'fusion-sm-letter'));
        }
        list.add_child(appRow(ctx, app, {desc: false, ...opts}));
    }
    return list;
}

export function emptyLabel(text) {
    return new St.Label({text, style_class: 'fusion-sm-empty', x_align: Clutter.ActorAlign.CENTER});
}

/** Fill `box` with search results for `query`. */
export function renderSearch(ctx, box, query) {
    box.destroy_all_children();
    const r = ctx.model.search(query);
    if (r.calc !== null) {
        box.add_child(actionRow(ctx, `= ${r.calc}`, 'accessories-calculator-symbolic', 'Copy result', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, r.calc);
        }));
    }
    if (r.command)
        box.add_child(actionRow(ctx, `Run: ${r.command}`, 'utilities-terminal-symbolic', 'Run command', () => ctx.model.runCommand(r.command)));
    if (r.apps.length) {
        box.add_child(heading('Apps'));
        r.apps.forEach(app => box.add_child(appRow(ctx, app)));
    }
    if (r.files.length) {
        box.add_child(heading('Files'));
        r.files.forEach(f => box.add_child(fileRow(ctx, f)));
    }
    if (r.web)
        box.add_child(actionRow(ctx, `Search the web for “${query}”`, 'web-browser-symbolic', null, () => ctx.openUriNow(r.web)));
    if (!box.get_n_children())
        box.add_child(emptyLabel(`No results for “${query}”`));
}

export function firstButton(container) {
    for (const child of container.get_children()) {
        if (!child.visible)
            continue;
        if (child instanceof St.Button)
            return child;
        if (child instanceof St.BoxLayout || child instanceof St.ScrollView || child instanceof St.Widget) {
            const inner = firstButton(child);
            if (inner)
                return inner;
        }
    }
    return null;
}
