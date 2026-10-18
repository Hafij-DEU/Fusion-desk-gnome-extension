# Deepin (DDE) feature inventory for Fusion Desk

Research notes for Fusion Desk's **Deepin mode**: a switch that turns the GNOME
desktop into a Deepin Desktop Environment–style UI.

DDE is GPL-3.0. Fusion Desk (GPL-2.0-or-later) only **reimplements behaviour and
look** in GJS. No DDE code, QML, icons, wallpapers or translations were copied.
The numbers below (sizes, timings, colours) are design measurements used as a
visual reference.

## Sources

Shallow clones (2026-10-18), read as data only:

| Requested repo | What was found | Used instead |
|---|---|---|
| linuxdeepin/dde-desktop | Archived in 2017; README says the code moved to dde-file-manager | `dde-file-manager/src/plugins/desktop` (canvas, organizer, background, wallpaper setting) |
| linuxdeepin/dde-control-center | Current (Qt6/QML, 2026-10) | — |
| linuxdeepin/dde-launcher | Qt5 launcher (2025-06) | plus `dde-shell/applets/dde-apps` (DDE 25) |
| linuxdeepin/dde-dock | Qt5 dock (2025-01) | plus `dde-shell/panels/dock` and `panels/notification` (DDE 25 QML dock) |
| linuxdeepin/dde-kwm | **Does not exist** (GitHub: repository not found) | `linuxdeepin/dde-kwin` (KWin configs and scripts) |

Method:
- REA `analyze_javascript_application` on dde-kwin, the only repo with JavaScript (5 KWin scripts).
  Evidence `ev_e691800b5645518393a80c6edfd9314ab82e9fe575f63ce49dcdbbbf88ed5b76`: 5 files parsed, 0 parse
  failures, static graph only (nothing executed).
- REA is meant for shipped binaries. The other repos are C++/QML source trees, so they were read with
  ordinary source tools, per REA's own routing rule.

## Legend

- **[P1]** high value and doable inside a GNOME Shell extension (see "What Deepin mode v1 builds" for what was built).
- **[P2]** nice to have, doable later.
- **[P3]** not possible, or not sensible, from a shell extension (window-manager, display-server,
  system-service or distro internals).
- **GNOME** = GNOME Shell / Settings already has it. **Fusion** = Fusion Desk already has it.

---

## 1. Dock (dde-dock, dde-shell/panels/dock)

| Feature | DDE behaviour / numbers | GNOME | Fusion | Prio |
|---|---|---|---|---|
| Fashion mode | Floating, centred bar 8–10 px off the edge; width shrinks to content; radius ≈ (size + 2·max(6, 0.16·size)) / 4; width animates 200 ms | — | — | **P1** |
| Efficient / Classic mode | Edge-to-edge bar, radius 0, icons left/centred, plugins right | — | Panel (top/bottom) | **P1** |
| Dock size | Default 56 px (range 37–100); icon = size × 9/14; spacing ≈ icon/48 × 10 | — | Panel height | **P1** |
| Positions | Top / Bottom / Left / Right; reposition = hide+show 250 ms OutCubic | — | Top/Bottom | P1 (bottom/top) · P2 (left/right) |
| Keep shown | Reserves screen space (struts) | — | Yes | **P1** |
| Keep hidden | Hidden, revealed at the screen edge after ~200 ms, slides 500 ms | — | Intellihide | **P1** |
| Smart hide | Hides when any normal window on the current workspace overlaps the dock area; show/hide timers 400 ms; always shown while the launcher is open | — | Intellihide (overlap modes) | **P1** |
| Drag to resize | Drag inner edge, 37–100; "Lock the Dock" disables it | — | — | P2 |
| Launcher button | Toggles the launcher | Apps grid | Start / apps button | **P1** |
| Multitask view button | Opens workspace overview (com.deepin.wm) | Overview | Activities | **P1** (opens GNOME overview) |
| Show desktop | 10 px strip at the far right edge | — | Show-desktop strip | **P1** |
| Task manager | Pinned + running, grouped per app; click = activate / minimize / cycle | Dash | Taskbar | **P1** (reuse Fusion taskbar, styled) |
| Running indicator | Dot/pill ≈ icon/3 × icon/16; hover background radius h/5 | — | Indicator styles | **P1** |
| Window previews on hover | 500 ms delay, 118 px thumbnails, close buttons | — | Previews | **P1** (reuse) |
| Drag reorder, drop files on apps | Own MIME, files open in the app | Dash reorder | Partial | P2 |
| Launch bounce, attention ripple | ~1.1 s bounce; looping ripple + 1.0→1.15 scale on urgent windows | — | — | P2 |
| App item menu | Open, desktop actions, Dock/Undock, Force Quit, Close All | App menu | App menu | **P1** (reuse) |
| Tray / plugin area | Pinned + collapsable + stashed areas; 16 px icons, 24 px items | Top-bar indicators | Status icons | **P1** (move GNOME's status area into the dock) |
| Datetime plugin | Clock in the plugin area | Date menu | Clock | **P1** (GNOME date menu, moved) |
| Sound / network / power plugins | Status icons, popups | Quick Settings | Indicators | **P1** (via Quick Settings) |
| Shutdown plugin | Lock / suspend / hibernate / shut down | System menu | Power submenu | **P1** |
| Trash plugin | Shows full/empty, opens trash, drop files to delete | — | — | **P1** (open + state); drop = P2 |
| Notification plugin | Opens the notification / control centre | Date menu | — | **P1** |
| Keyboard layout, onboard, media plugins | Small status plugins | Input source indicator, OSK | Media widget | P2 |
| Dock right-click menu | Mode, Position, Status (hide mode), Lock, Dock Settings | — | Panel menu | **P1** |
| Multi-display | Dock on primary or follows the pointer | — | Multi-monitor panels | P2 |

## 2. Launcher (dde-launcher, dde-shell/applets/dde-apps)

| Feature | DDE behaviour / numbers | GNOME | Fusion | Prio |
|---|---|---|---|---|
| Fullscreen mode | Blurred wallpaper background (or #000F27), 7 × 4 grid, item = 4/5 of the cell, icon = item × 0.5, hover radius 18 (white α 0.1 / 0.2 selected) | App grid | Launcher Grid layout | **P1** |
| Paging | Horizontal pages + dot indicator; one wheel notch = one page | Paged grid | Scrolling | P2 (v1 scrolls) |
| Windowed (small) mode | 780 × 600, radius 18 (dock corner square), left 1/3 = category or A–Z list + Settings/Power, right 2/3 = search, favourites + all apps (4 columns) | — | 7 start-menu layouts | **P1** |
| Fullscreen ↔ windowed toggle | Button next to the search field | — | — | **P1** |
| Categories | Fixed order: Internet, Chat, Music, Video, Graphics, Games, Office, Reading, Development, System, Others (XDG categories mapped to best match) | Folders | Category lists | **P1** (own XDG mapping) |
| Category navigation in fullscreen | Category view in display-mode "category" | — | — | **P1** (side rail) |
| Search | Case-insensitive substring on name, desktop id, keywords; pinyin + initials | Search providers | Search | **P1** (substring + keywords + initials); pinyin = P3 without a pinyin table |
| Typing anywhere starts search | Letters/digits go to the search field | Yes | Yes | **P1** |
| Free order with drag and folders | Drop an app on an app = folder (4 × 3, radius 36) | App folders | — | P2 |
| Sort windowed list by use / install time | New installs first, then frequency | Frequent view | Frequent | P2 |
| App right-click menu | Open, favourites, send to desktop, send to dock, add to startup, proxy, disable scaling, uninstall | Pin to dash, details | App context menu | **P1** (open, pin to dock, autostart, details); uninstall/proxy/scaling = P3 |
| New-install blue dot | 10 px dot before the label | — | — | P2 |
| Favourites ("My Favorites") | Separate grid in windowed mode | Dash favourites | Pinned | **P1** (shares dock pins) |
| Keyboard | Arrows/Tab/Enter, Ctrl+P/N/F/B, Esc | Yes | Yes | **P1** (arrows, Enter, Esc) |
| Opened by Super | Daemon keybinding → Toggle | Overview | Start menu Super | **P1** |

## 3. Control centre (dde-control-center) and quick panel (dde-shell)

| Feature | DDE behaviour / numbers | GNOME | Fusion | Prio |
|---|---|---|---|---|
| Full control-centre app (Display, Sound, Bluetooth, Mouse, Keyboard, Power, Accounts, Privacy, Default apps, Date/time, Notifications, About…) | Two-pane QML app | GNOME Settings | Settings shortcut | **P1** as *links* to GNOME Settings panels; re-creating the app = P3 |
| Sliding side panel / quick panel | Quick toggles (network, Bluetooth, airplane, eye comfort, DND, screenshot…), sliders | Quick Settings menu | — | **P1** (right-edge sliding panel) |
| Notification centre | 360 px wide, grouped per app, Clear All, "No recent notifications", 5 s bubbles | Date menu list, banners | — | **P1** (list + clear in the side panel); per-app folding = P2 |
| Do Not Disturb (with schedule) | Toggle + time range | DND toggle | — | **P1** toggle; schedule = P2 |
| Eye comfort | Colour temperature | Night Light | — | **P1** (toggle) |
| Light / Auto / Dark appearance | Theme cards | Style switch | — | **P1** (dock/launcher theme follows or overrides) |
| Accent colours | Pink #DF4187, Orange #EA691F, Yellow #F3B517, Green #49B125, Teal #00A48A, Blue #1F6EE7, Indigo #402FDB, Purple #7724B1, Grey #757575 (dark variants differ) | Accent colours | Follows system accent | **P1** (Deepin mode follows the GNOME accent; default look uses a Deepin-like blue) |
| Window effects: blur/transparency presets, opacity 25–100 | Affects DDE surfaces | — | Panel opacity | **P1** for Deepin-mode surfaces (blur, opacity, glossy glass setting) |
| Icon and cursor themes ("bloom") | Theme grids | Tweaks | — | **P1** as a theme switch while Deepin mode is on (themes come from the deepin-icon-theme package; not bundled) |
| Window rounded corners (0/6/12/18) | KWin effect | — | — | P3 (needs per-window shaders; separate extensions do this) |
| Minimize effect (Scale / Magic Lamp) | KWin effect | Scale | — | P3 |
| Title bar height | KWin decoration | — | — | P3 |
| Fonts (size steps 11–20 px) | Font settings | Tweaks / Settings | — | Link only (P3 to replicate) |
| Wallpaper slideshow / screensaver | Wallpaper + screensaver pages | Background panel | — | P2 (slideshow), P3 (screensaver) |
| Power plans, accounts, biometrics, boot menu, developer mode, deepin ID | System services | Power, Users | — | P3 |

## 4. Desktop (dde-file-manager desktop plugins)

| Feature | DDE behaviour / numbers | GNOME | Fusion | Prio |
|---|---|---|---|---|
| Desktop icon grid | Per-screen grid, free placement or auto-arrange, 5 icon sizes 32/48/64/96/128 | DING extension (Ubuntu) | — | P2 (DING already does this on Ubuntu) |
| Desktop right-click menu | New folder/document, paste, refresh, auto arrange, sort by, icon size, open in terminal, display settings, wallpaper | DING / Background menu | — | P1 for Organize desktop / show-hide / view options (added to GNOME's background menu); rest P2 |
| Desktop organizer collections ("Organize Desktop", deepin 23) | Right-click → Organize desktop; collections by type (documents, pictures, videos, music, folders, apps, others); drag the title bar; small / medium / large or drag the border; Alt+O hides/shows all; View options choose the collection types | — | — | **P1** (built; needs Ubuntu's Desktop Icons extension off) |
| Wallpaper & screensaver strip | Bottom blurred strip, 172 × 100 thumbnails | Background panel | — | P2 |
| Licence watermark | "Not authorized" text | — | — | P3 (distro-specific) |
| Rounded, translucent, blurred surfaces | Everywhere | Some | Themes | **P1** (Deepin-mode stylesheet + Shell.BlurEffect) |

## 5. Window manager (dde-kwin, in place of the missing dde-kwm)

| Feature | DDE behaviour | GNOME | Fusion | Prio |
|---|---|---|---|---|
| Multitasking view (Super+S), Expose (Super+W/A) | KWin effects | Overview (Super) | — | P1 via overview button; key remap P2 |
| Show desktop (Super+D) | KWin shortcut | Optional shortcut | Show desktop | P2 |
| Meta+Up absolute maximize / Meta+Down unmaximize | KWin script | Super+Up/Down already | — | GNOME |
| Screen-edge actions (run command / close window) | KWin screen-edge scripts | Hot corner | — | P2 |
| Force launchpad fullscreen | KWin script (geometry) | — | — | P3 (not needed: the launcher is shell chrome) |
| GTK frame extents, decorations, compositing config, Xwayland settings | KWin plugins/configs | Mutter | — | P3 |

---

## What Deepin mode v1 builds

The user chose (2026-10-18) to keep their own Fusion taskbar in every mode: a desktop mode only *adds* features,
icons and theming, and only one bar ever runs. So the DDE dock itself (Fashion / Efficient, smart hide, dock
plugins) is documented above but **not built**; its useful parts arrive as taskbar additions instead.

`desktop-mode` = `fusion` | `deepin` | `windows`:

1. **Deepin** – taskbar additions: launcher button after the start button, control-centre button before the system
   menu, Super opens the Deepin launcher (optional). Plus:
   - **Launcher** – fullscreen blurred grid with category rail and search; windowed 780 × 600 mode with category /
     A–Z list, favourites, Settings and Power; toggle between them.
   - **Control centre** – right-edge sliding panel: GNOME's own quick toggles and sliders mirrored, notification
     list with Clear All, links to GNOME Settings panels.
   - **Organize Desktop** – desktop files in movable, resizable collections by type; Alt+O; desktop right-click items.
   - **Look** – glossy glass taskbar (gradient + light top edge), blur, light/dark/auto colours for the Deepin panels,
     optional icon / cursor theme (e.g. bloom from deepin-icon-theme) and accent colour from Deepin's palette while
     the mode runs, and an optional **floating taskbar** (Fashion-dock look: rounded, gap from the edges) that keeps
     the user's layout.
2. **Windows-like** – not a DDE feature, added at the user's request: search box (or icon) and Task View button after
   the start button, Windows-style rounded hover tiles, blur.

## i18n

All new UI strings go through `gettext` (`_()`), so they are ready for a `po/` catalogue. The Deepin Transifex
project needs a login and was not used; DDE translations are GPL-3.0 and are not copied.
