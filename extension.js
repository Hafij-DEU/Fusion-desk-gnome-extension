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
import {TrayOverflow} from './lib/trayOverflow.js';
import {PipOnTop} from './lib/pip.js';
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
import {Battery} from './lib/battery.js';
import {TrayTint} from './lib/trayTint.js';
import {WallpaperBlur} from './lib/wallpaperBlur.js';
import {ChargeLimit} from './lib/chargeLimit.js';
import {DeepinMode} from './lib/deepin/index.js';
import {watchSystemStyle} from './lib/style.js';
import {cleanupGlass} from './lib/glass.js';
import {migrateDesktopModes} from './lib/presets.js';
import {TaskView, WindowsSearch} from './lib/windowsMode.js';
import {DeepinControlButton, DeepinLauncherButton} from './lib/deepin/panelButtons.js';

// Modules that own a panel actor. `keys` are setting prefixes that force a rebuild.
const MODULES = {
    // Menu content settings apply live inside MenuHost; these rebuild the button/shortcuts.
    menu: {cls: StartMenu, visible: 'menu-visible',
        keys: ['menu-icon', 'menu-label', 'super-key', 'menu-button-', 'menu-hotkey', 'menu-runner-hotkey', 'deepin-start', 'icons-follow-accent']},
    apps: {cls: AppsButton, visible: 'apps-visible', keys: ['taskbar-icon-size', 'apps-icon', 'icons-follow-accent']},
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
    // Other apps' tray icons behind a "show hidden icons" arrow (pins apply live).
    overflow: {cls: TrayOverflow, visible: 'overflow-visible', keys: ['panel-position']},
    desktop: {cls: ShowDesktop, visible: 'desktop-visible', keys: []},
    // Extra buttons of the Windows-like and Deepin modes (see extraElements()).
    winsearch: {cls: WindowsSearch, visible: null, windowsExtra: true, keys: ['windows-search', 'windows-extras-in-fusion']},
    taskview: {cls: TaskView, visible: 'windows-task-view', windowsExtra: true, keys: ['windows-extras-in-fusion']},
    dlauncher: {cls: DeepinLauncherButton, visible: null, feature: 'launcher', keys: ['deepin-launcher-icon', 'deepin-start', 'panel-height']},
    dcontrol: {cls: DeepinControlButton, visible: null, feature: 'control', keys: ['deepin-control-button', 'deepin-control-position']},
    // Not placed in the layout.
    clock: {cls: Clock, visible: null, keys: ['clock-']},
    caffeine: {cls: Caffeine, visible: 'caffeine-visible', keys: []},
    // Picture-in-picture windows and chosen apps stay on top (options apply live).
    pip: {cls: PipOnTop, visible: null, keys: []},
    // Other apps' tray icons in the status-icon colour.
    traytint: {cls: TrayTint, visible: null, keys: ['tray-app-icons']},
    // Wallpaper blurs while windows are open on its monitor.
    wallblur: {cls: WallpaperBlur, visible: 'wallpaper-blur', keys: ['wallpaper-blur-strength']},
    // Stops charging at the chosen level (needs the one-time charge helper setup).
    chargelimit: {cls: ChargeLimit, visible: 'charge-limit', keys: ['charge-limit-percent', 'charge-helper-ready']},
    // Coloured battery with the percentage inside (in GNOME's status area).
    battery: {cls: Battery, visible: null, keys: ['battery-style', 'battery-standalone', 'hidden-indicators']},
    // Hides chosen built-in status icons (after caffeine so its icon exists).
    indicators: {cls: Indicators, visible: null, keys: ['hidden-indicators']},
    autohide: {cls: AutoHide, visible: null,
        keys: ['intellihide', 'intellihide-mode', 'dynamic-opacity', 'panel-position', 'panel-height', 'panel-opacity']},
    // Start button + per-monitor taskbar on every non-primary monitor.
    multimon: {cls: SecondaryPanels, visible: 'multi-monitor',
        keys: ['layout', 'panel-', 'taskbar-', 'menu-visible', 'menu-icon', 'menu-label', 'menu-button-', 'icons-follow-accent', 'accent-gradient', 'accent-gradient-', 'glass-']},
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

const LAYOUT_KEYS = ['layout', 'activities-visible', 'panel-', 'pill-', 'hide-overview-dash', 'deepin-floating-taskbar', 'accent-gradient', 'accent-gradient-', 'icons-follow-accent', 'windows-extras-in-fusion', 'glass-'];

export default class FusionDeskExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
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
        n.connectObject('destroy', () => {
            if (this._conflictNotification === n)
                this._conflictNotification = null;
        }, this);
        this._conflictNotification = n;
        source.addNotification(n);
    }

    _start() {
        this._running = true;
        // Older versions only had these features inside "desktop modes".
        migrateDesktopModes(this._settings);
        // The Dashboard and Galaxy menu layouts are gone: back to the default one.
        if (['dashboard', 'galaxy'].includes(this._settings.get_string('menu-layout')))
            this._settings.reset('menu-layout');
        this._settings.connectObject('changed', (_s, key) => this._onSettingChanged(key), this);
        // App launcher, control centre, desktop organizer and the theme
        // switches (lib/deepin/); each part follows its own setting.
        try {
            this._deepin = new DeepinMode(this);
        } catch (e) {
            console.error('Fusion Desk: launcher / control centre failed', e);
            this._deepin?.destroy();
            this._deepin = null;
        }
        this._startFusion();
    }

    _startFusion() {
        this._modules = {};
        this._pending = new Set();
        this._layout = new PanelLayout(this);

        for (const name of Object.keys(MODULES))
            this._build(name);
        this._layout.arrange(this._actors());
        // Light / dark taskbar follows the system style: same as changing panel-theme.
        this._unwatchStyle = watchSystemStyle(() => this._onChanged('panel-theme'));
    }

    _stop() {
        this._running = false;
        this._settings.disconnectObject(this);
        for (const id of ['_idleId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._unwatchStyle?.();
        this._unwatchStyle = null;
        if (this._modules) {
            for (const name of Object.keys(this._modules).reverse())
                this._destroyModule(name);
            destroyStore();
            this._layout.destroy();
        }
        this._layout = null;
        this._modules = null;
        this._pending = null;
        this._deepin?.destroy();
        this._deepin = null;
        cleanupGlass();
    }

    _onSettingChanged(key) {
        this._deepin?.onSettingChanged(key);
        this._onChanged(key);
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

    /** Taskbar background (PanelLayout knows whether it floats). */
    setPanelBackground(alpha, extra = '') {
        this._layout?.setBackground(alpha, extra);
    }

    /** App launcher, control centre and desktop organizer (lib/deepin/). */
    get deepin() {
        return this._deepin ?? null;
    }

    /** Search and Task View buttons after the start button. */
    get windowsExtras() {
        return this._settings.get_boolean('windows-extras-in-fusion');
    }

    /**
     * Whether an optional feature is on. Each has its own setting (presets in
     * lib/presets.js only write these settings).
     */
    deepinFeature(id) {
        const s = this._settings;
        switch (id) {
        case 'launcher':
            return s.get_string('deepin-start') !== 'FUSION';
        case 'control':
            return s.get_boolean('deepin-control-button');
        case 'organizer':
            return s.get_boolean('deepin-organizer');
        case 'floating':
            return s.get_boolean('deepin-floating-taskbar');
        default:
            // Accent colour and icon themes act when a value is chosen.
            return true;
        }
    }

    /** The start button itself opens the app launcher (one start button). */
    get deepinStartButton() {
        return this.deepinFeature('launcher') && this._settings.get_string('deepin-start') === 'DEEPIN';
    }

    /** Mode buttons placed around the user's layout: right after the start menu and before the system menu. */
    extraElements() {
        const afterMenu = [];
        const beforeQuick = [];
        const leftEdge = [];
        // Standalone battery right after the system menu.
        const afterQuick = this._settings.get_boolean('battery-standalone') ? ['battery'] : [];
        if (this.windowsExtras)
            afterMenu.push('winsearch', 'taskview');
        if (this.deepinFeature('launcher') && !this.deepinStartButton)
            afterMenu.push('dlauncher');
        // The control centre button follows the start button, sits at the left edge
        // or in the tray (on the clock it has no button of its own).
        if (this.deepinFeature('control')) {
            const where = this._settings.get_string('deepin-control-position');
            if (where === 'START')
                afterMenu.push('dcontrol');
            else if (where === 'LEFT')
                leftEdge.push('dcontrol');
            else if (where === 'TRAY')
                beforeQuick.push('dcontrol');
        }
        return {afterMenu, beforeQuick, afterQuick, leftEdge};
    }

    toggleStartMenu() {
        this._modules?.menu?._button?.toggle();
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
        if (def.feature && !this.deepinFeature(def.feature))
            return;
        if (def.windowsExtra && !this.windowsExtras)
            return;
        if (def.visible && !this.settings.get_boolean(def.visible))
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
        // Deepin mode writes its saved-theme keys while starting, before the modules exist.
        if (!this._pending)
            return;
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
