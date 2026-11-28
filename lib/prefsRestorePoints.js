// Settings → Panel → Restore points: make a point, see every point, bring one
// back with one click (with Undo), or delete it. Storage and the restore
// itself live in lib/restorePoints.js; this file is only the page.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {createPoint, exportPoint, importPoint, listPoints, pointTime, removePoint, restorePoint}
    from './restorePoints.js';

const FILTER = new Gtk.FileFilter({name: 'Fusion Desk restore points'});
FILTER.add_pattern('*.json');

function jsonFilters() {
    const list = new Gio.ListStore({item_type: Gtk.FileFilter});
    list.append(FILTER);
    return list;
}

/** The "Restore points" group for the Panel page. */
export function restorePointsGroup(window, settings) {
    const g = new Adw.PreferencesGroup({
        title: 'Restore points',
        description: 'Each point keeps every Fusion Desk setting and the shared glass look. ' +
            'Fusion Desk also makes one a day and before a style preset or a restore.',
    });
    const toast = (title, undo) => {
        const t = new Adw.Toast({title, timeout: undo ? 6 : 3});
        if (undo) {
            t.button_label = 'Undo';
            t.connect('button-clicked', () => {
                restorePoint(settings, undo);
                removePoint(undo);
                refresh();
            });
        }
        window.add_toast(t);
    };

    // Make a point: a name entry with a Create button.
    const make = new Adw.EntryRow({title: 'New restore point name', show_apply_button: false});
    const create = new Gtk.Button({label: 'Create', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    make.add_suffix(create);
    const doCreate = () => {
        const name = make.text.trim() || 'Restore point';
        try {
            createPoint(settings, name);
            make.text = '';
            toast(`Restore point “${name}” made`);
        } catch (e) {
            toast(`Could not make the restore point: ${e.message}`);
        }
        refresh();
    };
    create.connect('clicked', doCreate);
    make.connect('entry-activated', doCreate);
    g.add(make);

    // Another PC: import a point exported there (each row has Export).
    const importRow = new Adw.ActionRow({title: 'Import a restore point',
        subtitle: 'From a file exported on this or another PC; then press Restore on it'});
    const importBtn = new Gtk.Button({label: 'Import\u2026', valign: Gtk.Align.CENTER});
    importRow.add_suffix(importBtn);
    importRow.activatable_widget = importBtn;
    importBtn.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title: 'Import a restore point', filters: jsonFilters()});
        dialog.open(window, null, (d, res) => {
            let file;
            try {
                file = d.open_finish(res);
            } catch {
                return;   // cancelled
            }
            try {
                const p = importPoint(file.get_path());
                toast(`\u201c${p.label}\u201d added: press Restore to use it`);
            } catch (e) {
                toast(`Could not import: ${e.message}`);
            }
            refresh();
        });
    });
    g.add(importRow);

    let rows = [];
    const refresh = () => {
        rows.forEach(r => g.remove(r));
        rows = [];
        const points = listPoints();
        if (!points.length) {
            const empty = new Adw.ActionRow({title: 'No restore points yet', subtitle: 'Make one above'});
            rows.push(empty);
            g.add(empty);
            return;
        }
        for (const p of points) {
            const row = new Adw.ActionRow({
                title: p.label,
                subtitle: `${pointTime(p)} · ${p.auto ? 'made automatically' : 'made by you'} · ` +
                    `${Object.keys(p.keys).length} settings`,
            });
            const restore = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER});
            restore.connect('clicked', () => {
                const {failed, undo} = restorePoint(settings, p);
                toast(failed ? `Restored with ${failed} problem(s); see the system log`
                    : `“${p.label}” is back`, undo);
                refresh();
            });
            const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Delete this restore point', css_classes: ['flat']});
            del.connect('clicked', () => {
                const dialog = new Adw.AlertDialog({heading: 'Delete this restore point?',
                    body: `“${p.label}” (${pointTime(p)}) will be deleted for good.`});
                dialog.add_response('cancel', 'Cancel');
                dialog.add_response('delete', 'Delete');
                dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.connect('response', (_d, id) => {
                    if (id !== 'delete')
                        return;
                    if (!removePoint(p))
                        toast('Could not delete the restore point');
                    refresh();
                });
                dialog.present(window);
            });
            const exp = new Gtk.Button({icon_name: 'document-save-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Export to a file (to use on another PC)', css_classes: ['flat']});
            exp.connect('clicked', () => {
                const safe = p.label.replace(/[^\w .-]+/g, '').trim() || 'restore-point';
                const dialog = new Gtk.FileDialog({title: 'Export restore point',
                    initial_name: `fusion-desk-${safe}.json`, filters: jsonFilters()});
                dialog.save(window, null, (d, res) => {
                    let file;
                    try {
                        file = d.save_finish(res);
                    } catch {
                        return;   // cancelled
                    }
                    try {
                        exportPoint(p, file.get_path());
                        toast(`Exported to ${file.get_basename()}`);
                    } catch (e) {
                        toast(`Could not export: ${e.message}`);
                    }
                });
            });
            row.add_suffix(restore);
            row.add_suffix(exp);
            row.add_suffix(del);
            rows.push(row);
            g.add(row);
        }
    };
    refresh();
    return g;
}
