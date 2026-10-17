// Media controls: prev / play-pause / next + current track over MPRIS.
// Apps that play audio without MPRIS (e.g. the Opera snap, whose sandbox blocks
// it) still show up through the sound server: app icon, window title, mute and
// "show window", since there is nothing to send play/pause to.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

export class MediaControls {
    constructor(ext) {
        // Characters of the track title to show (0 = buttons only).
        this._maxTitle = ext.settings.get_int('media-title-length');
        this._players = new Map(); // bus name -> Gio.DBusProxy
        this.actor = new St.BoxLayout({style_class: 'fusion-media', y_align: Clutter.ActorAlign.CENTER, visible: false});

        const mkButton = (icon, name, method) => {
            const b = new St.Button({
                style_class: 'fusion-media-button',
                can_focus: true,
                track_hover: true,
                accessible_name: name,
                child: new St.Icon({icon_name: icon, icon_size: 16}),
            });
            b.connect('clicked', () => this._call(method));
            return b;
        };
        this._prev = mkButton('media-skip-backward-symbolic', 'Previous', 'Previous');
        this._play = mkButton('media-playback-start-symbolic', 'Play', 'PlayPause');
        this._next = mkButton('media-skip-forward-symbolic', 'Next', 'Next');
        this._appIcon = new St.Bin({style_class: 'fusion-media-app', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'fusion-media-label', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const labelButton = new St.Button({style_class: 'fusion-media-title', child: this._label, can_focus: true});
        labelButton.connect('clicked', () => this._raise());

        this.actor.add_child(this._appIcon);
        this.actor.add_child(this._prev);
        this.actor.add_child(this._play);
        this.actor.add_child(this._next);
        this.actor.add_child(labelButton);

        this._cancellable = new Gio.Cancellable();
        if (ext.settings.get_boolean('media-audio-fallback'))
            this._watchAudio();
        this._ownerSub = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._addPlayer(name);
                else
                    this._removePlayer(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error('Fusion Desk: MPRIS list failed', e);
                }
            });
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null,
            name, '/org/mpris/MediaPlayer2', PLAYER_IFACE, this._cancellable, (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_finish(res);
                    proxy.connectObject('g-properties-changed', () => this._sync(), this);
                    this._players.set(name, proxy);
                    this._sync();
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Fusion Desk: MPRIS proxy for ${name} failed: ${e.message}`);
                }
            });
    }

    _removePlayer(name) {
        this._players.get(name)?.disconnectObject(this);
        this._players.delete(name);
        this._sync();
    }

    _prop(proxy, key) {
        return proxy.get_cached_property(key)?.recursiveUnpack();
    }

    _active() {
        const all = [...this._players.values()];
        return all.find(p => this._prop(p, 'PlaybackStatus') === 'Playing') ??
            all.find(p => this._prop(p, 'PlaybackStatus') === 'Paused') ?? all[0] ?? null;
    }

    // ---- Sound-server fallback -------------------------------------------

    _watchAudio() {
        this._mixer = new Gvc.MixerControl({name: 'Fusion Desk media'});
        this._streamSignals = new Map();
        const changed = () => this._sync();
        this._mixer.connect('stream-added', (_m, id) => {
            const stream = this._mixer.lookup_stream_id(id);
            if (stream instanceof Gvc.MixerSinkInput) {
                this._streamSignals.set(stream, [
                    stream.connect('notify::state', changed),
                    stream.connect('notify::is-muted', changed),
                    stream.connect('notify::description', changed),
                ]);
            }
            changed();
        });
        this._mixer.connect('stream-removed', (_m, id) => {
            for (const [stream, ids] of this._streamSignals) {
                if (stream.id === id) {
                    ids.forEach(i => stream.disconnect(i));
                    this._streamSignals.delete(stream);
                }
            }
            changed();
        });
        this._mixer.open();
        global.display.connectObject('notify::focus-window', changed, this);
    }

    /** Shell app that owns a sound stream, matched by name / id / icon. */
    _appForStream(stream) {
        const keys = [stream.name, stream.application_id, stream.icon_name]
            .filter(Boolean).map(k => k.toLowerCase().replace(/\.desktop$/, ''));
        if (!keys.length)
            return null;
        const running = Shell.AppSystem.get_default().get_running();
        return running.find(app => keys.includes(app.get_name().toLowerCase())) ??
            running.find(app => {
                const id = app.get_id().toLowerCase();
                return keys.some(k => k.length > 2 && (id.startsWith(`${k}.`) || id.startsWith(`${k}_`) || id.includes(`.${k}`)));
            }) ?? null;
    }

    /** First app playing audio right now: {stream, app, win}. */
    _audioSource() {
        if (!this._mixer || this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return null;
        for (const stream of this._mixer.get_sink_inputs()) {
            if (stream.is_event_stream || stream.is_virtual)
                continue;
            // Sink inputs usually report no state (INVALID); skip only known-idle ones.
            const st = stream.state;
            if (st === Gvc.MixerStreamState.IDLE || st === Gvc.MixerStreamState.SUSPENDED)
                continue;
            const app = this._appForStream(stream);
            if (!app)
                continue;
            // Prefer a window that looks like it plays media, then the most recent one.
            const windows = app.get_windows();
            const win = windows.find(w => /youtube|video|music|spotify|netflix|twitch|▶/i.test(w.get_title() ?? '')) ?? windows[0] ?? null;
            return {stream, app, win};
        }
        return null;
    }

    _cleanTitle(title, app) {
        let t = (title ?? '').replace(/^\(\d+\)\s*/, '');
        const name = app.get_name();
        for (const suffix of [name, 'YouTube', 'YouTube Music', 'Opera', 'Google Chrome', 'Chromium', 'Brave']) {
            for (const sep of [' - ', ' – ', ' — ', ' | '])
                t = t.endsWith(sep + suffix) ? t.slice(0, -(sep.length + suffix.length)) : t;
        }
        return t.trim() || name;
    }

    _setText(text, full) {
        let shown = text;
        if (shown.length > this._maxTitle)
            shown = `${shown.slice(0, Math.max(this._maxTitle - 1, 0))}…`;
        this._label.text = shown;
        this._label.get_parent().accessible_name = full || text;
        this._label.visible = !!shown && this._maxTitle > 0;
    }

    _showAudio(src) {
        this._mode = 'audio';
        this._audio = src;
        this._appIcon.set_child(src.app.create_icon_texture(16));
        this._appIcon.show();
        this._prev.hide();
        this._next.hide();
        const muted = src.stream.is_muted;
        this._play.child.icon_name = muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
        this._play.accessible_name = muted ? 'Unmute' : 'Mute';
        const title = this._cleanTitle(src.win?.get_title(), src.app);
        this._setText(title, `${src.app.get_name()}: ${title}`);
        this.actor.show();
    }

    _sync() {
        const p = this._active();
        const playing = p && this._prop(p, 'PlaybackStatus') === 'Playing';
        const audio = playing ? null : this._audioSource();
        this._current = p;
        if (audio) {
            this._showAudio(audio);
            return;
        }
        this._mode = 'mpris';
        this._audio = null;
        this._appIcon.hide();
        this._prev.show();
        this._next.show();
        this._play.accessible_name = 'Play';
        if (!p) {
            this.actor.hide();
            return;
        }
        const meta = this._prop(p, 'Metadata') ?? {};
        const title = meta['xesam:title'] ?? '';
        const artist = Array.isArray(meta['xesam:artist']) ? meta['xesam:artist'].join(', ') : meta['xesam:artist'] ?? '';
        // Short: the title only; the full "artist – title" is the accessible name.
        this._setText(title || artist, artist && title ? `${artist} – ${title}` : '');
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = this._prop(p, 'CanGoPrevious') !== false;
        this._next.reactive = this._prop(p, 'CanGoNext') !== false;
        this.actor.visible = !!(title || artist) || playing;
    }

    _call(method) {
        if (this._mode === 'audio') {
            // No player interface: the middle button mutes / unmutes the app.
            if (method === 'PlayPause')
                this._audio?.stream.change_is_muted(!this._audio.stream.is_muted);
            return;
        }
        this._current?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _raise() {
        if (this._mode === 'audio') {
            if (this._audio?.win)
                Main.activateWindow(this._audio.win);
            return;
        }
        const name = this._current?.g_name;
        if (!name)
            return;
        Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'Raise',
            null, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        global.display.disconnectObject(this);
        if (this._mixer) {
            for (const [stream, ids] of this._streamSignals)
                ids.forEach(i => stream.disconnect(i));
            this._streamSignals.clear();
            this._mixer.close();
            this._mixer = null;
        }
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerSub);
        for (const p of this._players.values())
            p.disconnectObject(this);
        this._players.clear();
        this.actor.destroy();
    }
}
