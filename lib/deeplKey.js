// DeepL API key for live captions, kept in the login keyring (libsecret):
// stored encrypted and unlocked with the login password, never in a file or
// in the settings. Shared by the shell (lib/captions.js, which hands it to
// the helper on stdin) and the settings (lib/prefsScreenText.js).
let Secret = null;
try {
    Secret = (await import('gi://Secret?version=1')).default;
} catch {
    // libsecret's introspection data (gir1.2-secret-1) is not installed.
}

const SCHEMA = Secret
    ? new Secret.Schema('io.github.hafij_deu.FusionDesk.DeepL', Secret.SchemaFlags.NONE,
        {service: Secret.SchemaAttributeType.STRING})
    : null;
const ATTRS = {service: 'deepl'};

export const keyringAvailable = () => SCHEMA !== null;

/** callback(key): the saved key, or '' when there is none (or no keyring). */
export function lookupKey(callback) {
    if (!SCHEMA) {
        callback('');
        return;
    }
    Secret.password_lookup(SCHEMA, ATTRS, null, (_s, res) => {
        let key = '';
        try {
            key = Secret.password_lookup_finish(res) ?? '';
        } catch {
            // locked keyring the user did not unlock, or no keyring daemon
        }
        callback(key);
    });
}

/** Save `key` in the keyring, or forget it when empty; callback(error message or null). */
export function saveKey(key, callback) {
    if (!SCHEMA) {
        callback('the keyring is not available (needs gir1.2-secret-1)');
        return;
    }
    const done = finish => (_s, res) => {
        try {
            finish(res);
            callback(null);
        } catch (e) {
            callback(e.message);
        }
    };
    if (key) {
        Secret.password_store(SCHEMA, ATTRS, Secret.COLLECTION_DEFAULT, 'Fusion Desk: DeepL API key for live captions',
            key, null, done(r => Secret.password_store_finish(r)));
    } else {
        Secret.password_clear(SCHEMA, ATTRS, null, done(r => Secret.password_clear_finish(r)));
    }
}
