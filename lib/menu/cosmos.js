// Space scenes behind the Dashboard layout. CosmicScene is drawn in code (no
// picture): nebula, stars, a large planet with moons, layered mountains, a
// glowing horizon and a lake that mirrors the sky. The still scene is drawn
// once with Cairo (again only when its size or horizon changes). StarMotion,
// twinkling stars, shooting stars and a slow drift, is cheap Clutter
// animation that runs only while the menu is open, and not at all with
// reduced motion.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const TWINKLES = 40;
const STILL_STARS = 420;

/** Small seeded random generator, so the scene looks the same on every paint. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Animations wanted: GNOME animations on and reduced motion off. */
function motionAllowed() {
    if (!St.Settings.get().enable_animations)
        return false;
    try {
        return new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}).get_string('reduced-motion') !== 'reduce';
    } catch {
        return true;
    }
}

function roundedRect(cr, w, h, [tl, tr, br, bl]) {
    cr.newPath();
    cr.moveTo(tl, 0);
    cr.lineTo(w - tr, 0);
    cr.arc(w - tr, tr, tr, -Math.PI / 2, 0);
    cr.lineTo(w, h - br);
    cr.arc(w - br, h - br, br, 0, Math.PI / 2);
    cr.lineTo(bl, h);
    cr.arc(bl, h - bl, bl, Math.PI / 2, Math.PI);
    cr.lineTo(0, tl);
    cr.arc(tl, tl, tl, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function glow(cr, x, y, r, [red, green, blue], alpha) {
    const g = new Cairo.RadialGradient(x, y, 0, x, y, r);
    g.addColorStopRGBA(0, red, green, blue, alpha);
    g.addColorStopRGBA(1, red, green, blue, 0);
    cr.setSource(g);
    cr.arc(x, y, r, 0, 2 * Math.PI);
    cr.fill();
}

/**
 * Ridge line of a mountain range, [x, y] points from left to right: jagged
 * peaks of `amp` height, rising by `edge` towards the sides.
 */
function ridge(rand, w, base, amp, edge, peaks) {
    const tops = [];
    for (let i = 0; i < peaks; i++) {
        const x = rand() * w;
        const side = Math.abs(x / w - 0.5) * 2;
        // Low in the middle (the planet shows above them), taller at the sides.
        tops.push([x, amp * (0.25 + 0.75 * side) * (0.35 + rand() * 0.65) + edge * side ** 2 * (0.6 + rand() * 0.6), 0.9 + rand() * 1.1]);
    }
    // Rugged slopes: a few sine waves of random phase on top of the peaks.
    const waves = [[0.045, 0.30], [0.11, 0.16], [0.27, 0.08]].map(([f, a]) => [f, a * amp, rand() * 6.3]);
    const pts = [];
    for (let x = -8; x <= w + 8; x += 3) {
        let hgt = 0;
        for (const [px, ph, slope] of tops)
            hgt = Math.max(hgt, ph - Math.abs(x - px) * slope);
        const rough = waves.reduce((sum, [f, a, p]) => sum + Math.sin(x * f + p) * a, 0);
        pts.push([x, base - Math.max(2, hgt + rough * Math.min(1, hgt / amp)) - rand() * 2]);
    }
    return pts;
}

function fillRange(cr, pts, bottom, [r1, g1, b1], [r2, g2, b2], snow = 0) {
    const minY = Math.min(...pts.map(p => p[1]));
    if (minY >= bottom - 1)
        return;
    cr.newPath();
    cr.moveTo(pts[0][0], bottom);
    pts.forEach(([x, y]) => cr.lineTo(x, y));
    cr.lineTo(pts.at(-1)[0], bottom);
    cr.closePath();
    const g = new Cairo.LinearGradient(0, minY, 0, bottom);
    g.addColorStopRGBA(0, r1, g1, b1, 1);
    g.addColorStopRGBA(1, r2, g2, b2, 1);
    cr.setSource(g);
    cr.fill();
    if (snow) {
        // Snowy, lit ridges.
        cr.newPath();
        pts.forEach(([x, y], i) => i ? cr.lineTo(x, y) : cr.moveTo(x, y));
        cr.setSourceRGBA(0.92, 0.90, 1, snow);
        cr.setLineWidth(1.6);
        cr.stroke();
        // Snow below the ridge, fading downwards.
        cr.newPath();
        pts.forEach(([x, y], i) => i ? cr.lineTo(x, y) : cr.moveTo(x, y));
        [...pts].reverse().forEach(([x, y]) => cr.lineTo(x, y + 14));
        cr.closePath();
        const g = new Cairo.LinearGradient(0, minY, 0, minY + 60);
        g.addColorStopRGBA(0, 0.95, 0.93, 1, snow * 0.7);
        g.addColorStopRGBA(1, 0.95, 0.93, 1, 0);
        cr.setSource(g);
        cr.fill();
    }
}

/** The sky: gradient, nebula band, stars, moons, planet and clouds (also used for the reflection). */
function drawSky(cr, w, h, horizon) {
    const rand = random(7);
    const sky = new Cairo.LinearGradient(0, 0, 0, horizon);
    sky.addColorStopRGBA(0, 0.04, 0.07, 0.30, 1);
    sky.addColorStopRGBA(0.45, 0.16, 0.20, 0.62, 1);
    sky.addColorStopRGBA(0.8, 0.50, 0.40, 0.82, 1);
    sky.addColorStopRGBA(1, 0.98, 0.72, 0.80, 1);
    cr.setSource(sky);
    cr.rectangle(0, 0, w, horizon);
    cr.fill();

    // Nebula: soft cyan, violet and pink clouds along a band from the lower
    // left to the upper right, with a bright core.
    cr.setOperator(Cairo.Operator.ADD);
    const colours = [[0.25, 0.75, 1.0], [0.55, 0.35, 1.0], [1.0, 0.45, 0.80], [0.40, 0.55, 1.0]];
    for (let i = 0; i < 70; i++) {
        const t = rand();
        const x = w * (0.05 + t * 0.95) + (rand() - 0.5) * w * 0.25;
        const y = horizon * (0.85 - t * 0.85) + (rand() - 0.5) * horizon * 0.25;
        glow(cr, x, y, w * (0.05 + rand() * 0.13), colours[i % colours.length], 0.06 + rand() * 0.11);
    }
    glow(cr, w * 0.68, horizon * 0.17, w * 0.16, [1.0, 0.75, 0.85], 0.30);
    glow(cr, w * 0.68, horizon * 0.17, w * 0.04, [1.0, 0.95, 0.95], 0.55);
    glow(cr, w * 0.95, horizon * 0.75, w * 0.30, [1.0, 0.70, 0.55], 0.28);
    cr.setOperator(Cairo.Operator.OVER);

    // Still stars, a few with glints.
    for (let i = 0; i < STILL_STARS; i++) {
        const x = rand() * w, y = rand() * horizon * 0.95;
        const s = rand() ** 3 * 1.6 + 0.35;
        cr.setSourceRGBA(1, 1, 1, 0.35 + rand() * 0.6);
        cr.arc(x, y, s, 0, 2 * Math.PI);
        cr.fill();
        if (s > 1.5) {
            glow(cr, x, y, s * 5, [0.8, 0.85, 1], 0.5);
            cr.setSourceRGBA(1, 1, 1, 0.5);
            cr.setLineWidth(0.8);
            cr.moveTo(x - s * 5, y);
            cr.lineTo(x + s * 5, y);
            cr.moveTo(x, y - s * 5);
            cr.lineTo(x, y + s * 5);
            cr.stroke();
        }
    }

    // Small moons.
    for (const [mx, my, mr] of [[0.13, 0.22, 0.045], [0.93, 0.26, 0.022], [0.86, 0.55, 0.012], [0.19, 0.27, 0.010]]) {
        const [x, y, r] = [w * mx, horizon * my, w * mr];
        glow(cr, x, y, r * 1.8, [0.7, 0.75, 1], 0.25);
        const m = new Cairo.RadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
        m.addColorStopRGBA(0, 0.85, 0.85, 0.95, 1);
        m.addColorStopRGBA(0.7, 0.42, 0.42, 0.62, 1);
        m.addColorStopRGBA(1, 0.18, 0.18, 0.35, 1);
        cr.setSource(m);
        cr.arc(x, y, r, 0, 2 * Math.PI);
        cr.fill();
    }

    // Glowing horizon behind the planet.
    cr.setOperator(Cairo.Operator.ADD);
    glow(cr, w * 0.66, horizon, w * 0.40, [1.0, 0.68, 0.55], 0.38);
    glow(cr, w * 0.70, horizon, w * 0.09, [1.0, 0.92, 0.85], 0.60);
    cr.setOperator(Cairo.Operator.OVER);

    // The planet: lit from the upper left, warm rim light from the horizon,
    // a faint surface texture and a glowing atmosphere.
    const [px, pr] = [w * 0.52, w * 0.22];
    const py = horizon + pr * 0.12;
    glow(cr, px, py, pr * 1.16, [0.70, 0.66, 1.0], 0.35);
    cr.save();
    cr.arc(px, py, pr, 0, 2 * Math.PI);
    cr.clip();
    const body = new Cairo.RadialGradient(px - pr * 0.45, py - pr * 0.55, pr * 0.1, px, py, pr * 1.05);
    body.addColorStopRGBA(0, 0.58, 0.68, 1.0, 1);
    body.addColorStopRGBA(0.55, 0.30, 0.36, 0.82, 1);
    body.addColorStopRGBA(1, 0.12, 0.10, 0.40, 1);
    cr.setSource(body);
    cr.paint();
    const texture = random(11);
    // Surface: pale blue continents and darker basins.
    for (let i = 0; i < 160; i++) {
        const a = texture() * 2 * Math.PI, d = Math.sqrt(texture()) * pr;
        const x = px + Math.cos(a) * d, y = py + Math.sin(a) * d;
        const light = texture() < 0.55;
        glow(cr, x, y, pr * (0.03 + texture() * 0.12), light ? [0.62, 0.74, 1.0] : [0.08, 0.08, 0.30], light ? 0.12 + texture() * 0.16 : 0.22 + texture() * 0.25);
    }
    const rim = new Cairo.RadialGradient(px + pr * 0.9, py + pr * 0.2, 0, px + pr * 0.9, py + pr * 0.2, pr * 1.1);
    rim.addColorStopRGBA(0, 1.0, 0.62, 0.48, 0.85);
    rim.addColorStopRGBA(1, 1.0, 0.65, 0.50, 0);
    cr.setSource(rim);
    cr.paint();
    cr.restore();

    // Soft pink cloud banks along the horizon, at the sides of the planet.
    for (const [cx, spread] of [[0.14, 0.20], [0.86, 0.18], [0.36, 0.08], [0.70, 0.08]]) {
        for (let i = 0; i < 40; i++) {
            const x = w * (cx + (rand() - 0.5) * spread * 2);
            const y = horizon - 6 - rand() ** 1.5 * horizon * 0.16;
            glow(cr, x, y, w * (0.02 + rand() * 0.035), [1.0, 0.74 + rand() * 0.16, 0.88], 0.16 + rand() * 0.16);
        }
    }
}

function paint(area, horizonShare, radius) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const horizon = Math.round(h * horizonShare);
    roundedRect(cr, w, h, radius);
    cr.clip();

    // Sky and mountains, drawn once into a group so the lake can mirror them.
    cr.pushGroup();
    drawSky(cr, w, h, horizon);
    // Far, middle and near ranges, low in the middle and taller at the sides.
    const m = random(5);
    fillRange(cr, ridge(m, w, horizon + 1, 26, 40, 28), horizon + 2, [0.62, 0.58, 0.90], [0.40, 0.36, 0.74], 0.35);
    fillRange(cr, ridge(m, w, horizon + 1, 34, 110, 22), horizon + 2, [0.44, 0.40, 0.80], [0.20, 0.18, 0.50], 0.50);
    fillRange(cr, ridge(m, w, horizon + 1, 20, 170, 16), horizon + 2, [0.26, 0.22, 0.56], [0.10, 0.09, 0.28], 0.40);
    const scene = cr.popGroup();
    cr.setSource(scene);
    cr.rectangle(0, 0, w, horizon + 1);
    cr.fill();

    // Lake: gradient, then the mirrored scene, a sun path and ripples.
    const lake = new Cairo.LinearGradient(0, horizon, 0, h);
    lake.addColorStopRGBA(0, 0.62, 0.55, 0.92, 1);
    lake.addColorStopRGBA(1, 0.10, 0.12, 0.40, 1);
    cr.setSource(lake);
    cr.rectangle(0, horizon, w, h - horizon);
    cr.fill();
    cr.save();
    cr.rectangle(0, horizon, w, h - horizon);
    cr.clip();
    cr.translate(0, 2 * horizon);
    cr.scale(1, -1);
    cr.setSource(scene);
    cr.paintWithAlpha(0.55);
    cr.restore();
    const path = new Cairo.LinearGradient(w * 0.45, 0, w * 0.8, 0);
    path.addColorStopRGBA(0, 1, 0.85, 0.75, 0);
    path.addColorStopRGBA(0.5, 1, 0.85, 0.75, 0.35);
    path.addColorStopRGBA(1, 1, 0.85, 0.75, 0);
    cr.setSource(path);
    cr.rectangle(w * 0.45, horizon, w * 0.35, (h - horizon) * 0.7);
    cr.fill();
    const rand = random(23);
    cr.setLineWidth(1);
    for (let i = 0; i < 140; i++) {
        const y = horizon + 4 + rand() ** 1.6 * (h - horizon);
        const x = rand() * w, len = 8 + rand() * 50;
        cr.setSourceRGBA(0.95, 0.9, 1, 0.08 + rand() * 0.14);
        cr.moveTo(x, y);
        cr.lineTo(x + len, y);
        cr.stroke();
    }
    // Shore line glow.
    const shore = new Cairo.LinearGradient(0, horizon - 2, 0, horizon + 6);
    shore.addColorStopRGBA(0, 1, 0.9, 0.95, 0);
    shore.addColorStopRGBA(0.5, 1, 0.9, 0.95, 0.45);
    shore.addColorStopRGBA(1, 1, 0.9, 0.95, 0);
    cr.setSource(shore);
    cr.rectangle(0, horizon - 2, w, 8);
    cr.fill();

    // Rocks on the near shore.
    for (const [x0, x1, top] of [[-0.02, 0.22, 0.90], [0.80, 1.02, 0.87]]) {
        const r = random(Math.round(x0 * 100) + 31);
        cr.newPath();
        cr.moveTo(w * x0, h);
        for (let x = x0; x <= x1; x += 0.008)
            cr.lineTo(w * x, h * (top + r() * 0.025 + Math.abs(x - (x0 + x1) / 2) * 0.22));
        cr.lineTo(w * x1, h);
        cr.closePath();
        cr.setSourceRGBA(0.07, 0.06, 0.18, 0.95);
        cr.fill();
    }
    cr.$dispose();
}

/**
 * Moving sky: twinkling stars, shooting stars and a slow drift, as small
 * Clutter actors. Shared by the drawn scene and the Space pictures (there it
 * sits between the sky picture and the planet overlay). Never reactive.
 */
export class StarMotion {
    constructor() {
        this._horizon = 0.53;
        this.actor = new St.Widget({x_expand: true, y_expand: true, reactive: false});
        this._shots = new Set();
    }

    /** Horizon height as a share of the scene height: stars stay above it. */
    setHorizon(share) {
        if (!Number.isFinite(share))
            return;
        this._horizon = Math.max(0.2, Math.min(0.9, share));
        if (this._stars)
            this._placeStars();
    }

    _placeStars() {
        if (!this.actor.get_stage())
            return; // placed again when the menu opens
        const rand = random(99);
        const [w, h] = [this.actor.width || 946, this.actor.height || 980];
        for (const star of this._stars)
            star.set_position(Math.round(rand() * w), Math.round(rand() * h * this._horizon * 0.9));
    }

    /** Start the twinkling, drift and shooting stars (menu opened). */
    start() {
        this.stop();
        if (!motionAllowed())
            return;
        if (!this._stars) {
            const rand = random(42);
            this._stars = [];
            for (let i = 0; i < TWINKLES; i++) {
                const s = 2 + Math.round(rand() * 2);
                const star = new St.Widget({width: s, height: s, reactive: false,
                    style: `border-radius: ${s}px; background-color: rgba(255, 255, 255, 0.95); ` +
                        `box-shadow: 0 0 ${s * 3}px rgba(190, 210, 255, 0.9);`});
                star._speed = 900 + rand() * 2200;
                this.actor.add_child(star);
                this._stars.push(star);
            }
        }
        this._placeStars();
        for (const star of this._stars) {
            star.opacity = 60;
            star.ease({opacity: 255, duration: star._speed, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1, autoReverse: true});
        }
        // A slow drift of the star layer: a little depth against the still scene.
        this.actor.translation_x = -4;
        this.actor.ease({translation_x: 4, duration: 20000, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: -1, autoReverse: true});
        this._queueShot();
    }

    _queueShot() {
        this._shotId = GLib.timeout_add(GLib.PRIORITY_LOW, 2500 + Math.random() * 6000, () => {
            this._shotId = 0;
            this._shoot();
            this._queueShot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _shoot() {
        const [w, h] = [this.actor.width || 946, this.actor.height || 980];
        const shot = new St.Widget({width: 130, height: 2, reactive: false, opacity: 0,
            style: 'border-radius: 2px; background-gradient-direction: horizontal; ' +
                'background-gradient-start: rgba(255, 255, 255, 0); background-gradient-end: rgba(255, 255, 255, 0.95);'});
        shot.set_pivot_point(1, 0.5);
        shot.rotation_angle_z = 18 + Math.random() * 14;
        shot.set_position(Math.round(Math.random() * w * 0.7), Math.round(Math.random() * h * this._horizon * 0.45));
        this.actor.add_child(shot);
        this._shots.add(shot);
        const angle = shot.rotation_angle_z * Math.PI / 180;
        shot.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        shot.ease({translation_x: Math.cos(angle) * 240, translation_y: Math.sin(angle) * 240, duration: 950,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._shots.delete(shot);
                shot.destroy();
            }});
        // Fade out towards the end.
        shot._fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            shot._fadeId = 0;
            shot.ease({opacity: 0, duration: 330, mode: Clutter.AnimationMode.EASE_IN_QUAD});
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stop every animation (menu closed or the scene is not shown). */
    stop() {
        if (this._shotId)
            GLib.source_remove(this._shotId);
        this._shotId = 0;
        for (const shot of this._shots) {
            if (shot._fadeId)
                GLib.source_remove(shot._fadeId);
            shot.destroy();
        }
        this._shots.clear();
        this.actor.remove_all_transitions();
        for (const star of this._stars ?? [])
            star.remove_all_transitions();
    }

    destroy() {
        this.stop();
        this.actor.destroy();
    }
}

export class CosmicScene {
    constructor() {
        this._horizon = 0.53;
        this._radius = [0, 0, 0, 0];
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true, reactive: false});
        this._area = new St.DrawingArea({x_expand: true, y_expand: true, reactive: false});
        this._area.connect('repaint', a => paint(a, this._horizon, this._radius));
        this.actor.add_child(this._area);
        this._motion = new StarMotion();
        this.actor.add_child(this._motion.actor);
    }

    /** Horizon height as a share of the scene height (0–1). */
    setHorizon(share) {
        share = Math.max(0.2, Math.min(0.85, share));
        if (Math.abs(share - this._horizon) < 0.002)
            return;
        this._horizon = share;
        this._area.queue_repaint();
        this._motion.setHorizon(share);
    }

    /** Corner radii [top-left, top-right, bottom-right, bottom-left]. */
    setRadius(radius) {
        if (radius.join() === this._radius.join())
            return;
        this._radius = radius;
        this._area.queue_repaint();
    }

    start() {
        this._motion.start();
    }

    stop() {
        this._motion.stop();
    }

    destroy() {
        this._motion.stop();
        this.actor.destroy();
    }
}
