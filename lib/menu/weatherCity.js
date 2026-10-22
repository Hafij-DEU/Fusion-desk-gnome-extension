// City lookup in the GWeather location database, shared by the shell and
// prefs (no gnome-shell imports).
import GWeather from 'gi://GWeather?version=4.0';

/** Lower case without accents, so "İzmir" and "Izmir" match. */
export function foldName(text) {
    return (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').toLowerCase().trim();
}

/**
 * The city called `name` ("Izmir" or "Izmir, Turkey"), or null. An exact
 * name wins over one that only starts with it.
 */
export function findCity(name) {
    const [city, country = ''] = name.split(',').map(foldName);
    if (!city)
        return null;
    let exact = null, prefix = null;
    const fits = loc => !country || foldName(loc.get_country_name()).startsWith(country);
    const walk = parent => {
        for (let loc = parent.next_child(null); loc && !exact; loc = parent.next_child(loc)) {
            if (loc.get_level() !== GWeather.LocationLevel.CITY) {
                walk(loc);
                continue;
            }
            const names = [loc.get_name(), loc.get_english_name()].map(foldName);
            if (names.includes(city) && fits(loc))
                exact = loc;
            else if (!prefix && names.some(n => n.startsWith(city)) && fits(loc))
                prefix = loc;
        }
    };
    walk(GWeather.Location.get_world());
    return exact ?? prefix;
}

/** "Izmir, Turkey" */
export function cityLabel(loc) {
    return [loc.get_name(), loc.get_country_name()].filter(Boolean).join(', ');
}
