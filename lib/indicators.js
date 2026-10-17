// Hides the built-in status icons the user switched off (hidden-indicators).
// GNOME keeps re-showing them as state changes, so each hidden icon is
// re-hidden on notify::visible and handed back to GNOME's own sync on destroy.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {INDICATORS} from './indicatorList.js';

export class Indicators {
    constructor(ext) {
        const qs = Main.panel.statusArea.quickSettings;
        const hidden = new Set(ext.settings.get_strv('hidden-indicators'));
        this._actors = [];
        for (const [id, , , prop] of INDICATORS) {
            if (!hidden.has(id))
                continue;
            const actor = id === 'battery-percentage' ? qs?._system?._percentageLabel : qs?.[prop];
            if (!actor)
                continue;
            actor.connectObject('notify::visible', () => {
                if (actor.visible)
                    actor.hide();
            }, this);
            actor.hide();
            this._actors.push([id, actor]);
        }
    }

    destroy() {
        const qs = Main.panel.statusArea.quickSettings;
        for (const [id, actor] of this._actors) {
            actor.disconnectObject(this);
            if (id === 'battery-percentage')
                qs?._system?._sync?.();
            else if (actor._syncIndicatorsVisible)
                actor._syncIndicatorsVisible();
            else
                actor.show();
        }
        this._actors = [];
    }
}
