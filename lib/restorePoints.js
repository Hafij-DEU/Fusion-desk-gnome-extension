// Restore points: dated copies of the whole Fusion Desk setup that come back
// with one click (Settings → Panel → Restore points, or the panel's Style menu).
//
// Layers, top to bottom; each one only calls the one below it:
//   1. actions   create / restore / remove / autoPoint / dailyPoint
//   2. capture   what a point holds: every Fusion setting (lib/snapshot.js)
//                plus the shared glass files in ~/.config/harbor/
//   3. storage   one JSON file per point in ~/.config/fusion-desk/restore-points/
//
// Points are kept outside the settings database, so they survive a settings
// reset or a reinstall. Shared by the shell and prefs: no gnome-shell imports.
import GLib from 'gi://GLib';
import {applyKeys, captureKeys} from './snapshot.js';

const FORMAT = 1;
/** Automatic points kept (oldest are removed); points you make are kept. */
const KEEP_AUTO = 15;
const DAY_US = 24 * 3600 * 1e6;
const LOG = 'Fusion Desk restore points:';
const warned = new Set();   // broken files are logged once, not on every listing

// ---- 3. storage ---------------------------------------------------------

function pointsDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'fusion-desk', 'restore-points']);
}

function harborDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'harbor']);
}

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/** Write a file and read it back, so a bad write is caught here, not at restore. */
function writeChecked(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
    if (readText(path) !== text)
        throw new Error(`${path} did not read back as written`);
}

/** Sortable file name: newest-first listing and pruning rely on it. */
function pointId(now) {
    return `${now.format('%Y%m%d-%H%M%S')}-${String(now.get_microsecond()).padStart(6, '0')}`;
}

function readPoint(path) {
    const text = readText(path);
    if (text === null)
        return null;
    try {
        const data = JSON.parse(text);
        if (data?.format !== FORMAT || typeof data.keys !== 'object' || !data.created)
            throw new Error('not a restore point');
        return {...data, path};
    } catch (e) {
        if (!warned.has(path)) {
            warned.add(path);
            console.warn(`${LOG} skipped ${path}: ${e.message}`);
        }
        return null;
    }
}

/** All readable points, newest first. */
export function listPoints() {
    const dir = pointsDir();
    let names = [];
    try {
        const d = GLib.Dir.open(dir, 0);
        for (let n = d.read_name(); n !== null; n = d.read_name()) {
            if (n.endsWith('.json'))
                names.push(n);
        }
        d.close();
    } catch {
        return [];   // no folder yet
    }
    return names.sort().reverse()
        .map(n => readPoint(GLib.build_filenamev([dir, n])))
        .filter(Boolean);
}

function prune() {
    for (const p of listPoints().filter(x => x.auto).slice(KEEP_AUTO)) {
        if (GLib.unlink(p.path) !== 0)
            console.warn(`${LOG} could not remove old point ${p.path}`);
    }
}

// ---- 2. capture ---------------------------------------------------------

/** The shared glass files (glass, glass-global, glass-<app>) as name → text. */
function captureGlassFiles() {
    const files = {};
    try {
        const d = GLib.Dir.open(harborDir(), 0);
        for (let n = d.read_name(); n !== null; n = d.read_name()) {
            if (n === 'glass' || n.startsWith('glass-')) {
                const text = readText(GLib.build_filenamev([harborDir(), n]));
                if (text !== null)
                    files[n] = text;
            }
        }
        d.close();
    } catch {
        // no Harbor config: nothing to keep
    }
    return files;
}

/**
 * Put the glass files back. A per-app file made after the point is set to
 * "global" (follow the global look), which is what its absence meant.
 * Returns the number of files that could not be written.
 */
function applyGlassFiles(files) {
    let failed = 0;
    const now = captureGlassFiles();
    const put = (name, text) => {
        try {
            writeChecked(GLib.build_filenamev([harborDir(), name]), text);
        } catch (e) {
            failed++;
            console.warn(`${LOG} could not restore ${name}: ${e.message}`);
        }
    };
    for (const [name, text] of Object.entries(files))
        put(name, text);
    for (const name of Object.keys(now)) {
        if (!(name in files) && name.startsWith('glass-') && name !== 'glass-global')
            put(name, 'global\n');
    }
    return failed;
}

// ---- 1. actions ---------------------------------------------------------

/** Make a point of the current setup. Returns it ({label, created, path, ...}). */
export function createPoint(settings, label = 'Restore point', auto = false) {
    const now = GLib.DateTime.new_now_local();
    const id = pointId(now);
    const point = {
        format: FORMAT, created: now.format_iso8601(), label, auto,
        keys: captureKeys(settings), glassFiles: captureGlassFiles(),
    };
    const path = GLib.build_filenamev([pointsDir(), `${id}.json`]);
    writeChecked(path, JSON.stringify(point, null, 1));
    if (auto)
        prune();
    return {...point, path};
}

/** A point made by Fusion Desk itself; never throws (a failure is logged). */
export function autoPoint(settings, label) {
    try {
        return createPoint(settings, label, true);
    } catch (e) {
        console.warn(`${LOG} automatic point "${label}" failed: ${e.message}`);
        return null;
    }
}

/** One automatic point a day (called when the extension starts). */
export function dailyPoint(settings) {
    const last = listPoints().find(p => p.auto && p.label === 'Daily');
    const lastAt = last ? GLib.DateTime.new_from_iso8601(last.created, null) : null;
    const now = GLib.DateTime.new_now_local();
    if (!lastAt || now.difference(lastAt) >= DAY_US)
        autoPoint(settings, 'Daily');
}

/**
 * Bring a point back, after making a "Before restore" point so the restore
 * can be undone. Returns {failed, undo}: failed = settings or files that
 * could not be put back (0 = all good), undo = the point made just before.
 */
export function restorePoint(settings, point) {
    const undo = autoPoint(settings, 'Before restore');
    const failed = applyKeys(settings, point.keys) + applyGlassFiles(point.glassFiles ?? {});
    if (failed)
        console.warn(`${LOG} "${point.label}" restored with ${failed} problem(s), see the lines above`);
    return {failed, undo};
}

/**
 * Save a point as a file anywhere (e.g. a USB stick) to take it to another
 * PC. The file is the same JSON as in the points folder.
 */
export function exportPoint(point, path) {
    const {path: _own, ...data} = point;
    writeChecked(path, JSON.stringify(data, null, 1));
}

/**
 * Add a point from an exported file to this PC's points; it can then be
 * restored like any other. Throws with a readable message for a file that is
 * not a Fusion Desk restore point.
 */
export function importPoint(path) {
    const text = readText(path);
    if (text === null)
        throw new Error('the file could not be read');
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('the file is not a Fusion Desk restore point');
    }
    if (data?.format !== FORMAT || typeof data.keys !== 'object' || !data.created)
        throw new Error('the file is not a Fusion Desk restore point');
    const id = pointId(GLib.DateTime.new_now_local());
    const point = {...data, auto: false, label: `${data.label ?? 'Restore point'} (imported)`};
    const dest = GLib.build_filenamev([pointsDir(), `${id}.json`]);
    writeChecked(dest, JSON.stringify(point, null, 1));
    return {...point, path: dest};
}

export function removePoint(point) {
    return GLib.unlink(point.path) === 0;
}

/** "28 Nov 2026, 10:12" for a point. */
export function pointTime(point) {
    const when = GLib.DateTime.new_from_iso8601(point.created, null)?.to_local();
    return when ? when.format('%-d %b %Y, %H:%M') : '';
}
