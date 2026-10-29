// CPU / RAM / network / temperature readout with a details menu: cards for
// RAM, swap, files in RAM and zram with history graphs, a stats column, and
// a button into Memory Sweep. Which readouts show in the panel can be
// switched from the menu itself.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {readText} from './files.js';

/** Text of a /proc or /sys file, read without blocking the shell ('' if missing). */
async function readFile(path) {
    return (await readText(path)) ?? '';
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
    return ''; // not reached: 'G' always returns
}

async function readCpu() {
    const line = (await readFile('/proc/stat')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = (line[3] ?? 0) + (line[4] ?? 0);
    const total = line.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle, total};
}

async function readMem() {
    const info = {};
    for (const l of (await readFile('/proc/meminfo')).split('\n')) {
        const m = /^(\w+):\s+(\d+)/.exec(l);
        if (m)
            info[m[1]] = Number(m[2]) * 1024;
    }
    return info;
}

/** Swap devices split into zram and the rest (swap file or partition), sizes in bytes. */
async function readSwap() {
    const zram = {size: 0, used: 0, ram: 0}, disk = {size: 0, used: 0};
    for (const l of (await readFile('/proc/swaps')).split('\n').slice(1)) {
        const [name, , size, used] = l.trim().split(/\s+/);
        if (!name)
            continue;
        const into = name.startsWith('/dev/zram') ? zram : disk;
        into.size += Number(size) * 1024;
        into.used += Number(used) * 1024;
        if (into === zram) {
            // mm_stat field 3: RAM the compressed pages take up.
            const dev = name.slice('/dev/'.length);
            zram.ram += Number((await readFile(`/sys/block/${dev}/mm_stat`)).trim().split(/\s+/)[2]) || 0;
        }
    }
    return {zram, disk};
}

async function readNet() {
    let rx = 0, tx = 0;
    for (const l of (await readFile('/proc/net/dev')).split('\n').slice(2)) {
        const [iface, rest] = l.split(':');
        if (!rest || iface.trim() === 'lo')
            continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
    }
    return {rx, tx};
}

async function readTemp() {
    // Prefer a CPU package sensor.
    let best = null;
    for (let i = 0; i < 16; i++) {
        const type = (await readFile(`/sys/class/thermal/thermal_zone${i}/type`)).trim();
        if (!type)
            break;
        const t = Number((await readFile(`/sys/class/thermal/thermal_zone${i}/temp`))) / 1000;
        if (!t)
            continue;
        if (/x86_pkg|cpu|k10temp|tctl|soc/i.test(type))
            return t;
        best ??= t;
    }
    return best;
}

/** Bytes of files kept in RAM: what /tmp and /dev/shm hold when they are tmpfs. */
async function readFilesInRam() {
    let used = 0;
    for (const l of (await readFile('/proc/mounts')).split('\n')) {
        const [, dir, type] = l.split(' ');
        if (type !== 'tmpfs' || (dir !== '/tmp' && dir !== '/dev/shm'))
            continue;
        try {
            const info = Gio.File.new_for_path(dir).query_filesystem_info('filesystem::used', null);
            used += Number(info.get_attribute_uint64('filesystem::used'));
        } catch (e) {
            // Gone or unreadable: count nothing.
        }
    }
    return used;
}

const gb = b => `${(b / 1073741824).toFixed(1)} GB`;

function formatUptime(secs) {
    const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
    return d ? `${d} d ${h} h` : `${h} h ${m} min`;
}

// Samples each history graph keeps (one per update).
const HISTORY = 40;
const MEMORY_SWEEP = 'io.github.hafij_bge.MemorySweep.desktop';

/** Progress bar: a track with a fill from the left edge. `set(pct, level)`. */
function meterBar() {
    // FixedLayout keeps the fill at the left edge: BinLayout centres a child narrower than itself.
    const track = new St.Widget({style_class: 'fusion-sysmon-track', layout_manager: new Clutter.FixedLayout(), x_expand: true});
    const bar = new St.Widget({style_class: 'fusion-sysmon-bar'});
    track.add_child(bar);
    let fraction = 0, idle = 0;
    const size = () => {
        // The width is only known once the track is on the stage.
        if (track.get_stage())
            bar.width = fraction > 0 ? Math.max(4, Math.round(track.width * fraction)) : 0;
    };
    // Resize after layout, not during the allocation that changed the width.
    track.connect('notify::width', () => {
        if (!idle) {
            idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                idle = 0;
                size();
                return GLib.SOURCE_REMOVE;
            });
        }
    });
    track.connect('destroy', () => {
        if (idle)
            GLib.source_remove(idle);
    });
    return {actor: track, set: (pct, level) => {
        fraction = Math.min(100, Math.max(0, pct)) / 100;
        bar.style_class = `fusion-sysmon-bar ${level}`;
        size();
    }};
}

/** Bar colour for a fill level: blue, yellow from 70 %, red from 90 %. */
const levelOf = pct => pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';

/** History graph of `history` (0–100 values): a line over a fading fill, stretched to the full width. */
function drawSpark(area, history, rgb) {
    const [w, h] = area.get_surface_size();
    const cr = area.get_context();
    const n = history.length;
    if (n >= 2 && w > 0 && h > 0) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Fit the range shown, at least 10 points tall, so small changes still show.
        let lo = Math.min(...history), hi = Math.max(...history);
        const pad = Math.max(0, 10 - (hi - lo)) / 2 + 2;
        lo = Math.max(0, lo - pad);
        hi = Math.min(100, hi + pad);
        if (hi - lo < 1)
            hi = lo + 1;
        const step = w / (n - 1);
        const line = 2 * sf;
        const y = v => line + (h - 2 * line) * (1 - (v - lo) / (hi - lo));
        const path = () => {
            cr.moveTo(0, y(history[0]));
            for (let i = 1; i < n; i++)
                cr.lineTo(i * step, y(history[i]));
        };
        path();
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        const fade = new Cairo.LinearGradient(0, 0, 0, h);
        fade.addColorStopRGBA(0, ...rgb, 0.65);
        fade.addColorStopRGBA(1, ...rgb, 0.15);
        cr.setSource(fade);
        cr.fill();
        path();
        cr.setSourceRGBA(...rgb, 1);
        cr.setLineWidth(line);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
    }
    cr.$dispose();
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
        this._ext = ext;
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

        // First sample: rates need two readings, so start from this one.
        this._prevCpu = null;
        this._prevNet = null;
        this._prevTime = GLib.get_monotonic_time();
        this._update();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, this._settings.get_int('sysmon-interval'), () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                return;
            // Light popup: plain black text in the details.
            const c = this.menu.box.get_theme_node().get_background_color();
            const scale = Math.max(c.red, c.green, c.blue) > 1 ? 1 : 255;
            if ((c.red + c.green + c.blue) * scale / 3 > 140)
                this.menu.actor.add_style_class_name('fusion-sysmon-light');
            else
                this.menu.actor.remove_style_class_name('fusion-sysmon-light');
            this._syncSweep();
            this._update();
        }, this);
    }

    _icon(name) {
        return Gio.icon_new_for_string(GLib.build_filenamev([this._iconDir, `${name}-symbolic.svg`]));
    }

    _buildMenu() {
        this._history = {ram: [], swap: [], files: []};
        // Sections, not menu items: GNOME greys out items that cannot be clicked.
        const top = new PopupMenu.PopupMenuSection();
        top.actor.add_style_class_name('fusion-sysmon-details');
        const body = new St.BoxLayout({style_class: 'fusion-sysmon-body', x_expand: true});
        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-sysmon-left', x_expand: true});
        const cards = new St.BoxLayout({style_class: 'fusion-sysmon-cards', x_expand: true});
        // Card: setting the history key, title, icon, tile colour, graph colour, what a click opens.
        this._cards = {};
        for (const [key, title, icon, tint, rgb, action] of [
            ['ram', 'RAM', 'fusion-ram', 'blue', [0.21, 0.52, 0.89], null],
            ['swap', 'Swap', 'fusion-swap', 'purple', [0.63, 0.38, 0.86], 'memory'],
            ['files', 'Files in RAM', 'fusion-files', 'green', [0.2, 0.75, 0.45], 'files'],
        ])
            cards.add_child(this._card(key, title, icon, tint, rgb, action));
        left.add_child(cards);
        left.add_child(this._zramCard());
        body.add_child(left);
        body.add_child(this._statsColumn());
        top.actor.add_child(body);
        this.menu.addMenuItem(top);

        // Bottom bar: into Memory Sweep, then toggle chips that keep the menu
        // open while you pick what the panel shows.
        const bottom = new PopupMenu.PopupMenuSection();
        bottom.actor.add_style_class_name('fusion-sysmon-pick');
        const bar = new St.BoxLayout({style_class: 'fusion-sysmon-bottom', x_expand: true});
        // Pushes the button and chips to the right, as in Memory Sweep's own bars.
        bar.add_child(new St.Widget({x_expand: true}));
        const sweepBox = new St.BoxLayout({style_class: 'fusion-sysmon-sweep-box'});
        sweepBox.add_child(new St.Icon({gicon: this._icon('fusion-sweep'), style_class: 'fusion-sysmon-sweep-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._sweepLabel = new St.Label({text: 'Open Memory Sweep', y_align: Clutter.ActorAlign.CENTER});
        sweepBox.add_child(this._sweepLabel);
        const sweep = new St.Button({child: sweepBox, style_class: 'fusion-sysmon-sweep', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        sweep.connect('clicked', () => this._openSweep(null));
        bar.add_child(sweep);
        bar.add_child(new St.Widget({style_class: 'fusion-sysmon-divider', y_expand: true}));
        bar.add_child(new St.Label({text: 'Show in panel:', style_class: 'fusion-sysmon-key', y_align: Clutter.ActorAlign.CENTER}));
        const chips = new St.BoxLayout({style_class: 'fusion-sysmon-chips', y_align: Clutter.ActorAlign.CENTER});
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
        bar.add_child(chips);
        bottom.actor.add_child(bar);
        this.menu.addMenuItem(bottom);
        this._syncSweep();
    }

    /** Tinted rounded square behind a coloured icon; `big` for the cards. */
    _tile(icon, tint, big = false) {
        return new St.Bin({
            style_class: `fusion-sysmon-tile ${tint}${big ? ' big' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this._icon(icon), style_class: 'fusion-sysmon-tile-icon'}),
        });
    }

    /** Chevron that says a card opens Memory Sweep. */
    _next() {
        return new St.Icon({gicon: this._icon('fusion-next'), style_class: 'fusion-sysmon-next', y_align: Clutter.ActorAlign.CENTER});
    }

    _card(key, title, icon, tint, rgb, action) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-sysmon-card-box', x_expand: true});
        // Head: tile beside the title over the percent. No chevron: it would
        // cut the title short in the narrow card, and hover shows it is a button.
        const head = new St.BoxLayout({style_class: 'fusion-sysmon-card-head', x_expand: true});
        head.add_child(this._tile(icon, tint, false));
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const titleRow = new St.BoxLayout({x_expand: true});
        titleRow.add_child(new St.Label({text: title, style_class: 'fusion-sysmon-key fusion-sysmon-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        col.add_child(titleRow);
        const pct = new St.Label({text: '–', style_class: 'fusion-sysmon-value fusion-sysmon-big'});
        col.add_child(pct);
        head.add_child(col);
        box.add_child(head);
        const meter = meterBar();
        box.add_child(meter.actor);
        const detail = new St.Label({text: '', style_class: 'fusion-sysmon-sub'});
        box.add_child(detail);
        const spark = new St.DrawingArea({style_class: 'fusion-sysmon-spark', x_expand: true});
        spark.connect('repaint', area => drawSpark(area, this._history[key], rgb));
        box.add_child(spark);
        const card = new St.Button({child: box, style_class: 'fusion-sysmon-card', can_focus: true, x_expand: true});
        card.connect('clicked', () => this._openSweep(action));
        this._cards[key] = {pct, meter, detail, spark};
        return card;
    }

    /** zram row: tile, title over sizes, then a short bar and the chevron. */
    _zramCard() {
        const box = new St.BoxLayout({style_class: 'fusion-sysmon-zram-box', x_expand: true});
        box.add_child(this._tile('fusion-zram', 'amber', true));
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-sysmon-zram-col', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        col.add_child(new St.Label({text: 'zram', style_class: 'fusion-sysmon-key fusion-sysmon-title'}));
        const detail = new St.Label({text: '', style_class: 'fusion-sysmon-sub'});
        col.add_child(detail);
        box.add_child(col);
        const meter = meterBar();
        meter.actor.x_expand = false;
        meter.actor.y_align = Clutter.ActorAlign.CENTER;
        meter.actor.add_style_class_name('fusion-sysmon-zram-track');
        box.add_child(meter.actor);
        box.add_child(this._next());
        const card = new St.Button({child: box, style_class: 'fusion-sysmon-card fusion-sysmon-zram', can_focus: true, x_expand: true});
        card.connect('clicked', () => this._openSweep('memory'));
        this._zram = {card, detail, meter};
        return card;
    }

    _statsColumn() {
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'fusion-sysmon-stats'});
        this._stats = {};
        for (const [name, icon, tint] of [
            ['CPU', 'fusion-cpu', 'blue'],
            ['Load', 'fusion-load', 'purple'],
            ['Temp', 'fusion-temp', 'orange'],
            ['Down', 'fusion-down', 'green'],
            ['Up', 'fusion-up', 'teal'],
            ['Uptime', 'fusion-clock', 'grey'],
        ]) {
            const row = new St.BoxLayout({style_class: 'fusion-sysmon-stat', x_expand: true, y_expand: true});
            row.add_child(this._tile(icon, tint));
            row.add_child(new St.Label({text: name, style_class: 'fusion-sysmon-key', y_align: Clutter.ActorAlign.CENTER}));
            const value = new St.Label({text: '–', style_class: 'fusion-sysmon-value fusion-sysmon-stat-value', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
            row.add_child(value);
            col.add_child(row);
            this._stats[name] = value;
        }
        return col;
    }

    _sweepApp() {
        return Shell.AppSystem.get_default().lookup_app(MEMORY_SWEEP);
    }

    /** "Open" when Memory Sweep is installed, else "Install" (from Fusion Desk settings). */
    _syncSweep() {
        this._sweepLabel.text = this._sweepApp() ? 'Open Memory Sweep' : 'Install Memory Sweep';
    }

    /** Memory Sweep, on the page of desktop action `action` (null: its start page). */
    _openSweep(action) {
        this.menu.close();
        const app = this._sweepApp();
        if (!app) {
            // Its install button sits on the System page of the settings.
            this._ext.openPreferences();
            return;
        }
        const info = app.get_app_info();
        if (action && info?.list_actions().includes(action))
            info.launch_action(action, global.create_app_launch_context(0, -1));
        else
            app.activate();
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

    async _update() {
        // One sample at a time; reads are async so the shell never blocks.
        if (this._updating)
            return;
        this._updating = true;
        try {
            await this._sample();
        } catch (e) {
            console.error('Fusion Desk: system monitor update failed', e);
        } finally {
            this._updating = false;
        }
    }

    async _sample() {
        const now = GLib.get_monotonic_time();
        const dt = Math.max((now - this._prevTime) / 1e6, 0.001);
        this._prevTime = now;

        const [cpu, mem, net, swap, files] = await Promise.all([readCpu(), readMem(), readNet(), readSwap(), readFilesInRam()]);
        const temp = this._items['sysmon-temp'].visible || this.menu.isOpen ? await readTemp() : null;
        if (this._destroyed)
            return;
        const prevCpu = this._prevCpu ?? cpu;
        const dTotal = cpu.total - prevCpu.total;
        const cpuPct = dTotal > 0 ? 100 * (1 - (cpu.idle - prevCpu.idle) / dTotal) : 0;
        this._prevCpu = cpu;

        const memTotal = mem.MemTotal ?? 0;
        const memUsed = memTotal - (mem.MemAvailable ?? 0);
        const memPct = memTotal ? 100 * memUsed / memTotal : 0;
        const swapPct = swap.disk.size ? 100 * swap.disk.used / swap.disk.size : 0;
        const filesPct = memTotal ? 100 * files / memTotal : 0;

        const prevNet = this._prevNet ?? net;
        const down = Math.max(0, net.rx - prevNet.rx) / dt;
        const up = Math.max(0, net.tx - prevNet.tx) / dt;
        this._prevNet = net;

        // History graphs keep filling while the menu is closed.
        for (const [key, v] of [['ram', memPct], ['swap', swapPct], ['files', filesPct]]) {
            const h = this._history[key];
            h.push(v);
            if (h.length > HISTORY)
                h.shift();
        }

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
            const [loadavg, uptime] = await Promise.all([readFile('/proc/loadavg'), readFile('/proc/uptime')]);
            if (this._destroyed)
                return;
            const card = (key, pct, detail, on = true) => {
                const c = this._cards[key];
                c.pct.text = on ? `${Math.round(pct)}%` : 'Off';
                c.meter.set(pct, levelOf(pct));
                c.detail.text = detail;
                c.spark.queue_repaint();
            };
            card('ram', memPct, `${gb(memUsed)} / ${gb(memTotal)}`);
            card('swap', swapPct, swap.disk.size ? `${gb(swap.disk.used)} / ${gb(swap.disk.size)}` : 'No swap file', swap.disk.size > 0);
            card('files', filesPct, gb(files));
            // zram is used first; its used part takes compressed room in RAM.
            this._zram.card.visible = swap.zram.size > 0;
            const zramPct = swap.zram.size ? 100 * swap.zram.used / swap.zram.size : 0;
            this._zram.detail.text = `${gb(swap.zram.used)} / ${gb(swap.zram.size)}  (${Math.round(zramPct)}%)  ·  ${gb(swap.zram.ram)} in RAM`;
            this._zram.meter.set(zramPct, 'amber');

            this._stats.CPU.text = `${Math.round(cpuPct)}%`;
            this._stats.Load.text = loadavg.split(' ').slice(0, 3).join('  ') || '–';
            this._stats.Temp.text = temp === null ? 'n/a' : `${Math.round(temp)} °C`;
            // Rate now, then the total since boot.
            this._stats.Down.text = `${formatRate(down)}/s · ${formatRate(net.rx)}`;
            this._stats.Up.text = `${formatRate(up)}/s · ${formatRate(net.tx)}`;
            this._stats.Uptime.text = formatUptime(Number(uptime.split(' ')[0]) || 0);
        }
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._settings.disconnectObject(this);
        this.menu.disconnectObject(this);
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
