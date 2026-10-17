// Built-in top-right status icons the user can hide one by one. Shared by the
// shell and prefs (no gnome-shell imports). [id, label, note, quickSettings property]
export const INDICATORS = [
    ['network', 'Network', 'Wi-Fi, wired, mobile and VPN', '_network'],
    ['bluetooth', 'Bluetooth', '', '_bluetooth'],
    ['volume', 'Volume', 'Speaker / headphone level', '_volumeOutput'],
    ['microphone', 'Microphone in use', 'Privacy icon shown while an app records audio', '_volumeInput'],
    ['camera', 'Camera in use', 'Privacy icon shown while an app uses the camera', '_camera'],
    ['remote-access', 'Screen sharing / recording', 'Privacy icon shown while the screen is shared', '_remoteAccess'],
    ['location', 'Location in use', 'Privacy icon shown while an app reads your location', '_location'],
    ['battery', 'Battery', 'Battery or power icon (and its percentage)', '_system'],
    ['battery-percentage', 'Battery percentage', 'Only the number next to the battery icon', null],
    ['brightness', 'Brightness', '', '_brightness'],
    ['night-light', 'Night Light', '', '_nightLight'],
    ['dark-mode', 'Dark Style', '', '_darkMode'],
    ['do-not-disturb', 'Do Not Disturb', '', '_doNotDisturb'],
    ['power-profile', 'Power mode', '', '_powerProfiles'],
    ['airplane', 'Airplane mode', '', '_rfkill'],
    ['thunderbolt', 'Thunderbolt', '', '_thunderbolt'],
    ['auto-rotate', 'Auto rotate', '', '_autoRotate'],
    ['background-apps', 'Background apps', '', '_backgroundApps'],
];
