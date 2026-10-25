// Mouse-wheel helpers shared by the taskbar and the workspace pills.
import Clutter from 'gi://Clutter';

/** -1 (up / left), 1 (down / right) or 0 (smooth scrolling and anything else). */
export function scrollStep(event) {
    switch (event.get_scroll_direction()) {
    case Clutter.ScrollDirection.UP:
    case Clutter.ScrollDirection.LEFT:
        return -1;
    case Clutter.ScrollDirection.DOWN:
    case Clutter.ScrollDirection.RIGHT:
        return 1;
    default:
        return 0;
    }
}

/** Switch `step` workspaces back or forward, stopping at the first and last. */
export function switchWorkspaceBy(step) {
    const wm = global.workspace_manager;
    const idx = Math.max(0, Math.min(wm.get_active_workspace_index() + step, wm.n_workspaces - 1));
    wm.get_workspace_by_index(idx).activate(global.get_current_time());
}
