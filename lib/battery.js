// Battery drawn by Fusion Desk: an accent outline, a fill whose colour shows
// the state (full and charging green, normal accent, low orange, critical
// red) and the percentage inside. It replaces GNOME's battery icon and
// percentage in the status area, or (battery-standalone) becomes its own
// panel button whose menu shows time left, power draw, battery health,
// power mode and charging mode. GNOME's own icon comes back on destroy.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// UPower.DeviceState / DeviceKind
const CHARGING = 1;
const DISCHARGING = 2;
const FULLY_CHARGED = 4;
const PENDING_CHARGE = 5;
const KIND_BATTERY = 2;

const DEVICE_XML = `<node><interface name="org.freedesktop.UPower.Device">
<property name="Type" type="u" access="read"/>
<property name="State" type="u" access="read"/>
<property name="Percentage" type="d" access="read"/>
<property name="TimeToEmpty" type="x" access="read"/>
<property name="TimeToFull" type="x" access="read"/>
<property name="IsPresent" type="b" access="read"/>
<property name="EnergyRate" type="d" access="read"/>
<property name="Capacity" type="d" access="read"/>
<property name="ChargeThresholdSupported" type="b" access="read"/>
<property name="ChargeThresholdEnabled" type="b" access="read"/>
<method name="EnableChargeThreshold"><arg name="chargeThreshold" type="b" direction="in"/></method>
</interface></node>`;
const PROFILES_XML = `<node><interface name="org.freedesktop.UPower.PowerProfiles">
<property name="ActiveProfile" type="s" access="readwrite"/>
<property name="Profiles" type="aa{sv}" access="read"/>
</interface></node>`;
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DEVICE_XML);
const ProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PROFILES_XML);

const COLORS = {
    full: [0.18, 0.63, 0.26],
    charging: [0.18, 0.63, 0.26],
    low: [0.88, 0.54, 0.0],
    critical: [0.90, 0.28, 0.30],
};

const N_ = s => s;
const PROFILE_NAMES = {
    'performance': N_('Performance'),
    'balanced': N_('Balanced'),
    'power-saver': N_('Power Saver'),
};
// Kernel charge_types values (e.g. laptop "conservation" / rapid charge modes).
const CHARGE_TYPE_NAMES = {
    'Fast': N_('Fast charging'),
    'Standard': N_('Standard charging'),
    'Long_Life': N_('Battery protection (charges less, lasts longer)'),
    'Adaptive': N_('Adaptive charging'),
    'Trickle': N_('Trickle charging'),
    'Bypass': N_('Bypass (runs on power, battery rests)'),
    'Custom': N_('Custom limit'),
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

/** "2 h 15 min" / "45 min". */
function formatDuration(seconds) {
    const min = Math.round(seconds / 60);
    if (min < 60)
        return _('%d min').format(min);
    return _('%d h %d min').format(Math.floor(min / 60), min % 60);
}

export class Battery {
    constructor(ext) {
        this._ext = ext;
        const s = ext.settings;
        this.actor = null;
        this._standalone = s.get_boolean('battery-standalone');
        if (s.get_string('battery-style') !== 'COLOR' && !this._standalone)
            return;
        const hidden = s.get_strv('hidden-indicators');
        if (hidden.includes('battery') && !this._standalone)
            return;
        this._showPercent = !hidden.includes('battery-percentage');

        this._area = new St.DrawingArea({style_class: 'fusion-battery', y_align: 2 /* CENTER */, visible: false});
        this._area.connect('repaint', area => this._draw(area));
        this._area.connect('style-changed', () => this._area.queue_repaint());

        if (this._standalone) {
            this._button = new PanelMenu.Button(0.5, _('Battery'), false);
            this._button.add_style_class_name('fusion-battery-button');
            // GNOME 50 panel buttons react to a click gesture: left button opens the menu.
            if (this._button._clickGesture)
                this._button._clickGesture.required_button = Clutter.BUTTON_PRIMARY;
            this._button.add_child(this._area);
            this._button.menu.actor.add_style_class_name('fusion-battery-menu');
            this._button.menu.connectObject('open-state-changed', (_m, open) => {
                if (open)
                    this._fillMenu();
            }, this);
            Main.panel.addToStatusArea('fusion-battery', this._button, 0, 'right');
            this.actor = this._button.container;
        }

        this._proxy = new DeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                if (error || !this._area)
                    return;
                this._proxyId = proxy.connect('g-properties-changed', () => this._sync());
                this._sync();
            });

        // GNOME's status indicators appear a moment after extensions start at login.
        this._attach();
        if (!this._system) {
            let tries = 0;
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._attach();
                if (this._system || ++tries > 30) {
                    this._waitId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    get _present() {
        const p = this._proxy;
        return !!p && p.IsPresent && p.Type === KIND_BATTERY;
    }

    /** Find GNOME's battery indicator: put ours in its place (inline) and hide its icon. */
    _attach() {
        const system = Main.panel.statusArea.quickSettings?._system;
        if (!system || this._system)
            return;
        this._system = system;
        if (!this._standalone)
            system.add_child(this._area);
        this._gnome = [system._indicator, system._percentageLabel].filter(Boolean);
        for (const actor of this._gnome)
            actor.connectObject('notify::visible', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        if (!this._area)
            return;
        const present = this._present;
        this._area.visible = present;
        if (this._button)
            this._button.visible = present;
        for (const actor of this._gnome ?? []) {
            if (present && actor.visible)
                actor.hide();
        }
        this._area.queue_repaint();
        // GNOME does not open an empty menu, so keep it filled.
        if (this._button && (this._button.menu.isOpen || this._button.menu.isEmpty()))
            this._fillMenu();
    }

    // ---- standalone menu -----------------------------------------------------

    _statusText() {
        const p = this._proxy;
        const pct = Math.round(p.Percentage ?? 0);
        switch (p.State) {
        case CHARGING:
            return p.TimeToFull > 0 ? _('Charging · full in %s').format(formatDuration(p.TimeToFull)) : _('Charging');
        case DISCHARGING:
            return p.TimeToEmpty > 0 ? _('On battery · %s left').format(formatDuration(p.TimeToEmpty)) : _('On battery');
        case FULLY_CHARGED:
            return _('Fully charged');
        case PENDING_CHARGE:
            return _('Plugged in, not charging');
        default:
            return pct >= 100 ? _('Fully charged') : _('Plugged in');
        }
    }

    _fillMenu() {
        const menu = this._button.menu;
        menu.removeAll();
        const p = this._proxy;
        if (!this._present)
            return;

        // Big percentage and what it means.
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'fusion-battery-head'});
        const box = new St.BoxLayout({orientation: 1 /* VERTICAL */, x_expand: true});
        box.add_child(new St.Label({text: `${Math.round(p.Percentage ?? 0)}%`, style_class: 'fusion-battery-big'}));
        box.add_child(new St.Label({text: this._statusText(), style_class: 'fusion-battery-status'}));
        const details = [];
        if (p.EnergyRate > 0.05)
            details.push(_('Power draw %s W').format(p.EnergyRate.toFixed(1)));
        const health = p.Capacity > 0 ? p.Capacity : this._kernelHealth();
        if (health > 0)
            details.push(_('Health %d%%').format(Math.round(health)));
        if (details.length)
            box.add_child(new St.Label({text: details.join('  ·  '), style_class: 'fusion-battery-details'}));
        head.add_child(box);
        menu.addMenuItem(head);

        this._addPowerModes(menu);
        this._addChargeModes(menu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Power Settings'), () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'power'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.warn(`Fusion Desk: cannot open power settings: ${e.message}`);
            }
        }, 'preferences-system-symbolic');
    }

    /** Full capacity versus design capacity from /sys (the combined UPower device lacks it). */
    _kernelHealth() {
        for (const [full, design] of [['energy_full', 'energy_full_design'], ['charge_full', 'charge_full_design']]) {
            for (const bat of ['BAT0', 'BAT1']) {
                try {
                    const read = f => Number(new TextDecoder().decode(GLib.file_get_contents(`/sys/class/power_supply/${bat}/${f}`)[1]).trim());
                    const d = read(design);
                    if (d > 0)
                        return Math.min(100, 100 * read(full) / d);
                } catch (e) {
                    // Not this battery / attribute.
                }
            }
        }
        return 0;
    }

    /** Performance / Balanced / Power Saver (power-profiles-daemon). */
    _addPowerModes(menu) {
        this._profiles ??= new ProfilesProxy(Gio.DBus.system, 'org.freedesktop.UPower.PowerProfiles',
            '/org/freedesktop/UPower/PowerProfiles', (proxy, error) => {
                if (!error && this._button?.menu.isOpen)
                    this._fillMenu();
            });
        const profiles = (this._profiles.Profiles ?? []).map(d => d.Profile?.deepUnpack?.() ?? d.Profile?.unpack?.()).filter(Boolean);
        if (!profiles.length)
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Power mode')));
        const active = this._profiles.ActiveProfile;
        for (const id of ['performance', 'balanced', 'power-saver'].filter(x => profiles.includes(x))) {
            const item = menu.addAction(_(PROFILE_NAMES[id]), () => {
                this._profiles.ActiveProfile = id;
            });
            item.setOrnament(id === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    /** Battery protection: UPower's charge limit, or the kernel's charge_types modes. */
    _addChargeModes(menu) {
        const p = this._proxy;
        if (p.ChargeThresholdSupported) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Charging')));
            const sw = new PopupMenu.PopupSwitchMenuItem(_('Protect battery (limit charging)'), !!p.ChargeThresholdEnabled);
            sw.connect('toggled', (_i, on) => p.EnableChargeThresholdRemote(on, () => {}));
            menu.addMenuItem(sw);
            return;
        }
        const types = this._chargeTypes();
        if (!types)
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Charging')));
        for (const value of types.values) {
            const label = CHARGE_TYPE_NAMES[value] ? _(CHARGE_TYPE_NAMES[value]) : value.replace(/_/g, ' ');
            const item = menu.addAction(label, () => this._setChargeType(types.path, value));
            item.setOrnament(value === types.current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    /** {path, values, current} from /sys/class/power_supply/BAT*\/charge_types, or null. */
    _chargeTypes() {
        const dir = Gio.File.new_for_path('/sys/class/power_supply');
        try {
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = en.next_file(null));) {
                const name = info.get_name();
                if (!/^BAT\w*$/.test(name))
                    continue;
                const path = `/sys/class/power_supply/${name}/charge_types`;
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    continue;
                const [, bytes] = GLib.file_get_contents(path);
                const tokens = new TextDecoder().decode(bytes).trim().split(/\s+/);
                const values = tokens.map(t => t.replace(/[[\]]/g, '')).filter(v => /^[A-Za-z_]+$/.test(v));
                const current = tokens.find(t => t.startsWith('['))?.replace(/[[\]]/g, '') ?? null;
                if (values.length > 1)
                    return {path, values, current};
            }
        } catch (e) {
            // No power supply information.
        }
        return null;
    }

    /** Writing charge_types needs administrator rights: asks through polkit. */
    _setChargeType(path, value) {
        try {
            const proc = Gio.Subprocess.new(['pkexec', 'tee', path],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(`${value}\n`, null, (pr, res) => {
                try {
                    pr.communicate_utf8_finish(res);
                } catch (e) {
                    console.warn(`Fusion Desk: charging mode not changed: ${e.message}`);
                }
            });
        } catch (e) {
            console.warn(`Fusion Desk: charging mode not changed: ${e.message}`);
        }
    }

    // ---- drawing -------------------------------------------------------------

    _draw(area) {
        const proxy = this._proxy;
        const pct = Math.max(0, Math.min(100, Math.round(proxy?.Percentage ?? 0)));
        const state = proxy?.State ?? 0;
        const charging = state === CHARGING || state === PENDING_CHARGE;
        const node = area.get_theme_node();
        // fusion-battery's colour is the accent; the number over the empty part uses the panel text colour.
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

        // Percentage (and a bolt while charging), readable on what is behind each part.
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
        if (this._proxyId)
            this._proxy.disconnect(this._proxyId);
        this._proxy = this._profiles = null;
        if (!this._area)
            return;
        for (const actor of this._gnome ?? [])
            actor.disconnectObject(this);
        this._button?.menu.disconnectObject(this);
        if (this._button)
            this._button.destroy();
        else
            this._area.destroy();
        this._area = this._button = null;
        // GNOME decides again which of its own icon / label to show.
        this._system?._indicator?.show();
        this._system?._sync?.();
    }
}
