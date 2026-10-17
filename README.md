# Fusion Desk

All-in-one GNOME Shell 50 extension: one panel with a taskbar, a start menu and desktop widgets.

**Author:** Md Hafijur Rahman ([Hafij-DEU](https://github.com/Hafij-DEU)) · **Source:** https://github.com/Hafij-DEU/Fusion-desk-gnome-extension · **License:** GPL-2.0-or-later (see [LICENSE](LICENSE))

## Features
- **Panel**: top or bottom, height, opacity, intellihide (overlap modes + edge-pressure reveal), dynamic opacity, hide the overview dash, panels on every monitor.
- **Element layout**: every item (start menu, apps button, taskbar, workspaces, media, system monitor, clipboard, App Hub, screenshot, quick settings, date, show desktop, activities, window title) can be shown or hidden, ordered, and placed left, center or right.
- **Taskbar**: pinned + running apps, grouped or one button per window, indicator styles, window previews, app menu on right-click, configurable click / middle-click / scroll actions, tooltips, Super+1…9.
- **Start menu**: 7 layouts (Modern, Launcher Grid, Runner, Classic, Fusion, Sidebar, Tabbed) picked from drawn previews; colour themes and presets; own pinned list or taskbar favourites; app context menu; search with calculator, `>commands`, recent files and web; places, drives and bookmarks; labelled power options; App Hub panel; Super / extra hotkey / Super+R runner; large click area; one-click import of an existing ArcMenu setup.
- **Widgets**: CPU / RAM / temperature / network monitor, clipboard history on Super+V (works with the icon hidden; paste-on-select is opt-in), media controls (MPRIS, plus a mute/show-window fallback for apps without MPRIS), custom clock, Caffeine with a timer, workspace pills, window title, screenshot button, show-desktop strip.
- **App Hub**: optional panel button and start-menu panel for [App Hub](https://github.com/Hafij-DEU/Application-hub) (updates, installs, disk space) through your installed `app-hub` command. Fusion Desk never installs App Hub itself: without it, the button opens the App Hub releases page.
- **Conflict guard**: pauses itself (with a notification) while Dash to Panel is enabled.

## Install on a fresh Ubuntu
Needs **GNOME 50** (Ubuntu 26.04). Check yours with `gnome-shell --version`.

1. Download the latest release:
   ```bash
   wget -O fusion-desk.zip "https://github.com/Hafij-DEU/Fusion-desk-gnome-extension/releases/latest/download/fusion-desk@hafij-deu.github.io.shell-extension.zip"
   ```
2. Install it for your user (no sudo needed):
   ```bash
   gnome-extensions install --force fusion-desk.zip
   ```
3. **Log out and log back in.** GNOME on Wayland only loads new extensions at login.
4. Turn off Ubuntu's dock (Fusion Desk has its own taskbar) and turn Fusion Desk on:
   ```bash
   gnome-extensions disable ubuntu-dock@ubuntu.com
   ```
   ```bash
   gnome-extensions enable fusion-desk@hafij-deu.github.io
   ```
5. Open the settings:
   ```bash
   gnome-extensions prefs fusion-desk@hafij-deu.github.io
   ```

If you also use **Dash to Panel** or **ArcMenu**, turn them off (`gnome-extensions disable dash-to-panel@jderose9.github.com`, `gnome-extensions disable arcmenu@arcmenu.com`): they change the same panel and the Super key. Fusion Desk pauses itself while Dash to Panel is on and offers a one-click fix. An existing ArcMenu setup is imported once automatically.

Nothing happens after enabling? Make sure user extensions are allowed: `gsettings set org.gnome.shell disable-user-extensions false`, then log out and in again. The graphical way is the **Extension Manager** app (`sudo apt install gnome-shell-extension-manager`).

### Uninstall
```bash
gnome-extensions uninstall fusion-desk@hafij-deu.github.io
```
Then log out and in, and re-enable Ubuntu's dock with `gnome-extensions enable ubuntu-dock@ubuntu.com`.

### Build from source
```bash
git clone https://github.com/Hafij-DEU/Fusion-desk-gnome-extension.git
cd Fusion-desk-gnome-extension
gnome-extensions pack --force --extra-source=lib --extra-source=icons --extra-source=LICENSE -o dist .
gnome-extensions install --force dist/fusion-desk@hafij-deu.github.io.shell-extension.zip
```

## Credits and design inspiration
Fusion Desk is an independent project written from scratch. No code was copied from the projects below; they inspired the feature set and the look, and their work is gratefully acknowledged:

- [Dash to Panel](https://github.com/home-sweet-gnome/dash-to-panel) by Jason DeRose, Charles Gagnon and contributors (GPL-2.0) — panel/taskbar ideas.
- [ArcMenu](https://gitlab.com/arcmenu/ArcMenu) by Andrew Zaech, LinxGem33 and contributors (GPL-2.0) — start menu layouts and settings structure. Fusion Desk can read an installed ArcMenu's settings once to import them.
- [Vitals](https://github.com/corecoding/Vitals), [Resource Monitor](https://github.com/0ry0n/Resource_Monitor) and GNOME's system-monitor extension — panel readouts.
- [Clipboard History](https://github.com/SUPERCILEX/gnome-clipboard-history) and [Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) — clipboard menu.
- [Caffeine](https://github.com/eonpatapon/gnome-shell-extension-caffeine) — keep-awake toggle and timer.
- [Date Menu Formatter](https://github.com/marcinjakubowski/date-menu-formatter) — custom clock format.
- [GNOME Shell](https://gitlab.gnome.org/GNOME/gnome-shell) (GPL-2.0-or-later) — the platform and its public extension APIs.
- General desktop conventions (start menus with pinned grids and side rails, tabbed launchers, search launchers) seen in other operating systems and desktops.

Icons: GNOME/Adwaita theme icons; the CPU, RAM, temperature, arrow and Caffeine icons in `icons/` were drawn for this project. The App Hub icon belongs to the App Hub project by the same author.

## Trademarks
All product names are the property of their owners. Microsoft Windows, KDE Plasma, Linux Mint, macOS / Spotlight and other names are trademarks of their respective owners; Fusion Desk is not affiliated with or endorsed by them, and its layouts use neutral names. Do not ship a start-button icon that copies another company's logo.

## Privacy
- Clipboard history is kept in memory and, with **Remember after restart** (on by default), stored unencrypted in `~/.cache/fusion-desk/clipboard.json` (mode 0600). Entries that password managers mark as secret are never recorded. Use **Private mode** before copying other passwords.
- Web search only runs when you pick that result; the URL is configurable.
- App Hub actions run your installed `app-hub` command only when you click them (plus a background `app-hub list` check once an hour while the App Hub button is shown).
