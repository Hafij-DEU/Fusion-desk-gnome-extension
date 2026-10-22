// Weather for the Dashboard layout: GWeather for the city in the settings,
// fetched in the background, kept in memory and in
// ~/.cache/fusion-desk/weather.json, and refreshed at most every 30 minutes
// and only while the menu is open.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather?version=4.0';
import {findCity, foldName} from './weatherCity.js';
import {readText} from '../files.js';

export const REFRESH_SECONDS = 30 * 60;
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'fusion-desk', 'weather.json']);

// Last report {city, celsius, sky, icon, time}, shared by every menu and kept
// across layout rebuilds.
let last = null;
let lastRead = false;

const ICON_TEXT = [
    [/storm/, 'Thunderstorm'], [/snow/, 'Snow'], [/showers-scattered/, 'Light rain'], [/showers|rain/, 'Rain'],
    [/fog/, 'Fog'], [/windy/, 'Windy'], [/overcast/, 'Cloudy'], [/few-clouds/, 'Partly cloudy'], [/clear/, 'Clear'],
];

function describeIcon(icon) {
    return ICON_TEXT.find(([re]) => re.test(icon))?.[1] ?? '';
}

function now() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

function saveCache() {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE), 0o700);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(last)));
        Gio.File.new_for_path(CACHE).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`Fusion Desk: saving the weather failed: ${e.message}`);
                }
            });
    } catch (e) {
        console.warn(`Fusion Desk: saving the weather failed: ${e.message}`);
    }
}

export class DashWeather {
    /**
     * @param {Gio.Settings} settings extension settings
     * @param {function()} onChange called when the report or its state changed
     */
    constructor(settings, onChange) {
        this._settings = settings;
        this._onChange = onChange;
        this._state = 'idle';
        settings.connectObject('changed::menu-weather-city', () => this._reset(),
            'changed::menu-weather-location', () => !this._storing && this._reset(), this);
    }

    /** "18°C" or "64°F" (setting menu-weather-unit; SYSTEM = the locale's unit). */
    formatTemp(report) {
        if (typeof report?.celsius !== 'number')
            return '';
        let unit = this._settings.get_string('menu-weather-unit');
        if (unit === 'SYSTEM') {
            // Fahrenheit where the locale's measurements are (US, Liberia, Myanmar).
            const locale = GLib.getenv('LC_MEASUREMENT') || GLib.getenv('LC_ALL') || GLib.getenv('LANG') || '';
            unit = /^en_(US|LR)|^my_MM/.test(locale) ? 'F' : 'C';
        }
        return unit === 'F' ? `${Math.round(report.celsius * 9 / 5 + 32)}°F` : `${Math.round(report.celsius)}°C`;
    }

    get city() {
        return this._settings.get_string('menu-weather-city').trim();
    }

    /** The last report for the current city, or null. */
    get report() {
        // Reports cached before the unit setting have no Celsius value: fetch again.
        return last && typeof last.celsius === 'number' && foldName(last.city) === foldName(this.city) ? last : null;
    }

    /** 'none' (no city), 'notfound', 'loading', 'error' or 'idle'. */
    get state() {
        return this.city ? this._state : 'none';
    }

    _reset() {
        this._location = undefined;
        this._state = 'idle';
        this._info?.abort();
        this.refresh();
    }

    _findLocation() {
        if (this._location !== undefined)
            return this._location;
        const stored = this._settings.get_value('menu-weather-location').deepUnpack();
        let loc = stored.length ? GWeather.Location.get_world().deserialize(stored[0]) : null;
        if (!loc) {
            // City typed without prefs (or prefs could not look it up): find it once.
            loc = findCity(this.city);
            if (loc) {
                this._storing = true;
                this._settings.set_value('menu-weather-location', new GLib.Variant('av', [loc.serialize()]));
                this._storing = false;
            }
        }
        this._location = loc;
        return loc;
    }

    /** Fetch when there is no report yet or it is older than 30 minutes. */
    async refresh() {
        if (!this.city)
            return;
        if (!lastRead) {
            lastRead = true;
            try {
                last ??= JSON.parse(await readText(CACHE) || 'null');
            } catch {
                // No usable cache.
            }
            if (this._destroyed)
                return;
            this._onChange();
        }
        const report = this.report;
        if ((report && now() - report.time < REFRESH_SECONDS) || this._state === 'loading')
            return;
        const loc = this._findLocation();
        if (!loc) {
            this._state = 'notfound';
            this._onChange();
            return;
        }
        if (!this._info) {
            this._info = new GWeather.Info({
                application_id: 'org.gnome.Shell',
                contact_info: 'https://github.com/Hafij-DEU/Fusion-desk-gnome-extension',
                enabled_providers: GWeather.Provider.METAR | GWeather.Provider.MET_NO | GWeather.Provider.OWM,
            });
            this._info.connectObject('updated', () => this._onUpdated(), this);
        }
        this._info.location = loc;
        this._state = 'loading';
        this._city = this.city;
        this._onChange();
        this._info.update();
    }

    _onUpdated() {
        const info = this._info;
        if (!info.is_valid()) {
            this._state = 'error';
            this._onChange();
            return;
        }
        const [hasTemp, celsius] = info.get_value_temp(GWeather.TemperatureUnit.CENTIGRADE);
        const icon = info.get_symbolic_icon_name() || 'weather-few-clouds-symbolic';
        const known = text => text && text !== '-' && text !== 'Unknown' ? text : '';
        last = {
            city: this._city,
            celsius: hasTemp ? celsius : null,
            // Some providers only send a symbol: describe it then.
            sky: known(info.get_conditions()) || known(info.get_sky()) || describeIcon(icon),
            icon,
            time: now(),
        };
        this._state = 'idle';
        saveCache();
        this._onChange();
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnectObject(this);
        this._info?.disconnectObject(this);
        this._info?.abort();
        this._info = null;
    }
}
