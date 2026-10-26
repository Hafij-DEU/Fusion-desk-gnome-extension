// Preferences: zram and swap file sizes (System page). Changes run the swap
// helper (lib/swap/) as root through pkexec, which asks for the password.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const ZRAM_CONF = '/etc/default/zramswap';
const ZRAMSWAP = '/usr/sbin/zramswap';
const ALGOS = ['lz4', 'zstd', 'lzo-rle'];
const ALGO_LABELS = ['lz4 (fastest)', 'zstd (packs the most)', 'lzo-rle'];
// What the helper's exit codes mean; pkexec itself uses 126 / 127 when the password is not given.
const ERRORS = {
    2: 'The value is out of range',
    3: 'Not enough free disk space (2 GB must stay free)',
    4: 'Not enough free memory to take back what is swapped out now; close some apps and try again',
    5: 'Swap files on btrfs are not supported here',
    6: 'zram-tools is not installed',
    126: 'Cancelled',
    127: 'Cancelled',
};

function read(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch (e) {
        return '';
    }
}

const gb = kib => `${(kib / 1048576).toFixed(1)} GB`;

/** Swap devices from /proc/swaps: [{name, type, size, used}] in KiB. */
function swaps() {
    return read('/proc/swaps').split('\n').slice(1).filter(Boolean).map(l => {
        const [name, type, size, used] = l.trim().split(/\s+/);
        return {name, type, size: Number(size), used: Number(used)};
    });
}

function ramKib() {
    return Number(/^MemTotal:\s+(\d+)/m.exec(read('/proc/meminfo'))?.[1] ?? 0);
}

function zramConf(key) {
    return new RegExp(`^${key}=(\\S+)`, 'm').exec(read(ZRAM_CONF))?.[1] ?? null;
}

function diskFreeKib(path) {
    try {
        const info = Gio.File.new_for_path(GLib.path_get_dirname(path)).query_filesystem_info('filesystem::free', null);
        return Number(info.get_attribute_uint64('filesystem::free')) / 1024;
    } catch (e) {
        return 0;
    }
}

/** The swap file in use, else the one in fstab, else Ubuntu's default (same order as the helper). */
function swapFilePath() {
    const active = swaps().find(d => d.type === 'file');
    if (active)
        return active.name;
    for (const l of read('/etc/fstab').split('\n')) {
        const f = l.trim().split(/\s+/);
        if (f[2] === 'swap' && f[0].startsWith('/') && !f[0].startsWith('/dev/'))
            return f[0];
    }
    return '/swap.img';
}

/** Run the helper as root; `done(error)` afterwards, error null on success. */
function runHelper(extPath, args, done) {
    const script = GLib.build_filenamev([extPath, 'lib', 'swap', 'fusion-desk-swap']);
    try {
        const proc = Gio.Subprocess.new(['pkexec', '/bin/sh', script, ...args.map(String)],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_async(null, () => {
            const code = proc.get_exit_status();
            done(code === 0 ? null : ERRORS[code] ?? `Failed (code ${code})`);
        });
    } catch (e) {
        done(e.message);
    }
}

/** A row's Apply button, shown only while the row differs from what is in use. */
function applyButton(row) {
    const b = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'], visible: false});
    row.add_suffix(b);
    return b;
}

/** "Swap and zram" group: zram size and compression, swap file size. */
export function swapGroup(window, extPath) {
    const g = new Adw.PreferencesGroup({
        title: 'Swap and zram',
        description: 'Extra room for when RAM runs full. zram keeps memory compressed inside RAM and is used first; the swap file on disk is slower and takes over when zram is full. Applying asks for your password.',
    });
    const toast = text => window.add_toast(new Adw.Toast({title: text, timeout: 4}));
    const ram = ramKib();
    const zramInstalled = GLib.file_test(ZRAM_CONF, GLib.FileTest.EXISTS) && GLib.file_test(ZRAMSWAP, GLib.FileTest.IS_EXECUTABLE);

    // zram: size as a percentage of RAM (what zram-tools uses) and compression.
    const zramRow = new Adw.SpinRow({title: 'zram size',
        adjustment: new Gtk.Adjustment({lower: 0, upper: 150, step_increment: 5, page_increment: 25})});
    const algoRow = new Adw.ComboRow({title: 'zram compression', model: Gtk.StringList.new(ALGO_LABELS)});
    const zramApply = applyButton(zramRow);
    // Swap file size in GB.
    const fileRow = new Adw.SpinRow({title: 'Swap file size',
        adjustment: new Gtk.Adjustment({lower: 1, upper: 64, step_increment: 1, page_increment: 4})});
    const fileApply = applyButton(fileRow);

    let zramNow = {percent: 0, algo: 'lz4'}, fileNow = 0;
    const zramSubtitle = () => {
        const dev = swaps().filter(d => d.name.startsWith('/dev/zram'));
        const used = dev.reduce((a, d) => a + d.used, 0);
        const size = gb(ram * zramRow.value / 100);
        if (!zramInstalled)
            return 'Needs the zram-tools package: sudo apt install zram-tools';
        if (zramRow.value === 0)
            return 'Off';
        return dev.length && zramRow.value === zramNow.percent
            ? `Percent of RAM: ${size}, ${gb(used)} used`
            : `Percent of RAM: ${size}`;
    };
    const fileSubtitle = () => {
        const path = swapFilePath();
        const dev = swaps().find(d => d.name === path);
        const free = gb(diskFreeKib(path) + (dev?.size ?? 0) - fileRow.value * 1048576);
        return dev
            ? `${path}: ${gb(dev.used)} used now · ${free} left free on the disk after applying`
            : `${path} (not in use) · ${free} left free on the disk after applying`;
    };
    const syncButtons = () => {
        zramApply.visible = zramInstalled && (zramRow.value !== zramNow.percent || ALGOS[algoRow.selected] !== zramNow.algo);
        fileApply.visible = fileRow.value !== fileNow;
        zramRow.subtitle = zramSubtitle();
        fileRow.subtitle = fileSubtitle();
    };
    // Read what is in use now into the rows.
    const load = () => {
        const percent = zramConf('PERCENT');
        zramNow = {percent: percent === null ? 50 : Number(percent), algo: zramConf('ALGO') ?? 'lz4'};
        // zram stopped (service off) shows as 0.
        if (!swaps().some(d => d.name.startsWith('/dev/zram')))
            zramNow.percent = 0;
        zramRow.value = zramNow.percent;
        algoRow.selected = Math.max(0, ALGOS.indexOf(zramNow.algo));
        const dev = swaps().find(d => d.name === swapFilePath());
        fileNow = dev ? Math.round(dev.size / 1048576) : 0;
        fileRow.value = fileNow || 4;
        syncButtons();
    };
    load();
    zramRow.sensitive = algoRow.sensitive = zramInstalled;
    zramRow.connect('notify::value', syncButtons);
    algoRow.connect('notify::selected', syncButtons);
    fileRow.connect('notify::value', syncButtons);

    const apply = (button, row, args, working, doneText) => {
        button.sensitive = false;
        row.subtitle = working;
        runHelper(extPath, args, error => {
            button.sensitive = true;
            load();
            toast(error ?? doneText);
        });
    };
    zramApply.connect('clicked', () => apply(zramApply, zramRow, ['zram', zramRow.value, ALGOS[algoRow.selected]],
        'Applying…', zramRow.value ? 'zram is resized' : 'zram is off'));
    fileApply.connect('clicked', () => apply(fileApply, fileRow, ['file', fileRow.value],
        'Applying… this can take a minute while swapped memory moves back', 'The swap file is resized'));

    g.add(zramRow);
    g.add(algoRow);
    g.add(fileRow);
    return g;
}
