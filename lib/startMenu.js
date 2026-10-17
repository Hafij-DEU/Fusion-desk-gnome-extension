// Start menu button, standalone runner and their shortcuts. The menu content
// itself (layouts, search, theme) lives in lib/menu/.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {Accelerators} from './accelerators.js';
import {giconFor} from './icons.js';
import {importArcMenu} from './menu/arcmenuImport.js';
import {MenuHost} from './menu/host.js';
import {LAYOUTS} from './menu/layouts.js';

export const StartMenuButton = GObject.registerClass(
class FusionStartMenuButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Fusion Menu', false);
        this._ext = ext;
        this._settings = ext.settings;

        this.add_style_class_name('fusion-start-button');
        this._buildButton();
        this.host = new MenuHost(ext, this.menu);

        // Left click: menu. Right click: context menu. Middle click: overview.
        this._clickGesture.required_button = Clutter.BUTTON_PRIMARY;
        const extraClick = (button, handler) => {
            const gesture = new Clutter.ClickGesture({required_button: button, recognize_on_press: true});
            gesture.connect('recognize', handler);
            this.add_action(gesture);
        };
        extraClick(Clutter.BUTTON_SECONDARY, () => {
            this.menu.close();
            this._openContextMenu();
        });
        extraClick(Clutter.BUTTON_MIDDLE, () => {
            this.menu.close();
            Main.overview.toggle();
        });
    }

    _buildButton() {
        const s = this._settings;
        const style = s.get_string('menu-button-style');
        const box = new St.BoxLayout({style_class: 'fusion-start-box'});
        if (style !== 'TEXT') {
            box.add_child(new St.Icon({
                gicon: giconFor(s.get_string('menu-icon'), 'view-app-grid-symbolic'),
                fallback_icon_name: 'view-app-grid-symbolic',
                style_class: 'fusion-start-icon',
                style: `icon-size: ${s.get_int('menu-button-icon-size')}px;`,
            }));
        }
        const text = s.get_string('menu-label') || (style !== 'ICON' ? 'Start' : '');
        if (style !== 'ICON' && text)
            box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER, style_class: 'fusion-start-label'}));
        this.add_child(box);
        if (s.get_boolean('menu-button-fill'))
            this.add_style_class_name('fusion-start-fill');
        const pad = s.get_int('menu-button-padding');
        if (pad >= 0)
            this.set_style(`-natural-hpadding: ${pad}px; -minimum-hpadding: ${pad}px;`);
    }

    _openContextMenu() {
        if (!this._ctxMenu) {
            const side = this._ext.panelAtBottom ? St.Side.BOTTOM : St.Side.TOP;
            const menu = this._ctxMenu = new PopupMenu.PopupMenu(this, 0.0, side);
            const appSys = Shell.AppSystem.get_default();
            const addApp = (label, ids) => {
                const a = ids.map(id => appSys.lookup_app(id)).find(Boolean);
                if (a)
                    menu.addAction(label, () => a.activate());
            };
            menu.addAction('Fusion Desk Settings', () => this._ext.openPreferences());

            // Quick layout switch.
            const layouts = new PopupMenu.PopupSubMenuMenuItem('Menu layout');
            this._layoutItems = [];
            for (const [id, Layout] of Object.entries(LAYOUTS)) {
                const item = layouts.menu.addAction(Layout.title, () => this._settings.set_string('menu-layout', id));
                item._layoutId = id;
                this._layoutItems.push(item);
            }
            menu.addMenuItem(layouts);
            menu.connect('open-state-changed', (_m, open) => {
                if (!open)
                    return;
                const current = this._settings.get_string('menu-layout');
                for (const item of this._layoutItems)
                    item.setOrnament(item._layoutId === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            });

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Activities Overview', () => Main.overview.toggle());
            menu.addAction('Show Applications', () => Main.overview.showApps());
            addApp('Terminal', ['org.gnome.Ptyxis.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Console.desktop']);
            addApp('Files', ['org.gnome.Nautilus.desktop']);
            addApp('System Monitor', ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'io.missioncenter.MissionCenter.desktop']);
            addApp('Settings', ['org.gnome.Settings.desktop']);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const power = new PopupMenu.PopupSubMenuMenuItem('Power');
            const sys = SystemActions.getDefault();
            power.menu.addAction('Lock', () => sys.activateLockScreen());
            power.menu.addAction('Log Out', () => sys.activateLogout());
            power.menu.addAction('Suspend', () => sys.activateSuspend());
            power.menu.addAction('Restart…', () => sys.activateRestart());
            power.menu.addAction('Power Off…', () => sys.activatePowerOff());
            menu.addMenuItem(power);
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            Main.panel.menuManager.addMenu(menu);
        }
        this._ctxMenu.toggle();
    }

    toggle() {
        this.menu.toggle();
    }

    _onDestroy() {
        this.host?.destroy();
        this.host = null;
        this._ctxMenu?.destroy();
        super._onDestroy();
    }
});

/** Spotlight-style runner that is not tied to a panel button. */
class Runner {
    constructor(ext) {
        this._anchor = new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
        Main.uiGroup.add_child(this._anchor);
        this.menu = new PopupMenu.PopupMenu(this._anchor, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this._anchor);
        this._manager.addMenu(this.menu);
        this._host = new MenuHost(ext, this.menu, {layout: 'runner'});
    }

    toggle() {
        if (!this.menu.isOpen) {
            // Open on the monitor with the pointer.
            const m = Main.layoutManager.monitors[global.display.get_current_monitor()] ?? Main.layoutManager.primaryMonitor;
            this._anchor.set_position(m.x + Math.round(m.width / 2), m.y);
        }
        this.menu.toggle();
    }

    destroy() {
        this._host.destroy();
        this.menu.destroy();
        this._anchor.destroy();
    }
}

/** Swaps GNOME's Super-key handler for one that toggles the start menu. */
class SuperKeyBinding {
    constructor(handler) {
        this._handlerId = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
        if (!this._handlerId) {
            console.warn('Fusion Desk: default overlay-key handler not found');
            return;
        }
        GObject.signal_handler_block(global.display, this._handlerId);
        global.display.connectObject('overlay-key', handler, this);
        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
    }

    destroy() {
        global.display.disconnectObject(this);
        if (this._handlerId)
            GObject.signal_handler_unblock(global.display, this._handlerId);
        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }
}

export class StartMenu {
    constructor(ext) {
        const s = ext.settings;
        // First run: bring over an existing ArcMenu setup once.
        if (!s.get_boolean('menu-imported-arcmenu')) {
            s.set_boolean('menu-imported-arcmenu', true);
            try {
                importArcMenu(s);
            } catch (e) {
                console.error('Fusion Desk: ArcMenu import failed', e);
            }
        }

        this._button = new StartMenuButton(ext);
        Main.panel.addToStatusArea('fusion-start-menu', this._button, 0, 'left');
        this.actor = this._button.container;
        this._runner = new Runner(ext);

        const startup = () => {
            this._keys = new Accelerators();
            this._keys.add(s.get_string('menu-hotkey'), () => this._button.toggle());
            this._keys.add(s.get_string('menu-runner-hotkey'), () => this._runner.toggle());
            if (s.get_boolean('menu-super-key')) {
                const runner = s.get_string('menu-super-action') === 'RUNNER';
                this._super = new SuperKeyBinding(() => (runner ? this._runner : this._button).toggle());
            }
        };
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', startup, this);
        else
            startup();
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this._super?.destroy();
        this._keys?.destroy();
        this._runner.destroy();
        this._button.destroy();
    }
}
