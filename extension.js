// Fusion Desk - all-in-one panel, taskbar and start menu for GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PanelLayout} from './lib/panelLayout.js';
import {StartMenu} from './lib/startMenu.js';
import {AppsButton, Taskbar} from './lib/taskbar.js';
import {WindowTitle} from './lib/windowTitle.js';
import {Workspaces} from './lib/workspaces.js';
import {MediaControls} from './lib/media.js';
import {SysMonitor} from './lib/sysMonitor.js';
import {ClipboardHistory} from './lib/clipboard.js';
import {ScreenshotButton, ShowDesktop} from './lib/buttons.js';
import {Clock} from './lib/clock.js';
import {Caffeine} from './lib/caffeine.js';
import {AutoHide} from './lib/autohide.js';
import {SecondaryPanels} from './lib/multiMonitor.js';
import {AppHubButton, destroyStore} from './lib/menu/appHub.js';
import {Indicators} from './lib/indicators.js';

// Modules that own a panel actor. `keys` are setting prefixes that force a rebuild.
const MODULES = {
    // Menu content settings apply live inside MenuHost; these rebuild the button/shortcuts.
    menu: {cls: StartMenu, visible: 'menu-visible',
        keys: ['menu-icon', 'menu-label', 'menu-super-', 'menu-button-', 'menu-hotkey', 'menu-runner-hotkey']},
    apps: {cls: AppsButton, visible: 'apps-visible', keys: ['taskbar-icon-size', 'apps-icon']},
    taskbar: {cls: Taskbar, visible: 'taskbar-visible', keys: ['taskbar-', 'multi-monitor']},
    title: {cls: WindowTitle, visible: 'title-visible', keys: []},
    workspaces: {cls: Workspaces, visible: 'workspaces-visible', keys: []},
    media: {cls: MediaControls, visible: 'media-visible', keys: ['media-']},
    // Readout toggles (sysmon-cpu, ...) apply live inside the module.
    sysmon: {cls: SysMonitor, visible: 'sysmon-visible', keys: ['sysmon-interval']},
    // Always built (history + Super+V); clipboard-visible only shows/hides the icon.
    clipboard: {cls: ClipboardHistory, visible: null, keys: ['clipboard-visible', 'clipboard-super-v']},
    apphub: {cls: AppHubButton, visible: 'apphub-visible', keys: []},
    screenshot: {cls: ScreenshotButton, visible: 'screenshot-visible', keys: []},
    desktop: {cls: ShowDesktop, visible: 'desktop-visible', keys: []},
    // Not placed in the layout.
    clock: {cls: Clock, visible: null, keys: ['clock-']},
    caffeine: {cls: Caffeine, visible: 'caffeine-visible', keys: []},
    // Hides chosen built-in status icons (after caffeine so its icon exists).
    indicators: {cls: Indicators, visible: null, keys: ['hidden-indicators']},
    autohide: {cls: AutoHide, visible: null,
        keys: ['intellihide', 'intellihide-mode', 'dynamic-opacity', 'panel-position', 'panel-height', 'panel-opacity']},
    // Start button + per-monitor taskbar on every non-primary monitor.
    multimon: {cls: SecondaryPanels, visible: 'multi-monitor',
        keys: ['layout', 'panel-', 'taskbar-', 'menu-visible', 'menu-icon', 'menu-label', 'menu-button-']},
};

// Fusion hides its own widget when one of these extensions is enabled, so the
// panel does not show the same thing twice (setting: avoid-duplicates).
const DUPLICATES = {
    sysmon: [
        'system-monitor@gnome-shell-extensions.gcampax.github.com', 'Vitals@CoreCoding.com',
        'Resource_Monitor@Ory0n', 'system-monitor-next@paradoxxx.zero.gmail.com',
        'System_Monitor@bghome.gmail.com', 'multicore-system-monitor@igrek.dev', 'system-monitor-tray@lsb.codes',
    ],
    clipboard: ['clipboard-history@alexsaveau.dev', 'clipboard-indicator@tudmotu.com'],
    caffeine: ['caffeine@patapon.info'],
    clock: ['date-menu-formatter@marcinjakubowski.github.com', 'panel-date-format@keiii.github.com'],
};

// Extensions that replace the same panel. Running both leaves the primary
// monitor without a panel, so Fusion stays idle while one of these is enabled.
const CONFLICTS = {
    'dash-to-panel@jderose9.github.com': 'Dash to Panel',
};

const LAYOUT_KEYS = ['layout', 'activities-visible', 'panel-', 'hide-overview-dash'];

export default class FusionDeskExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._importOldSettings();
        // State that survives module rebuilds (e.g. clipboard history, timers).
        this.state = {};
        this._running = false;

        const extensionsChanged = () => {
            if (this._syncConflict() && this._running) {
                Object.keys(DUPLICATES).forEach(n => this._pending.add(n));
                this._onChanged('@duplicates');
            }
        };
        global.settings.connectObject('changed::enabled-extensions', extensionsChanged,
            'changed::disabled-extensions', extensionsChanged, this);
        this._syncConflict();
    }

    /** UUID of an enabled extension that also replaces the panel, if any. */
    _conflict() {
        if (global.settings.get_boolean('disable-user-extensions'))
            return null;
        const enabled = global.settings.get_strv('enabled-extensions');
        const disabled = global.settings.get_strv('disabled-extensions');
        return Object.keys(CONFLICTS).find(uuid => enabled.includes(uuid) && !disabled.includes(uuid)) ?? null;
    }

    /** Start or stop the panel depending on conflicts. Returns true when no conflict. */
    _syncConflict() {
        const conflict = this._conflict();
        if (conflict) {
            if (this._running)
                this._stop();
            this._notifyConflict(conflict);
            return false;
        }
        this._conflictNotification?.destroy();
        if (!this._running)
            this._start();
        return true;
    }

    _notifyConflict(uuid) {
        if (this._conflictNotification)
            return;
        const name = CONFLICTS[uuid];
        const source = MessageTray.getSystemSource();
        const n = new MessageTray.Notification({
            source,
            title: `Fusion Desk is paused: ${name} is enabled`,
            body: `Both replace the panel. Turn ${name} off in the Extensions app to use Fusion Desk (it already includes the taskbar), or turn Fusion Desk off.`,
            urgency: MessageTray.Urgency.CRITICAL,
            iconName: 'dialog-warning-symbolic',
        });
        const extensionsApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Extensions.desktop');
        if (extensionsApp)
            n.addAction('Open Extensions', () => extensionsApp.activate());
        n.connect('destroy', () => {
            if (this._conflictNotification === n)
                this._conflictNotification = null;
        });
        this._conflictNotification = n;
        source.addNotification(n);
    }

    _start() {
        this._running = true;
        this._modules = {};
        this._pending = new Set();
        this._layout = new PanelLayout(this);

        for (const name of Object.keys(MODULES))
            this._build(name);
        this._layout.arrange(this._actors());

        this._settings.connectObject('changed', (_s, key) => this._onChanged(key), this);
    }

    _stop() {
        this._running = false;
        this._settings.disconnectObject(this);
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const name of Object.keys(this._modules).reverse())
            this._destroyModule(name);
        destroyStore();
        this._layout.destroy();
        this._layout = null;
        this._modules = null;
        this._pending = null;
    }

    /** Name of an enabled extension that already provides this module, if any. */
    duplicateOf(name) {
        if (!DUPLICATES[name] || !this._settings.get_boolean('avoid-duplicates'))
            return null;
        const enabled = global.settings.get_strv('enabled-extensions');
        const disabled = global.settings.get_strv('disabled-extensions');
        return DUPLICATES[name].find(uuid =>
            enabled.includes(uuid) && !disabled.includes(uuid) && Main.extensionManager.lookup(uuid)) ?? null;
    }

    /** One-time import of the icons used by Dash to Panel and ArcMenu. */
    _importOldSettings() {
        if (this._settings.get_boolean('imported-settings'))
            return;
        this._settings.set_boolean('imported-settings', true);

        const open = (uuid, schemaId) => {
            const dir = Main.extensionManager.lookup(uuid)?.dir?.get_child('schemas');
            if (!dir?.query_exists(null))
                return null;
            try {
                const source = Gio.SettingsSchemaSource.new_from_directory(dir.get_path(),
                    Gio.SettingsSchemaSource.get_default(), false);
                const schema = source.lookup(schemaId, false);
                return schema ? new Gio.Settings({settings_schema: schema}) : null;
            } catch {
                return null;
            }
        };
        const importIcon = (settings, from, to) => {
            if (!settings?.settings_schema.has_key(from))
                return;
            const value = settings.get_string(from);
            if (value?.startsWith('/') && GLib.file_test(value, GLib.FileTest.EXISTS))
                this._settings.set_string(to, value);
        };
        importIcon(open('arcmenu@arcmenu.com', 'org.gnome.shell.extensions.arcmenu'), 'menu-button-icon', 'menu-icon');
        importIcon(open('dash-to-panel@jderose9.github.com', 'org.gnome.shell.extensions.dash-to-panel'),
            'show-apps-icon-file', 'apps-icon');
    }

    disable() {
        global.settings.disconnectObject(this);
        if (this._running)
            this._stop();
        this._conflictNotification?.destroy();
        this._conflictNotification = null;
        this.state = null;
        this._settings = null;
    }

    get settings() {
        return this._settings;
    }

    /** The actor that currently draws the main panel (our row while enabled). */
    get panelActor() {
        return this._layout?.row ?? null;
    }

    get panelAtBottom() {
        return this._settings.get_string('panel-position') === 'BOTTOM';
    }

    _actors() {
        const actors = {};
        for (const [name, mod] of Object.entries(this._modules)) {
            if (mod.actor)
                actors[name] = mod.actor;
        }
        return actors;
    }

    _build(name) {
        const def = MODULES[name];
        if (def.visible && !this._settings.get_boolean(def.visible))
            return;
        if (this.duplicateOf(name))
            return;
        try {
            this._modules[name] = new def.cls(this);
        } catch (e) {
            console.error(`Fusion Desk: failed to build ${name}`, e);
        }
    }

    _destroyModule(name) {
        try {
            this._modules[name]?.destroy();
        } catch (e) {
            console.error(`Fusion Desk: failed to destroy ${name}`, e);
        }
        delete this._modules[name];
    }

    _onChanged(key) {
        const matches = prefix => key === prefix || (prefix.endsWith('-') && key.startsWith(prefix));

        for (const [name, def] of Object.entries(MODULES)) {
            if (key === def.visible || def.keys.some(matches) || (key === 'avoid-duplicates' && DUPLICATES[name]))
                this._pending.add(name);
        }
        if (LAYOUT_KEYS.some(matches))
            this._pending.add('@layout');

        if (this._pending.size && !this._idleId) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = 0;
                this._flush();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _flush() {
        const pending = [...this._pending];
        this._pending.clear();
        for (const name of pending) {
            if (name === '@layout')
                continue;
            this._destroyModule(name);
            this._build(name);
        }
        this._layout.apply();
        this._layout.arrange(this._actors());
    }
}
