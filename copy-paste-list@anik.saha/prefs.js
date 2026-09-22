import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CopyPasteListPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Copy Paste List'});
        page.add(group);

        const limitRow = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Maximum number of clipboard entries to keep',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 200,
                step_increment: 1,
            }),
        });
        settings.bind('history-limit', limitRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(limitRow);

        const shortcutRow = new Adw.ActionRow({
            title: 'Shortcut',
            subtitle: 'Accelerator string, e.g. <Super>v',
        });
        const shortcutEntry = new Gtk.Entry({
            valign: Gtk.Align.CENTER,
            text: settings.get_strv('toggle-shortcut')[0] || '<Super>v',
        });
        shortcutEntry.connect('changed', () => {
            const [ok] = Gtk.accelerator_parse(shortcutEntry.get_text());
            if (ok)
                shortcutEntry.remove_css_class('error');
            else
                shortcutEntry.add_css_class('error');
        });
        shortcutEntry.connect('activate', () => {
            const text = shortcutEntry.get_text();
            const [ok] = Gtk.accelerator_parse(text);
            if (ok)
                settings.set_strv('toggle-shortcut', [text]);
        });
        shortcutRow.add_suffix(shortcutEntry);
        group.add(shortcutRow);

        window.add(page);
    }
}
