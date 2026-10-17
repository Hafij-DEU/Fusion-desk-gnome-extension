// CPU / RAM / network / temperature readout with a details menu.
// Which readouts show in the panel can be switched from the menu itself.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const decoder = new TextDecoder();

function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch {
        return '';
    }
}

function formatRate(bytes) {
    if (bytes < 1000)
        return `${Math.round(bytes)} B`;
    if (bytes < 1e6)
        return `${(bytes / 1e3).toFixed(1)} kB`;
    if (bytes < 1e9)
        return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Short rate for the panel: "840 B", "12 K", "3.4 M". */
function compactRate(bytes) {
    if (bytes < 1000)
        return `${Math.round(bytes)}B`;
    for (const [div, unit] of [[1e3, 'K'], [1e6, 'M'], [1e9, 'G']]) {
        const v = bytes / div;
        if (v < 1000 || unit === 'G')
            return `${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`;
    }
    return '';
}

function readCpu() {
    const line = readFile('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = (line[3] ?? 0) + (line[4] ?? 0);
    const total = line.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle, total};
}

function readMem() {
    const info = {};
    for (const l of readFile('/proc/meminfo').split('\n')) {
        const m = /^(\w+):\s+(\d+)/.exec(l);
        if (m)
            info[m[1]] = Number(m[2]) * 1024;
    }
    return info;
}

function readNet() {
    let rx = 0, tx = 0;
    for (const l of readFile('/proc/net/dev').split('\n').slice(2)) {
        const [iface, rest] = l.split(':');
        if (!rest || iface.trim() === 'lo')
            continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
    }
    return {rx, tx};
}

function readTemp() {
    // Prefer a CPU package sensor.
    let best = null;
    for (let i = 0; i < 16; i++) {
        const type = readFile(`/sys/class/thermal/thermal_zone${i}/type`).trim();
        if (!type)
            break;
        const t = Number(readFile(`/sys/class/thermal/thermal_zone${i}/temp`)) / 1000;
        if (!t)
            continue;
        if (/x86_pkg|cpu|k10temp|tctl|soc/i.test(type))
            return t;
        best ??= t;
    }
    return best;
}

// Panel readouts: setting key, chip label, icon.
const READOUTS = [
    ['sysmon-cpu', 'CPU', 'fusion-cpu'],
    ['sysmon-ram', 'Memory', 'fusion-ram'],
    ['sysmon-temp', 'Temp', 'fusion-temp'],
    ['sysmon-net', 'Network', null],
];

const SysMonitorButton = GObject.registerClass(
class FusionSysMonitor extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Fusion System Monitor', false);
        this._iconDir = GLib.build_filenamev([ext.path, 'icons']);
        this._settings = ext.settings;
        this.add_style_class_name('fusion-sysmon');
        this.menu.actor.add_style_class_name('fusion-sysmon-menu');
        const box = new St.BoxLayout({style_class: 'fusion-sysmon-box'});
        this.add_child(box);

        this._items = {};
        const labels = {};
        for (const [key, , icon] of READOUTS) {
            const item = new St.BoxLayout({style_class: 'fusion-sysmon-item', y_align: Clutter.ActorAlign.CENTER});
            if (icon)
                item.add_child(new St.Icon({gicon: this._icon(icon), style_class: 'fusion-sysmon-icon', y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(item);
            this._items[key] = item;
            if (key === 'sysmon-net')
                continue;
            labels[key] = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER, style_class: 'fusion-sysmon-label'});
            item.add_child(labels[key]);
        }
        this._cpuLabel = labels['sysmon-cpu'];
        this._ramLabel = labels['sysmon-ram'];
        this._tempLabel = labels['sysmon-temp'];

        // Upload over download in one narrow column.
        const net = this._items['sysmon-net'];
        net.add_style_class_name('fusion-sysmon-net');
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        const rateRow = (icon, style) => {
            const row = new St.BoxLayout({style_class: `fusion-sysmon-rate-row ${style}`});
            row.add_child(new St.Icon({gicon: this._icon(icon), style_class: 'fusion-sysmon-arrow', y_align: Clutter.ActorAlign.CENTER}));
            const l = new St.Label({text: '…', style_class: 'fusion-sysmon-rate', y_align: Clutter.ActorAlign.CENTER});
            row.add_child(l);
            col.add_child(row);
            return l;
        };
        this._upLabel = rateRow('fusion-up', 'up');
        this._downLabel = rateRow('fusion-down', 'down');
        net.add_child(col);

        this._buildMenu();
        this._syncVisible();
        this._settings.connectObject('changed', (_s, key) => {
            if (key in this._items)
                this._syncVisible();
        }, this);

        this._prevCpu = readCpu();
        this._prevNet = readNet();
        this._prevTime = GLib.get_monotonic_time();
        this._update();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, this._settings.get_int('sysmon-interval'), () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._update();
        });
    }

    _icon(name) {
        return Gio.icon_new_for_string(GLib.build_filenamev([this._iconDir, `${name}-symbolic.svg`]));
    }

    _buildMenu() {
        this._details = {};
        const grid = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'fusion-sysmon-details'});
        const rows = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'fusion-sysmon-rows'});
        for (const k of ['CPU', 'Load', 'Memory', 'Swap', 'Temperature', 'Download', 'Upload', 'Uptime']) {
            const row = new St.BoxLayout({style_class: 'fusion-sysmon-row', x_expand: true});
            row.add_child(new St.Label({text: k, style_class: 'fusion-sysmon-key', y_align: Clutter.ActorAlign.CENTER}));
            const value = new St.Label({x_expand: true, x_align: Clutter.ActorAlign.END, style_class: 'fusion-sysmon-value'});
            row.add_child(value);
            rows.add_child(row);
            this._details[k] = value;
        }
        grid.add_child(rows);
        this.menu.addMenuItem(grid);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Toggle chips: they stay open while you pick what the panel shows.
        const chipsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'fusion-sysmon-pick'});
        const pick = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'fusion-sysmon-pick-box'});
        pick.add_child(new St.Label({text: 'Show in panel', style_class: 'fusion-sysmon-key'}));
        const chips = new St.BoxLayout({style_class: 'fusion-sysmon-chips'});
        for (const [key, name] of READOUTS) {
            const chip = new St.Button({
                label: name,
                style_class: 'fusion-sysmon-chip',
                toggle_mode: true,
                can_focus: true,
                checked: this._settings.get_boolean(key),
            });
            chip.connect('notify::checked', () => this._settings.set_boolean(key, chip.checked));
            this._settings.connectObject(`changed::${key}`, () => {
                chip.checked = this._settings.get_boolean(key);
            }, chip);
            chips.add_child(chip);
        }
        pick.add_child(chips);
        chipsItem.add_child(pick);
        this.menu.addMenuItem(chipsItem);
    }

    _syncVisible() {
        let any = false;
        for (const [key, item] of Object.entries(this._items)) {
            item.visible = this._settings.get_boolean(key);
            any ||= item.visible;
        }
        // Keep something clickable so the menu (and its switches) stay reachable.
        if (!any)
            this._items['sysmon-cpu'].visible = true;
    }

    _update() {
        const now = GLib.get_monotonic_time();
        const dt = Math.max((now - this._prevTime) / 1e6, 0.001);
        this._prevTime = now;

        const cpu = readCpu();
        const dTotal = cpu.total - this._prevCpu.total;
        const cpuPct = dTotal > 0 ? 100 * (1 - (cpu.idle - this._prevCpu.idle) / dTotal) : 0;
        this._prevCpu = cpu;

        const mem = readMem();
        const memUsed = (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0);
        const memPct = mem.MemTotal ? 100 * memUsed / mem.MemTotal : 0;
        const swapUsed = (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0);

        const net = readNet();
        const down = Math.max(0, net.rx - this._prevNet.rx) / dt;
        const up = Math.max(0, net.tx - this._prevNet.tx) / dt;
        this._prevNet = net;

        const temp = this._items['sysmon-temp'].visible || this.menu.isOpen ? readTemp() : null;

        this._cpuLabel.text = `${Math.round(cpuPct)}%`;
        this._ramLabel.text = `${Math.round(memPct)}%`;
        this._tempLabel.text = temp === null ? '–' : `${Math.round(temp)}°`;
        this._upLabel.text = compactRate(up);
        this._downLabel.text = compactRate(down);
        // Tint busy readouts.
        const level = (item, pct) => {
            item.remove_style_class_name('warn');
            item.remove_style_class_name('hot');
            if (pct >= 90)
                item.add_style_class_name('hot');
            else if (pct >= 70)
                item.add_style_class_name('warn');
        };
        level(this._items['sysmon-cpu'], cpuPct);
        level(this._items['sysmon-ram'], memPct);
        level(this._items['sysmon-temp'], temp === null ? 0 : (temp - 20) * 1.25);

        if (this.menu.isOpen) {
            const gb = b => `${(b / 1073741824).toFixed(1)} GB`;
            const load = readFile('/proc/loadavg').split(' ').slice(0, 3).join('  ');
            const upSecs = Number(readFile('/proc/uptime').split(' ')[0]) || 0;
            const h = Math.floor(upSecs / 3600), m = Math.floor(upSecs % 3600 / 60);
            this._details.CPU.text = `${cpuPct.toFixed(1)}%`;
            this._details.Load.text = load;
            this._details.Memory.text = `${gb(memUsed)} / ${gb(mem.MemTotal ?? 0)}`;
            this._details.Swap.text = `${gb(swapUsed)} / ${gb(mem.SwapTotal ?? 0)}`;
            this._details.Temperature.text = temp === null ? 'n/a' : `${temp.toFixed(1)} °C`;
            this._details.Download.text = `${formatRate(down)}/s · ${gb(net.rx)}`;
            this._details.Upload.text = `${formatRate(up)}/s · ${gb(net.tx)}`;
            this._details.Uptime.text = `${h} h ${m} min`;
        }
    }

    _onDestroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._settings.disconnectObject(this);
        super._onDestroy();
    }
});

export class SysMonitor {
    constructor(ext) {
        this._button = new SysMonitorButton(ext);
        Main.panel.addToStatusArea('fusion-sysmon', this._button, 0, 'right');
        this.actor = this._button.container;
    }

    destroy() {
        this._button.destroy();
    }
}
