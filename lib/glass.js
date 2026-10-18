// Glass surfaces: the taskbar, menus, start menu, control centre and
// launcher get a translucent (or, with the "solid gloss" material, opaque)
// base colour, and on top of it a picture drawn for the surface's exact size:
// the glass variant's shading, the accent gradient, a thin light rim and
// glare in the corners. CSS gradients cannot carry that (St drops the
// background image when a gradient is set), so the picture is a generated SVG
// in the runtime folder. "Light follows pointer" adds a soft light spot that
// moves with the pointer over the surface.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {accentFill, glassLevel, glassStyle} from './style.js';

// GNOME's accent colours (org.gnome.desktop.interface accent-color).
const ACCENTS = {
    blue: [53, 132, 228], teal: [33, 144, 164], green: [58, 148, 74], yellow: [200, 136, 0],
    orange: [237, 91, 0], red: [230, 45, 66], pink: [213, 97, 153], purple: [145, 65, 172],
    slate: [111, 131, 150],
};
// Sizes are rounded to this step so a surface that grows a little reuses its picture.
const STEP = 8;

const painted = new Set();
const written = new Set();
let iface = null;
let lightFile = null;

function folder() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'fusion-desk', 'glass']);
}

/** The system accent colour as [r, g, b]. */
function accentRgb() {
    return ACCENTS[iface?.get_string('accent-color')] ?? ACCENTS.blue;
}

/** CLEAR glass (see-through, blurred) or GLOSS (opaque, shiny). */
export function glassMaterial(settings) {
    return settings.get_string('glass-material') === 'GLOSS' ? 'GLOSS' : 'GLASS';
}

/** Whether surfaces should blur what is behind them. */
export function glassBlurs(settings) {
    return glassLevel(settings) > 0 && glassMaterial(settings) === 'GLASS';
}

/**
 * Opacity of a surface's base colour: opaque for solid gloss, the Glass
 * opacity setting for clear glass, else `fallback` (the surface's own).
 */
export function glassAlpha(settings, fallback, useOpacity = true) {
    if (!glassLevel(settings))
        return fallback;
    if (glassMaterial(settings) === 'GLOSS')
        return 1;
    return useOpacity ? settings.get_int('glass-opacity') / 100 : fallback;
}

function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
        h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

function write(name, svg) {
    const dir = folder();
    const path = GLib.build_filenamev([dir, name]);
    if (!written.has(path)) {
        GLib.mkdir_with_parents(dir, 0o700);
        GLib.file_set_contents(path, svg);
        written.add(path);
    }
    return path;
}

const stop = (offset, rgb, a) =>
    `<stop offset="${offset}" stop-color="rgb(${rgb.join(',')})" stop-opacity="${Math.max(0, Math.min(1, a)).toFixed(3)}"/>`;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** The picture on top of a glass surface (see the file comment). */
function overlaySvg(o) {
    const {w, h, r, k, light, material, style, accent, amount, rim, glare} = o;
    const defs = [];
    const body = [];
    const fill = (id, grad) => {
        defs.push(grad.replace('ID', id));
        body.push(`<rect width="${w}" height="${h}" fill="url(#${id})"/>`);
    };
    const vertical = (id, stops) => fill(id, `<linearGradient id="ID" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`);

    if (material === 'GLOSS') {
        // Polished plastic: bright specular band over the top half, deeper bottom.
        // The band is capped in height so tall menus keep a readable body.
        const band = Math.min(h * 0.5, Math.max(28, h * 0.22, 140));
        defs.push(`<linearGradient id="band" x1="0" y1="0" x2="0" y2="1">${stop(0, WHITE, (light ? 0.75 : 0.34) * k)}` +
            `${stop(0.85, WHITE, (light ? 0.3 : 0.08) * k)}${stop(1, WHITE, (light ? 0.2 : 0.04) * k)}</linearGradient>`);
        body.push(`<rect width="${w}" height="${band.toFixed(1)}" fill="url(#band)"/>`);
        defs.push(`<linearGradient id="deep" x1="0" y1="0" x2="0" y2="1">${stop(0, BLACK, 0)}${stop(1, BLACK, (light ? 0.1 : 0.22) * k)}</linearGradient>`);
        body.push(`<rect y="${band.toFixed(1)}" width="${w}" height="${(h - band).toFixed(1)}" fill="url(#deep)"/>`);
    } else {
        switch (style) {
        case 'FROSTED':
            vertical('s', stop(0, WHITE, 0.30 * k) + stop(1, WHITE, 0.16 * k));
            break;
        case 'GEL':
            vertical('s', stop(0, WHITE, 0.42 * k) + stop(1, BLACK, 0.12 * k));
            break;
        case 'TINTED':
            vertical('s', stop(0, accent, 0.38 * k) + stop(1, accent, 0.14 * k));
            break;
        case 'SMOKE':
            vertical('s', stop(0, BLACK, 0.08 * k) + stop(1, BLACK, 0.28 * k));
            break;
        case 'HALO':
            fill('s', `<radialGradient id="ID" cx="0.5" cy="0.5" r="0.6">${stop(0, WHITE, 0.26 * k)}${stop(1, WHITE, 0)}</radialGradient>`);
            break;
        default: // CLEAR
            vertical('s', stop(0, WHITE, 0.20 * k) + stop(1, WHITE, 0));
        }
    }
    if (amount && style !== 'TINTED')
        vertical('a', stop(0, accent, amount / 100) + stop(1, accent, 0));

    if (glare) {
        // Light catching the glass: a soft glow near the top-left corner and
        // a sheen in the bottom-right corner.
        const R = Math.round(Math.min(Math.max(w, h) * 0.45, Math.max(Math.min(w, h) * 1.6, 60)));
        const a = (light ? 0.5 : 0.3) * k * (material === 'GLOSS' ? 0.6 : 1);
        defs.push(`<radialGradient id="g1" gradientUnits="userSpaceOnUse" cx="${Math.round(R * 0.3)}" cy="${Math.round(R * 0.2)}" r="${R}">` +
            `${stop(0, WHITE, a)}${stop(0.45, WHITE, a * 0.35)}${stop(1, WHITE, 0)}</radialGradient>`);
        body.push(`<rect width="${w}" height="${h}" fill="url(#g1)"/>`);
        const S = Math.round(Math.min(R * 0.55, w, h));
        defs.push(`<linearGradient id="g2" gradientUnits="userSpaceOnUse" x1="${w}" y1="${h}" x2="${w - S}" y2="${h - S}">` +
            `${stop(0, WHITE, a * 1.1)}${stop(0.35, WHITE, a * 0.3)}${stop(1, WHITE, 0)}</linearGradient>`);
        body.push(`<rect width="${w}" height="${h}" fill="url(#g2)"/>`);
    }

    if (rim) {
        const ri = Math.max(0, r - 0.5);
        const rect = `x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${ri}" ry="${ri}" fill="none" stroke-width="1"`;
        if (material === 'GLOSS') {
            // Sharp white inner highlight on top, darker bevel at the bottom.
            defs.push(`<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">${stop(0, WHITE, 0.95)}${stop(0.18, WHITE, 0.3)}` +
                `${stop(0.8, BLACK, 0)}${stop(1, BLACK, 0.38)}</linearGradient>`);
        } else {
            // Thin stroke that catches the light at top-left and bottom-right.
            const a = light ? 0.95 : 0.55;
            defs.push(`<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">${stop(0, WHITE, a)}${stop(0.3, WHITE, a * 0.3)}` +
                `${stop(0.7, WHITE, a * 0.15)}${stop(1, WHITE, a * 0.7)}</linearGradient>`);
        }
        body.push(`<rect ${rect} stroke="url(#rim)"/>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs>${defs.join('')}<clipPath id="c"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></clipPath></defs>` +
        `<g clip-path="url(#c)">${body.join('')}</g></svg>`;
}

function lightSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
        `<defs><radialGradient id="l" cx="0.5" cy="0.5" r="0.5">${stop(0, WHITE, 0.32)}${stop(0.4, WHITE, 0.12)}${stop(1, WHITE, 0)}</radialGradient></defs>` +
        '<rect width="256" height="256" fill="url(#l)"/></svg>';
}

function watchAccent() {
    if (iface)
        return;
    iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    iface.connect('changed::accent-color', () => {
        for (const actor of painted)
            update(actor);
    });
}

function cornerRadius(actor) {
    try {
        return Math.round(actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT));
    } catch (e) {
        return 0;
    }
}

// A shadow must not sit on the surface itself: St draws a box shadow next to
// a background image as a hard dark rectangle, and a blur behind the surface
// would spread over the shadow's area. Surfaces get it from their parent bin
// (menus) or from a twin right behind them (control centre, launcher, desktop
// collections); surfaces in other layouts (the taskbar) go without.
const SHADOW = 'box-shadow: 0 12px 32px -6px rgba(0, 0, 0, 0.34);';
const GLOSS_SHADOW = 'box-shadow: 0 4px 14px rgba(0, 0, 0, 0.38);';

function setShadowBehind(actor, css, radius) {
    const parent = actor.get_parent();
    if (parent instanceof St.Bin && !actor._fusionShadowTwin) {
        const style = css ? `${css} border-radius: ${radius}px;` : null;
        if (parent.style !== style)
            parent.set_style(style);
        actor._fusionShadowBin = css ? parent : null;
        return;
    }
    let twin = actor._fusionShadowTwin;
    const lm = parent?.layout_manager;
    if (!css || !parent || (lm && !(lm instanceof Clutter.FixedLayout))) {
        removeShadowTwin(actor);
        return;
    }
    if (!twin) {
        twin = actor._fusionShadowTwin = new St.Widget({reactive: false});
        parent.insert_child_below(twin, actor);
        const sync = () => {
            twin.set_position(actor.x, actor.y);
            twin.set_size(actor.width, actor.height);
            twin.translation_x = actor.translation_x;
            twin.translation_y = actor.translation_y;
            twin.visible = actor.visible;
            twin.opacity = actor.opacity;
        };
        actor._fusionTwinIds = ['notify::allocation', 'notify::translation-x', 'notify::translation-y',
            'notify::visible', 'notify::opacity'].map(n => actor.connect(n, sync));
        sync();
    }
    const style = `${css} border-radius: ${radius}px;`;
    if (twin.style !== style)
        twin.set_style(style);
}

function removeShadowTwin(actor) {
    for (const id of actor._fusionTwinIds ?? [])
        actor.disconnect(id);
    actor._fusionTwinIds = null;
    actor._fusionShadowTwin?.destroy();
    actor._fusionShadowTwin = null;
}

function removeShadows(actor) {
    removeShadowTwin(actor);
    actor._fusionShadowBin?.set_style(null);
    actor._fusionShadowBin = null;
}

function update(actor) {
    const g = actor._fusionGlass;
    if (!g)
        return;
    const s = g.settings;
    const level = glassLevel(s);
    if (!level) {
        removeShadows(actor);
        actor.set_style(`${accentFill(s, g.base, g.amount)} ${g.extra}`);
        return;
    }
    const material = glassMaterial(s);
    let shadow = '';
    if (s.get_boolean('glass-shadow') && g.shadow)
        shadow = material === 'GLOSS' ? GLOSS_SHADOW : SHADOW;
    // No CSS gradient: St would drop the picture (a theme may set one).
    let css = `background-color: ${g.base}; background-gradient-direction: none; box-shadow: none; ${g.extra}`;
    const w = Math.ceil(actor.width / STEP) * STEP;
    const h = Math.ceil(actor.height / STEP) * STEP;
    if (w >= STEP && h >= STEP && actor.get_stage()) {
        // Set the base first so the theme node knows the corner radius.
        if (actor._fusionGlassBase !== css) {
            actor.set_style(css);
            actor._fusionGlassBase = css;
        }
        const radius = cornerRadius(actor);
        if (shadow)
            setShadowBehind(actor, shadow, radius);
        else
            removeShadows(actor);
        const o = {
            w, h, r: Math.min(radius, Math.floor(Math.min(w, h) / 2)),
            k: level === 2 ? 1 : 0.6, light: g.light, material, style: glassStyle(s), accent: accentRgb(),
            amount: s.get_boolean('accent-gradient') ? g.amount : 0,
            rim: s.get_boolean('glass-rim'), glare: s.get_boolean('glass-glare'),
        };
        const path = write(`${hash(JSON.stringify(o))}.svg`, overlaySvg(o));
        css += ` background-image: url("file://${path}"); background-size: ${Math.round(actor.width)}px ${Math.round(actor.height)}px;`;
    }
    if (actor.style !== css)
        actor.set_style(css);
}

/**
 * Paint `actor` as a glass surface. `base` is its CSS base colour (already
 * with the right opacity), `light` whether that colour is light, `amount`
 * the accent gradient strength, `extra` more inline CSS (margins, radius),
 * `shadow` whether it may cast one. With the glass effect off it gets the plain fill (with accent
 * gradient). Repaints when the actor's size changes; call again when
 * settings change.
 */
export function paintGlass(actor, settings, {base, light = false, amount = 18, extra = '', shadow = true}) {
    watchAccent();
    actor._fusionGlass = {settings, base, light, amount, extra, shadow};
    if (!painted.has(actor)) {
        painted.add(actor);
        let id = 0;
        const queue = () => {
            if (id)
                return;
            id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                id = 0;
                update(actor);
                return GLib.SOURCE_REMOVE;
            });
        };
        actor._fusionGlassIds = [
            actor.connect('notify::width', queue),
            actor.connect('notify::height', queue),
            actor.connect('notify::mapped', queue),
            actor.connect('captured-event', (_a, event) => lightEvent(actor, event)),
            actor.connect('destroy', () => {
                if (id)
                    GLib.source_remove(id);
                id = 0;
                removeLight(actor);
                removeShadows(actor);
                painted.delete(actor);
            }),
        ];
        actor._fusionGlassCancel = () => {
            if (id)
                GLib.source_remove(id);
            id = 0;
        };
    }
    update(actor);
}

/** Undo paintGlass (the actor gets its theme look back). */
export function unpaintGlass(actor) {
    if (!actor._fusionGlass)
        return;
    actor._fusionGlassCancel?.();
    for (const id of actor._fusionGlassIds ?? [])
        actor.disconnect(id);
    removeLight(actor);
    removeShadows(actor);
    painted.delete(actor);
    delete actor._fusionGlass;
    delete actor._fusionGlassIds;
    delete actor._fusionGlassBase;
    delete actor._fusionGlassCancel;
    actor.set_style(null);
}

// ---- light that follows the pointer ----------------------------------------

function lightEvent(actor, event) {
    const g = actor._fusionGlass;
    const type = event.type();
    if (type === Clutter.EventType.LEAVE) {
        const to = event.get_related();
        if (!to || (to !== actor && !actor.contains(to)))
            removeLight(actor);
        return Clutter.EVENT_PROPAGATE;
    }
    if (type !== Clutter.EventType.MOTION || !g || !glassLevel(g.settings) || !g.settings.get_boolean('glass-light-follows'))
        return Clutter.EVENT_PROPAGATE;
    const [sx, sy] = event.get_coords();
    const [ok, x, y] = actor.transform_stage_point(sx, sy);
    if (!ok)
        return Clutter.EVENT_PROPAGATE;
    let spot = actor._fusionGlassLight;
    if (!spot) {
        lightFile ??= write('light.svg', lightSvg());
        spot = actor._fusionGlassLight = new St.Widget({reactive: false, style_class: 'fusion-glass-light'});
        spot.set_clip_to_allocation(true);
        Main.uiGroup.add_child(spot);
    }
    const [ax, ay] = actor.get_transformed_position();
    spot.set_position(Math.round(ax), Math.round(ay));
    spot.set_size(Math.round(actor.width), Math.round(actor.height));
    const d = Math.round(Math.min(360, Math.max(120, Math.min(actor.width, actor.height) * 1.2)));
    spot.set_style(`background-image: url("file://${lightFile}"); background-size: ${d}px ${d}px; ` +
        `background-position: ${Math.round(x - d / 2)}px ${Math.round(y - d / 2)}px;`);
    return Clutter.EVENT_PROPAGATE;
}

function removeLight(actor) {
    actor._fusionGlassLight?.destroy();
    actor._fusionGlassLight = null;
}

/** Repaint every glass surface (e.g. after a glass setting changed). */
export function repaintGlass() {
    for (const actor of painted)
        update(actor);
}

/** Called when Fusion Desk stops: forget watchers and remove the pictures. */
export function cleanupGlass() {
    for (const actor of [...painted])
        unpaintGlass(actor);
    iface?.run_dispose();
    iface = null;
    lightFile = null;
    written.clear();
    // Also pictures left by an earlier shell session.
    try {
        const dir = Gio.File.new_for_path(folder());
        const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = en.next_file(null));)
            dir.get_child(info.get_name()).delete(null);
    } catch (e) {
        // No folder yet.
    }
}
