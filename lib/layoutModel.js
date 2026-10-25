// Shared between the shell and prefs: no gnome-shell imports here.

export const ELEMENT_NAMES = {
    activities: 'Activities button',
    menu: 'Start menu',
    title: 'Window title',
    apps: 'Show Applications button',
    taskbar: 'Taskbar',
    workspaces: 'Workspace indicator',
    media: 'Media controls',
    sysmon: 'System monitor',
    clipboard: 'Clipboard history',
    apphub: 'App Hub',
    screenshot: 'Screenshot button',
    overflow: 'Hidden icons arrow',
    quick: 'System menu',
    date: 'Date menu',
    desktop: 'Show desktop button',
};

// Default order: the order of ELEMENT_NAMES.
const ELEMENT_IDS = Object.keys(ELEMENT_NAMES);

const DEFAULT_BOX = {
    activities: 'left', menu: 'left', title: 'left', apps: 'center', taskbar: 'center',
    workspaces: 'right', media: 'left', sysmon: 'right', clipboard: 'right', apphub: 'right',
    screenshot: 'right', overflow: 'right', quick: 'right', date: 'right', desktop: 'right',
};

/** Parse the `layout` setting into [{id, box}], adding any missing ids. */
export function parseLayout(strv) {
    const seen = new Set();
    const out = [];
    for (const entry of strv) {
        const [id, box] = entry.split(':');
        if (!ELEMENT_IDS.includes(id) || seen.has(id))
            continue;
        seen.add(id);
        out.push({id, box: ['left', 'center', 'right'].includes(box) ? box : DEFAULT_BOX[id]});
    }
    // Missing ids (e.g. new elements after an update) go to their default box,
    // before the next element of that box in the default order, else at the end.
    ELEMENT_IDS.forEach((id, i) => {
        if (seen.has(id))
            return;
        const box = DEFAULT_BOX[id];
        const next = ELEMENT_IDS.slice(i + 1).find(n => seen.has(n) && out.find(e => e.id === n).box === box);
        const at = next ? out.findIndex(e => e.id === next) : -1;
        const entry = {id, box};
        if (at >= 0)
            out.splice(at, 0, entry);
        else
            out.push(entry);
    });
    return out;
}

