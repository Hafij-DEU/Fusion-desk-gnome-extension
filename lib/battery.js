// Battery drawn by Fusion Desk: an accent outline, a fill whose colour shows
// the state (full and charging green, normal accent, low orange, critical
// red) and the percentage inside. It replaces GNOME's battery icon and
// percentage in the status area, or (battery-standalone) becomes its own
// panel button whose menu shows time left, power draw, battery health,
// the batteries of connected gadgets (earbuds per side when reported),
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
import {helperInstalled, runHelper} from './chargeLimit.js';

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
<property name="PowerSupply" type="b" access="read"/>
<property name="Model" type="s" access="read"/>
<property name="Serial" type="s" access="read"/>
<property name="NativePath" type="s" access="read"/>
<property name="ChargeThresholdEnabled" type="b" access="read"/>
<method name="EnableChargeThreshold"><arg name="chargeThreshold" type="b" direction="in"/></method>
</interface></node>`;
const PROFILES_XML = `<node><interface name="org.freedesktop.UPower.PowerProfiles">
<property name="ActiveProfile" type="s" access="readwrite"/>
<property name="Profiles" type="aa{sv}" access="read"/>
</interface></node>`;
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DEVICE_XML);
const ProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PROFILES_XML);

const N_ = s => s;

// Icons for UPower device kinds of wireless gadgets.
const KIND_ICONS = {
    5: 'input-mouse-symbolic', 6: 'input-keyboard-symbolic', 8: 'phone-symbolic',
    9: 'multimedia-player-symbolic', 10: 'input-tablet-symbolic', 12: 'input-gaming-symbolic',
    13: 'input-tablet-symbolic', 14: 'input-touchpad-symbolic', 17: 'audio-headset-symbolic',
    18: 'audio-speakers-symbolic', 19: 'audio-headphones-symbolic', 26: 'smartwatch-symbolic',
};
// Parts of one gadget that report their own battery (earbuds and their case).
const PARTS = [[/\bleft\b|\(l\)|\bL$/i, N_('L')], [/\bright\b|\(r\)|\bR$/i, N_('R')], [/\bcase\b/i, N_('Case')]];

const COLORS = {
    full: [0.18, 0.63, 0.26],
    charging: [0.18, 0.63, 0.26],
    low: [0.88, 0.54, 0.0],
    critical: [0.90, 0.28, 0.30],
};

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
        // GNOME may take the indicator down (e.g. when the panel is rebuilt):
        // stop updating actors that are gone instead of touching them.
        this._area.connect('destroy', () => this._gone());
        this._area.connect('style-changed', () => this._area.queue_repaint());

        if (this._standalone) {
            this._button = new PanelMenu.Button(0.5, _('Battery'), false);
            this._button.add_style_class_name('fusion-battery-button');
            // GNOME 50 panel buttons react to a click gesture: left button opens the menu.
            if (this._button._clickGesture)
                this._button._clickGesture.required_button = Clutter.BUTTON_PRIMARY;
            this._button.add_child(this._area);
            this._button.connect('destroy', () => this._gone());
            this._button.menu.actor.add_style_class_name('fusion-battery-menu');
            this._button.menu.connectObject('open-state-changed', (_m, open) => {
                if (open)
                    this._fillMenu();
            }, this);
            Main.panel.addToStatusArea('fusion-battery', this._button, 0, 'right');
            this.actor = this._button.container;
            this._watchDevices();
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

    _gone() {
        // Taken down by someone else (not our destroy()): GNOME's own icon
        // would come back inside the system menu, so build the battery again.
        if (!this._destroying && !this._rebuildId) {
            this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._rebuildId = 0;
                this._ext._onChanged?.('battery-standalone');
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._proxyId)
            this._proxy?.disconnect(this._proxyId);
        this._proxyId = 0;
        for (const actor of this._gnome ?? [])
            actor.disconnectObject(this);
        this._gnome = null;
        this._area = this._button = null;
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
        if (!this._area || !this._proxy)
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
        // A section, not a menu item: GNOME greys out items that cannot be clicked.
        const head = new PopupMenu.PopupMenuSection();
        head.actor.add_style_class_name('fusion-battery-head');
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
        head.actor.add_child(box);
        menu.addMenuItem(head);

        this._addDevices(menu);
        this._addPowerModes(menu);
        this._addChargeModes(menu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Power Settings'), () => this._openSettings('power'), 'preferences-system-symbolic');
    }

    _openSettings(panel) {
        try {
            Gio.Subprocess.new(['gnome-control-center', panel], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`Fusion Desk: cannot open ${panel} settings: ${e.message}`);
        }
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

    // ---- connected devices (earbuds, mouse, keyboard...) ----------------------

    /** Follow UPower's gadget batteries (Bluetooth headsets, mice, keyboards...). */
    _watchDevices() {
        this._devices = new Map(); // object path -> DeviceProxy
        const bus = Gio.DBus.system;
        const iface = 'org.freedesktop.UPower';
        this._deviceSignals = ['DeviceAdded', 'DeviceRemoved'].map(signal => bus.signal_subscribe(iface, iface, signal,
            '/org/freedesktop/UPower', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, name, params) => {
                const [path] = params.deepUnpack();
                if (name === 'DeviceAdded')
                    this._addDevice(path);
                else
                    this._removeDevice(path);
            }));
        bus.call(iface, '/org/freedesktop/UPower', iface, 'EnumerateDevices', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (_b, res) => {
                try {
                    const [paths] = bus.call_finish(res).deepUnpack();
                    paths.forEach(path => this._addDevice(path));
                } catch (e) {
                    // No UPower: no gadget list.
                }
            });
    }

    _addDevice(path) {
        if (!this._devices || this._devices.has(path) || path.endsWith('/DisplayDevice'))
            return;
        const proxy = new DeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower', path, (p, error) => {
            if (error || !this._devices?.has(path))
                return;
            p.connectObject('g-properties-changed', () => this._devicesChanged(), this);
            this._devicesChanged();
        });
        this._devices.set(path, proxy);
    }

    _removeDevice(path) {
        this._devices?.get(path)?.disconnectObject(this);
        this._devices?.delete(path);
        this._devicesChanged();
    }

    _devicesChanged() {
        if (this._button?.menu.isOpen)
            this._fillMenu();
    }

    /**
     * Gadgets with a battery level, one entry per gadget: [{name, icon, levels}].
     * Earbuds that report each side (and the case) separately share one
     * entry with levels like [['L', 80], ['R', 75], ['Case', 50]].
     */
    _gadgets() {
        const groups = new Map();
        for (const p of this._devices?.values() ?? []) {
            if (p.PowerSupply !== false || !(p.Percentage > 0) || p.Type === KIND_BATTERY)
                continue;
            const model = p.Model || _('Device');
            // Parts of one gadget share its Bluetooth address.
            const key = p.Serial || (p.NativePath ?? '').replace(/\/(battery|bat)[^/]*$/, '') || model;
            if (!groups.has(key))
                groups.set(key, {icon: KIND_ICONS[p.Type] ?? 'battery-symbolic', parts: []});
            groups.get(key).parts.push({model, percent: Math.round(p.Percentage)});
        }
        return [...groups.values()].map(({icon, parts}) => {
            const tag = part => PARTS.find(([re]) => re.test(part.model))?.[1];
            const plain = model => PARTS.reduce((m, [re]) => m.replace(re, ''), model).replace(/[\s(),-]+$/, '').trim();
            if (parts.length === 1)
                return {icon, name: parts[0].model, levels: [[null, parts[0].percent]]};
            const order = [N_('L'), N_('R'), N_('Case')];
            const levels = parts.map((part, i) => [tag(part) ?? `${i + 1}`, part.percent])
                .sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9));
            return {icon, name: plain(parts[0].model) || parts[0].model, levels};
        }).sort((a, b) => a.name.localeCompare(b.name));
    }

    _addDevices(menu) {
        const gadgets = this._gadgets();
        if (!gadgets.length)
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Devices')));
        for (const g of gadgets) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'fusion-battery-device'});
            item.connect('activate', () => this._openSettings('bluetooth'));
            item.add_child(new St.Icon({icon_name: g.icon, style_class: 'popup-menu-icon'}));
            item.add_child(new St.Label({text: g.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'fusion-battery-device-name'}));
            const levels = new St.BoxLayout({style_class: 'fusion-battery-device-levels', y_align: Clutter.ActorAlign.CENTER});
            for (const [part, percent] of g.levels) {
                const pill = new St.BoxLayout({style_class: 'fusion-battery-device-level'});
                if (percent <= 20)
                    pill.add_style_class_name('fusion-battery-device-low');
                if (part)
                    pill.add_child(new St.Label({text: _(part), style_class: 'fusion-battery-device-part'}));
                pill.add_child(new St.Label({text: `${percent}%`}));
                levels.add_child(pill);
            }
            item.add_child(levels);
            menu.addMenuItem(item);
        }
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
        // With the one-time setup the helper changes it without a password.
        if (helperInstalled()) {
            runHelper(['mode', value]);
            return;
        }
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
        this._destroying = true;
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        if (this._proxyId)
            this._proxy?.disconnect(this._proxyId);
        this._proxyId = 0;
        this._proxy = this._profiles = null;
        for (const id of this._deviceSignals ?? [])
            Gio.DBus.system.signal_unsubscribe(id);
        this._deviceSignals = null;
        for (const p of this._devices?.values() ?? [])
            p.disconnectObject(this);
        this._devices = null;
        if (!this._area)
            return;
        for (const actor of this._gnome ?? [])
            actor.disconnectObject(this);
        this._button?.menu.disconnectObject(this);
        const button = this._button, area = this._area;
        this._area = this._button = null;
        if (button)
            button.destroy();
        else
            area.destroy();
        // GNOME decides again which of its own icon / label to show.
        this._system?._indicator?.show();
        this._system?._sync?.();
    }
}
