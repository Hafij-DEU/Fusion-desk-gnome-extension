// Deepin mode: replaces Fusion's panel with a Deepin-style dock, launcher and
// control centre. Built and torn down as a whole by extension.js when the
// desktop-mode setting changes, so switching needs no logout.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SuperKeyBinding} from '../startMenu.js';
import {Dock} from './dock.js';
import {Launcher} from './launcher.js';
import {ControlCenter} from './controlCenter.js';

// Settings that rebuild one part; theme keys rebuild everything.
const DOCK_KEYS = ['deepin-dock-'];
const THEME_KEYS = ['deepin-theme', 'deepin-blur', 'deepin-opacity'];

export class DeepinMode {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext.settings;
        const lm = Main.layoutManager;

        // No top bar: GNOME's status area and date menu move into the dock.
        this._panelIndex = lm.panelBox.get_children().indexOf(Main.panel);
        if (this._panelIndex >= 0)
            lm.panelBox.remove_child(Main.panel);
        lm.panelBox.add_style_class_name('fusion-deepin-panel-box');

        // The dock replaces the overview dash.
        this._dash = Main.overview.dash;
        if (this._dash) {
            this._dash.hide();
            this._dash.set_height(0);
        }

        this._build();

        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._iface.connectObject('changed::color-scheme', () => {
            if (this._settings.get_string('deepin-theme') === 'AUTO')
                this._queueRebuild('all');
        }, this);

        const startup = () => {
            if (this._settings.get_boolean('deepin-super-key'))
                this._super = new SuperKeyBinding(() => this.launcher?.toggle());
        };
        if (lm._startingUp)
            lm.connectObject('startup-complete', startup, this);
        else
            startup();
    }

    _build(part = 'all') {
        if (part === 'all' || part === 'dock') {
            try {
                this.dock = new Dock(this);
            } catch (e) {
                console.error('Fusion Desk: Deepin dock failed', e);
            }
        }
        if (part === 'all') {
            this.launcher = new Launcher(this);
            this.controlCenter = new ControlCenter(this);
        }
    }

    _destroyParts(part = 'all') {
        if (part === 'all') {
            this.controlCenter?.destroy();
            this.launcher?.destroy();
            this.controlCenter = this.launcher = null;
        }
        try {
            this.dock?.destroy();
        } catch (e) {
            console.error('Fusion Desk: Deepin dock teardown failed', e);
        }
        this.dock = null;
    }

    /** Called by extension.js for every changed setting while in Deepin mode. */
    onSettingChanged(key) {
        const matches = prefix => key === prefix || (prefix.endsWith('-') && key.startsWith(prefix));
        if (THEME_KEYS.some(matches))
            this._queueRebuild('all');
        else if (DOCK_KEYS.some(matches))
            this._queueRebuild('dock');
        else if (key === 'deepin-super-key')
            this._queueRebuild('super');
    }

    _queueRebuild(part) {
        const order = {super: 0, dock: 1, all: 2};
        if (!this._pendingPart || order[part] > order[this._pendingPart])
            this._pendingPart = part;
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            const p = this._pendingPart;
            this._pendingPart = null;
            if (p === 'super') {
                this._super?.destroy();
                this._super = this._settings.get_boolean('deepin-super-key')
                    ? new SuperKeyBinding(() => this.launcher?.toggle()) : null;
                return GLib.SOURCE_REMOVE;
            }
            this._destroyParts(p);
            this._build(p);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        const lm = Main.layoutManager;
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        lm.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._iface = null;
        this._super?.destroy();
        this._super = null;
        this._destroyParts('all');

        if (this._dash) {
            this._dash.set_height(-1);
            this._dash.show();
        }
        lm.panelBox.remove_style_class_name('fusion-deepin-panel-box');
        if (!Main.panel.get_parent())
            lm.panelBox.insert_child_at_index(Main.panel, Math.max(0, this._panelIndex));
        Main.panel.queue_relayout();
        lm._updateBoxes?.();
        lm._updatePanelBarrier?.();
        lm._queueUpdateRegions?.();
    }
}
