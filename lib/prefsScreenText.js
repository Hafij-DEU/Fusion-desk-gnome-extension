// Preferences: text from a screen area (lib/ocr.js) and live captions
// (lib/captions.js), System page. Packages install through pkexec like the
// region PiP ones; speech models download into MODEL_DIR on a click.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {comboRow, entryRow, group, spinRow, switchRow, watch} from './prefsRows.js';
import {accelKeys, withShortcut} from './prefsShortcuts.js';
import {aptInstallRow, commandRow} from './prefsRegionPip.js';
import {LANGUAGES, MODELS, MODEL_DIR, modelPath, modelUrl} from './captionModels.js';

// Reading languages offered (tesseract codes; package tesseract-ocr-<code>).
const OCR_LANGUAGES = [
    ['eng', 'English'], ['tur', 'Turkish'], ['ben', 'Bengali'], ['hin', 'Hindi'], ['urd', 'Urdu'],
    ['ara', 'Arabic'], ['deu', 'German'], ['fra', 'French'], ['spa', 'Spanish'], ['ita', 'Italian'],
    ['por', 'Portuguese'], ['rus', 'Russian'], ['fas', 'Persian'], ['chi_sim', 'Chinese (simplified)'],
    ['jpn', 'Japanese'], ['kor', 'Korean'],
];
const ocrPackage = code => `tesseract-ocr-${code.replace(/_/g, '-')}`;

/** Languages tesseract can read now. */
function installedOcrLanguages() {
    try {
        const [, out] = GLib.spawn_sync(null, ['tesseract', '--list-langs'], null, GLib.SpawnFlags.SEARCH_PATH, null);
        return new Set(new TextDecoder().decode(out).split('\n').slice(1).map(l => l.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/** System page: "Text from a screen area". */
export function screenTextGroup(window, s) {
    const g = group('Text from a screen area', [
        withShortcut(entryRow(s, 'ocr-hotkey', 'Shortcut (empty = off)'), s,
            () => accelKeys(s.get_string('ocr-hotkey')), ['ocr-hotkey']),
    ], 'Drag a rectangle over any part of the screen, even a picture or a video, and its text is copied to the clipboard. Also in the panel\'s right-click menu. Read on this computer by tesseract.');

    const have = installedOcrLanguages();
    const langs = new Adw.ExpanderRow({title: 'Languages to read'});
    const wanted = () => s.get_string('ocr-languages').split('+').filter(Boolean);
    const syncTitle = () => {
        langs.subtitle = wanted().map(c => OCR_LANGUAGES.find(l => l[0] === c)?.[1] ?? c).join(', ') || 'None';
    };
    for (const [code, name] of OCR_LANGUAGES) {
        const row = new Adw.SwitchRow({title: name, subtitle: have.has(code) ? '' : `Needs ${ocrPackage(code)}`});
        row.active = wanted().includes(code);
        row.connect('notify::active', () => {
            const list = wanted().filter(c => c !== code);
            if (row.active)
                list.push(code);
            if (list.join('+') !== s.get_string('ocr-languages'))
                s.set_string('ocr-languages', list.join('+'));
        });
        langs.add_row(row);
    }
    syncTitle();
    g.add(langs);

    // The packages follow the chosen languages.
    let install = null;
    const syncInstall = () => {
        if (install)
            g.remove(install);
        const pkgs = ['tesseract-ocr', ...wanted().map(ocrPackage)];
        install = aptInstallRow(window, pkgs, pkgs, 'Remove');
        g.add(install);
    };
    syncInstall();
    watch(s, 'changed::ocr-languages', g, () => {
        syncTitle();
        syncInstall();
    });
    return g;
}

/** Row for one speech model: Download (or Cancel) while missing, Remove once downloaded here. */
function modelRow(window, [, file, size, label, note], onChange) {
    const row = new Adw.ActionRow({title: `${label} · ${size}`, use_markup: false});
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    const own = GLib.build_filenamev([MODEL_DIR, file]);
    const part = `${own}.part`;
    let proc = null, timer = 0;
    const sync = () => {
        const path = modelPath(file);
        row.subtitle = proc ? `${note}. Downloading…` : `${note}. ${path ? 'Downloaded' : 'Not downloaded'}`;
        button.label = proc ? 'Cancel' : path ? 'Remove' : 'Download';
        button.css_classes = proc || path ? [] : ['suggested-action'];
        // Models of other apps (e.g. Astra Player) are not removed from here.
        button.visible = proc !== null || !path || path === own;
    };
    const stopTimer = () => {
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
    };
    button.connect('clicked', () => {
        if (proc) {
            proc.force_exit();
            return;
        }
        if (modelPath(file) === own) {
            GLib.unlink(own);
            sync();
            onChange();
            return;
        }
        GLib.mkdir_with_parents(MODEL_DIR, 0o755);
        try {
            proc = Gio.Subprocess.new(['curl', '-fL', '--silent', '--show-error', '-o', part, modelUrl(file)],
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            window.add_toast(new Adw.Toast({title: e.message, timeout: 4}));
            return;
        }
        sync();
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            const info = Gio.File.new_for_path(part).query_info('standard::size', 0, null);
            row.subtitle = `${note}. Downloading… ${Math.round(info.get_size() / 1e6)} of ${size}`;
            return GLib.SOURCE_CONTINUE;
        });
        proc.communicate_utf8_async(null, null, (_p, res) => {
            let err = '';
            try {
                [, , err] = proc.communicate_utf8_finish(res);
            } catch (e) {
                err = e.message;
            }
            stopTimer();
            const ok = proc.get_successful();
            proc = null;
            if (ok) {
                GLib.rename(part, own);
                window.add_toast(new Adw.Toast({title: `${label} model downloaded`, timeout: 3}));
            } else {
                GLib.unlink(part);
                window.add_toast(new Adw.Toast({title: err.trim().split('\n').pop() || 'Download cancelled', timeout: 4}));
            }
            sync();
            onChange();
        });
    });
    row.connect('destroy', stopTimer);
    sync();
    return row;
}

/** System page: "Live captions". */
export function captionsGroup(window, s) {
    const g = group('Live captions', [
        withShortcut(entryRow(s, 'captions-hotkey', 'Shortcut (empty = off)'), s,
            () => accelKeys(s.get_string('captions-hotkey')), ['captions-hotkey']),
        comboRow(s, 'captions-source', 'Listen to', ['system', 'mic'], ['Sound the computer plays', 'Microphone']),
        comboRow(s, 'captions-language', 'Spoken language', LANGUAGES.map(l => l[0]), LANGUAGES.map(l => l[1]),
            'Choosing it gives better captions than detecting it'),
        switchRow(s, 'captions-translate', 'Translate into English',
            'Captions in English whatever language is spoken; off shows the words as spoken'),
    ], 'Captions of what is said in videos, calls or the microphone, in a bar on top of every window. Also in the panel\'s right-click menu. Everything runs on this computer: no sound is sent anywhere.');

    // Model choice: the labels say which ones are downloaded.
    const ids = ['auto', ...MODELS.map(m => m[0])];
    const labels = () => ['Best downloaded', ...MODELS.map(([, file, size, label]) =>
        `${label} · ${size}${modelPath(file) ? '' : ' (not downloaded)'}`)];
    const model = new Adw.ComboRow({title: 'Speech model', model: Gtk.StringList.new(labels()),
        subtitle: 'Bigger models are more accurate and use more memory'});
    const syncModel = () => {
        model.model = Gtk.StringList.new(labels());
        model.selected = Math.max(0, ids.indexOf(s.get_string('captions-model')));
    };
    syncModel();
    model.connect('notify::selected', () => {
        if (s.get_string('captions-model') !== ids[model.selected])
            s.set_string('captions-model', ids[model.selected]);
    });
    watch(s, 'changed::captions-model', model, syncModel);
    g.add(model);
    g.add(comboRow(s, 'captions-position', 'Position', ['bottom', 'top'], ['Bottom of the screen', 'Top of the screen']));
    g.add(spinRow(s, 'captions-size', 'Text size', 14, 48, 2, 'Pixels'));

    const models = new Adw.ExpanderRow({title: 'Speech models',
        subtitle: `Downloaded into ${MODEL_DIR.replace(GLib.get_home_dir(), '~')}`});
    for (const m of MODELS)
        models.add_row(modelRow(window, m, syncModel));
    g.add(models);

    const install = aptInstallRow(window, ['whisper.cpp', 'pipewire-bin', 'python3'], ['whisper.cpp'],
        'Remove (pipewire-bin and python3 are shared parts of the desktop, so they stay)');
    const [, file] = MODELS.find(m => m[0] === 'medium');
    install.add_row(commandRow('Download a speech model in a terminal',
        `mkdir -p ${MODEL_DIR} && curl -fL -o ${MODEL_DIR}/${file} ${modelUrl(file)}`, window));
    install.add_row(commandRow('Remove the downloaded models', `rm -r ${MODEL_DIR}`, window));
    g.add(install);
    return g;
}
