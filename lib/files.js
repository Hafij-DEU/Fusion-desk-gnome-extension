// Asynchronous file reads for shell code (no blocking IO on the main loop).
import Gio from 'gi://Gio';

const decoder = new TextDecoder();

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

/** Text of `path`, or null when it cannot be read. */
export async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

/**
 * FileInfos (with `attrs`) of a directory's children. Throws when it cannot be
 * listed, or when `cancellable` is cancelled.
 */
export async function listInfos(path, attrs, cancellable = null) {
    const en = await Gio.File.new_for_path(path).enumerate_children_async(attrs,
        Gio.FileQueryInfoFlags.NONE, 0, cancellable);
    const all = [];
    for (;;) {
        const infos = await en.next_files_async(200, 0, cancellable);
        if (!infos.length)
            break;
        all.push(...infos);
    }
    en.close(null);
    return all;
}

/** Child names of a directory, or [] when it cannot be listed. */
export async function listDir(path) {
    try {
        return (await listInfos(path, 'standard::name')).map(i => i.get_name());
    } catch {
        return [];
    }
}
