// Preferences: text from a screen area (lib/ocr.js), System page. The
// reading packages install through pkexec like the region PiP ones.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import {entryRow, group, switchRow, watch} from './prefsRows.js';
import {accelKeys, withShortcut} from './prefsShortcuts.js';
import {aptInstallRow} from './prefsRegionPip.js';

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
