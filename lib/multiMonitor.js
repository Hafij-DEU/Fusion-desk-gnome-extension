// Panels on secondary monitors: a start button and a taskbar that lists only
// the windows on that monitor. Position, height and opacity follow the main panel.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {parseLayout} from './layoutModel.js';
import {StartMenuButton} from './startMenu.js';
import {Taskbar} from './taskbar.js';
import {panelIsLight, panelRgb} from './style.js';

const ALIGN = {left: Clutter.ActorAlign.START, center: Clutter.ActorAlign.CENTER, right: Clutter.ActorAlign.END};

class SecondaryPanel {
    constructor(ext, monitorIndex) {
        this._ext = ext;
        this.monitorIndex = monitorIndex;
        const s = ext.settings;

        this.actor = new St.BoxLayout({
            style_class: 'fusion-panel-box fusion-secondary-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // Named "panel" so the theme's #panel rules style the buttons like the main panel.
        this._panel = new St.Widget({
            name: 'panel',
            style_class: `fusion-panel fusion-secondary-panel ${ext.panelAtBottom ? 'fusion-panel-bottom' : 'fusion-panel-top'}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
        });
        this.actor.add_child(this._panel);

        const boxes = {};
        for (const [name, align] of Object.entries(ALIGN)) {
            boxes[name] = new St.BoxLayout({
                style_class: `fusion-secondary-${name}`,
                x_expand: true,
                y_expand: true,
                x_align: align,
                y_align: Clutter.ActorAlign.FILL,
            });
            this._panel.add_child(boxes[name]);
        }

        this._menuManager = new PopupMenu.PopupMenuManager(this._panel);
        for (const {id, box} of parseLayout(s.get_strv('layout'))) {
            if (id === 'menu' && s.get_boolean('menu-visible')) {
                this._startButton = new StartMenuButton(ext);
                boxes[box].add_child(this._startButton.container);
                this._menuManager.addMenu(this._startButton.menu);
            } else if (id === 'taskbar' && s.get_boolean('taskbar-visible')) {
                this._taskbar = new Taskbar(ext, {monitor: monitorIndex, hotkeys: false});
                boxes[box].add_child(this._taskbar.actor);
            }
        }

        Main.layoutManager.addChrome(this.actor, {affectsStruts: true, trackFullscreen: true});
        this._apply();
    }

    _apply() {
        const s = this._ext.settings;
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (!m)
            return;
        const height = s.get_int('panel-height');
        const alpha = s.get_int('panel-opacity') / 100;
        this.actor.set_style(`background-color: rgba(${panelRgb(s)}, ${alpha.toFixed(2)});`);
        if (panelIsLight(s))
            this._panel.add_style_class_name('fusion-panel-light');
        else
            this._panel.remove_style_class_name('fusion-panel-light');
        this._panel.set_height(height);
        this.actor.set_size(m.width, height);
        this.actor.set_position(m.x, this._ext.panelAtBottom ? m.y + m.height - height : m.y);
    }

    destroy() {
        this._taskbar?.destroy();
        this._startButton?.destroy();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this._taskbar = this._startButton = this._menuManager = this._panel = this.actor = null;
    }
}

export class SecondaryPanels {
    constructor(ext) {
        this._ext = ext;
        this._panels = [];
        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        this._rebuild();
    }

    _rebuild() {
        this._destroyPanels();
        const lm = Main.layoutManager;
        lm.monitors.forEach((_m, i) => {
            if (i === lm.primaryIndex)
                return;
            try {
                this._panels.push(new SecondaryPanel(this._ext, i));
            } catch (e) {
                console.error(`Fusion Desk: failed to build panel for monitor ${i}`, e);
            }
        });
    }

    _destroyPanels() {
        for (const panel of this._panels) {
            try {
                panel.destroy();
            } catch (e) {
                console.error('Fusion Desk: failed to destroy secondary panel', e);
            }
        }
        this._panels = [];
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this._destroyPanels();
    }
}
