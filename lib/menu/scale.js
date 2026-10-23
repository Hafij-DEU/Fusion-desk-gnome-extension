// Real size scaling for the Dashboard and Galaxy layouts (setting
// menu-dash-scale). Shrinking the finished menu with a transform blurs its
// text, so instead every size is made smaller at its source: the stylesheet's
// pixel values (a scaled copy of the start menu rules, under the class
// fusion-sm-scaled), the root font size, and the icon sizes and fixed sizes
// set in code (scaleTree, which also follows children added later).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const ROOT = '.fusion-sm-scaled';
// Compounds that are the layout's own root actor.
const ROOT_COMPOUND = /^\.fusion-sm(\.|$)|\.fusion-sm-(galaxy|dashboard)(?![\w-])/;
const MENU_RULE = /\.fusion-(sm|hub)\b|\.fusion-sm-/;
// Size properties copied even without pixels ("padding: 0" must still win over a scaled base rule).
const LENGTH = /^(-?[a-z-]*(padding|margin|spacing|width|height|radius|size)[a-z-]*)$/;

let loaded = null; // {k, file, users}
let source = null;
let counter = 0;

function scaleValue(value, k) {
    return value.replace(/(-?\d*\.?\d+)px/g, (_m, n) => {
        const v = Number(n);
        if (v === 0)
            return '0px';
        const r = Math.round(v * k * 10) / 10;
        // Hairlines stay visible.
        return `${Math.abs(v) <= 1 ? Math.sign(v) * Math.max(1, Math.abs(r)) : r}px`;
    });
}

function scaleSelector(selector) {
    const parts = selector.trim().split(/(\s+|\s*>\s*)/);
    for (let i = 0; i < parts.length; i += 2) {
        if (ROOT_COMPOUND.test(parts[i])) {
            parts[i] += ROOT;
            return parts.join('');
        }
    }
    return `${ROOT} ${selector.trim()}`;
}

/** The start menu rules of `css` with their pixel values times `k`, under ROOT. */
export function scaleCss(css, k) {
    const out = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = m[1].split(',').map(x => x.trim()).filter(Boolean);
        if (!selectors.length || !selectors.every(x => MENU_RULE.test(x) && !x.includes('#panel')))
            continue;
        const decls = m[2].split(';').map(d => d.trim())
            .filter(d => /\dpx/.test(d) || (LENGTH.test(d.split(':')[0].trim()) && /:\s*[\d.]/.test(d)));
        if (!decls.length)
            continue;
        out.push(`${selectors.map(scaleSelector).join(',\n')} { ${decls.map(d => {
            const i = d.indexOf(':');
            return `${d.slice(0, i)}: ${scaleValue(d.slice(i + 1), k)}`;
        }).join('; ')}; }`);
    }
    return out.join('\n');
}

/** Load the scaled rules for `k` (shared by every scaled layout); returns a release function. */
export function useScaledStyles(extPath, k) {
    if (k === 1)
        return () => {};
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    if (loaded && loaded.k !== k && loaded.users === 0) {
        theme.unload_stylesheet(loaded.file);
        loaded = null;
    }
    if (!loaded) {
        try {
            source ??= new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([extPath, 'stylesheet.css']))[1]);
            const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'fusion-desk']);
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `menu-scale-${Date.now()}-${counter++}.css`]));
            file.replace_contents(new TextEncoder().encode(scaleCss(source, k)), null, false, Gio.FileCreateFlags.PRIVATE, null);
            theme.load_stylesheet(file);
            loaded = {k, file, users: 0};
        } catch (e) {
            console.error('Fusion Desk: scaled menu styles failed', e);
            return () => {};
        }
    }
    const mine = loaded;
    mine.users++;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        mine.users--;
        if (mine.users === 0 && loaded === mine) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(mine.file);
            try {
                mine.file.delete(null);
            } catch {
                // Already gone.
            }
            loaded = null;
        }
    };
}

/**
 * Icon sizes and fixed sizes set in code, times `k`, for `actor` and
 * everything added under it later. Sizes set after an actor joins the tree
 * are taken as already scaled.
 */
export function scaleTree(actor, k) {
    if (k === 1 || !actor || actor._fusionScaled)
        return;
    actor._fusionScaled = true;
    if (actor instanceof St.Icon && actor.icon_size > 0)
        actor.icon_size = Math.max(8, Math.round(actor.icon_size * k));
    // natural_width, not width: reading width measures the actor, which
    // fails (with log errors for it and its parents) before it is on stage.
    if (actor.natural_width_set && actor.natural_width > 0)
        actor.width = Math.round(actor.natural_width * k);
    if (actor.natural_height_set && actor.natural_height > 0)
        actor.height = Math.round(actor.natural_height * k);
    actor.connect('child-added', (_a, child) => scaleTree(child, k));
    for (const child of actor.get_children())
        scaleTree(child, k);
}
