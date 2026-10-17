// Panel position, size, styling and element arrangement.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {parseLayout} from './layoutModel.js';
import {PanelRow} from './panelRow.js';

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
        const alpha = s.get_int('panel-opacity') / 100;
        lm.panelBox.set_style(`background-color: rgba(22, 22, 26, ${alpha.toFixed(2)});`);

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
        this._reposition();
    }

    _openPanelMenu(x) {
        if (!this._panelMenu) {
            this._menuAnchor = new St.Widget({width: 1, height: 1, opacity: 0});
            Main.uiGroup.add_child(this._menuAnchor);
            const side = this._ext.panelAtBottom ? St.Side.BOTTOM : St.Side.TOP;
            const menu = this._panelMenu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, side);
            const appSys = Shell.AppSystem.get_default();
            const addApp = (label, ids) => {
                const app = ids.map(id => appSys.lookup_app(id)).find(Boolean);
                if (app)
                    menu.addAction(label, () => app.activate());
            };
            menu.addAction('Fusion Desk Settings', () => this._ext.openPreferences());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            addApp('Terminal', ['org.gnome.Ptyxis.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Console.desktop']);
            addApp('System Monitor', ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'io.missioncenter.MissionCenter.desktop']);
            addApp('Files', ['org.gnome.Nautilus.desktop']);
            addApp('Extensions', ['org.gnome.Extensions.desktop', 'com.mattjakeman.ExtensionManager.desktop']);
            addApp('Settings', ['org.gnome.Settings.desktop']);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Activities Overview', () => Main.overview.toggle());
            menu.addAction('Show Desktop', () => {
                const ws = global.workspace_manager.get_active_workspace();
                ws.list_windows().filter(w => !w.skip_taskbar && w.can_minimize()).forEach(w => w.minimize());
            });
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

        const layout = parseLayout(this._settings.get_strv('layout'));
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
        lm.panelBox.set_style(null);

        lm._updatePanelBarrier = this._origUpdateBarrier;
        lm._updateBoxes();
        lm._updatePanelBarrier();
        lm._queueUpdateRegions?.();
    }
}
