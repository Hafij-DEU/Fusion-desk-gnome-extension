# Fusion Desk

All-in-one GNOME Shell 48–51 extension: one panel with a taskbar, a start menu and desktop widgets.

**Author:** Md Hafijur Rahman ([Hafij-DEU](https://github.com/Hafij-DEU)) · **Source:** https://github.com/Hafij-DEU/Fusion-desk-gnome-extension · **License:** GPL-2.0-or-later (see [LICENSE](LICENSE))

## Features
- **Panel**: top or bottom, height, opacity, intellihide (overlap modes + edge-pressure reveal), dynamic opacity, hide the overview dash, panels on every monitor.
- **Element layout**: every item (start menu, apps button, taskbar, workspaces, media, system monitor, clipboard, App Hub, screenshot, quick settings, date, show desktop, activities, window title) can be shown or hidden, ordered, and placed left, center or right.
- **Taskbar**: pinned + running apps, grouped or one button per window, indicator styles, window previews, app menu on right-click, configurable click / middle-click / scroll actions, tooltips, Super+1…9.
- **Start menu**: 7 layouts (Modern, Launcher Grid, Runner, Classic, Fusion, Sidebar, Tabbed) picked from drawn previews; colour themes and presets; own pinned list or taskbar favourites; app context menu; search with calculator, `>commands`, recent files and web; places, drives and bookmarks; labelled power options; App Hub panel; Super / extra hotkey / Super+R runner; large click area; one-click import of an existing ArcMenu setup.
- **Widgets**: CPU / RAM / temperature / network monitor, clipboard history on Super+V (works with the icon hidden), media controls (MPRIS, plus a mute/show-window fallback for apps without MPRIS), custom clock, Caffeine with a timer, workspace pills, window title, screenshot button, show-desktop strip.
- **App Hub**: optional panel button and start-menu panel for [App Hub](https://github.com/Hafij-DEU/Application-hub) (updates, installs, disk space).
- **Conflict guard**: pauses itself (with a notification and a one-click fix) while Dash to Panel is enabled.

## Install
```bash
gnome-extensions pack --force --extra-source=lib --extra-source=icons -o dist .
gnome-extensions install --force dist/fusion-desk@hafij-deu.github.io.shell-extension.zip
```
Log out and back in (Wayland), then enable **Fusion Desk** in Extensions. Turn off Dash to Panel and ArcMenu first: they change the same panel and claim the same Super key.

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
- Clipboard history stays in memory; **Remember after restart** (off by default) stores it unencrypted in `~/.cache/fusion-desk/clipboard.json`. Use **Private mode** before copying passwords.
- Web search only runs when you pick that result; the URL is configurable.
- App Hub actions run `app-hub` / `pkexec apt-get` only when you click them.
