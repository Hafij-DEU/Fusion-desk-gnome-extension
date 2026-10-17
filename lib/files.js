// Asynchronous file reads for shell code (no blocking IO on the main loop).
import Gio from 'gi://Gio';

const decoder = new TextDecoder();

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

/** Text of `path`, or null when it cannot be read. */
export async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

/** Child names of a directory, or [] when it cannot be listed. */
export async function listDir(path) {
    const names = [];
    try {
        const en = await Gio.File.new_for_path(path).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, 0, null);
        for (;;) {
            const infos = await en.next_files_async(200, 0, null);
            if (!infos.length)
                break;
            infos.forEach(i => names.push(i.get_name()));
        }
        en.close(null);
    } catch {
        // Missing or unreadable directory.
    }
    return names;
}
