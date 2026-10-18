<div align="center">

# Fusion Desk

**One panel for GNOME: taskbar, start menu, control centre, glass look, and the widgets you actually use.**

[![GNOME 50](https://img.shields.io/badge/GNOME-50-4A86CF?logo=gnome&logoColor=white)](https://release.gnome.org/50/)
[![Latest release](https://img.shields.io/github/v/release/Hafij-DEU/Fusion-desk-gnome-extension?color=2ea44f)](https://github.com/Hafij-DEU/Fusion-desk-gnome-extension/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Hafij-DEU/Fusion-desk-gnome-extension/total?color=orange)](https://github.com/Hafij-DEU/Fusion-desk-gnome-extension/releases)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)

[Install](#install) · [Features](#features) · [Screenshots](#screenshots) · [Settings](#where-to-find-things) · [FAQ](#faq) · [Credits](#credits)

<img src="screenshots/desktop.png" alt="Fusion Desk: floating glass taskbar with the control centre open" width="900">

</div>

---

## Why Fusion Desk

Fusion Desk replaces Ubuntu's dock and GNOME's top bar with a single, configurable panel. It brings together what usually takes five or six extensions: a taskbar, a start menu, a system monitor, clipboard history, media controls and more. It also adds a modern glass look you can tune down to the last detail.

- **Everything in one place.** The panel layout, start menu, widgets and appearance are all in one settings window.
- **Looks the way you like.** Pick a glass style, a material, a gradient and your own opacity, or turn it all off for a flat panel.
- **Light on your system.** Clean-room code built on GNOME Shell's own APIs, with no background daemons. The one optional helper is the charge limit's.

## Install

Needs **GNOME 50** (Ubuntu 26.04). Check with `gnome-shell --version`.

1. Download the latest release:

   ```bash
   wget -O fusion-desk.zip "https://github.com/Hafij-DEU/Fusion-desk-gnome-extension/releases/latest/download/fusion-desk@hafij-deu.github.io.shell-extension.zip"
   ```

2. Install it for your user (no `sudo`):

   ```bash
   gnome-extensions install --force fusion-desk.zip
   ```

3. **Log out and back in.** GNOME on Wayland loads new extensions only at login.

4. Turn off Ubuntu's dock, then turn Fusion Desk on:

   ```bash
   gnome-extensions disable ubuntu-dock@ubuntu.com
   ```

   ```bash
   gnome-extensions enable fusion-desk@hafij-deu.github.io
   ```

5. Open the settings, or right-click the panel → **Fusion Desk Settings**:

   ```bash
   gnome-extensions prefs fusion-desk@hafij-deu.github.io
   ```

> [!TIP]
> To update, run steps 1–3 again. Your settings are kept.

## Features

### 🪟 Panel and taskbar
- Top or bottom, any height and opacity. **Floating** (rounded, with a gap from the screen edges) or full width.
- **Pills** style groups the tray, clock and system monitor into rounded blocks, or choose **Flat**.
- Pinned and running apps, grouped or one button per window, window previews, indicator styles, and click / middle-click / scroll actions. Super+1…9 opens apps.
- **Intellihide** (with edge-pressure reveal), dynamic opacity, panels on every monitor.
- **Element layout**: show, hide, reorder and place every item left, centre or right.
- Optional **search box** and **Task View** button right after the start button.

### 🚀 Start menu and app launcher
- **7 start menu layouts** (Modern, Launcher Grid, Runner, Classic, Fusion, Sidebar, Tabbed), picked from drawn previews.
- Search with calculator, `>commands`, recent files and web. Places, drives and bookmarks. Labelled power options. One-click import of an existing ArcMenu setup.
- **App launcher**: fullscreen blurred grid with a category rail, or a small window. Use its own button, the start button or Super.

### 🎛️ Control centre
- Avatar and quick actions (screenshot, Settings, lock, power).
- **Media card** with cover and controls, plus a chip per player when several are playing.
- CPU, memory, disk and battery meters. Battery care and Fn lock switches on laptops that support them.
- **Notifications** take only the room they need. The panel grows with them, then scrolls.
- Month calendar. The button sits after the start button, in the tray, or on the clock.

### ✨ Glass and colours
- **Glass effect** (off / soft / strong) on the taskbar, start menu, Quick Settings, calendar, every panel menu, control centre and launcher.
- **Six styles**: Clear, Frosted, Gel, Tinted, Smoke, Halo.
- **Two materials**: clear glass (subtle shine) or gloss (strong polished shine and bevel).
- **Opacity**: below 100% the desktop shows through, blurred.
- Optional **rim highlight**, **corner glare**, **soft shadow** and a **light that follows the pointer**.
- **Accent gradient** in eight kinds: from the corner, the top, the side or the middle, or blended with a second colour (aurora, sunset, ocean, berry). The strength is adjustable.
- **Accent-coloured icons**. Plain white / black app tray icons take the same colour; colourful ones keep theirs.
- **Wallpaper blur** while windows are open, sharp again on an empty desktop.
- Light / dark taskbar that follows the system style. Optional accent colour, icon and cursor theme while Fusion Desk runs.

### 🔋 Battery and power
- **Coloured battery** with the percentage inside: green when full or charging, accent when normal, orange when low, red when almost empty.
- **Battery button** (optional), whose menu shows:
  - time left or time to full, power draw and battery health
  - **connected devices' batteries** (earbuds show left / right / case when the system reports them)
  - power mode and charging modes
- **Charge limit** (default 90%): stops charging at the level you choose. [How it works ↓](#charge-limit)

### 🧩 Widgets and extras
- System monitor (CPU, RAM, temperature, network).
- Clipboard history (optional Super+V; paste-on-select is opt-in).
- Media controls, custom clock, Caffeine with a timer, workspaces, window title, screenshot button, show-desktop strip.
- **Organize Desktop**: Desktop-folder files in movable, resizable collections (Computer, folders, documents, pictures, videos, music, apps, others). Alt+O hides or shows them. Works with the Desktop Icons extension.
- **Right-click menu**: style presets, background apps (with quit buttons), disk usage, panel toggles, power, quick launchers.
- **Style presets**: **Classic** (taskbar only), **Studio** (launcher, control centre, organizer, floating taskbar) or **Workbench** (search box and Task View). A preset only flips settings, never your layout.
- **App Hub** integration when [App Hub](https://github.com/Hafij-DEU/Application-hub) is installed.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="screenshots/start-menu.png" alt="Classic start menu with glass"><br><sub><b>Start menu</b>: Classic layout with glass</sub></td>
    <td width="50%"><img src="screenshots/app-launcher.png" alt="Fullscreen app launcher"><br><sub><b>App launcher</b>: fullscreen with categories</sub></td>
  </tr>
  <tr>
    <td><img src="screenshots/organize-desktop.png" alt="Organize Desktop collections"><br><sub><b>Organize Desktop</b>: files sorted into collections</sub></td>
    <td><img src="screenshots/start-menu-modern-dark.png" alt="Modern start menu, dark theme"><br><sub><b>Modern layout</b>: dark theme</sub></td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><img src="screenshots/control-centre.png" alt="Control centre" height="420"><br><sub><b>Control centre</b></sub></td>
    <td align="center"><img src="screenshots/battery-menu.png" alt="Battery menu" height="420"><br><sub><b>Battery menu</b></sub></td>
    <td align="center"><img src="screenshots/right-click-menu.png" alt="Right-click menu" height="420"><br><sub><b>Right-click menu</b></sub></td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><img src="screenshots/settings-appearance.png" alt="Settings: Appearance and Glass"><br><sub><b>Settings</b>: style presets and glass</sub></td>
    <td width="50%"><img src="screenshots/settings-layouts.png" alt="Settings: start menu layouts"><br><sub><b>Settings</b>: start menu layouts</sub></td>
  </tr>
</table>

<p align="center"><img src="screenshots/search-task-view.png" alt="Search box and Task View after the start button" width="640"><br><sub><b>Search box and Task View</b> (Workbench preset)</sub></p>

## Where to find things

| I want to… | Go to |
| --- | --- |
| Move the panel, change its height or opacity | Settings → **Layout** → Panel |
| Reorder or hide panel items | Settings → **Layout** → Elements |
| Show the battery as its own button, set a charge limit | Settings → **Layout** → Battery / Charge limit |
| Pick a preset, glass style, material or opacity | Settings → **Appearance** → Style presets / Glass |
| Change the gradient, accent icons or wallpaper blur | Settings → **Appearance** → Colours / Wallpaper |
| Add the search box and Task View | Settings → **Taskbar** → Search and Task View |
| Turn on the launcher, control centre or Organize Desktop | Settings → **Desktop** |
| Choose a start menu layout or theme | Settings → **Start Menu** |
| Change the start button icon or hotkeys | Settings → **Menu Button** |
| Configure system monitor, clipboard, clock, media | Settings → **Widgets** |

## Charge limit

Settings → **Layout** → **Charge limit** stops charging at a level you choose (60–100%, default 90%).

- **Laptops with an adjustable limit** (`charge_control_end_threshold`) get it set directly by the firmware.
- **Others**, for example IdeaPads with a fixed battery-protection mode: Fusion Desk charges normally up to your level, then switches to protection so charging stops. Below the level minus 3%, it charges again. The limit can't go below the laptop's own protection level (often 60 or 80%).

Changing the charging mode needs administrator rights. **Set up** asks for your password **once** and installs:

- `/usr/local/libexec/fusion-desk-charge`: a tiny helper that can only write a charging mode or a limit between 50 and 100%.
- A polkit rule that lets your logged-in session run that helper without a password.

The same button (**Remove**) takes both out again.

## FAQ

<details>
<summary><b>Nothing happens after enabling it</b></summary>

Make sure user extensions are allowed, then log out and back in:

```bash
gsettings set org.gnome.shell disable-user-extensions false
```

The graphical way is the **Extension Manager** app (`sudo apt install gnome-shell-extension-manager`).
</details>

<details>
<summary><b>I use Dash to Panel or ArcMenu</b></summary>

Turn them off: they change the same panel and the Super key. Fusion Desk pauses itself while Dash to Panel is on and tells you so. To bring over an ArcMenu setup, use **Settings → Start Menu → Import from ArcMenu**.

```bash
gnome-extensions disable dash-to-panel@jderose9.github.com
```

```bash
gnome-extensions disable arcmenu@arcmenu.com
```
</details>

<details>
<summary><b>I don't see any blur</b></summary>

Blur needs **Glass effect** on and **Opacity** below 100 (Settings → Appearance → Glass). At 100 the surfaces are solid.
</details>

<details>
<summary><b>Text is hard to read on my wallpaper</b></summary>

Raise **Opacity** (Settings → Appearance → Glass), pick the **Frosted** style, or lower **Gradient strength**.
</details>

<details>
<summary><b>What does a fresh install look like?</b></summary>

- A bottom 48 px panel with pills.
- The start menu on the left, the taskbar in the centre, and the system monitor, clipboard, Quick Settings and clock on the right.
- The **Classic** start menu with a dark theme.
- **Default look**: strong frosted glass at 75% opacity, the aurora accent gradient and a light wallpaper blur. **Settings → Appearance → Default look → Reset look** brings it back at any time without touching your layout.

Change anything in the settings. To go back to the defaults:

```bash
dconf reset -f /org/gnome/shell/extensions/fusion-desk/
```
</details>

<details>
<summary><b>Uninstall</b></summary>

1. If you set up the charge limit, click **Remove** first (Settings → Layout → Charge limit).
2. Uninstall the extension:

   ```bash
   gnome-extensions uninstall fusion-desk@hafij-deu.github.io
   ```

3. Log out and back in, then bring back Ubuntu's dock:

   ```bash
   gnome-extensions enable ubuntu-dock@ubuntu.com
   ```
</details>

## Build from source

```bash
git clone https://github.com/Hafij-DEU/Fusion-desk-gnome-extension.git
cd Fusion-desk-gnome-extension
gnome-extensions pack --force --extra-source=lib --extra-source=icons --extra-source=LICENSE -o dist .
gnome-extensions install --force dist/fusion-desk@hafij-deu.github.io.shell-extension.zip
```

## Privacy

- **Clipboard history** is kept in memory. With **Remember after restart** (on by default), it is also stored unencrypted in `~/.cache/fusion-desk/clipboard.json` (mode 0600).
  - Entries that password managers mark as secret are never recorded.
  - Use **Private mode** before copying other passwords.
- **Web search** runs only when you pick that result. The URL is configurable.
- **Organize Desktop** only lists your Desktop folder. It opens, shows or trashes a file only when you ask.
- **Themes**: if you pick an accent colour, icon or cursor theme on the Appearance page, Fusion Desk switches GNOME's setting while it runs. Yours comes back when you choose "Keep mine" or turn the extension off.
- **App Hub** actions run your installed `app-hub` command only when you click them. While the App Hub button is shown, there is also a background `app-hub list` check once an hour.
- **Nothing is ever sent anywhere** by Fusion Desk itself.

## Credits

Fusion Desk is an independent project written from scratch by **Md Hafijur Rahman** ([Hafij-DEU](https://github.com/Hafij-DEU)). No code was copied from the projects below; they inspired the feature set and the look:

- [Dash to Panel](https://github.com/home-sweet-gnome/dash-to-panel) (GPL-2.0): panel and taskbar ideas.
- [ArcMenu](https://gitlab.com/arcmenu/ArcMenu) (GPL-2.0): start menu layouts and settings structure. Fusion Desk can read an installed ArcMenu's settings once to import them.
- [Vitals](https://github.com/corecoding/Vitals), [Resource Monitor](https://github.com/0ry0n/Resource_Monitor) and GNOME's system-monitor extension: panel readouts.
- [Clipboard History](https://github.com/SUPERCILEX/gnome-clipboard-history) and [Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator): clipboard menu.
- [Caffeine](https://github.com/eonpatapon/gnome-shell-extension-caffeine): keep-awake toggle and timer.
- [Date Menu Formatter](https://github.com/marcinjakubowski/date-menu-formatter): custom clock format.
- [Deepin Desktop Environment](https://github.com/linuxdeepin) (GPL-3.0): ideas for the app launcher, control centre, desktop organizer and glossy look. These were reimplemented from observed behaviour (see [docs/deepin-inventory.md](docs/deepin-inventory.md)). No Deepin code, icons, wallpapers or translations are included.
- [GNOME Shell](https://gitlab.gnome.org/GNOME/gnome-shell) (GPL-2.0-or-later): the platform and its extension APIs.

Icons are from the GNOME / Adwaita theme. The CPU, RAM, temperature, arrow and Caffeine icons in `icons/` were drawn for this project. The App Hub icon belongs to the App Hub project by the same author.

## License and trademarks

Fusion Desk is free software under the **GPL-2.0-or-later** licence (see [LICENSE](LICENSE)).

All product names are the property of their owners. Microsoft Windows, deepin, KDE Plasma, Linux Mint, macOS / Spotlight and other names are trademarks of their respective owners. Fusion Desk is not affiliated with or endorsed by them, and its features use neutral names. Do not ship a start-button icon that copies another company's logo.
