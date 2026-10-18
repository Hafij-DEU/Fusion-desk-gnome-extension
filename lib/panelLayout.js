// Panel position, size, styling and element arrangement.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {parseLayout} from './layoutModel.js';
import {fillToolsMenu} from './toolsMenu.js';
import {PanelRow} from './panelRow.js';
import {accentFill, glassEdge, glassLevel, keepBlurClean, panelIsLight, panelRgb} from './style.js';

export class PanelLayout {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        const lm = Main.layoutManager;
        const status = Main.panel.statusArea;

        this._builtins = {
            activities: status.activities?.container ?? null,
            quick: status.quickSettings?.container ?? null,
            date: status.dateMenu?.container ?? null,
        };

        lm.panelBox.add_style_class_name('fusion-panel-box');

        // Swap GNOME's Panel actor for our row, keeping its three boxes (and
        // therefore every indicator other extensions add to them).
        this.row = new PanelRow({name: 'panel', style_class: 'fusion-panel'});
        this._panelIndex = lm.panelBox.get_children().indexOf(Main.panel);
        lm.panelBox.remove_child(Main.panel);
        this.row.setBoxes(Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox);
        lm.panelBox.insert_child_at_index(this.row, Math.max(0, this._panelIndex));
        // Right-click on empty panel space: panel menu (like Dash to Panel).
        this.row.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            const src = global.stage.get_event_actor(event);
            const empty = src === this.row ||
                [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].includes(src) ||
                src?.has_style_class_name?.('fusion-taskbar');
            if (!empty)
                return Clutter.EVENT_PROPAGATE;
            this._openPanelMenu(event.get_coords()[0]);
            return Clutter.EVENT_STOP;
        });
        Main.overview.connectObject(
            'showing', () => this.row.add_style_pseudo_class('overview'),
            'hiding', () => this.row.remove_style_pseudo_class('overview'), this);

        // Keep the right-edge pointer barrier next to the panel wherever it is.
        this._origUpdateBarrier = lm._updatePanelBarrier;
        const self = this;
        lm._updatePanelBarrier = function () {
            this._destroyPanelBarrier();
            const p = this.primaryMonitor;
            const h = this.panelBox.height;
            if (!p || !h)
                return;
            const y1 = self._ext.panelAtBottom ? p.y + p.height - h : p.y;
            this._rightPanelBarrier = new Meta.Barrier({
                backend: global.backend,
                x1: p.x + p.width, y1,
                x2: p.x + p.width, y2: y1 + h,
                directions: Meta.BarrierDirection.NEGATIVE_X,
            });
        };

        lm.connectObject('monitors-changed', () => this._reposition(), this);
        // GNOME re-adds its own items to default boxes on session-mode changes
        // (startup, unlock). Re-apply our arrangement afterwards.
        Main.sessionMode.connectObject('updated', () => this._queueArrange(), this);
        this._builtins.activities?.connectObject('notify::visible', () => {
            const want = this._settings.get_boolean('activities-visible');
            if (this._builtins.activities.visible !== want)
                this._builtins.activities.visible = want;
        }, this);
        lm.panelBox.connectObject('notify::height', () => this._reposition(), this);
        this.apply();
    }

    apply() {
        const s = this._settings;
        const lm = Main.layoutManager;

        this.row.set_height(s.get_int('panel-height'));
        this.setBackground(s.get_int('panel-opacity') / 100);

        if (this._builtins.activities)
            this._builtins.activities.visible = s.get_boolean('activities-visible');

        const dash = Main.overview.dash;
        if (dash) {
            if (s.get_boolean('hide-overview-dash')) {
                dash.hide();
                dash.set_height(0);
            } else {
                dash.set_height(-1);
                dash.show();
            }
        }

        this.row.remove_style_class_name('fusion-panel-top');
        this.row.remove_style_class_name('fusion-panel-bottom');
        this.row.add_style_class_name(this._ext.panelAtBottom ? 'fusion-panel-bottom' : 'fusion-panel-top');
        // "Pills": tray, clock and monitor sit in rounded groups with space between.
        if (s.get_string('panel-style') === 'PILLS')
            this.row.add_style_class_name('fusion-pills');
        else
            this.row.remove_style_class_name('fusion-pills');
        Main.panel.statusArea.quickSettings?.add_style_class_name('fusion-tray');
        this._applyWindowsLook();
        this._reposition();
    }

    /** "Floating taskbar": rounded bar with a gap from the screen edges. */
    get floating() {
        return this._ext.deepinFeature('floating');
    }

    /**
     * Taskbar background at `alpha` (also used by dynamic opacity). A floating
     * taskbar paints it on the rounded row and leaves the strip around it clear.
     */
    setBackground(alpha, extra = '') {
        const lm = Main.layoutManager;
        const a = alpha.toFixed(2);
        const rgb = panelRgb(this._settings);
        const setStyle = (actor, style) => {
            if (actor.style !== style)
                actor.set_style(style);
        };
        if (!this.floating) {
            setStyle(lm.panelBox, `${accentFill(this._settings, `rgba(${rgb}, ${a})`)} ${extra}`);
            const edge = glassEdge(glassLevel(this._settings), panelIsLight(this._settings));
            setStyle(this.row, edge || null);
            return;
        }
        setStyle(lm.panelBox, `background-color: transparent; ${extra}`);
        const h = this._settings.get_int('panel-height');
        const margin = this._ext.panelAtBottom ? '4px 10px 8px 10px' : '8px 10px 4px 10px';
        const light = panelIsLight(this._settings);
        const fill = `${accentFill(this._settings, `rgba(${rgb}, ${a})`)} ${glassEdge(glassLevel(this._settings), light)}`;
        setStyle(this.row, `${fill} margin: ${margin}; border-radius: ${Math.round(h * 0.32)}px; ${extra}`);
    }

    /**
     * Glass on GNOME's Quick Settings and calendar menus: their own theme
     * colour, made translucent with a lighter top and blur behind.
     */
    _glassMenus(level) {
        const status = Main.panel.statusArea;
        const boxes = [status.quickSettings?.menu?.box, status.dateMenu?.menu?.box].filter(Boolean);
        for (const box of boxes) {
            box.set_style(null);
            box.remove_effect_by_name('fusion-glass-blur');
            if (!level || !box.get_stage())
                continue;
            // The theme's own colour, read from a twin without our inline style.
            const parent = box.get_parent();
            if (!parent)
                continue;
            const probe = new St.Widget({style_class: box.get_style_class_name(), visible: false});
            parent.add_child(probe);
            const c = probe.get_theme_node().get_background_color();
            probe.destroy();
            const scale = Math.max(c.red, c.green, c.blue) > 1 ? 1 : 255;
            const alpha = level === 2 ? 0.80 : 0.90;
            const base = `rgba(${Math.round(c.red * scale)}, ${Math.round(c.green * scale)}, ${Math.round(c.blue * scale)}, ${alpha})`;
            const light = (c.red * scale + c.green * scale + c.blue * scale) / 3 > 140;
            box.set_style(`${accentFill(this._settings, base, 14, level)} ${glassEdge(level, light)}`);
            box.add_effect_with_name('fusion-glass-blur', new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 34, brightness: 1.0}));
            keepBlurClean(box);
        }
        this._glassedMenus = boxes;
    }

    /** Taskbar theming (light / dark, glass, extras) and blur behind it. */
    _applyWindowsLook() {
        const s = this._settings;
        for (const c of ['fusion-windows', 'fusion-deepin-look', 'fusion-deepin-gloss', 'fusion-floating', 'fusion-panel-light'])
            this.row.remove_style_class_name(c);
        if (panelIsLight(s))
            this.row.add_style_class_name('fusion-panel-light');
        if (s.get_boolean('icons-follow-accent'))
            this.row.add_style_class_name('fusion-accent-icons');
        else
            this.row.remove_style_class_name('fusion-accent-icons');
        if (this.floating)
            this.row.add_style_class_name('fusion-floating');
        // Rounded hover tiles with the search / Task View buttons; softer
        // rounded hovers and accent running dots with the glass effect.
        if (this._ext.windowsExtras)
            this.row.add_style_class_name('fusion-windows');
        const glass = glassLevel(s);
        if (glass)
            this.row.add_style_class_name('fusion-deepin-look');
        const blur = (this._ext.windowsExtras && s.get_boolean('windows-blur')) || glass > 0;
        this._glassMenus(glass);
        // Glass on popups and menus everywhere: a bright top edge and rim.
        Main.uiGroup.remove_style_class_name('fusion-glass-ui');
        Main.uiGroup.remove_style_class_name('fusion-glass-ui-strong');
        if (glass)
            Main.uiGroup.add_style_class_name(glass === 2 ? 'fusion-glass-ui-strong' : 'fusion-glass-ui');
        // Blur only behind the visible bar: the row when floating, else the whole strip.
        const target = this.floating ? this.row : Main.layoutManager.panelBox;
        const other = target === this.row ? Main.layoutManager.panelBox : this.row;
        other.remove_effect_by_name('fusion-windows-blur');
        if (blur && !target.get_effect('fusion-windows-blur')) {
            target.add_effect_with_name('fusion-windows-blur', new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 30, brightness: 0.9}));
            keepBlurClean(target);
        }
        else if (!blur)
            target.remove_effect_by_name('fusion-windows-blur');
    }

    _openPanelMenu(x) {
        if (!this._panelMenu) {
            this._menuAnchor = new St.Widget({width: 1, height: 1, opacity: 0});
            Main.uiGroup.add_child(this._menuAnchor);
            const side = this._ext.panelAtBottom ? St.Side.BOTTOM : St.Side.TOP;
            const menu = this._panelMenu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, side);
            this._toolsSection = new PopupMenu.PopupMenuSection();
            menu.addMenuItem(this._toolsSection);
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            Main.panel.menuManager.addMenu(menu);
        }
        const [, y] = this.row.get_transformed_position();
        const h = this.row.height;
        this._menuAnchor.set_position(Math.round(x), Math.round(this._ext.panelAtBottom ? y : y + h - 1));
        // Open after the anchor has been allocated at its new position.
        if (this._menuIdleId)
            GLib.source_remove(this._menuIdleId);
        this._menuIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._menuIdleId = 0;
            if (this._panelMenu && !this._panelMenu.isOpen)
                fillToolsMenu(this._toolsSection, this._ext, this._panelMenu);
            this._panelMenu?.toggle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        const lm = Main.layoutManager;
        const m = lm.primaryMonitor;
        if (!m)
            return;
        const y = this._ext.panelAtBottom ? m.y + m.height - lm.panelBox.height : m.y;
        lm.panelBox.set_position(m.x, y);
        lm._updatePanelBarrier();
        lm._queueUpdateRegions?.();
    }

    _queueArrange() {
        if (this._arrangeId)
            return;
        this._arrangeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._arrangeId = 0;
            if (this._lastActors)
                this.arrange(this._lastActors);
            this.apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Place every element actor into its box in configured order. */
    arrange(moduleActors) {
        this._lastActors = moduleActors;
        const actors = {...moduleActors};
        for (const [id, actor] of Object.entries(this._builtins)) {
            if (actor)
                actors[id] = actor;
        }

        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };

        // The user's layout, plus the current desktop mode's extra buttons
        // right after the start menu and before the system menu.
        const extra = this._ext.extraElements();
        const layout = [];
        for (const entry of parseLayout(this._settings.get_strv('layout'))) {
            if (entry.id === 'quick')
                extra.beforeQuick.forEach(id => layout.push({id, box: entry.box}));
            layout.push(entry);
            if (entry.id === 'menu')
                extra.afterMenu.forEach(id => layout.push({id, box: entry.box}));
            if (entry.id === 'quick')
                (extra.afterQuick ?? []).forEach(id => layout.push({id, box: entry.box}));
        }
        for (const {id} of layout)
            actors[id]?.get_parent()?.remove_child(actors[id]);

        let left = 0, center = 0;
        for (const {id, box} of layout) {
            const actor = actors[id];
            if (!actor)
                continue;
            if (box === 'left')
                boxes.left.insert_child_at_index(actor, left++);
            else if (box === 'center')
                boxes.center.insert_child_at_index(actor, center++);
            else
                boxes.right.add_child(actor);
        }
    }

    destroy() {
        const lm = Main.layoutManager;
        lm.disconnectObject(this);
        lm.panelBox.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._builtins.activities?.disconnectObject(this);
        if (this._arrangeId)
            GLib.source_remove(this._arrangeId);

        // Put the built-in items back where GNOME keeps them.
        const {activities, quick, date} = this._builtins;
        for (const actor of [activities, quick, date])
            actor?.get_parent()?.remove_child(actor);
        if (activities) {
            Main.panel._leftBox.insert_child_at_index(activities, 0);
            activities.visible = true;
        }
        if (date)
            Main.panel._centerBox.insert_child_at_index(date, 0);
        if (quick)
            Main.panel._rightBox.add_child(quick);

        const dash = Main.overview.dash;
        if (dash) {
            dash.set_height(-1);
            dash.show();
        }

        if (this._menuIdleId)
            GLib.source_remove(this._menuIdleId);
        this._panelMenu?.destroy();
        this._menuAnchor?.destroy();
        // Give the boxes back to GNOME's Panel in their original order.
        Main.overview.disconnectObject(this);
        const boxes = this.row.releaseBoxes();
        boxes.forEach(b => Main.panel.add_child(b));
        lm.panelBox.remove_child(this.row);
        this.row.destroy();
        this.row = null;
        lm.panelBox.insert_child_at_index(Main.panel, Math.max(0, this._panelIndex));
        Main.panel.queue_relayout();
        lm.panelBox.remove_style_class_name('fusion-panel-box');
        lm.panelBox.remove_effect_by_name('fusion-windows-blur');
        for (const box of this._glassedMenus ?? []) {
            box.set_style(null);
            box.remove_effect_by_name('fusion-glass-blur');
        }
        this._glassedMenus = null;
        Main.uiGroup.remove_style_class_name('fusion-glass-ui');
        Main.uiGroup.remove_style_class_name('fusion-glass-ui-strong');
        lm.panelBox.set_style(null);
        Main.panel.statusArea.quickSettings?.remove_style_class_name('fusion-tray');

        lm._updatePanelBarrier = this._origUpdateBarrier;
        lm._updateBoxes();
        lm._updatePanelBarrier();
        lm._queueUpdateRegions?.();
    }
}
