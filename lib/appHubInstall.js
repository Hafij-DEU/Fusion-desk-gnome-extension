// "Install App Hub?" dialog, shown when an App Hub entry is clicked but App Hub
// is not installed. Install downloads the latest release .deb from GitHub into
// ~/Downloads (SHA-256 checked when GitHub publishes one) and opens it with the
// system's package installer, where the user confirms with their password.
// Fusion Desk itself never runs the installation.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const REPO = 'Hafij-DEU/Application-hub';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const DEB_TYPE = 'application/vnd.debian.binary-package';

let dialog = null;

function httpGet(url, accept, method = 'GET') {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({user_agent: 'fusion-desk', timeout: 120});
        const msg = Soup.Message.new(method, url);
        if (accept)
            msg.request_headers.append('Accept', accept);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`GitHub answered HTTP ${msg.get_status()}`);
                resolve({bytes, uri: msg.get_uri().to_string()});
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Latest release .deb: {name, url, digest}. Falls back to the /latest redirect when the API is rate-limited. */
async function latestDeb() {
    try {
        const {bytes} = await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`, 'application/vnd.github+json');
        const release = JSON.parse(new TextDecoder().decode(bytes.toArray()));
        const assets = release.assets ?? [];
        const a = assets.find(x => x.name.endsWith('_all.deb')) ?? assets.find(x => x.name.endsWith('.deb'));
        if (a)
            return {name: a.name, url: a.browser_download_url, digest: (a.digest ?? '').replace(/^sha256:/, '')};
    } catch {
        // Fall through to the redirect.
    }
    const {uri} = await httpGet(RELEASES, null, 'HEAD');
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(uri ?? '')?.[1];
    if (!tag)
        throw new Error('No App Hub release found');
    const name = `app-hub_${tag.replace(/^v/, '')}_all.deb`;
    return {name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, digest: ''};
}

/** Download the .deb into ~/Downloads and return its Gio.File. */
async function downloadDeb() {
    const deb = await latestDeb();
    const {bytes} = await httpGet(deb.url, null);
    if (deb.digest && GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes) !== deb.digest)
        throw new Error('The download did not match its published checksum');
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir();
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, deb.name.replace(/[^\w.+-]/g, '_')]));
    await new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
            try {
                f.replace_contents_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
    return file;
}

/** Open the .deb in the system's package installer, or show it in Files. */
function openInInstaller(file) {
    const ctx = global.create_app_launch_context(0, -1);
    const installer = Gio.AppInfo.get_default_for_type(DEB_TYPE, false);
    if (installer) {
        installer.launch([file], ctx);
        return true;
    }
    Gio.AppInfo.launch_default_for_uri(file.get_parent().get_uri(), ctx);
    return false;
}

/**
 * Ask whether to install App Hub.
 * @param {string} iconPath App Hub's icon shipped with Fusion Desk
 */
export function askInstallAppHub(iconPath) {
    if (dialog)
        return;
    dialog = new ModalDialog.ModalDialog({styleClass: 'fusion-hub-dialog', destroyOnClose: true});
    dialog.connect('destroy', () => {
        dialog = null;
    });
    if (iconPath && GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
        dialog.contentLayout.add_child(new St.Icon({gicon: Gio.icon_new_for_string(iconPath), icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER, style_class: 'fusion-hub-dialog-icon'}));
    }
    const content = new Dialog.MessageDialogContent({
        title: 'Install App Hub?',
        description: 'App Update needs App Hub, a free app that installs, updates and removes your apps ' +
            '(GitHub, deb, snap, flatpak, AppImage).\n\nInstall downloads the latest App Hub from GitHub ' +
            'and opens it in your software installer, where you confirm with your password.',
    });
    dialog.contentLayout.add_child(content);

    dialog.addButton({label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape});
    const install = dialog.addButton({label: 'Install', default: true, action: async () => {
        install.reactive = false;
        install.label = 'Downloading…';
        try {
            const file = await downloadDeb();
            dialog?.close();
            if (!openInInstaller(file))
                Main.notify('App Hub downloaded', `Open ${file.get_basename()} in Downloads to install it.`);
        } catch (e) {
            content.description = `Could not download App Hub: ${e.message}\n\nYou can get it from the release page instead.`;
            install.reactive = true;
            install.label = 'Open release page';
            dialog.clearButtons();
            dialog.addButton({label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape});
            dialog.addButton({label: 'Open release page', default: true, action: () => {
                dialog.close();
                Gio.AppInfo.launch_default_for_uri(RELEASES, global.create_app_launch_context(0, -1));
            }});
        }
    }});
    dialog.open();
}
