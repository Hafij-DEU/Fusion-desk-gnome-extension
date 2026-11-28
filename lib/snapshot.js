// "My setup": save every Fusion Desk setting to a file and bring it all back
// with one click. The file lives outside the settings database
// (~/.config/fusion-desk/my-setup.json), so it survives a settings reset or a
// reinstall. Shared by the shell and prefs: no gnome-shell imports here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Internal state, not choices: never saved or restored.
const STATE_KEYS = new Set([
    'caffeine-active', 'charge-helper-ready', 'laptop-unsupported', 'notes',
    'menu-recent-apps', 'menu-app-hours', 'menu-known-apps', 'menu-new-apps',
]);

function snapshotPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'fusion-desk', 'my-setup.json']);
}

function keysOf(settings) {
    return settings.settings_schema.list_keys().filter(k => !STATE_KEYS.has(k)).sort();
}

/** Every saved key as printed GVariant text (shared with lib/restorePoints.js). */
export function captureKeys(settings) {
    const keys = {};
    for (const key of keysOf(settings))
        keys[key] = settings.get_value(key).print(true);
    return keys;
}

/** Write the current settings to the snapshot file. Returns the save time. */
export function saveSnapshot(settings) {
    const saved = GLib.DateTime.new_now_local().format_iso8601();
    const path = snapshotPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify({format: 1, saved, keys: captureKeys(settings)}, null, 1));
    return saved;
}

/** {saved, keys} from the snapshot file, or null when there is none. */
export function readSnapshot() {
    try {
        const [, bytes] = GLib.file_get_contents(snapshotPath());
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return data?.keys ? data : null;
    } catch {
        return null;
    }
}

/**
 * Put every setting back from captured key texts, in one batch. Keys added
 * after the capture go back to their defaults; keys that no longer exist are
 * skipped. Returns the number of keys that could not be restored (each one is
 * logged), so a caller can tell the user instead of failing quietly.
 */
export function applyKeys(shared, keys) {
    // Batch on a private twin: GSettings has no way out of delay mode, so
    // delaying the caller's shared object would keep every later write local
    // (lost at the next lock or logout). The twin's apply() reaches the shared
    // object through the backend like any other change.
    const settings = new Gio.Settings({
        settings_schema: shared.settings_schema,
        path: shared.path,
    });
    let failed = 0;
    settings.delay();
    try {
        for (const key of keysOf(settings)) {
            const text = keys[key];
            if (text === undefined) {
                settings.reset(key);
                continue;
            }
            try {
                const schemaKey = settings.settings_schema.get_key(key);
                const value = GLib.Variant.parse(schemaKey.get_value_type(), text, null, null);
                if (schemaKey.range_check(value)) {
                    settings.set_value(key, value);
                } else {
                    failed++;
                    console.warn(`Fusion Desk: ${key}: saved value ${text} is out of range, kept current`);
                }
            } catch (e) {
                failed++;
                console.warn(`Fusion Desk: could not restore ${key}: ${e.message}`);
            }
        }
    } finally {
        settings.apply();
    }
    return failed;
}

/**
 * Put every setting back as saved in My setup. Returns false when there is
 * no snapshot.
 */
export function restoreSnapshot(shared) {
    const data = readSnapshot();
    if (!data)
        return false;
    applyKeys(shared, data.keys);
    return true;
}

/** "23 Oct 2026, 10:12" for the snapshot's save time, or ''. */
export function savedLabel(data = readSnapshot()) {
    const when = data?.saved ? GLib.DateTime.new_from_iso8601(data.saved, null)?.to_local() : null;
    return when ? when.format('%-d %b %Y, %H:%M') : '';
}

