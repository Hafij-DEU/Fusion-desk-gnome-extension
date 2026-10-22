// Data for the Dashboard layout: background picture, unfinished downloads,
// today's calendar events, screen tools, greeting and the daily tip. No
// layout code here (that lives in layouts.js).
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import {fileKind} from './model.js';
import {listDir, readText} from '../files.js';
import {prefersDark} from '../style.js';

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'replace_async', 'replace_finish');
Gio._promisify(Gio.File.prototype, 'move_async', 'move_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async', 'query_filesystem_info_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const BG = 'org.gnome.desktop.background';
const PICTURE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk', 'dashboard']);
// Pictures are scaled to fit this box once, so the menu never decodes a
// full-size wallpaper on the main loop.
const PICTURE_W = 1920, PICTURE_H = 1200;

// ---- Background picture -----------------------------------------------------

/** Path of the picture for the `menu-dash-background` setting, or null (plain surface). */
export function backgroundPath(settings, extPath) {
    const mode = settings.get_string('menu-dash-background');
    if (mode === 'SPACE')
        return GLib.build_filenamev([extPath, 'icons', 'dashboard-space.jpg']);
    if (mode === 'IMAGE')
        return settings.get_string('menu-dash-image').trim() || null;
    if (mode !== 'WALLPAPER')
        return null;
    const bg = new Gio.Settings({schema_id: BG});
    const uri = (prefersDark() && bg.get_string('picture-uri-dark')) || bg.get_string('picture-uri');
    if (!uri || uri.endsWith('.xml'))
        return null; // slide shows have no single picture
    return Gio.File.new_for_uri(uri).get_path();
}

/** Call `cb` when the wallpaper (light or dark) changes; returns a disconnect function. */
export function watchWallpaper(cb) {
    const bg = new Gio.Settings({schema_id: BG});
    const ids = ['changed::picture-uri', 'changed::picture-uri-dark'].map(sig => bg.connect(sig, () => cb()));
    return () => ids.forEach(id => bg.disconnect(id));
}

const scaled = new Map(); // source key -> scaled path (this session)

/**
 * A copy of the picture at `path` scaled down to at most 1920×1200, made in
 * the background and kept in ~/.cache/fusion-desk/dashboard. Resolves to its
 * file path, or null when the picture cannot be read.
 */
export async function scaledPicture(path) {
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = await file.query_info_async('time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    } catch {
        return null;
    }
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
        `${path}|${info.get_modification_date_time()?.to_unix() ?? 0}|${info.get_size()}`, -1);
    if (scaled.has(key))
        return scaled.get(key);
    const out = GLib.build_filenamev([PICTURE_DIR, `${key}.jpg`]);
    if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
        scaled.set(key, out);
        return out;
    }
    try {
        GLib.mkdir_with_parents(PICTURE_DIR, 0o700);
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
        const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, PICTURE_W, PICTURE_H, true, null);
        stream.close(null);
        const part = Gio.File.new_for_path(`${out}.part`);
        const output = await part.replace_async(null, false, Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, null);
        await new Promise((resolve, reject) => pixbuf.save_to_streamv_async(output, 'jpeg', ['quality'], ['88'], null, (_p, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        }));
        output.close(null);
        await part.move_async(Gio.File.new_for_path(out), Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
    } catch (e) {
        console.warn(`Fusion Desk: dashboard picture ${path}: ${e.message}`);
        return null;
    }
    scaled.set(key, out);
    // Older scaled pictures are no longer needed.
    const keep = new Set(scaled.values());
    for (const name of await listDir(PICTURE_DIR)) {
        const p = GLib.build_filenamev([PICTURE_DIR, name]);
        if (!keep.has(p))
            Gio.File.new_for_path(p).delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
    return out;
}

const sizes = new Map(); // scaled path -> [width, height]

/** [width, height] of a scaled picture (reads only its header), or null. */
export function pictureSize(path) {
    if (!sizes.has(path)) {
        const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        sizes.set(path, format ? [width, height] : null);
    }
    return sizes.get(path);
}

// ---- Recent files -------------------------------------------------------------

export const FILE_FILTERS = [['all', 'All'], ['documents', 'Documents'], ['images', 'Images'],
    ['pdf', 'PDF'], ['markdown', 'Markdown'], ['other', 'Other']];

const DOCUMENT = /opendocument|officedocument|msword|ms-excel|ms-powerpoint|rtf|epub|spreadsheet|presentation|xournal|x-xopp/;

/** 'documents', 'images', 'pdf', 'markdown' or 'other' for a recent file. */
export function dashKind(file) {
    const type = file.contentType ?? '';
    const name = (file.name ?? '').toLowerCase();
    if (type === 'application/pdf')
        return 'pdf';
    if (type === 'text/markdown' || /\.(md|markdown)$/.test(name))
        return 'markdown';
    if (fileKind(type) === 'images')
        return 'images';
    if (fileKind(type) === 'docs' && (type.startsWith('text/') || DOCUMENT.test(type)))
        return 'documents';
    return 'other';
}

// ---- Downloads (Draco DM) ---------------------------------------------------

export const DRACO_ID = 'io.github.draco.DracoDM.desktop';
const DRACO_LIST = GLib.build_filenamev([GLib.get_user_data_dir(), 'draco', 'downloads.json']);

/**
 * Unfinished Draco DM downloads from the list it keeps on disk:
 * {count, done (0–1, or -1 when sizes are unknown)}, or null when there are
 * none (or Draco is not installed).
 */
export async function unfinishedDownloads() {
    if (!Shell.AppSystem.get_default().lookup_app(DRACO_ID))
        return null;
    let items;
    try {
        items = JSON.parse(await readText(DRACO_LIST) ?? '{}').items ?? [];
    } catch {
        return null;
    }
    const open = items.filter(i => i && i.status && i.status !== 'complete');
    if (!open.length)
        return null;
    const sized = open.filter(i => i.size > 0);
    const size = sized.reduce((sum, i) => sum + i.size, 0);
    const got = sized.reduce((sum, i) => sum + Math.min(i.downloaded ?? 0, i.size), 0);
    return {count: open.length, done: size > 0 && sized.length === open.length ? got / size : -1};
}

/** Whether the Dashboard clock uses 12 hours (setting menu-dash-clock; SYSTEM = GNOME's clock format). */
export function twelveHour(settings) {
    const mode = settings.get_string('menu-dash-clock');
    if (mode !== 'SYSTEM')
        return mode === '12H';
    return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format') === '12h';
}

/** strftime pattern for a time of day: "9:05 PM" or "21:05". */
export function clockPattern(settings) {
    return twelveHour(settings) ? '%-l:%M %p' : '%H:%M';
}

// ---- Storage --------------------------------------------------------------------

/** {size, free} in bytes of the disk that holds the home folder, or null. */
export async function homeStorage() {
    try {
        const info = await Gio.File.new_for_path(GLib.get_home_dir()).query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, null);
        return {size: info.get_attribute_uint64('filesystem::size'), free: info.get_attribute_uint64('filesystem::free')};
    } catch {
        return null;
    }
}

// ---- Calendar ----------------------------------------------------------------

/** The date menu's event source (GNOME Calendar / Evolution), or null. */
export function eventSource() {
    if (!Main.sessionMode.showCalendarEvents)
        return null;
    return Main.panel.statusArea.dateMenu?._eventSource ?? null;
}

/** Today's events: [{time, summary}], all-day ones first. */
export function todayEvents(source, settings) {
    if (!source?.hasCalendars)
        return [];
    const begin = new Date();
    begin.setHours(0, 0, 0, 0);
    const end = new Date(begin);
    end.setDate(end.getDate() + 1);
    const pattern = clockPattern(settings);
    const fmt = d => GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format(pattern);
    return source.getEvents(begin, end).map(e => {
        const allDay = e.date <= begin && e.end >= end;
        return {time: allDay ? 'All day' : fmt(e.date < begin ? begin : e.date), summary: e.summary, allDay};
    }).sort((a, b) => Number(b.allDay) - Number(a.allDay));
}

// ---- Screen tools -------------------------------------------------------------

/** Open the screenshot UI with whole screen or area selection picked. */
export async function openScreenshot(mode = 'screen') {
    const ui = Main.screenshotUI;
    try {
        await ui.open();
        const button = mode === 'screen' ? ui._screenButton : ui._selectionButton;
        if (button && !button.checked)
            button.checked = true;
    } catch (e) {
        console.error('Fusion Desk: screenshot UI failed', e);
    }
}

/** Pick a colour anywhere on screen; its hex code goes to the clipboard. */
export async function pickColor() {
    try {
        const pick = new Screenshot.PickPixel(new Shell.Screenshot());
        const color = await pick.pickAsync();
        if (!color)
            return;
        const hex = `#${[color.red, color.green, color.blue].map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, hex);
        Main.notify('Colour copied', hex);
    } catch {
        // Cancelled with Escape.
    }
}

// Apps that read text or QR codes from the screen: only shown when installed.
const SCREEN_APPS = [
    ['Text from screen', ['com.github.tenderowl.frog.desktop', 'com.github.dynobo.normcap.desktop', 'normcap_normcap.desktop', 'com.github.rajsolai.textsnatcher.desktop']],
    ['QR code', ['com.belmoussaoui.Decoder.desktop']],
];

/** Installed screen text / QR apps: [{name, app}]. */
export function screenApps() {
    const sys = Shell.AppSystem.get_default();
    return SCREEN_APPS.map(([name, ids]) => ({name, app: ids.map(id => sys.lookup_app(id)).find(Boolean)}))
        .filter(t => t.app);
}

// ---- Greeting, quotes and tips ---------------------------------------------------

export function greeting(date = new Date()) {
    const h = date.getHours();
    if (h < 5)
        return ['Good night', 'weather-clear-night-symbolic'];
    if (h < 12)
        return ['Good morning', 'weather-clear-symbolic'];
    if (h < 18)
        return ['Good afternoon', 'weather-few-clouds-symbolic'];
    return ['Good evening', 'weather-clear-night-symbolic'];
}

/** First name for the greeting ("Hafij"). */
export function firstName() {
    const words = (GLib.get_real_name() || GLib.get_user_name()).split(/\s+/);
    return words.find(w => w.length > 2 && !/^(md|mohd|dr|mr|mrs|ms)\.?$/i.test(w)) ?? words[0];
}

const ENCOURAGEMENTS = [
    'Ready when you are.',
    'One thing at a time.',
    'Make today count.',
    'Small steps add up.',
    'You have got this.',
    'Pick up where you left off.',
    'Take a short break now and then.',
];

const QUOTES = [
    'Start where you are. Use what you have.',
    'Done is better than perfect.',
    'Simple things, done well.',
    'Progress, not perfection.',
    'Focus on what matters most.',
    'Every expert was once a beginner.',
    'Make it work, then make it better.',
    'Curiosity is a good place to start.',
];

export const TIPS = [
    'Type 2+2*3 in the search box to calculate.',
    'Type >command in the search box to run it.',
    'Right-click any app to pin it to Start or the taskbar.',
    'Middle-click the start button for the Activities overview.',
    'Super+Left and Super+Right tile a window to half the screen.',
    'Super+Page Up and Super+Page Down switch workspaces.',
    'Print Screen opens the screenshot tool.',
    'Ctrl+Shift+Alt+R starts and stops a screen recording.',
    'Super+L locks the screen.',
    'Alt+F2 runs a command.',
    'Super+Tab switches apps; Alt+` switches windows of one app.',
];

function dayNumber(date = new Date()) {
    return Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
}

export function encouragement() {
    return ENCOURAGEMENTS[dayNumber() % ENCOURAGEMENTS.length];
}

export function quote() {
    return QUOTES[dayNumber() % QUOTES.length];
}

/** Today's tip index (the list rotates daily). */
export function tipOfTheDay() {
    return dayNumber() % TIPS.length;
}
