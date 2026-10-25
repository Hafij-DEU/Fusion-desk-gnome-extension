// Window open / close effects: Fire (the window burns away from the bottom
// up, or rises out of the flames when it opens), Dissolve (it crumbles into
// noise) and Glide (it slides and fades). Written for Fusion Desk: own
// shader, no code from other extensions.
//
// GNOME's own map / destroy handlers are blocked while this runs; windows
// this module does not animate are handed back to them unchanged.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT = 'fusion-window-effect';

const DECLARATIONS = `
uniform float progress;
uniform float fire;
uniform float time;
uniform vec2 seed;

float fusion_hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float fusion_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fusion_hash(i), fusion_hash(i + vec2(1.0, 0.0)), u.x),
               mix(fusion_hash(i + vec2(0.0, 1.0)), fusion_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fusion_fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * fusion_noise(p);
        p = p * 2.03 + vec2(1.7, 9.2);
        a *= 0.5;
    }
    return v;
}

// Black body ramp: dark red, orange, yellow, white as the heat rises.
vec3 fusion_flame(float h) {
    vec3 c = mix(vec3(0.45, 0.03, 0.0), vec3(0.95, 0.28, 0.02), smoothstep(0.05, 0.4, h));
    c = mix(c, vec3(1.0, 0.62, 0.08), smoothstep(0.4, 0.7, h));
    c = mix(c, vec3(1.0, 0.85, 0.35), smoothstep(0.7, 0.9, h));
    return mix(c, vec3(1.0, 0.96, 0.8), smoothstep(0.93, 1.0, h));
}
`;

// cogl_color_out holds the window's (premultiplied) colour.
// Fire: a ragged burning front climbs the window from below; flames lick
// upwards from it, the window chars just ahead of them, and behind it only
// fading embers remain. Dissolve: the window crumbles into noise.
const CODE = `
vec2 uv = cogl_tex_coord_in[0].st;
float body = cogl_color_out.a;
if (fire > 0.5) {
    float y = 1.0 - uv.y;
    // Rising, flickering turbulence (warped twice so it curls like flame).
    vec2 q = vec2(uv.x * 5.0, y * 3.0 - time * 2.2) + seed;
    vec2 w = vec2(fusion_fbm(q + vec2(0.0, time * 0.6)), fusion_fbm(q + vec2(5.2, 1.3)));
    float turb = fusion_fbm(q + 1.8 * w);
    // Burning front: wavy line from below the window to above it.
    float front = mix(-0.35, 1.3, progress) + 0.18 * (fusion_fbm(vec2(uv.x * 2.5, time * 0.4) + seed) - 0.5);
    float above = y - front;
    // Window left: ragged edge right at the front.
    float keep = smoothstep(-0.01, 0.02, above + (turb - 0.5) * 0.08);
    // Flames: separate tongues (noise stretched upwards) that reach different heights.
    float h = above / 0.34;
    float tongues = fusion_fbm(vec2(uv.x * 9.0, y * 2.2 - time * 2.6) + seed + 1.6 * w);
    float flame = smoothstep(h - 0.05, h + 0.2, tongues * 1.35 - 0.12) * step(-0.02, above) * step(h, 1.0);
    // Hottest at the base of each tongue.
    float heat = flame * pow(clamp(1.0 - h, 0.0, 1.0), 0.8) * (0.55 + 0.6 * tongues);
    // Embers behind the front, dying out.
    float ember = exp(min(above, 0.0) * 30.0) * step(above, 0.0) * smoothstep(0.5, 0.8, turb);
    heat = clamp(max(heat, ember * 0.6), 0.0, 1.0);
    // Scorch: the window darkens to brown just ahead of the flames, in patches.
    float scorch = clamp(1.0 - above / 0.14, 0.0, 1.0) * keep * (0.6 + 0.4 * turb);
    vec4 win = cogl_color_out * keep;
    win.rgb = mix(win.rgb, vec3(0.12, 0.05, 0.02) * win.a, 0.85 * scorch * scorch);
    float fa = smoothstep(0.04, 0.35, heat) * max(body, 0.25 * step(0.01, body));
    cogl_color_out = vec4(win.rgb * (1.0 - fa) + fusion_flame(heat) * fa, max(win.a, fa));
} else {
    float n = fusion_fbm(uv * vec2(9.0, 6.0) + seed);
    float d = n - (progress * 1.2 - 0.1);
    float keep = smoothstep(0.0, 0.04, d);
    // A thin light rim where it crumbles.
    float rim = (1.0 - smoothstep(0.0, 0.05, d)) * step(0.0, d) * body;
    vec4 win = cogl_color_out * keep;
    cogl_color_out = vec4(win.rgb + vec3(0.9) * rim * 0.6, max(win.a, rim * 0.6));
}
`;

export const BurnEffect = GObject.registerClass(
class FusionBurnEffect extends Shell.GLSLEffect {
    _init(fire) {
        super._init();
        this._progress = this.get_uniform_location('progress');
        this._time = this.get_uniform_location('time');
        this.set_uniform_float(this.get_uniform_location('fire'), 1, [fire ? 1 : 0]);
        this.set_uniform_float(this.get_uniform_location('seed'), 2, [Math.random() * 50, Math.random() * 50]);
        this.setProgress(0, 0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    /** progress: 0 = the whole window, 1 = all gone; seconds: animates the flames. */
    setProgress(p, seconds) {
        this.set_uniform_float(this._progress, 1, [p]);
        this.set_uniform_float(this._time, 1, [seconds]);
        this.queue_repaint();
    }
});

export class WindowEffects {
    constructor(ext) {
        this._settings = ext.settings;
        this._effect = this._settings.get_string('window-effect');
        this._running = new Map(); // actor -> stop()
        if (!['FIRE', 'DISSOLVE', 'GLIDE'].includes(this._effect))
            return;

        const shellwm = Main.wm._shellwm;
        this._blocked = [];
        for (const signal of ['map', 'destroy']) {
            // GNOME connected its handler first, at startup.
            const id = GObject.signal_handler_find(shellwm, {signalId: signal});
            if (!id) {
                console.warn(`Fusion Desk: GNOME's window ${signal} handler not found; window effects off`);
                this._unblock();
                return;
            }
            GObject.signal_handler_block(shellwm, id);
            this._blocked.push(id);
        }
        shellwm.connectObject('map', (wm, actor) => this._onMap(wm, actor),
            'destroy', (wm, actor) => this._onDestroy(wm, actor), this);
    }

    _unblock() {
        for (const id of this._blocked ?? [])
            GObject.signal_handler_unblock(Main.wm._shellwm, id);
        this._blocked = [];
    }

    /** Only normal windows, and only when GNOME would animate them too. */
    _handles(actor, opening) {
        if (!this._settings.get_boolean(opening ? 'window-effect-open' : 'window-effect-close'))
            return false;
        return !Main.wm._skippedActors.has(actor) && Main.wm._shouldAnimate() && !!actor.get_texture() &&
            actor.meta_window?.get_window_type() === Meta.WindowType.NORMAL;
    }

    _onMap(shellwm, actor) {
        const ours = this._handles(actor, true);
        // GNOME still does its bookkeeping (dialog dimming), just without its animation.
        if (ours)
            Main.wm._skippedActors.add(actor);
        Main.wm._mapWindow(shellwm, actor);
        if (ours)
            this._play(actor, true, null);
    }

    _onDestroy(shellwm, actor) {
        if (!this._handles(actor, false)) {
            Main.wm._destroyWindow(shellwm, actor);
            return;
        }
        actor.meta_window.disconnectObject(actor);
        // Listed as "being destroyed", so GNOME can still end it early (kill-window-effects).
        Main.wm._destroying.add(actor);
        this._play(actor, false, () => Main.wm._destroyWindowDone(shellwm, actor));
    }

    _play(actor, opening, done) {
        this._running.get(actor)?.();
        const duration = this._settings.get_int('window-effect-duration') * (opening ? 0.75 : 1);
        if (this._effect === 'GLIDE') {
            this._glide(actor, opening, duration, done);
            return;
        }
        const fx = new BurnEffect(this._effect === 'FIRE');
        actor.add_effect_with_name(EFFECT, fx);
        fx.setProgress(opening ? 1 : 0, 0);
        const timeline = new Clutter.Timeline({actor, duration});
        let finished = false;
        const finish = () => {
            if (finished)
                return;
            finished = true;
            this._running.delete(actor);
            timeline.stop();
            actor.disconnectObject(this);
            if (actor.get_effect(EFFECT) === fx)
                actor.remove_effect(fx);
            done?.();
        };
        timeline.connect('new-frame', () => {
            // Even pace with soft ends; the flames keep moving with real time.
            const p = timeline.get_progress();
            const e = p * p * (3 - 2 * p);
            fx.setProgress(opening ? 1 - e : e, timeline.get_elapsed_time() / 1000);
        });
        timeline.connect('completed', finish);
        actor.connectObject('destroy', () => {
            finished = true;
            this._running.delete(actor);
            timeline.stop();
        }, this);
        this._running.set(actor, finish);
        timeline.start();
    }

    _glide(actor, opening, duration, done) {
        actor.set_pivot_point(0.5, 0.5);
        const hidden = {opacity: 0, scale_x: 0.92, scale_y: 0.92, translation_y: 48};
        const shown = {opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0};
        if (opening)
            Object.assign(actor, hidden);
        const finish = () => {
            this._running.delete(actor);
            Object.assign(actor, shown);
            actor.set_pivot_point(0, 0);
            done?.();
        };
        this._running.set(actor, () => actor.remove_all_transitions());
        actor.ease({
            ...(opening ? shown : hidden),
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: finish,
        });
    }

    destroy() {
        Main.wm._shellwm.disconnectObject(this);
        // Finish running effects now (closing windows complete their destroy).
        for (const stop of [...this._running.values()])
            stop();
        this._running.clear();
        this._unblock();
    }
}
