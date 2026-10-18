// Applies the custom start menu theme by loading a generated stylesheet.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {PRESETS, contrastOn, parseColor, rgba, withAlpha} from './themes.js';
import {accentFill, glassLevel, prefersDark, watchSystemStyle} from '../style.js';

let counter = 0;

function deleteQuietly(file) {
    file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
        try {
            f.delete_finish(res);
        } catch {
            // Already gone.
        }
    });
}

export class MenuTheme {
    /**
     * @param {Gio.Settings} settings extension settings
     * @param {function(): boolean} [glossy] whether the Deepin glossy look is on
     */
    constructor(settings, glossy = () => false) {
        this._settings = settings;
        this._glossy = glossy;
        // Light system style: the custom theme switches to light colours.
        this._unwatchStyle = watchSystemStyle(() => {
            if (this._settings.get_boolean('menu-theme-follow-system'))
                this.apply();
        });
        this._generation = 0;
        this.apply();
    }

    get active() {
        return this._settings.get_string('menu-theme') === 'CUSTOM';
    }

    get glossy() {
        return this._glossy() || glassLevel(this._settings) > 0;
    }

    /** The menu's background colour (CSS rgba), after following the system style. */
    get background() {
        const s = this._settings;
        if (s.get_boolean('menu-theme-follow-system') && !prefersDark())
            return PRESETS['Frost'][0];
        const c = parseColor(s.get_string('menu-bg-color')) ?? parseColor(s.get_default_value('menu-bg-color').unpack());
        return rgba(c);
    }

    _css() {
        const s = this._settings;
        // Only well-formed colours reach the stylesheet; anything else uses the default.
        const color = key => {
            const c = parseColor(s.get_string(key)) ?? parseColor(s.get_default_value(key).unpack());
            return rgba(c);
        };
        let bg = color('menu-bg-color');
        let fg = color('menu-fg-color');
        const accent = color('menu-accent-color');
        let hover = color('menu-hover-color');
        let border = color('menu-border-color');
        if (s.get_boolean('menu-theme-follow-system') && !prefersDark()) {
            // Light colours (the "Frost" preset); accent, border width and radius stay yours.
            [bg, fg, , hover, border] = PRESETS['Frost'];
        }
        const bw = s.get_int('menu-border-width');
        const radius = s.get_int('menu-radius');
        const dim = withAlpha(fg, 0.62);
        const subtle = withAlpha(fg, 0.07);
        const sep = withAlpha(fg, 0.12);
        const onAccent = contrastOn(accent);
        // Solid hover colours get their own readable text; translucent ones keep the menu text.
        const onHover = (parseColor(hover)?.[3] ?? 0) >= 0.6 ? contrastOn(hover) : fg;
        const T = '.fusion-start-menu.fusion-themed';
        // Glass / Deepin glossy look and accent gradient: one fill (lib/style.js).
        const fill = accentFill(s, bg, 18, this._glossy() ? 1 : 0);
        return `
${T} .popup-menu-content { ${fill} color: ${fg}; border: ${bw}px solid ${border}; border-radius: ${radius}px; }
${T}.fusion-sm-flush-bottom .popup-menu-content { border-radius: ${radius}px ${radius}px ${radius}px 0; }
${T}.fusion-sm-flush-top .popup-menu-content { border-radius: 0 ${radius}px ${radius}px ${radius}px; }
${T} .fusion-sm, ${T} .fusion-sm StLabel { color: ${fg}; }
${T} .fusion-sm-item-desc, ${T} .fusion-sm-heading, ${T} .fusion-sm-letter, ${T} .fusion-sm-empty, ${T} .fusion-sm-hint { color: ${dim}; }
${T} .fusion-sm-search { background-color: ${subtle}; color: ${fg}; border: 1px solid ${sep}; }
${T} .fusion-sm-search:focus { border-color: ${accent}; }
${T} .fusion-sm-content-scroll, ${T} .fusion-sm-footer-bar, ${T} .fusion-sm-rail, ${T} .fusion-sm-favbar { background-color: ${subtle}; }
${T} .fusion-sm-sep { background-color: ${sep}; }
${T} .fusion-sm-item:hover, ${T} .fusion-sm-item:focus, ${T} .fusion-sm-tile:hover, ${T} .fusion-sm-tile:focus,
${T} .fusion-sm-cat:hover, ${T} .fusion-sm-cat:focus, ${T} .fusion-sm-round:hover, ${T} .fusion-sm-round:focus,
${T} .fusion-sm-rail-item:hover, ${T} .fusion-sm-rail-item:focus, ${T} .fusion-sm-fav:hover, ${T} .fusion-sm-fav:focus,
${T} .fusion-sm-user:hover, ${T} .fusion-sm-user:focus, ${T} .fusion-sm-pill:hover, ${T} .fusion-sm-pill:focus,
${T} .fusion-sm-chip:hover, ${T} .fusion-sm-tab:hover, ${T} .fusion-sm-pop-item:hover, ${T} .fusion-sm-pop-item:focus { background-color: ${hover}; color: ${onHover}; }
${T} .fusion-sm-cat:checked, ${T} .fusion-sm-chip:checked, ${T} .fusion-sm-tab:checked { background-color: ${accent}; color: ${onAccent}; }
${T} .fusion-sm-cat:checked StLabel, ${T} .fusion-sm-chip:checked StLabel, ${T} .fusion-sm-tab:checked StLabel { color: ${onAccent}; }
${T} .fusion-sm-pin, ${T} .fusion-sm-pill { color: ${accent}; }
${T} .fusion-sm-livetile { background-color: ${withAlpha(accent, 0.22)}; }
${T} .fusion-sm-popover, ${T} .fusion-sm-tooltip { background-color: ${withAlpha(bg, 1)}; color: ${fg}; border: 1px solid ${sep}; }
`;
    }

    apply() {
        this._unload();
        if (!this.active)
            return;
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'fusion-desk']);
        GLib.mkdir_with_parents(dir, 0o700);
        // A fresh file name each time: St caches stylesheets by file.
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `menu-theme-${Date.now()}-${counter++}.css`]));
        const generation = ++this._generation;
        const bytes = new GLib.Bytes(new TextEncoder().encode(this._css()));
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
            try {
                f.replace_contents_finish(res);
                // Settings changed again (or the menu went away) while writing.
                if (generation !== this._generation) {
                    deleteQuietly(f);
                    return;
                }
                St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(f);
                this._file = f;
            } catch (e) {
                console.error('Fusion Desk: menu theme failed', e);
            }
        });
    }

    _unload() {
        if (!this._file)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        deleteQuietly(this._file);
        this._file = null;
    }

    destroy() {
        this._unwatchStyle?.();
        this._generation++;
        this._unload();
    }
}
