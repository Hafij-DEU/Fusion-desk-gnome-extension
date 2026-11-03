// Speech models for live captions (whisper.cpp ggml files) and the text
// translator on this computer, shared by the shell side (lib/captions.js)
// and the settings (lib/prefsScreenText.js). Settings download the models
// into MODEL_DIR (models Astra Player already has are used too) and the
// translator into TRANSLATOR_DIR (lib/captions/install-translator).
import GLib from 'gi://GLib';

export const MODEL_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'fusion-desk', 'models']);
const OTHER_DIRS = [
    GLib.build_filenamev([GLib.get_user_data_dir(), 'astra-player', 'models']),
    '/usr/share/whisper.cpp/models',
];
const URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// id, file, size, label, note. Best first: the turbo model is the most
// accurate for captions, but it was not trained to translate, so the
// medium model comes first when whisper itself translates (no text
// translator, see findModel).
export const MODELS = [
    ['turbo', 'ggml-large-v3-turbo-q5_0.bin', '574 MB', 'Best', 'Most accurate captions; weak at translating by itself'],
    ['medium', 'ggml-medium-q5_0.bin', '539 MB', 'Best without a translator', 'Very good captions and its own English translation, slower'],
    ['small', 'ggml-small.bin', '466 MB', 'Good', 'Good captions and translation'],
    ['base', 'ggml-base.bin', '142 MB', 'Fast', 'Quick, but often wrong outside English'],
    ['tiny', 'ggml-tiny.bin', '75 MB', 'Fastest', 'Rough; for slow computers'],
];

export const modelUrl = file => `${URL}${file}`;

/** Path of `file` in one of the model folders, or null. */
export function modelPath(file) {
    for (const dir of [MODEL_DIR, ...OTHER_DIRS]) {
        const path = GLib.build_filenamev([dir, file]);
        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return path;
    }
    return null;
}

/** The model to use for setting `id` ('auto' = best installed), or null when none is there. `translate`: whisper itself translates. */
export function findModel(id, translate) {
    if (id !== 'auto') {
        const m = MODELS.find(x => x[0] === id);
        if (m && modelPath(m[1]))
            return modelPath(m[1]);
    }
    const order = translate
        ? ['medium', 'small', 'turbo', 'base', 'tiny']
        : ['turbo', 'medium', 'small', 'base', 'tiny'];
    for (const want of order) {
        const path = modelPath(MODELS.find(x => x[0] === want)[1]);
        if (path)
            return path;
    }
    return null;
}

export const TRANSLATOR_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'fusion-desk', 'translator']);
export const TRANSLATOR_SIZE = '640 MB';

/** True when the translator on this computer (a venv and the NLLB-200 model) is installed. */
export function translatorReady() {
    return GLib.file_test(GLib.build_filenamev([TRANSLATOR_DIR, 'venv', 'bin', 'python3']), GLib.FileTest.IS_EXECUTABLE) &&
        GLib.file_test(GLib.build_filenamev([TRANSLATOR_DIR, 'nllb', 'model.bin']), GLib.FileTest.IS_REGULAR);
}

// Spoken languages offered in the settings (whisper codes).
export const LANGUAGES = [
    ['auto', 'Detect automatically'], ['en', 'English'], ['tr', 'Turkish'], ['bn', 'Bengali'],
    ['hi', 'Hindi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['de', 'German'], ['fr', 'French'],
    ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['fa', 'Persian'],
    ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
];
