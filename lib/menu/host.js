// Hosts a start menu layout inside a PopupMenu: sizing, theme, positioning
// (at the button, screen centre or runner-style), type-to-search, tooltips
// and the app context popover.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {setBundledIcon} from './appHub.js';
import {LAYOUTS} from './layouts.js';
import {MenuModel, launchUri} from './model.js';
import {MenuTheme} from './theme.js';

const TOOLTIP_DELAY = 450;

// Settings that need the layout rebuilt (others are read when the menu opens).
const REBUILD_KEYS = /^menu-(gap|layout|width|height|font-size|tile-icon-size|list-icon-size|pinned-columns|show-|search-position|hover-categories|power-options)/;
const THEME_KEYS = /^menu-(theme|bg-color|fg-color|accent-color|hover-color|border-color|border-width|radius)$/;

export class MenuHost {
    /**
     * @param {object} ext the extension
     * @param {PopupMenu} menu the menu to fill
     * @param {object} [opts]
     * @param {string} [opts.layout] force a layout (e.g. 'runner' for the runner hotkey)
     */
    constructor(ext, menu, {layout = null} = {}) {
        this.ext = ext;
        this.settings = ext.settings;
        this.menu = menu;
        this._forced = layout;
        this.model = new MenuModel(ext);
        setBundledIcon(GLib.build_filenamev([ext.path, 'icons', 'app-hub.png']));

        menu.actor.add_style_class_name('fusion-start-menu');
        this._root = new St.Widget({style_class: 'fusion-sm-root', layout_manager: new Clutter.BinLayout()});
        menu.box.add_child(this._root);

        // Overlay for the context popover and tooltips (inside the menu so it
        // receives events while the menu holds the grab).
        this._overlay = new St.Widget({reactive: true, visible: false, x_expand: true, y_expand: true});
        this._overlay.connect('button-press-event', (_a, event) => {
            if (event.get_source() === this._overlay) {
                this._hidePopover();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._tooltip = new St.Label({style_class: 'fusion-sm-tooltip', visible: false});

        this._theme = new MenuTheme(this.settings);
        this._build();

        this.settings.connectObject('changed', (_s, key) => {
            if (THEME_KEYS.test(key)) {
                this._theme.apply();
                this._syncThemeClass();
            } else if (REBUILD_KEYS.test(key)) {
                this._dirty = true;
                if (!this.menu.isOpen)
                    this._rebuildIfDirty();
            }
        }, this);
        this._unwatchPins = this.model.onPinnedChanged(() => {
            if (this.menu.isOpen && !this._popover)
                this._layout.reset();
        });

        menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._onOpen();
            else
                this._onClose();
        }, this);
        menu.actor.connectObject('key-press-event', (_a, event) => this._onKeyPress(event), this);
    }

    get layoutId() {
        const id = this._forced ?? this.settings.get_string('menu-layout');
        return LAYOUTS[id] ? id : 'eleven';
    }

    get tileSize() {
        return this.settings.get_int('menu-tile-icon-size');
    }

    get listSize() {
        return this.settings.get_int('menu-list-icon-size');
    }

    _syncThemeClass() {
        if (this._theme.active)
            this.menu.actor.add_style_class_name('fusion-themed');
        else
            this.menu.actor.remove_style_class_name('fusion-themed');
    }

    _build() {
        this._hidePopover();
        this._layout?.destroy();
        this._root.remove_all_children();
        this._dirty = false;

        const Layout = LAYOUTS[this.layoutId];
        this._layout = new Layout(this);
        const [defW, defH] = Layout.size;
        const w = this.settings.get_int('menu-width') || defW;
        const h = this.settings.get_int('menu-height') || defH;
        const font = this.settings.get_int('menu-font-size');
        const style = [`width: ${w}px;`];
        if (defH)
            style.push(`height: ${h}px;`);
        if (font)
            style.push(`font-size: ${font}pt;`);
        this._layout.actor.set_style(style.join(' '));

        this._root.add_child(this._layout.actor);
        this._overlay.remove_all_children();
        this._root.add_child(this._overlay);
        this._root.add_child(this._tooltip);
        for (const id of Object.keys(LAYOUTS))
            this.menu.actor.remove_style_class_name(`fusion-sm-menu-${id}`);
        this.menu.actor.add_style_class_name(`fusion-sm-menu-${this.layoutId}`);
        this._syncThemeClass();
    }

    _rebuildIfDirty() {
        if (this._dirty)
            this._build();
    }

    // ---- Open / close -------------------------------------------------------

    _onOpen() {
        if (Main.overview.visible)
            Main.overview.hide();
        // Space between the menu and the screen edge / panel (-1 = theme default).
        // Appended on every open: PanelMenu replaces the style with max-height first.
        const gap = this.settings.get_int('menu-gap');
        if (gap >= 0) {
            // The theme also gives panel menus a bottom margin; drop it, and line the
            // menu up with the button's edge instead of its centre.
            const base = (this.menu.actor.get_style() ?? '').replace(/-arrow-rise:[^;]*;|-boxpointer-gap:[^;]*;|margin:[^;]*;/g, '');
            this.menu.actor.set_style(`${base} -arrow-rise: ${gap}px; -boxpointer-gap: ${gap}px; margin: 0px;`);
            this.menu._boxPointer.setSourceAlignment(0);
        }
        // Flush menu: square the corner that touches the screen corner.
        const flush = gap === 0 && this.layoutId !== 'runner' && this.settings.get_string('menu-position') === 'BUTTON';
        for (const c of ['fusion-sm-flush', 'fusion-sm-flush-top', 'fusion-sm-flush-bottom'])
            this.menu.actor.remove_style_class_name(c);
        if (flush) {
            this.menu.actor.add_style_class_name('fusion-sm-flush');
            this.menu.actor.add_style_class_name(this.ext.panelAtBottom ? 'fusion-sm-flush-bottom' : 'fusion-sm-flush-top');
        }
        this._position();
        this._layout.onOpen();
        if (this._focusId)
            GLib.source_remove(this._focusId);
        this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusId = 0;
            if (this.menu.isOpen)
                this._layout?.search?.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onClose() {
        this._hidePopover();
        this._hideTooltip();
        // Apply setting changes made while the menu was open.
        if (this._closeId)
            GLib.source_remove(this._closeId);
        this._closeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._closeId = 0;
            if (!this.menu.isOpen)
                this._rebuildIfDirty();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Centre / runner placement: point the box pointer at a hidden anchor. */
    _position() {
        const runner = this.layoutId === 'runner';
        const mode = runner ? 'RUNNER' : this.settings.get_string('menu-position');
        if (mode === 'BUTTON')
            return;
        const source = this.menu.sourceActor;
        const lm = Main.layoutManager;
        const monitor = (source && lm.findMonitorForActor(source)) ?? lm.primaryMonitor;
        if (!monitor)
            return;
        if (!this._anchor) {
            this._anchor = new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
            Main.uiGroup.add_child(this._anchor);
        }
        const [, natH] = this.menu.actor.get_preferred_height(-1);
        const y = mode === 'RUNNER'
            ? monitor.y + Math.round(monitor.height * 0.14)
            : monitor.y + Math.max(0, Math.round((monitor.height - natH) / 2));
        this._anchor.set_position(monitor.x + Math.round(monitor.width / 2), y);
        this.menu._boxPointer.setPosition(this._anchor, 0.5);
    }

    // ---- Actions used by layouts ---------------------------------------------

    close() {
        this.menu.close();
    }

    launch(app, newWindow = false) {
        this.close();
        if (newWindow && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    openUri(uri) {
        this.close();
        launchUri(uri);
    }

    openUriNow(uri) {
        launchUri(uri);
    }

    // ---- Type to search -----------------------------------------------------------

    _onKeyPress(event) {
        const search = this._layout?.search;
        if (!search || this._popover)
            return Clutter.EVENT_PROPAGATE;
        const state = event.get_state();
        if (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const ch = String.fromCodePoint(event.get_key_unicode() || 0);
        const focus = global.stage.get_key_focus();
        if (!event.get_key_unicode() || !/\S/.test(ch) || focus === search.clutter_text || focus instanceof Clutter.Text)
            return Clutter.EVENT_PROPAGATE;
        search.grab_key_focus();
        search.text += ch;
        search.clutter_text.set_cursor_position(-1);
        return Clutter.EVENT_STOP;
    }

    // ---- Tooltips -----------------------------------------------------------------

    addTooltip(actor, text) {
        if (!this.settings.get_boolean('menu-tooltips'))
            return;
        actor.connect('notify::hover', () => {
            if (this._tipId) {
                GLib.source_remove(this._tipId);
                this._tipId = 0;
            }
            if (!actor.hover) {
                this._hideTooltip();
                return;
            }
            this._tipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY, () => {
                this._tipId = 0;
                if (!actor.hover || !actor.mapped)
                    return GLib.SOURCE_REMOVE;
                this._tooltip.text = text;
                this._tooltip.show();
                const [ax, ay] = actor.get_transformed_position();
                const [aw] = actor.get_transformed_size();
                const [rx, ry] = this._root.get_transformed_position();
                const [, tw] = this._tooltip.get_preferred_width(-1);
                const [, th] = this._tooltip.get_preferred_height(tw);
                const x = Math.max(0, Math.min(ax - rx + aw / 2 - tw / 2, this._root.width - tw));
                const y = ay - ry - th - 6 >= 0 ? ay - ry - th - 6 : ay - ry + actor.height + 6;
                this._tooltip.set_position(Math.round(x), Math.round(y));
                return GLib.SOURCE_REMOVE;
            });
        });
        actor.connect('destroy', () => {
            if (this._tipId) {
                GLib.source_remove(this._tipId);
                this._tipId = 0;
            }
            this._hideTooltip();
        });
    }

    _hideTooltip() {
        this._tooltip?.hide();
    }

    // ---- App context popover ---------------------------------------------------

    showAppMenu(button, app) {
        this._hidePopover();
        this._hideTooltip();
        const m = this.model;
        const items = [];
        if (app.can_open_new_window())
            items.push(['window-new-symbolic', 'New window', () => this.launch(app, true)]);
        items.push(['view-pin-symbolic',
            m.isPinned(app) ? 'Unpin from Start' : 'Pin to Start', () => m.togglePin(app), true]);
        if (m.ownPinned && m.isPinned(app)) {
            items.push(['go-previous-symbolic', 'Move earlier', () => m.movePin(app, -1), true]);
            items.push(['go-next-symbolic', 'Move later', () => m.movePin(app, 1), true]);
        }
        if (m.ownPinned) {
            items.push(['view-app-grid-symbolic', m.isTaskbarPinned(app) ? 'Unpin from taskbar' : 'Pin to taskbar',
                () => m.toggleTaskbarPin(app), true]);
        }
        const software = m.lookup('org.gnome.Software.desktop');
        if (software) {
            items.push(['dialog-information-symbolic', 'App details', () => {
                this.close();
                m.runArgv(['gnome-software', `--details=${app.get_id()}`]);
            }]);
        }
        this.showActions(button, app.get_name(), items);
    }

    /**
     * Labelled action list next to `button` (inside the menu, so it gets input
     * while the menu holds the grab). items: [icon, text, action, stayOpen].
     */
    showActions(button, title, items, {style = '', iconSize = 16} = {}) {
        this._hidePopover();
        this._hideTooltip();
        const pop = this._popover = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: `fusion-sm-popover ${style}`, reactive: true});
        if (title)
            pop.add_child(new St.Label({text: title, style_class: 'fusion-sm-pop-title'}));
        for (const [icon, text, action, stay] of items) {
            const b = new St.Button({style_class: 'fusion-sm-pop-item', can_focus: true, track_hover: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'fusion-sm-pop-box', x_expand: true, x_align: Clutter.ActorAlign.START});
            box.add_child(new St.Icon({icon_name: icon, icon_size: iconSize}));
            box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            b.set_child(box);
            b.connect('clicked', () => {
                this._hidePopover();
                action();
                if (stay && this.menu.isOpen)
                    this._layout.reset();
            });
            pop.add_child(b);
        }
        pop.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._hidePopover();
                button.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlay.add_child(pop);
        this._overlay.show();
        const [bx, by] = button.get_transformed_position();
        const [bw, bh] = button.get_transformed_size();
        const [rx, ry] = this._root.get_transformed_position();
        const [, pw] = pop.get_preferred_width(-1);
        const [, ph] = pop.get_preferred_height(pw);
        let x = bx - rx + bw / 2 - pw / 2;
        let y = by - ry + bh - 4;
        x = Math.max(4, Math.min(x, this._root.width - pw - 4));
        if (y + ph > this._root.height - 4)
            y = Math.max(4, by - ry - ph + 4);
        pop.set_position(Math.round(x), Math.round(y));
        pop.get_child_at_index(title ? 1 : 0)?.grab_key_focus();
    }

    _hidePopover() {
        if (!this._popover)
            return;
        this._popover.destroy();
        this._popover = null;
        this._overlay.hide();
    }

    destroy() {
        this.settings.disconnectObject(this);
        this.menu.disconnectObject(this);
        this.menu.actor.disconnectObject(this);
        this._unwatchPins?.();
        if (this._tipId)
            GLib.source_remove(this._tipId);
        if (this._focusId)
            GLib.source_remove(this._focusId);
        if (this._closeId)
            GLib.source_remove(this._closeId);
        this._tipId = this._focusId = this._closeId = 0;
        this._hidePopover();
        this._layout?.destroy();
        this._layout = null;
        this._root.destroy();
        this._root = null;
        this._anchor?.destroy();
        this._theme.destroy();
        this.model.destroy();
    }
}
