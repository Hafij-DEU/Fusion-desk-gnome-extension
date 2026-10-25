// Preferences: the row and group helpers every settings page uses (prefs
// process only), so all pages look and behave the same.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/** Connect a settings signal for as long as `widget` lives (sub-pages are rebuilt on every open). */
export function watch(s, signal, widget, cb) {
    const id = s.connect(signal, cb);
    widget.connect('destroy', () => s.disconnect(id));
}

export function switchRow(s, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function spinRow(s, key, title, min, max, step = 1, subtitle = '') {
    const row = new Adw.SpinRow({title, subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5})});
    s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function comboRow(s, key, title, values, labels, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
    const sync = () => {
        row.selected = Math.max(0, values.indexOf(s.get_string(key)));
    };
    sync();
    watch(s, `changed::${key}`, row, sync);
    row.connect('notify::selected', () => {
        if (s.get_string(key) !== values[row.selected])
            s.set_string(key, values[row.selected]);
    });
    return row;
}

/** Text setting, saved on Apply; newlines show as \n so multi-line values stay editable. */
export function entryRow(s, key, title) {
    const shown = () => s.get_string(key).replace(/\n/g, '\\n');
    // Plain titles: "<Super>space" is not markup.
    const row = new Adw.EntryRow({title, use_markup: false, show_apply_button: true, text: shown()});
    row.connect('apply', () => s.set_string(key, row.text.trim().replace(/\\n/g, '\n')));
    watch(s, `changed::${key}`, row, () => {
        if (row.text !== shown())
            row.text = shown();
    });
    return row;
}

export function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    return g;
}

/** Show a sub-page (with a back button) filled by `build(page)`. */
export function pushSubpage(window, title, build) {
    const page = new Adw.PreferencesPage();
    build(page);
    const nav = new Adw.NavigationPage({title, child: new Adw.ToolbarView({content: page})});
    nav.child.add_top_bar(new Adw.HeaderBar());
    window.push_subpage(nav);
}

/** A row that opens a sub-page built by `build(page)`. */
export function navRow(window, title, subtitle, icon, build) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_prefix(new Gtk.Image({icon_name: icon}));
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => pushSubpage(window, title, build));
    return row;
}

/** A Reset button in the group's header that resets `keys`. */
export function resetButton(s, groupWidget, keys, tooltip = 'Back to the defaults') {
    const b = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, tooltip_text: tooltip});
    b.connect('clicked', () => keys.forEach(k => s.reset(k)));
    groupWidget.set_header_suffix(b);
    return b;
}

/**
 * Rows that only matter while another setting says so: greyed out
 * otherwise. `on(s)` decides, re-checked whenever one of `keys` changes.
 */
export function dependsOn(s, keys, on, rows) {
    const sync = () => {
        const active = on(s);
        rows.forEach(r => r.set_sensitive(active));
    };
    sync();
    for (const key of keys)
        watch(s, `changed::${key}`, rows[0], sync);
    return rows;
}

/** dependsOn for the common case: rows greyed out while switch `key` is off. */
export function dependsOnSwitch(s, key, rows) {
    return dependsOn(s, [key], () => s.get_boolean(key), rows);
}
