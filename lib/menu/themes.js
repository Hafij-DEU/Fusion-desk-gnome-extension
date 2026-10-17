// Start menu colour themes, shared by the shell and prefs (no gnome-shell imports).

// name: [background, foreground, accent, hover, border, border width, radius]
export const PRESETS = {
    'Midnight': ['rgba(20,22,33,0.94)', 'rgb(223,223,223)', 'rgb(25,98,163)', 'rgb(21,83,158)', 'rgb(60,60,60)', 1, 16],
    'Graphite': ['rgba(30,30,32,0.97)', 'rgb(236,236,240)', 'rgb(79,140,255)', 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.08)', 1, 18],
    'Frost': ['rgba(246,247,250,0.97)', 'rgb(24,28,40)', 'rgb(37,99,235)', 'rgba(24,28,40,0.08)', 'rgba(24,28,40,0.12)', 1, 18],
    'Nord': ['rgba(46,52,64,0.97)', 'rgb(229,233,240)', 'rgb(136,192,208)', 'rgba(229,233,240,0.10)', 'rgb(59,66,82)', 1, 14],
    'Glass': ['rgba(28,28,36,0.72)', 'rgb(245,245,250)', 'rgb(124,92,255)', 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0.18)', 1, 22],
    'Rosé': ['rgba(35,33,54,0.97)', 'rgb(224,222,244)', 'rgb(235,111,146)', 'rgba(224,222,244,0.10)', 'rgb(57,53,82)', 1, 16],
};

/** Parse a CSS colour (#rgb, #rrggbb, rgb(), rgba()) to [r, g, b, a] or null. */
export function parseColor(text) {
    const s = (text ?? '').trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
        const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1);
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m)
        return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    return null;
}

export function rgba([r, g, b, a]) {
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;
}

export function withAlpha(text, alpha, fallback = 'rgba(127, 127, 127, 1)') {
    const c = parseColor(text) ?? parseColor(fallback);
    return rgba([c[0], c[1], c[2], alpha]);
}

/** Readable text colour (black or white) on top of `bg`. */
export function contrastOn(bg) {
    const c = parseColor(bg);
    if (!c)
        return '#ffffff';
    const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    return lum > 0.6 ? '#101014' : '#ffffff';
}
