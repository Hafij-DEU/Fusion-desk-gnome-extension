// Workspace pills: click to switch, scroll to cycle, number of windows shown as dots.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class Workspaces {
    constructor() {
        this.actor = new St.BoxLayout({style_class: 'fusion-workspaces', reactive: true, y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('scroll-event', (_a, event) => this._onScroll(event));
        const wm = global.workspace_manager;
        wm.connectObject('notify::n-workspaces', () => this._rebuild(),
            'active-workspace-changed', () => this._rebuild(), this);
        global.display.connectObject('window-created', () => this._rebuild(), this);
        global.window_manager.connectObject('switch-workspace', () => this._rebuild(), this);
        this._rebuild();
    }

    _rebuild() {
        this.actor.destroy_all_children();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            const count = ws.list_windows().filter(w => !w.skip_taskbar).length;
            const pill = new St.Button({
                style_class: `fusion-ws${i === active ? ' active' : ''}${count ? ' occupied' : ''}`,
                label: String(i + 1),
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            pill.connect('clicked', () => ws.activate(global.get_current_time()));
            this.actor.add_child(pill);
        }
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        const wm = global.workspace_manager;
        let idx = wm.get_active_workspace_index();
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            idx--;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            idx++;
        else
            return Clutter.EVENT_PROPAGATE;
        idx = Math.max(0, Math.min(idx, wm.n_workspaces - 1));
        wm.get_workspace_by_index(idx).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this.actor.destroy();
    }
}

