# Copy Paste List(For my own use -_-)

A GNOME Shell extension that remembers what you copy. Press **Super+V** to pop up
a history of your clipboard, click an entry to paste it again — like the
clipboard history in Windows 10.

- Text you copy is hashed (SHA-256) and deduplicated.
- The full text of each entry is stored **encrypted, in your GNOME Keyring**
  (via libsecret) — only a hash, timestamp, and short preview live in a plain
  index file on disk (`~/.local/share/copy-paste-list/index.json`, permissions
  `0600`).
- Oldest entries are evicted once you pass the configured history size
  (default 30), including their stored secret.
- Copying files (e.g. in the Files app or off the Desktop) and images (e.g. a
  screenshot) is also captured, shown with a preview icon on the right of the
  entry — a real thumbnail when one exists (the same one you'd see as the
  file's desktop/Files icon), otherwise a generic icon for that file type
  (PDF, Word, Excel, etc). File entries only store the file paths; image data
  is cached under `~/.local/share/copy-paste-list/blobs/` (mode `0600`).
- GNOME Shell's own "Show notification list" shortcut also defaults to
  Super+V, which would otherwise silently steal the keypress. While enabled,
  this extension removes just the conflicting `<Super>v` binding from it
  (leaving `<Super>m` untouched) and restores it automatically when disabled.

Requires GNOME Shell **45+** (Ubuntu 24.04's default). It will **not** load on
GNOME 42 (Ubuntu 22.04) without porting to the legacy `imports.*` extension API.

## Requirements

- GNOME Shell 45, 46, or 47
- `gir1.2-secret-1` (GNOME Keyring bindings) — installed by default on Ubuntu;
  check with:
  ```bash
  dpkg -l | grep gir1.2-secret-1
  ```
- A running GNOME Keyring / Secret Service (normal on any standard GNOME
  desktop session — unlocked automatically when you log in)

## Install

1. Symlink (or copy) the extension folder into GNOME Shell's user extensions
   directory. Symlinking is recommended if you're developing/tinkering —
   edits to the source take effect on the next popup open, no reinstall
   needed.

   ```bash
   ln -s "$(pwd)/copy-paste-list@anik.saha" \
     ~/.local/share/gnome-shell/extensions/copy-paste-list@anik.saha
   ```

2. Compile the settings schema:

   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/copy-paste-list@anik.saha/schemas
   ```

3. **First-time only:** log out and log back in. GNOME Shell on Wayland does
   not reliably discover a brand-new extension UUID it has never seen before
   without a session restart (this is a known GNOME limitation, not specific
   to this extension). Extensions it already knows about *do* hot-reload on
   file changes — so this logout is only needed once, the very first time you
   install it.

4. Enable it:

   ```bash
   gnome-extensions enable copy-paste-list@anik.saha
   ```

5. Confirm it's running:

   ```bash
   gnome-extensions info copy-paste-list@anik.saha
   ```
   It should report `State: ACTIVE`.

## User guide

### Opening the history

Press **Super+V** anywhere, or click the clipboard icon it adds to the top
GNOME panel (top bar, usually near the clock/system menu):

```
┌──────────────────────────────────────────────┐
│  Activities   ...          󰆓  🔒 🔊  12:34 PM │  ← top panel
└──────────────────────────────────────────────┘
                                       ↑
                              clipboard icon (click)
                              or press Super+V
```

Clicking the icon (or pressing the shortcut) drops down a menu under it:

```
                              ┌───────────────────────────────┐
                              │ 192.168.1.1 ssh anik@server    │  ← most recent
                              │ TODO: fix the login bug        │
                              │ Edit Resume.pdf            [📄]│  ← copied file, icon = its
                              │                                 │    real thumbnail if one exists
                              │ Image (image/png, 812 KB)  [🖼]│  ← screenshot / copied image
                              │ https://example.com/some/link  │
                              │ ─────────────────────────────  │
                              │ Clear History                  │
                              └───────────────────────────────┘
```

- Copy text anywhere as normal (`Ctrl+C`, right-click → Copy, etc.) — it's
  picked up automatically within about a second and added to the top of the
  list.
- Copying the exact same text again just moves its existing entry back to the
  top instead of creating a duplicate.
- **Click any entry** to copy it back onto the clipboard, ready to paste
  (`Ctrl+V`) wherever you need it. The menu closes automatically.
- **Clear History** wipes the whole list, including the encrypted secrets
  stored in your keyring for each entry and any cached image blobs.
- Copying multiple files at once shows the first file's name and icon, with
  "(+N more)" appended; clicking it pastes all of them.

### Changing the shortcut or history size

Open preferences either via:

```bash
gnome-extensions prefs copy-paste-list@anik.saha
```

or through the **Extensions** app (search "Extensions" in Activities → find
"Copy Paste List" → gear icon).

```
┌─ Copy Paste List ──────────────────────────┐
│                                              │
│  History size            [ 30        ▲▼ ]  │
│  Maximum number of clipboard entries to keep│
│                                              │
│  Shortcut                 [ <Super>v      ] │
│  Accelerator string, e.g. <Super>v          │
│                                              │
└──────────────────────────────────────────────┘
```

Type a new accelerator string (e.g. `<Super><Shift>v`) into the Shortcut field
and press Enter to apply it.

## Uninstall

```bash
gnome-extensions disable copy-paste-list@anik.saha
rm ~/.local/share/gnome-shell/extensions/copy-paste-list@anik.saha   # removes the symlink only, not this repo
```

To also remove all stored data (history index and settings):

```bash
rm -rf ~/.local/share/copy-paste-list
dconf reset -f /org/gnome/shell/extensions/copy-paste-list/
```

To remove the encrypted clip contents left in your GNOME Keyring (in case any
secrets weren't cleaned up, e.g. the extension was force-removed mid-session):

```bash
secret-tool search --all xdg:schema org.gnome.shell.extensions.copy-paste-list
```
Delete matches with `secret-tool clear` and the same `hash` attribute shown in
the search output, or open **Seahorse** ("Passwords and Keys" app) and remove
entries labeled `Copy Paste List clip …` by hand.

If the extension was killed or force-removed while enabled (rather than
cleanly disabled), it may not have had a chance to give GNOME's own Super+V
notification-list shortcut back. Restore the stock default with:

```bash
gsettings reset org.gnome.shell.keybindings toggle-message-tray
```

## Troubleshooting

- **`gnome-extensions enable` says "does not exist"**: this is the Wayland
  first-discovery issue described in step 3 above — log out and back in once.
- **Extension loads but errors out**: watch the live log:
  ```bash
  journalctl --user _COMM=gnome-shell -f
  ```
  then trigger the bug (open the popup, copy something) and read the JS
  traceback that appears.
- **Nothing gets captured**: confirm the extension is `ACTIVE` via
  `gnome-extensions info`, and that GNOME Keyring is unlocked (it should be,
  automatically, on a normal desktop login).
