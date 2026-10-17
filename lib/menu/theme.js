// Applies the custom start menu theme by loading a generated stylesheet.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {contrastOn, parseColor, rgba, withAlpha} from './themes.js';

let counter = 0;

export class MenuTheme {
    constructor(settings) {
        this._settings = settings;
        this.apply();
    }

    get active() {
        return this._settings.get_string('menu-theme') === 'CUSTOM';
    }

    _css() {
        const s = this._settings;
        // Only well-formed colours reach the stylesheet; anything else uses the default.
        const color = key => {
            const c = parseColor(s.get_string(key)) ?? parseColor(s.get_default_value(key).unpack());
            return rgba(c);
        };
        const bg = color('menu-bg-color');
        const fg = color('menu-fg-color');
        const accent = color('menu-accent-color');
        const hover = color('menu-hover-color');
        const border = color('menu-border-color');
        const bw = s.get_int('menu-border-width');
        const radius = s.get_int('menu-radius');
        const dim = withAlpha(fg, 0.62);
        const subtle = withAlpha(fg, 0.07);
        const sep = withAlpha(fg, 0.12);
        const onAccent = contrastOn(accent);
        // Solid hover colours get their own readable text; translucent ones keep the menu text.
        const onHover = (parseColor(hover)?.[3] ?? 0) >= 0.6 ? contrastOn(hover) : fg;
        const T = '.fusion-start-menu.fusion-themed';
        return `
${T} .popup-menu-content { background-color: ${bg}; color: ${fg}; border: ${bw}px solid ${border}; border-radius: ${radius}px; }
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
        const path = GLib.build_filenamev([dir, `menu-theme-${Date.now()}-${counter++}.css`]);
        try {
            GLib.file_set_contents(path, this._css());
            this._file = Gio.File.new_for_path(path);
            St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._file);
        } catch (e) {
            console.error('Fusion Desk: menu theme failed', e);
            this._file = null;
        }
    }

    _unload() {
        if (!this._file)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        try {
            this._file.delete(null);
        } catch {
            // Already gone.
        }
        this._file = null;
    }

    destroy() {
        this._unload();
    }
}
