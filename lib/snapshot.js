// "My setup": save every Fusion Desk setting to a file and bring it all back
// with one click. The file lives outside the settings database
// (~/.config/fusion-desk/my-setup.json), so it survives a settings reset or a
// reinstall. Shared by the shell and prefs: no gnome-shell imports here.
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

/** Write the current settings to the snapshot file. Returns the save time. */
export function saveSnapshot(settings) {
    const keys = {};
    for (const key of keysOf(settings))
        keys[key] = settings.get_value(key).print(true);
    const saved = GLib.DateTime.new_now_local().format_iso8601();
    const path = snapshotPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify({format: 1, saved, keys}, null, 1));
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
 * Put every setting back as saved, in one batch. Keys added after the save go
 * back to their defaults; keys that no longer exist are skipped.
 * Returns false when there is no snapshot.
 */
export function restoreSnapshot(settings) {
    const data = readSnapshot();
    if (!data)
        return false;
    settings.delay();
    try {
        for (const key of keysOf(settings)) {
            const text = data.keys[key];
            if (text === undefined) {
                settings.reset(key);
                continue;
            }
            try {
                const schemaKey = settings.settings_schema.get_key(key);
                const value = GLib.Variant.parse(schemaKey.get_value_type(), text, null, null);
                if (schemaKey.range_check(value))
                    settings.set_value(key, value);
            } catch (e) {
                console.warn(`Fusion Desk: could not restore ${key}: ${e.message}`);
            }
        }
    } finally {
        settings.apply();
    }
    return true;
}

/** "23 Oct 2026, 10:12" for the snapshot's save time, or ''. */
export function savedLabel(data = readSnapshot()) {
    const when = data?.saved ? GLib.DateTime.new_from_iso8601(data.saved, null)?.to_local() : null;
    return when ? when.format('%-d %b %Y, %H:%M') : '';
}

