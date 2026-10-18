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
    // Glass: white mixed into the top; accent: some accent mixed in on top of that.
    let top = base;
    if (glass)
        top = `st-mix(rgba(255, 255, 255, 1), ${base}, ${glass === 2 ? 20 : 11}%)`;
    if (accent)
        top = `st-mix(-st-accent-color, ${top}, ${amount}%)`;
    return `background-color: ${base}; background-gradient-direction: vertical; ` +
        `background-gradient-start: ${top}; background-gradient-end: ${base};`;
}

/** Glass effect strength: 0 off, 1 soft, 2 strong (setting glass-effect). */
export function glassLevel(settings) {
    return {SOFT: 1, STRONG: 2}[settings.get_string('glass-effect')] ?? 0;
}

/** Bright inner top edge of a glass surface. */
export function glassEdge(level, light) {
    if (!level)
        return '';
    const a = light ? (level === 2 ? 0.95 : 0.8) : (level === 2 ? 0.32 : 0.2);
    return `box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, ${a});`;
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
    const effect = new AccentTintEffect();
    actor.add_effect_with_name('fusion-accent-tint', effect);
    const sync = () => {
        if (actor.get_stage())
            effect.setColor(actor.get_theme_node().get_foreground_color());
    };
    actor.connect('style-changed', sync);
    actor.connect('notify::mapped', sync);
    sync();
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
