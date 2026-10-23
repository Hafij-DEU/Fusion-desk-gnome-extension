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
    for (int i = 0; i < 4; i++) {
        v += a * fusion_noise(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}
`;

// cogl_color_out holds the window's (premultiplied) colour; burned parts
// turn transparent and, with fire, the burning front glows.
const CODE = `
vec2 uv = cogl_tex_coord_in[0].st;
// The noise drifts upwards as it burns, so the flames rise.
float n = fusion_fbm(uv * vec2(7.0, 5.0) + seed + vec2(0.0, progress * 1.5));
// Fire burns from the bottom up; dissolve follows the noise alone.
float shape = mix(n, 0.5 * n + 0.5 * (1.0 - uv.y), fire);
float d = shape - (progress * 1.3 - 0.15);
float keep = smoothstep(0.0, 0.015, d);
float t = clamp(d / 0.16, 0.0, 1.0);
vec3 flame = mix(vec3(1.0, 0.92, 0.55), mix(vec3(1.0, 0.42, 0.05), vec3(0.55, 0.04, 0.0), t), smoothstep(0.0, 0.6, t));
float glow = fire * (1.0 - t) * step(0.0, d) * cogl_color_out.a;
vec4 base = cogl_color_out * keep;
cogl_color_out = vec4(base.rgb * (1.0 - glow) + flame * glow, max(base.a, glow));
`;

const BurnEffect = GObject.registerClass(
class FusionBurnEffect extends Shell.GLSLEffect {
    _init(fire) {
        super._init();
        this._progress = this.get_uniform_location('progress');
        this.set_uniform_float(this.get_uniform_location('fire'), 1, [fire ? 1 : 0]);
        this.set_uniform_float(this.get_uniform_location('seed'), 2, [Math.random() * 50, Math.random() * 50]);
        this.setProgress(0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    /** 0 = the whole window, 1 = all gone. */
    setProgress(p) {
        this.set_uniform_float(this._progress, 1, [p]);
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
        fx.setProgress(opening ? 1 : 0);
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
            // Even pace with soft ends.
            const p = timeline.get_progress();
            const e = p * p * (3 - 2 * p);
            fx.setProgress(opening ? 1 - e : e);
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
