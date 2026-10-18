// Battery drawn by Fusion Desk: the fill colour shows the state (full and
// charging green, normal accent, low orange, critical red) and the
// percentage sits inside the battery. Replaces GNOME's battery icon and
// separate percentage in the status area; GNOME's own come back on destroy.
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// UPower.DeviceState
const CHARGING = 1;
const FULLY_CHARGED = 4;
const PENDING_CHARGE = 5;

const COLORS = {
    full: [0.18, 0.63, 0.26],
    charging: [0.18, 0.63, 0.26],
    low: [0.88, 0.54, 0.0],
    critical: [0.90, 0.28, 0.30],
};

function rgb(color) {
    const scale = Math.max(color.red, color.green, color.blue) > 1 ? 255 : 1;
    return [color.red / scale, color.green / scale, color.blue / scale];
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

export class Battery {
    constructor(ext) {
        this._ext = ext;
        this._setup();
        // At login GNOME adds its status indicators a moment after extensions start.
        if (!this._area && !this._system) {
            let tries = 0;
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._setup();
                if (this._system || ++tries > 30) {
                    this._waitId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _setup() {
        const s = this._ext.settings;
        this._system = Main.panel.statusArea.quickSettings?._system;
        const toggle = this._system?._systemItem?.powerToggle;
        if (s.get_string('battery-style') !== 'COLOR' || !toggle?._proxy ||
            s.get_strv('hidden-indicators').includes('battery'))
            return;
        this._toggle = toggle;
        this._showPercent = !s.get_strv('hidden-indicators').includes('battery-percentage');

        this._area = new St.DrawingArea({style_class: 'fusion-battery', y_align: 2 /* CENTER */});
        this._area.connect('repaint', area => this._draw(area));
        this._area.connect('style-changed', () => this._area.queue_repaint());
        this._system.add_child(this._area);

        // GNOME keeps re-showing its icon and label on every change.
        this._gnome = [this._system._indicator, this._system._percentageLabel].filter(Boolean);
        for (const actor of this._gnome) {
            actor.connectObject('notify::visible', () => this._sync(), this);
        }
        toggle.connectObject('notify::title', () => this._sync(),
            'notify::gicon', () => this._sync(), 'notify::visible', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const present = this._toggle?.visible && this._toggle._proxy?.IsPresent;
        this._area.visible = !!present;
        for (const actor of this._gnome) {
            if (present && actor.visible)
                actor.hide();
        }
        this._area.queue_repaint();
    }

    _draw(area) {
        const proxy = this._toggle._proxy;
        const pct = Math.max(0, Math.min(100, Math.round(proxy?.Percentage ?? 0)));
        const state = proxy?.State ?? 0;
        const charging = state === CHARGING || state === PENDING_CHARGE;
        const node = area.get_theme_node();
        // fusion-battery's colour is the accent; the outline uses the panel text colour.
        const accent = rgb(node.get_foreground_color());
        const parentNode = area.get_parent()?.get_theme_node();
        const fg = parentNode ? rgb(parentNode.get_foreground_color()) : [1, 1, 1];

        let fill = accent;
        if (charging)
            fill = COLORS.charging;
        else if (state === FULLY_CHARGED || pct >= 95)
            fill = COLORS.full;
        else if (pct <= 10)
            fill = COLORS.critical;
        else if (pct <= 20)
            fill = COLORS.low;

        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const line = 1.6 * sf;
        const nubW = 2.5 * sf;
        const bodyW = w - nubW - line;
        const bodyH = h - line;
        const r = 3.5 * sf;

        // Outline and terminal in the accent colour.
        cr.setSourceRGBA(...accent, 1);
        cr.setLineWidth(line);
        roundedRect(cr, line / 2, line / 2, bodyW, bodyH, r);
        cr.stroke();
        roundedRect(cr, bodyW + line / 2, h * 0.32, nubW, h * 0.36, nubW / 2);
        cr.fill();

        // Fill to the charge level.
        const pad = line + 1 * sf;
        const innerW = bodyW - 2 * pad + line;
        const innerH = bodyH - 2 * pad + line;
        const levelW = Math.max(innerW * pct / 100, pct > 0 ? 2 * sf : 0);
        cr.setSourceRGBA(...fill, 1);
        roundedRect(cr, pad, pad, levelW, innerH, Math.max(1, r - pad / 2));
        cr.fill();

        // Percentage (and a bolt while charging) inside the battery: white
        // over the fill, panel colour over the empty part.
        if (this._showPercent || charging) {
            const text = this._showPercent ? `${pct}` : '';
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(innerH * 0.92);
            const ext = cr.textExtents(text || '0');
            const bolt = charging ? innerH * 0.55 : 0;
            const total = (text ? ext.xAdvance : 0) + bolt + (text && charging ? sf : 0);
            const x0 = pad + (innerW - total) / 2;
            const yMid = pad + innerH / 2;
            const paintLabel = color => {
                cr.setSourceRGBA(...color, 1);
                let x = x0;
                if (charging) {
                    const bh = innerH * 0.8;
                    const by = yMid - bh / 2;
                    cr.moveTo(x + bolt * 0.62, by);
                    cr.lineTo(x, by + bh * 0.56);
                    cr.lineTo(x + bolt * 0.45, by + bh * 0.56);
                    cr.lineTo(x + bolt * 0.32, by + bh);
                    cr.lineTo(x + bolt, by + bh * 0.42);
                    cr.lineTo(x + bolt * 0.55, by + bh * 0.42);
                    cr.closePath();
                    cr.fill();
                    x += bolt + sf;
                }
                if (text) {
                    cr.moveTo(x - ext.xBearing, yMid - ext.yBearing - ext.height / 2);
                    cr.showText(text);
                }
            };
            // Readable on whatever is behind each part of the number.
            const contrast = c => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 0.62 ? [0.08, 0.08, 0.1] : [1, 1, 1];
            const split = pad + levelW;
            cr.save();
            cr.rectangle(0, 0, split, h);
            cr.clip();
            paintLabel(contrast(fill));
            cr.restore();
            cr.save();
            cr.rectangle(split, 0, w - split, h);
            cr.clip();
            paintLabel(fg);
            cr.restore();
        }
        cr.$dispose();
    }

    destroy() {
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        if (!this._area)
            return;
        this._toggle?.disconnectObject(this);
        for (const actor of this._gnome)
            actor.disconnectObject(this);
        this._area.destroy();
        this._area = null;
        // GNOME decides again which of its own icon / label to show.
        this._system?._sync?.();
        this._system?._indicator?.show();
        this._system?._sync?.();
    }
}
