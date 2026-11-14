// Let app shortcuts registered through the Global Shortcuts portal (e.g. a
// dictation app's push-to-talk key) fire while a menu or the overview is open.
//
// GNOME Shell only runs a grabbed accelerator in the action modes its owner
// asked for. xdg-desktop-portal-gnome asks for normal mode only, and an open
// menu (the start menu, the launcher, any popup) switches the shell to popup
// mode, so the key press is dropped there. This widens the modes of grabs
// owned by the portal backend, and restores them on destroy.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PORTAL_BUS_NAME = 'org.freedesktop.impl.portal.desktop.gnome';
const EXTRA_MODES = Shell.ActionMode.POPUP | Shell.ActionMode.OVERVIEW;

export class PortalShortcuts {
    constructor() {
        this._service = Main.shellDBusService;
        this._portalOwner = null;
        // binding name -> modes the portal asked for
        this._original = new Map();
        if (!this._service?._grabAcceleratorForSender || !this._service._grabbedAccelerators)
            return;

        const service = this._service;
        const original = service._grabAcceleratorForSender;
        this._originalGrab = original;
        this._hadOwnGrab = Object.hasOwn(service, '_grabAcceleratorForSender');
        const self = this;
        service._grabAcceleratorForSender = function (accelerator, modeFlags, grabFlags, sender) {
            const action = original.call(this, accelerator, modeFlags, grabFlags, sender);
            if (action !== Meta.KeyBindingAction.NONE && sender === self._portalOwner)
                self._widen(action, modeFlags);
            return action;
        };

        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, PORTAL_BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            (_c, _name, owner) => {
                this._portalOwner = owner;
                this._widenExisting();
            },
            () => {
                this._portalOwner = null;
            });
    }

    _widen(action, modeFlags) {
        const name = Meta.external_binding_name_for_action(action);
        this._original.set(name, modeFlags);
        Main.wm.allowKeybinding(name, modeFlags | EXTRA_MODES);
    }

    /** Grabs the portal made before Fusion Desk started (or before a restart). */
    _widenExisting() {
        for (const [action, sender] of this._service._grabbedAccelerators) {
            if (sender !== this._portalOwner)
                continue;
            const name = Meta.external_binding_name_for_action(action);
            if (this._original.has(name))
                continue;
            this._widen(action, Main.wm._allowedKeybindings?.[name] ?? Shell.ActionMode.NORMAL);
        }
    }

    destroy() {
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        if (this._originalGrab) {
            if (this._hadOwnGrab)
                this._service._grabAcceleratorForSender = this._originalGrab;
            else
                delete this._service._grabAcceleratorForSender;
            // Only restore grabs that still exist; released ones are gone.
            const live = new Set();
            for (const action of this._service._grabbedAccelerators.keys())
                live.add(Meta.external_binding_name_for_action(action));
            for (const [name, modes] of this._original) {
                if (live.has(name))
                    Main.wm.allowKeybinding(name, modes);
            }
        }
        this._originalGrab = null;
        this._original.clear();
    }
}
