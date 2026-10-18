// Deepin mode: Deepin features and looks on top of the user's own Fusion
// taskbar (which stays as it is): launcher, control centre, Organize
// Desktop, glossy theming and an optional icon / cursor theme. Built and torn
// down by extension.js when desktop-mode changes, so switching needs no logout.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SuperKeyBinding} from '../startMenu.js';
import {Launcher} from './launcher.js';
import {ControlCenter} from './controlCenter.js';
import {Organizer} from './organizer.js';

// Settings that rebuild the Deepin surfaces (launcher, control centre, collections).
const THEME_KEYS = ['deepin-theme', 'deepin-blur', 'deepin-opacity', 'deepin-gloss'];
const ORGANIZER_KEYS = ['deepin-organizer', 'deepin-organizer-collections', 'deepin-organizer-size'];
// Desktop-wide themes swapped in while Deepin mode runs: [our key, saved key, GNOME key, feature].
const SYSTEM_THEMES = [
    ['deepin-icon-theme', 'deepin-saved-icon-theme', 'icon-theme', 'icons'],
    ['deepin-cursor-theme', 'deepin-saved-cursor-theme', 'cursor-theme', 'icons'],
    ['deepin-accent', 'deepin-saved-accent', 'accent-color', 'accent'],
];

export class DeepinMode {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext.settings;
        // Set by the taskbar's launcher button so the windowed launcher opens next to it.
        this.launcherButton = null;

        this._build();

        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._applySystemThemes();
        this._iface.connectObject('changed::color-scheme', () => {
            if (this._settings.get_string('deepin-theme') === 'AUTO')
                this._queueRebuild('all');
        }, this);

        const lm = Main.layoutManager;
        if (lm._startingUp)
            lm.connectObject('startup-complete', () => this._bindSuper(), this);
        else
            this._bindSuper();
    }

    /** Super opens the Deepin launcher (the start menu keeps its button). */
    _bindSuper() {
        this._super?.destroy();
        this._super = this.ext.deepinFeature('launcher') && this._settings.get_boolean('deepin-super-key')
            ? new SuperKeyBinding(() => this.launcher?.toggle()) : null;
    }

    /** Space the Fusion taskbar takes at its screen edge. */
    get reservedHeight() {
        const box = Main.layoutManager.panelBox;
        if (this._settings.get_boolean('intellihide') || !box.visible)
            return 0;
        return box.height;
    }

    get atBottom() {
        return this.ext.panelAtBottom;
    }

    /**
     * Use the chosen icon / cursor theme (e.g. Deepin's "bloom") while the
     * mode runs; the user's own theme is saved and put back afterwards.
     */
    _applySystemThemes() {
        const s = this._settings;
        for (const [key, savedKey, gnomeKey, feature] of SYSTEM_THEMES) {
            const want = this.ext.deepinFeature(feature) ? s.get_string(key) : '';
            const saved = s.get_string(savedKey);
            if (want) {
                if (!saved)
                    s.set_string(savedKey, this._iface.get_string(gnomeKey));
                if (this._iface.get_string(gnomeKey) !== want)
                    this._iface.set_string(gnomeKey, want);
            } else if (saved) {
                this._iface.set_string(gnomeKey, saved);
                s.set_string(savedKey, '');
            }
        }
    }

    _restoreSystemThemes() {
        const s = this._settings;
        for (const [, savedKey, gnomeKey] of SYSTEM_THEMES) {
            const saved = s.get_string(savedKey);
            if (!saved)
                continue;
            this._iface.set_string(gnomeKey, saved);
            s.set_string(savedKey, '');
        }
    }

    _build(part = 'all') {
        if (part === 'all') {
            this.launcher = new Launcher(this);
            this.controlCenter = new ControlCenter(this);
        }
        if (this.ext.deepinFeature('organizer')) {
            try {
                this.organizer = new Organizer(this);
            } catch (e) {
                console.error('Fusion Desk: Organize Desktop failed', e);
            }
        }
    }

    _destroyParts(part = 'all') {
        this.organizer?.destroy();
        this.organizer = null;
        if (part !== 'all')
            return;
        this.controlCenter?.destroy();
        this.launcher?.destroy();
        this.controlCenter = this.launcher = null;
    }

    /** Called by extension.js for every changed setting while in Deepin mode. */
    onSettingChanged(key) {
        if (THEME_KEYS.includes(key))
            this._queueRebuild('all');
        else if (ORGANIZER_KEYS.includes(key))
            this._queueRebuild('organizer');
        else if (key === 'deepin-super-key' || key === 'deepin-launcher-button')
            this._bindSuper();
        else if (['deepin-icon-theme', 'deepin-cursor-theme', 'deepin-accent'].includes(key))
            this._applySystemThemes();
    }

    _queueRebuild(part) {
        if (part === 'all' || !this._pendingPart)
            this._pendingPart = part;
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            const p = this._pendingPart;
            this._pendingPart = null;
            this._destroyParts(p);
            this._build(p);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        Main.layoutManager.disconnectObject(this);
        this._iface.disconnectObject(this);
        // The screen lock disables extensions; keep the themes until unlock.
        if (!Main.sessionMode.isLocked)
            this._restoreSystemThemes();
        this._iface = null;
        this._super?.destroy();
        this._super = null;
        this._destroyParts('all');
        this.launcherButton = null;
    }
}
