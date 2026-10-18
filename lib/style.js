// Light / dark panel following the system style, and accent-coloured icons.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const IFACE = 'org.gnome.desktop.interface';

/** True when GNOME's style (Settings → Appearance) is dark. */
export function prefersDark() {
    return new Gio.Settings({schema_id: IFACE}).get_string('color-scheme') === 'prefer-dark';
}

/** Whether the taskbar uses the light palette (setting panel-theme: AUTO / LIGHT / DARK). */
export function panelIsLight(settings) {
    const theme = settings.get_string('panel-theme');
    if (theme !== 'AUTO')
        return theme === 'LIGHT';
    return !prefersDark();
}

/** RGB triple of the taskbar background for rgba(). */
export function panelRgb(settings) {
    return panelIsLight(settings) ? '246, 246, 250' : '22, 22, 26';
}

/**
 * Background CSS for a surface whose plain colour is `base`: a vertical
 * gradient that starts with some of the system accent colour mixed in
 * (setting accent-gradient), or just the colour. -st-accent-color keeps it
 * live when the accent changes.
 */
export function accentFill(settings, base, amount = 24, minGlass = 0) {
    const glass = Math.max(glassLevel(settings), minGlass);
    const accent = settings.get_boolean('accent-gradient');
    if (!glass && !accent)
        return `background-color: ${base};`;
    const mix = (color, into, pct) => `st-mix(${color}, ${into}, ${Math.round(pct)}%)`;
    const WHITE = 'rgba(255, 255, 255, 1)';
    const BLACK = 'rgba(0, 0, 0, 1)';
    const k = glass === 2 ? 1 : 0.6;
    let top = base, end = base, dir = 'vertical';
    let tinted = false;
    if (glass) {
        switch (glassStyle(settings)) {
        case 'FROSTED': // milky all over, a little brighter at the top
            top = mix(WHITE, base, 30 * k);
            end = mix(WHITE, base, 16 * k);
            break;
        case 'GEL': // bright candy top, deeper bottom
            top = mix(WHITE, base, 42 * k);
            end = mix(BLACK, base, 12 * k);
            break;
        case 'TINTED': // coloured glass in the accent colour
            top = mix('-st-accent-color', base, 38 * k);
            end = mix('-st-accent-color', base, 14 * k);
            tinted = true;
            break;
        case 'SMOKE': // dark smoked glass
            top = mix(BLACK, base, 8 * k);
            end = mix(BLACK, base, 28 * k);
            break;
        case 'HALO': // soft glow in the middle
            dir = 'radial';
            top = mix(WHITE, base, 26 * k);
            break;
        default: // CLEAR: lighter top fading down
            top = mix(WHITE, base, 20 * k);
        }
    }
    // Accent gradient: some accent mixed into the top on top of that.
    if (accent && !tinted)
        top = mix('-st-accent-color', top, amount);
    return `background-color: ${base}; background-gradient-direction: ${dir}; ` +
        `background-gradient-start: ${top}; background-gradient-end: ${end};`;
}

/** Glass effect strength: 0 off, 1 soft, 2 strong (setting glass-effect). */
export function glassLevel(settings) {
    return {SOFT: 1, STRONG: 2}[settings.get_string('glass-effect')] ?? 0;
}

/** Glass variant: CLEAR, FROSTED, GEL, TINTED, SMOKE or HALO (setting glass-style). */
export function glassStyle(settings) {
    return settings.get_string('glass-style');
}

/** Blur radius behind glass surfaces for the current variant. */
export function glassBlur(settings) {
    return {FROSTED: 60, SMOKE: 24, GEL: 36}[glassStyle(settings)] ?? 30;
}

/** Bright inner top edge of a glass surface (strength and colour follow the variant). */
export function glassEdge(level, light, settings = null) {
    if (!level)
        return '';
    const style = settings ? glassStyle(settings) : 'CLEAR';
    if (style === 'TINTED')
        return `box-shadow: inset 0 1px 0 0 st-transparentize(-st-accent-color, ${level === 2 ? 0.3 : 0.5});`;
    const strength = {GEL: 1.5, FROSTED: 0.8, SMOKE: 0.5, HALO: 0.9}[style] ?? 1;
    const a = Math.min(1, (light ? (level === 2 ? 0.95 : 0.8) : (level === 2 ? 0.32 : 0.2)) * strength);
    return `box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, ${a.toFixed(2)});`;
}

/** Call `callback` whenever the system light / dark style changes; returns a disconnect function. */
export function watchSystemStyle(callback) {
    const iface = new Gio.Settings({schema_id: IFACE});
    const id = iface.connect('changed::color-scheme', () => callback());
    return () => iface.disconnect(id);
}

const DECLARATIONS = 'uniform vec4 fusion_accent;';
// Keep the image's shape (alpha), paint it in the accent colour (premultiplied).
const CODE = 'cogl_color_out.rgb = fusion_accent.rgb * cogl_color_out.a;';

const AccentTintEffect = GObject.registerClass(
class FusionAccentTintEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._location = this.get_uniform_location('fusion_accent');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    setColor(color) {
        // Cogl.Color channels are 0–255 bytes on some versions, 0–1 floats on others.
        const scale = Math.max(color.red, color.green, color.blue) > 1 ? 255 : 1;
        this.set_uniform_float(this._location, 4, [color.red / scale, color.green / scale, color.blue / scale, 1]);
        this.queue_repaint();
    }
});

// Shaded: the colour scaled by the image's brightness, so pictures keep their
// detail (white parts get the full colour, dark parts a deep shade of it).
const SHADED_CODE = `
    vec3 c = cogl_color_out.a > 0.0 ? cogl_color_out.rgb / cogl_color_out.a : vec3(0.0);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    cogl_color_out.rgb = fusion_accent.rgb * (0.30 + 0.70 * l) * cogl_color_out.a;`;

const ShadedTintEffect = GObject.registerClass(
class FusionShadedTintEffect extends AccentTintEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, SHADED_CODE, false);
    }
});

/**
 * Paint an icon (theme icon or image, e.g. the start or apps button) in the
 * system accent colour when the icons-follow-accent setting is on. Follows
 * accent changes live and cleans up with the actor.
 */
export function tintWithAccent(actor, settings) {
    if (!settings.get_boolean('icons-follow-accent'))
        return;
    // The actor's CSS colour is -st-accent-color; its theme node turns that
    // into real RGB and is restyled (style-changed) when the accent changes.
    actor.add_style_class_name('fusion-accent-fg');
    tintWithForeground(actor);
}

/**
 * Paint any icon (also full-colour app images) in its own CSS text colour,
 * e.g. app tray icons in the same colour as the other status icons.
 */
export function tintWithForeground(actor, {shaded = false} = {}) {
    if (actor.get_effect('fusion-accent-tint'))
        return;
    const effect = shaded ? new ShadedTintEffect() : new AccentTintEffect();
    actor.add_effect_with_name('fusion-accent-tint', effect);
    const sync = () => {
        if (actor.get_stage())
            effect.setColor(actor.get_theme_node().get_foreground_color());
    };
    actor._fusionTintIds = [actor.connect('style-changed', sync), actor.connect('notify::mapped', sync)];
    sync();
}

/** Undo tintWithForeground (for actors that outlive Fusion Desk, e.g. other extensions' icons). */
export function removeTint(actor) {
    for (const id of actor._fusionTintIds ?? [])
        actor.disconnect(id);
    delete actor._fusionTintIds;
    actor.remove_effect_by_name('fusion-accent-tint');
}

/**
 * A background blur only repaints the part of a surface that changed, and
 * then blurs the surface's own old pixels into that spot (smudges where the
 * pointer hovered). Repaint the whole surface whenever the pointer acts on
 * it, so the blur always samples what is really behind.
 */
export function keepBlurClean(actor) {
    if (actor._fusionBlurClean)
        return;
    actor._fusionBlurClean = true;
    actor.connect('captured-event', () => {
        actor.queue_redraw();
        return Clutter.EVENT_PROPAGATE;
    });
}
