// Shared helpers for Deepin mode: colours, blur, app categories, launching.
// Clean-room: behaviour modelled on the Deepin desktop, no DDE code or assets.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {accentFill, glassEdge, glassLevel, glassStyle, keepBlurClean} from '../style.js';

/** True when Deepin-mode surfaces should use the dark palette. */
export function isDark(settings) {
    const theme = settings.get_string('deepin-theme');
    if (theme !== 'AUTO')
        return theme === 'DARK';
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return iface.get_string('color-scheme') === 'prefer-dark';
}

/** Style class that selects the light or dark palette in stylesheet.css. */
export function themeClass(settings) {
    return isDark(settings) ? 'fusion-deepin-dark' : 'fusion-deepin-light';
}

/** Inline background for a translucent surface (opacity comes from settings). */
export function surfaceStyle(settings, extra = '') {
    const a = (settings.get_int('deepin-opacity') / 100).toFixed(2);
    const dark = isDark(settings);
    const rgb = dark ? '32, 32, 36' : '246, 246, 250';
    // Glass effect (or Deepin's glossy switch) and accent gradient share one fill.
    const level = Math.max(glassLevel(settings), settings.get_boolean('deepin-gloss') ? 1 : 0);
    if (level || settings.get_boolean('accent-gradient'))
        return `${accentFill(settings, `rgba(${rgb}, ${a})`, 18, level)} ${glassEdge(level, !dark, settings)} ${extra}`;
    if (!settings.get_boolean('deepin-gloss'))
        return `background-color: rgba(${rgb}, ${a}); ${extra}`;
    // Glossy glass: lighter at the top, a bright inner top edge, soft glow.
    const top = dark ? '76, 76, 86' : '255, 255, 255';
    const end = dark ? '24, 24, 28' : '214, 216, 228';
    const edge = dark ? '0.18' : '0.85';
    return `background-color: rgba(${rgb}, ${a}); background-gradient-direction: vertical; ` +
        `background-gradient-start: rgba(${top}, ${a}); background-gradient-end: rgba(${end}, ${a}); ` +
        `box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, ${edge}); ${extra}`;
}

/** Blur what is behind `actor` (no-op when the setting is off). */
export function addBlur(actor, settings, radius = 40, brightness = 1.0) {
    if (!settings.get_boolean('deepin-blur'))
        return;
    // The frosted glass variant blurs more.
    if (glassLevel(settings) && glassStyle(settings) === 'FROSTED')
        radius = Math.max(radius, 60);
    actor.add_effect_with_name('fusion-deepin-blur', new Shell.BlurEffect({
        mode: Shell.BlurMode.BACKGROUND,
        radius,
        brightness,
    }));
    keepBlurClean(actor);
}

// Marks strings for translation; they are translated when shown (module
// top level runs before the extension object exists, so _() cannot run here).
const N_ = s => s;

// Deepin's launcher category order. Each entry maps XDG main/additional
// categories (freedesktop.org menu spec) to one bucket; first match wins.
export const CATEGORIES = [
    {id: 'internet', label: N_('Internet'), icon: 'web-browser-symbolic',
        match: ['WebBrowser', 'Email', 'FileTransfer', 'P2P', 'News', 'RemoteAccess', 'Network']},
    {id: 'chat', label: N_('Chat'), icon: 'chat-symbolic',
        match: ['InstantMessaging', 'Chat', 'IRCClient', 'Telephony', 'VideoConference']},
    {id: 'music', label: N_('Music'), icon: 'audio-x-generic-symbolic',
        match: ['Music', 'Audio', 'Midi', 'Mixer', 'Sequencer', 'Tuner']},
    {id: 'video', label: N_('Video'), icon: 'video-x-generic-symbolic',
        match: ['Video', 'TV', 'Player', 'AudioVideo', 'AudioVideoEditing']},
    {id: 'graphics', label: N_('Graphics'), icon: 'image-x-generic-symbolic',
        match: ['Graphics', 'Photography', '2DGraphics', '3DGraphics', 'RasterGraphics', 'VectorGraphics', 'Scanning']},
    {id: 'games', label: N_('Games'), icon: 'input-gaming-symbolic',
        match: ['Game']},
    {id: 'office', label: N_('Office'), icon: 'x-office-document-symbolic',
        match: ['Office', 'WordProcessor', 'Spreadsheet', 'Presentation', 'Calendar', 'ContactManagement', 'Finance', 'ProjectManagement']},
    {id: 'reading', label: N_('Reading'), icon: 'accessories-dictionary-symbolic',
        match: ['Viewer', 'Dictionary', 'Literature', 'Education', 'Science', 'Documentation']},
    {id: 'development', label: N_('Development'), icon: 'applications-engineering-symbolic',
        match: ['Development', 'IDE', 'Debugger', 'RevisionControl', 'GUIDesigner', 'Building', 'Translation']},
    {id: 'system', label: N_('System'), icon: 'emblem-system-symbolic',
        match: ['Settings', 'System', 'Monitor', 'PackageManager', 'HardwareSettings', 'Security', 'TerminalEmulator', 'FileManager', 'Filesystem']},
    {id: 'others', label: N_('Others'), icon: 'view-more-symbolic', match: []},
];

/** Translated category name. */
export function categoryName(c) {
    return _(c.label);
}

/** Category id for a Shell.App. */
export function categoryOf(app) {
    const raw = app.get_app_info()?.get_categories() ?? '';
    const cats = raw.split(';').filter(Boolean);
    for (const c of CATEGORIES) {
        if (c.match.some(m => cats.includes(m)))
            return c.id;
    }
    return 'others';
}

/** Visible, launchable apps sorted by name. */
export function allApps() {
    return Shell.AppSystem.get_default().get_installed()
        .filter(info => info.should_show())
        .map(info => Shell.AppSystem.get_default().lookup_app(info.get_id()))
        .filter(Boolean)
        .sort((a, b) => a.get_name().localeCompare(b.get_name()));
}

/** Case-insensitive substring match on name, id, keywords and word initials. */
export function matchesSearch(app, query) {
    const q = query.toLowerCase();
    const name = app.get_name().toLowerCase();
    if (name.includes(q) || app.get_id().toLowerCase().includes(q))
        return true;
    const initials = name.split(/[\s\-_.]+/).map(w => w[0] ?? '').join('');
    if (initials.startsWith(q))
        return true;
    const info = app.get_app_info();
    const extra = [
        info?.get_generic_name?.() ?? '',
        ...(info?.get_keywords?.() ?? []),
    ].join(' ').toLowerCase();
    return extra.includes(q);
}

/** Open a GNOME Settings panel (e.g. 'wifi', 'sound'). */
export function openSettingsPanel(panel = '') {
    try {
        const argv = ['gnome-control-center'];
        if (panel)
            argv.push(panel);
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.warn(`Fusion Desk: cannot open Settings ${panel}: ${e.message}`);
    }
}

const autostartDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'autostart']);

/** True when the app has a user autostart entry. */
export function isAutostart(app) {
    return GLib.file_test(GLib.build_filenamev([autostartDir(), app.get_id()]), GLib.FileTest.EXISTS);
}

/** Add or remove the app's user autostart entry. */
export function setAutostart(app, on) {
    const dest = Gio.File.new_for_path(GLib.build_filenamev([autostartDir(), app.get_id()]));
    try {
        if (!on) {
            dest.delete(null);
            return;
        }
        GLib.mkdir_with_parents(autostartDir(), 0o755);
        const src = Gio.File.new_for_path(app.get_app_info().get_filename());
        src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch (e) {
        console.warn(`Fusion Desk: autostart change failed: ${e.message}`);
    }
}

/** Copy the app's launcher to the desktop folder. */
export function sendToDesktop(app) {
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    if (!dir)
        return;
    try {
        const dest = Gio.File.new_for_path(GLib.build_filenamev([dir, app.get_id()]));
        Gio.File.new_for_path(app.get_app_info().get_filename())
            .copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
        // Mark it trusted and executable so desktop-icon extensions launch it.
        dest.set_attribute_string('metadata::trusted', 'true', Gio.FileQueryInfoFlags.NONE, null);
        dest.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        console.warn(`Fusion Desk: send to desktop failed: ${e.message}`);
    }
}

/** Round icon button used by the launcher and control centre. */
export function iconButton(iconName, styleClass, accessibleName, onClick) {
    const button = new St.Button({
        style_class: styleClass,
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
    });
    button.connect('clicked', onClick);
    return button;
}
