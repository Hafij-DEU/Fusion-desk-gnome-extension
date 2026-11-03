// Preferences: text from a screen area (lib/ocr.js) and live captions
// (lib/captions.js), System page. Packages install through pkexec like the
// region PiP ones; speech models download into MODEL_DIR and the translator
// into TRANSLATOR_DIR on a click. The DeepL key goes into the login keyring.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {comboRow, entryRow, group, spinRow, switchRow, watch} from './prefsRows.js';
import {accelKeys, withShortcut} from './prefsShortcuts.js';
import {aptInstallRow, commandRow} from './prefsRegionPip.js';
import {LANGUAGES, MODELS, MODEL_DIR, TRANSLATOR_DIR, TRANSLATOR_SIZE, modelPath, modelUrl,
    translatorReady} from './captionModels.js';
import {keyringAvailable, lookupKey, saveKey} from './deeplKey.js';

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
        switchRow(s, 'ocr-choose-text', 'Choose the words to copy',
            'Drag over the words you want, then Copy text (Ctrl+C); off copies all the text at once'),
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

/** Row for the translator on this computer: Download (or Cancel) while missing, Remove once there. */
function translatorRow(window, extPath) {
    const row = new Adw.ActionRow({title: `Translator on this computer · ${TRANSLATOR_SIZE}`, use_markup: false});
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    const note = 'NLLB-200, 200 languages; used offline and when online translating fails. Free for non-commercial use (CC-BY-NC)';
    const part = GLib.build_filenamev([TRANSLATOR_DIR, 'nllb', 'model.bin.part']);
    let proc = null, timer = 0;
    const sync = () => {
        const ready = translatorReady();
        row.subtitle = proc ? `${note}. Installing…` : `${note}. ${ready ? 'Installed' : 'Not installed'}`;
        button.label = proc ? 'Cancel' : ready ? 'Remove' : 'Download';
        button.css_classes = proc || ready ? [] : ['suggested-action'];
    };
    const stopTimer = () => {
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
    };
    const run = (argv, done) => {
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            window.add_toast(new Adw.Toast({title: e.message, timeout: 4}));
            return;
        }
        sync();
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
            done(ok, err ?? '');
            sync();
        });
    };
    button.connect('clicked', () => {
        if (proc) {
            proc.send_signal(15);
            return;
        }
        if (translatorReady()) {
            run(['rm', '-rf', TRANSLATOR_DIR], ok => window.add_toast(new Adw.Toast({
                title: ok ? 'Translator removed' : 'The translator could not be removed', timeout: 3})));
            return;
        }
        run(['sh', GLib.build_filenamev([extPath, 'lib', 'captions', 'install-translator']), TRANSLATOR_DIR],
            (ok, err) => window.add_toast(new Adw.Toast({timeout: 4,
                title: ok ? 'Translator installed' : err.trim().split('\n').pop() || 'Download cancelled'})));
        if (!proc)
            return;
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (GLib.file_test(part, GLib.FileTest.EXISTS)) {
                const info = Gio.File.new_for_path(part).query_info('standard::size', 0, null);
                row.subtitle = `${note}. Downloading… ${Math.round(info.get_size() / 1e6)} of ${TRANSLATOR_SIZE}`;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
    row.connect('destroy', stopTimer);
    sync();
    return row;
}

/** DeepL API key: typed here, kept encrypted in the login keyring, never in the settings. */
function deeplRow(window, s) {
    const row = new Adw.PasswordEntryRow({title: 'DeepL API key', show_apply_button: true});
    const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Remove the saved key',
        valign: Gtk.Align.CENTER, css_classes: ['flat']});
    row.add_suffix(remove);
    const sync = () => {
        const saved = s.get_boolean('captions-deepl');
        row.title = saved ? 'DeepL API key · saved in the login keyring' : 'DeepL API key (optional, best translations)';
        remove.visible = saved;
    };
    const store = key => saveKey(key, err => {
        if (err) {
            window.add_toast(new Adw.Toast({title: `Key not saved: ${err}`, timeout: 4}));
            return;
        }
        row.text = '';
        s.set_boolean('captions-deepl', key !== '');
        window.add_toast(new Adw.Toast({title: key ? 'Key saved in the keyring' : 'Key removed', timeout: 3}));
    });
    row.connect('apply', () => {
        const key = row.text.trim();
        if (key)
            store(key);
    });
    remove.connect('clicked', () => store(''));
    watch(s, 'changed::captions-deepl', row, sync);
    // The setting follows the keyring, in case the key was removed there.
    lookupKey(key => {
        if (s.get_boolean('captions-deepl') !== (key !== ''))
            s.set_boolean('captions-deepl', key !== '');
    });
    row.sensitive = keyringAvailable();
    sync();
    return row;
}

/** System page: "Live captions". */
export function captionsGroup(window, s, extPath) {
    const g = group('Live captions', [
        withShortcut(entryRow(s, 'captions-hotkey', 'Shortcut (empty = off)'), s,
            () => accelKeys(s.get_string('captions-hotkey')), ['captions-hotkey']),
        comboRow(s, 'captions-source', 'Listen to', ['system', 'mic'], ['Sound the computer plays', 'Microphone']),
        comboRow(s, 'captions-language', 'Spoken language', LANGUAGES.map(l => l[0]), LANGUAGES.map(l => l[1]),
            'Choosing it gives better captions than detecting it'),
        switchRow(s, 'captions-translate', 'Translate into English',
            'Captions in English whatever language is spoken; off shows the words as spoken'),
        switchRow(s, 'captions-online', 'Translate online',
            'The caption text (never the sound) goes to DeepL with a saved key, else to Google\'s free translator. The translator on this computer takes over when they fail or you are offline'),
        deeplRow(window, s),
    ], 'Captions of what is said in videos, calls or the microphone, in a bar on top of every window. Also in the panel\'s right-click menu. The sound is turned into words on this computer and is never sent anywhere.');

    // Model choice: the labels say which ones are downloaded.
    const ids = ['auto', ...MODELS.map(m => m[0])];
    const labels = () => ['Best downloaded', ...MODELS.map(([, file, size, label]) =>
        `${label} · ${size}${modelPath(file) ? '' : ' (not downloaded)'}`)];
    const model = new Adw.ComboRow({title: 'Speech model', model: Gtk.StringList.new(labels()),
        subtitle: 'Bigger models are more accurate but slower; captions lag when the model cannot keep up'});
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
    const position = comboRow(s, 'captions-position', 'Position', ['bottom', 'top'],
        ['Bottom of the screen', 'Top of the screen'], 'Or drag the bar by its title');
    const back = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Put the bar back in this position',
        valign: Gtk.Align.CENTER, css_classes: ['flat']});
    back.connect('clicked', () => s.reset('captions-place'));
    position.add_suffix(back);
    const syncPlace = () => {
        back.visible = s.get_value('captions-place').deepUnpack()[0] >= 0;
    };
    // Picking a position forgets where the bar was dragged to.
    watch(s, 'changed::captions-position', position, () => s.reset('captions-place'));
    watch(s, 'changed::captions-place', position, syncPlace);
    syncPlace();
    g.add(position);
    g.add(spinRow(s, 'captions-size', 'Text size', 14, 48, 2, 'Pixels'));
    g.add(spinRow(s, 'captions-opacity', 'Background', 20, 100, 5, 'Percent solid; lower lets more of the window show through'));

    const models = new Adw.ExpanderRow({title: 'Speech models',
        subtitle: `Downloaded into ${MODEL_DIR.replace(GLib.get_home_dir(), '~')}`});
    for (const m of MODELS)
        models.add_row(modelRow(window, m, syncModel));
    models.add_row(translatorRow(window, extPath));
    g.add(models);

    const install = aptInstallRow(window, ['whisper.cpp', 'pipewire-bin', 'python3'], ['whisper.cpp'],
        'Remove (pipewire-bin and python3 are shared parts of the desktop, so they stay)');
    const [, file] = MODELS.find(m => m[0] === 'medium');
    install.add_row(commandRow('Download a speech model in a terminal',
        `mkdir -p ${MODEL_DIR} && curl -fL -o ${MODEL_DIR}/${file} ${modelUrl(file)}`, window));
    install.add_row(commandRow('Install the translator in a terminal',
        `sh ${extPath}/lib/captions/install-translator ${TRANSLATOR_DIR}`, window));
    install.add_row(commandRow('Remove the downloaded models', `rm -r ${MODEL_DIR} ${TRANSLATOR_DIR}`, window));
    g.add(install);
    return g;
}
