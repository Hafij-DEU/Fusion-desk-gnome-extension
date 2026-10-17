// Global hotkeys from accelerator strings (e.g. "<Super>space") without a
// GSettings keybinding schema.
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

export class Accelerators {
    constructor() {
        this._actions = new Map();
        global.display.connectObject('accelerator-activated', (_d, action) => {
            this._actions.get(action)?.();
        }, this);
    }

    /** Grab `accel`; returns false when it is invalid or already taken. */
    add(accel, handler) {
        if (!accel)
            return false;
        const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
        if (action === Meta.KeyBindingAction.NONE) {
            console.warn(`Fusion Desk: could not bind ${accel}`);
            return false;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), MODES);
        this._actions.set(action, handler);
        return true;
    }

    destroy() {
        global.display.disconnectObject(this);
        for (const action of this._actions.keys()) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        }
        this._actions.clear();
    }
}
