// Blurred wallpaper behind the Activities overview and the app grid (GNOME
// shows a plain dark background there), and frosted app folder popups.
// One setting turns it on, one sets the strength. Written for Fusion Desk.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {keepBlurClean} from './style.js';

const BLUR = 'fusion-overview-blur';
// keepBlurClean redraws actors with this effect name every frame they show.
const FOLDER_BLUR = 'fusion-deepin-blur';
const DIM = 0.7; // brightness of the blurred wallpaper, so icons and labels stay readable
const FOLDER_ALPHA = 0.6;

export class OverviewBlur {
    constructor(ext) {
        this._settings = ext.settings;
        this._radius = Math.max(4, Math.round(this._settings.get_int('overview-blur-strength') * 0.8));
        this._managers = [];
        this._folders = new Map(); // folder popup's view box -> popup

        const group = Main.layoutManager.overviewGroup;
        this._layer = new St.Widget({name: 'fusionOverviewBlur', layout_manager: new Clutter.FixedLayout()});
        group.insert_child_at_index(this._layer, 0);
        this._fill();
        Main.layoutManager.connectObject('monitors-changed', () => this._fill(), this);

        // App folder popups are added to the overview group when first opened.
        group.connectObject('child-added', (_g, child) => {
            if (child !== this._layer)
                this._frost(child);
        }, this);
        group.get_children().forEach(c => this._frost(c));
    }

    /** One blurred copy of the wallpaper per monitor, below everything in the overview. */
    _fill() {
        this._managers.forEach(m => m.destroy());
        this._managers = [];
        this._layer.destroy_all_children();
        Main.layoutManager.monitors.forEach((m, index) => {
            const bin = new St.Widget({x: m.x, y: m.y, width: m.width, height: m.height, clip_to_allocation: true});
            bin.add_effect_with_name(BLUR, new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: this._radius,
                brightness: DIM,
            }));
            this._layer.add_child(bin);
            this._managers.push(new Background.BackgroundManager({
                container: bin,
                monitorIndex: index,
                controlPosition: false,
                vignette: false,
            }));
        });
    }

    /** Frosted glass for an app folder popup: see-through background, blurred behind. */
    _frost(dialog) {
        const box = dialog?._viewBox;
        if (!box || this._folders.has(box) || dialog.constructor.name !== 'AppFolderDialog')
            return;
        this._folders.set(box, dialog);
        box.add_effect_with_name(FOLDER_BLUR, new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: Math.max(20, Math.round(this._radius * 0.6)),
            brightness: 1.0,
        }));
        keepBlurClean(box);
        // The theme's colour is only known once the popup is styled.
        dialog.connectObject('open-state-changed', (_d, open) => {
            if (open && box._fusionFolderStyle === undefined) {
                box._fusionFolderStyle = box.get_style();
                const c = box.get_theme_node().get_background_color();
                box.set_style(`background-color: rgba(${c.red}, ${c.green}, ${c.blue}, ${FOLDER_ALPHA});`);
            }
        }, this);
        box.connectObject('destroy', () => this._folders.delete(box), this);
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.overviewGroup.disconnectObject(this);
        for (const [box, dialog] of this._folders) {
            box.disconnectObject(this);
            dialog.disconnectObject(this);
            box.remove_effect_by_name(FOLDER_BLUR);
            if (box._fusionFolderStyle !== undefined) {
                box.set_style(box._fusionFolderStyle);
                delete box._fusionFolderStyle;
            }
        }
        this._folders.clear();
        this._managers.forEach(m => m.destroy());
        this._managers = [];
        this._layer.destroy();
    }
}
