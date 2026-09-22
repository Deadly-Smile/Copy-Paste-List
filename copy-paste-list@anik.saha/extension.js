import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Secret from 'gi://Secret';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MAX_PREVIEW_LEN = 60;
const POLL_INTERVAL_MS = 1000;
const PREVIEW_ICON_SIZE = 32;
const IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/tiff', 'image/webp'];

// GNOME Shell's own "toggle-message-tray" action defaults to <Super>v, which
// silently wins any grab conflict with our keybinding. We temporarily strip
// our shortcut out of it while enabled, and restore it on disable.
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';

const SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.copy-paste-list',
    Secret.SchemaFlags.NONE,
    {hash: Secret.SchemaAttributeType.STRING}
);

const ClipboardHistoryIndicator = GObject.registerClass(
class ClipboardHistoryIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Copy Paste List', false);
        this._extension = extension;

        const icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(icon);

        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._clearItem = new PopupMenu.PopupMenuItem('Clear History');
        this._clearItem.connect('activate', () => this._extension.clearHistory());
        this.menu.addMenuItem(this._clearItem);
    }

    rebuild(history) {
        this._listSection.removeAll();

        if (history.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('(No clipboard history yet)', {
                reactive: false,
            });
            this._listSection.addMenuItem(empty);
            return;
        }

        for (const entry of history) {
            const item = new PopupMenu.PopupMenuItem(entry.preview || '(empty)');
            item.label.x_expand = true;

            const icon = this._buildPreviewIcon(entry);
            if (icon)
                item.add_child(icon);

            item.connect('activate', () => this._extension.restoreEntry(entry.hash));
            this._listSection.addMenuItem(item);
        }
    }

    _buildPreviewIcon(entry) {
        let gicon = null;

        if (entry.kind === 'image' && entry.path)
            gicon = Gio.FileIcon.new(Gio.File.new_for_path(entry.path));
        else if (entry.kind === 'file' && entry.iconPath)
            gicon = Gio.FileIcon.new(Gio.File.new_for_path(entry.iconPath));
        else if (entry.kind === 'file' && entry.contentType)
            gicon = Gio.content_type_get_icon(entry.contentType);

        if (!gicon)
            return null;

        return new St.Icon({
            gicon,
            icon_size: PREVIEW_ICON_SIZE,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }
});

export default class CopyPasteListExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._traySettings = new Gio.Settings({schema_id: TRAY_SCHEMA});
        this._reclaimedTrayBindings = null;

        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'copy-paste-list']);
        GLib.mkdir_with_parents(this._dataDir, 0o700);
        this._indexFile = GLib.build_filenamev([this._dataDir, 'index.json']);
        this._blobDir = GLib.build_filenamev([this._dataDir, 'blobs']);

        this._history = this._loadIndex();
        this._lastSignature = null;
        this._clipboard = St.Clipboard.get_default();

        this._indicator = new ClipboardHistoryIndicator(this);
        this._indicator.rebuild(this._history);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._updateKeybindingConflicts();
        this._shortcutChangedId = this._settings.connect(
            'changed::toggle-shortcut', () => this._updateKeybindingConflicts());

        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator.menu.toggle()
        );

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._checkClipboard();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }

        Main.wm.removeKeybinding('toggle-shortcut');

        if (this._shortcutChangedId) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = null;
        }
        this._restoreTrayBindings();
        this._traySettings = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
        this._history = null;
        this._clipboard = null;
        this._lastSignature = null;
    }

    // --- Keybinding conflict handling -------------------------------------

    _updateKeybindingConflicts() {
        this._restoreTrayBindings();

        const ours = this._settings.get_strv('toggle-shortcut');
        const trayBindings = this._traySettings.get_strv(TRAY_KEY);
        const filtered = trayBindings.filter(b => !ours.includes(b));

        if (filtered.length !== trayBindings.length) {
            this._reclaimedTrayBindings = trayBindings;
            this._traySettings.set_strv(TRAY_KEY, filtered);
        }
    }

    _restoreTrayBindings() {
        if (this._reclaimedTrayBindings) {
            this._traySettings.set_strv(TRAY_KEY, this._reclaimedTrayBindings);
            this._reclaimedTrayBindings = null;
        }
    }

    // --- Clipboard polling / classification --------------------------------

    _checkClipboard() {
        const mimetypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);

        if (mimetypes.length > 0 && mimetypes.join(',') !== this._lastMimeDebug) {
            this._lastMimeDebug = mimetypes.join(',');
            log(`[copy-paste-list] mimetypes: ${this._lastMimeDebug}`);
        }

        const uriListMime = mimetypes.find(m => m === 'text/uri-list' || m.startsWith('text/uri-list;'));
        if (uriListMime) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, uriListMime,
                (clipboard, bytes) => {
                    log(`[copy-paste-list] uri-list bytes: ${bytes ? bytes.get_size() : 'null'}`);
                    this._handleUriList(bytes);
                });
            return;
        }

        const imageMime = IMAGE_MIMETYPES.find(m => mimetypes.includes(m));
        if (imageMime) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, imageMime,
                (clipboard, bytes) => this._handleImage(imageMime, bytes));
            return;
        }

        this._checkClipboardText();
    }

    _checkClipboardText() {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
            if (!text)
                return;

            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
            if (!this._claimSignature(`text:${hash}`))
                return;

            this._addTextEntry(hash, text);
        });
    }

    _handleUriList(bytes) {
        if (!bytes || bytes.get_size() === 0) {
            this._checkClipboardText();
            return;
        }

        const text = new TextDecoder().decode(bytes.get_data());
        log(`[copy-paste-list] uri-list content: ${JSON.stringify(text)}`);
        const fileUris = text.split(/\r\n|\n/)
            .map(line => line.trim())
            .filter(line => line.startsWith('file://'));

        if (fileUris.length === 0) {
            this._checkClipboardText();
            return;
        }

        const hash = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, fileUris.join('\n'), -1);
        if (!this._claimSignature(`file:${hash}`))
            return;

        this._addFileEntry(hash, fileUris);
    }

    _handleImage(mime, bytes) {
        if (!bytes || bytes.get_size() === 0) {
            this._checkClipboardText();
            return;
        }

        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (!this._claimSignature(`image:${hash}`))
            return;

        this._addImageEntry(hash, mime, bytes);
    }

    // Returns false (and does nothing) if this is the same content we saw on
    // the previous poll, so we don't reprocess unchanged clipboard content
    // every second.
    _claimSignature(signature) {
        if (signature === this._lastSignature)
            return false;

        this._lastSignature = signature;
        return true;
    }

    // --- Entry creation ------------------------------------------------

    _bumpExisting(hash) {
        const idx = this._history.findIndex(e => e.hash === hash);
        if (idx === -1)
            return false;

        const [existing] = this._history.splice(idx, 1);
        existing.timestamp = Date.now();
        this._history.unshift(existing);
        this._saveIndex();
        this._indicator?.rebuild(this._history);
        return true;
    }

    _addTextEntry(hash, text) {
        if (this._bumpExisting(hash))
            return;

        const preview = text.length > MAX_PREVIEW_LEN
            ? `${text.slice(0, MAX_PREVIEW_LEN)}…`
            : text;
        this._history.unshift({kind: 'text', hash, timestamp: Date.now(), preview});
        this._storeSecret(hash, text);

        this._trimHistory();
        this._saveIndex();
        this._indicator?.rebuild(this._history);
    }

    _addFileEntry(hash, uris) {
        if (this._bumpExisting(hash))
            return;

        const files = uris.map(uri => this._describeFile(uri));
        const primary = files[0];
        const preview = files.length === 1
            ? primary.displayName
            : `${primary.displayName} (+${files.length - 1} more)`;

        this._history.unshift({
            kind: 'file',
            hash,
            timestamp: Date.now(),
            preview,
            uris,
            contentType: primary.contentType,
            iconPath: primary.thumbnailPath,
        });

        this._trimHistory();
        this._saveIndex();
        this._indicator?.rebuild(this._history);
    }

    _addImageEntry(hash, mime, bytes) {
        if (this._bumpExisting(hash))
            return;

        const ext = mime.split('/')[1] || 'bin';
        GLib.mkdir_with_parents(this._blobDir, 0o700);
        const path = GLib.build_filenamev([this._blobDir, `${hash}.${ext}`]);

        try {
            const file = Gio.File.new_for_path(path);
            file.replace_contents(
                bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            logError(e, 'Copy Paste List: failed to cache image blob');
            return;
        }

        this._history.unshift({
            kind: 'image',
            hash,
            timestamp: Date.now(),
            preview: `Image (${mime}, ${Math.round(bytes.get_size() / 1024)} KB)`,
            path,
            mime,
        });

        this._trimHistory();
        this._saveIndex();
        this._indicator?.rebuild(this._history);
    }

    _describeFile(uri) {
        try {
            const file = Gio.File.new_for_uri(uri);
            const info = file.query_info(
                'standard::display-name,standard::content-type,thumbnail::path,thumbnail::is-valid',
                Gio.FileQueryInfoFlags.NONE, null);

            const thumbValid = info.get_attribute_boolean('thumbnail::is-valid');
            const thumbPath = thumbValid ? info.get_attribute_byte_string('thumbnail::path') : null;

            return {
                displayName: info.get_display_name() || file.get_basename() || uri,
                contentType: info.get_content_type(),
                thumbnailPath: thumbPath || null,
            };
        } catch (e) {
            return {
                displayName: GLib.path_get_basename(uri) || uri,
                contentType: null,
                thumbnailPath: null,
            };
        }
    }

    // --- Restore / clear -------------------------------------------------

    restoreEntry(hash) {
        const entry = this._history.find(e => e.hash === hash);
        if (!entry)
            return;

        if (entry.kind === 'file') {
            this._lastSignature = `file:${hash}`;
            const text = `${entry.uris.join('\r\n')}\r\n`;
            this._clipboard.set_content(
                St.ClipboardType.CLIPBOARD, 'text/uri-list',
                GLib.Bytes.new(new TextEncoder().encode(text)));
            return;
        }

        if (entry.kind === 'image') {
            try {
                const [ok, contents] = Gio.File.new_for_path(entry.path).load_contents(null);
                if (!ok)
                    return;
                this._lastSignature = `image:${hash}`;
                this._clipboard.set_content(
                    St.ClipboardType.CLIPBOARD, entry.mime, GLib.Bytes.new(contents));
            } catch (e) {
                logError(e, 'Copy Paste List: failed to restore image blob');
            }
            return;
        }

        this._lookupSecret(hash, text => {
            if (!text)
                return;

            this._lastSignature = `text:${hash}`;
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        });
    }

    clearHistory() {
        for (const entry of this._history)
            this._evictEntry(entry);

        this._history = [];
        this._saveIndex();
        this._indicator?.rebuild(this._history);
    }

    // --- Eviction ----------------------------------------------------------

    _trimHistory() {
        const limit = this._settings.get_int('history-limit');
        while (this._history.length > limit)
            this._evictEntry(this._history.pop());
    }

    _evictEntry(entry) {
        if (entry.kind === 'image' && entry.path)
            this._deleteBlobFile(entry.path);
        else if (!entry.kind || entry.kind === 'text')
            this._deleteSecret(entry.hash);
        // 'file' entries only reference paths that already exist on disk
        // elsewhere; nothing of ours to delete.
    }

    _deleteBlobFile(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            // Already gone; nothing to do.
        }
    }

    // --- Secret storage ------------------------------------------------

    _storeSecret(hash, text) {
        Secret.password_store(
            SECRET_SCHEMA,
            {hash},
            Secret.COLLECTION_DEFAULT,
            `Copy Paste List clip ${hash.slice(0, 8)}`,
            text,
            null,
            (source, result) => {
                try {
                    Secret.password_store_finish(result);
                } catch (e) {
                    logError(e, 'Copy Paste List: failed to store secret');
                }
            }
        );
    }

    _deleteSecret(hash) {
        Secret.password_clear(SECRET_SCHEMA, {hash}, null, (source, result) => {
            try {
                Secret.password_clear_finish(result);
            } catch (e) {
                logError(e, 'Copy Paste List: failed to clear secret');
            }
        });
    }

    _lookupSecret(hash, callback) {
        Secret.password_lookup(SECRET_SCHEMA, {hash}, null, (source, result) => {
            let text = null;
            try {
                text = Secret.password_lookup_finish(result);
            } catch (e) {
                logError(e, 'Copy Paste List: failed to look up secret');
            }
            callback(text);
        });
    }

    // --- Index persistence -------------------------------------------------

    _loadIndex() {
        try {
            const file = Gio.File.new_for_path(this._indexFile);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return [];

            const data = JSON.parse(new TextDecoder().decode(contents));
            return Array.isArray(data.entries) ? data.entries : [];
        } catch (e) {
            return [];
        }
    }

    _saveIndex() {
        try {
            const file = Gio.File.new_for_path(this._indexFile);
            const json = JSON.stringify({entries: this._history});
            file.replace_contents(
                json, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            file.set_attribute_uint32(
                'unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            logError(e, 'Copy Paste List: failed to save index');
        }
    }
}
