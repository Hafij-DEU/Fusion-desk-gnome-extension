// Icon helpers shared by the shell and prefs (no gnome-shell imports).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Icon from a theme icon name, an absolute/~ path or a file:// URI. */
export function giconFor(value, fallback) {
    if (value && /^(\/|~|file:\/\/)/.test(value)) {
        const file = value.startsWith('file://')
            ? Gio.File.new_for_uri(value)
            : Gio.File.new_for_path(value.replace(/^~/, GLib.get_home_dir()));
        if (file.query_exists(null))
            return new Gio.FileIcon({file});
        value = '';
    }
    return Gio.ThemedIcon.new_with_default_fallbacks(value || fallback);
}
