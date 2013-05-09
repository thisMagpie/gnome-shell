// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const NetworkManager = imports.gi.NetworkManager;
const NMClient = imports.gi.NMClient;
const NMGtk = imports.gi.NMGtk;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const ModemManager = imports.misc.modemManager;
const Util = imports.misc.util;

const NMConnectionCategory = {
    INVALID: 'invalid',
    WIRED: 'wired',
    VIRTUAL: 'virtual',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn'
};

const NMAccessPointSecurity = {
    NONE: 1,
    WEP: 2,
    WPA_PSK: 3,
    WPA2_PSK: 4,
    WPA_ENT: 5,
    WPA2_ENT: 6
};

// small optimization, to avoid using [] all the time
const NM80211Mode = NetworkManager['80211Mode'];
const NM80211ApFlags = NetworkManager['80211ApFlags'];
const NM80211ApSecurityFlags = NetworkManager['80211ApSecurityFlags'];

function ssidCompare(one, two) {
    if (!one || !two)
        return false;
    if (one.length != two.length)
        return false;
    for (let i = 0; i < one.length; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

function signalToIcon(value) {
    if (value > 80)
        return 'excellent';
    if (value > 55)
        return 'good';
    if (value > 30)
        return 'ok';
    if (value > 5)
        return 'weak';
    return 'none';
}

function ssidToLabel(ssid) {
    let label = NetworkManager.utils_ssid_to_utf8(ssid);
    if (!label)
        label = _("<unknown>");
    return label;
}

const NMDevice = new Lang.Class({
    Name: 'NMDevice',
    Abstract: true,

    _init: function(client, device, connections) {
        this._client = client;
        this._setDevice(device);
        this._connections = [];
        connections.forEach(Lang.bind(this, this.checkConnection));

        this._activeConnection = null;
        this._activeConnectionItem = null;

        this.statusItem = new PopupMenu.PopupSwitchMenuItem('', this.connected, { style_class: 'popup-subtitle-menu-item' });
        this._statusChanged = this.statusItem.connect('toggled', Lang.bind(this, function(item, state) {
            let ok;
            if (state)
                ok = this.activate();
            else
                ok = this.deactivate();

            if (!ok)
                item.setToggleState(!state);
        }));

        this._updateStatusItem();
        this.section = new PopupMenu.PopupMenuSection();

        this._deferredWorkId = Main.initializeDeferredWork(this.section.actor, Lang.bind(this, this._createSection));
    },

    checkConnection: function(connection) {
        let pos = this._findConnection(connection.get_uuid());
        let exists = pos != -1;
        let valid = this.connectionValid(connection);
        let similar = false;
        if (exists) {
            let existing = this._connections[pos];

            // Check if connection changed name or id
            similar = existing.name == connection.get_id() &&
                existing.timestamp == connection._timestamp;
        }

        if (exists && valid && similar) {
            // Nothing to do
            return;
        }

        if (exists)
            this.removeConnection(connection);
        if (valid)
            this.addConnection(connection);
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection.get_id(),
            uuid: connection.get_uuid(),
            timestamp: connection._timestamp,
            item: null,
        };
        Util.insertSorted(this._connections, obj, this._connectionSortFunction);

        this._queueCreateSection();
    },

    removeConnection: function(connection) {
        let pos = this._findConnection(connection.get_uuid());
        if (pos == -1) {
            // this connection was never added, nothing to do here
            return;
        }

        let obj = this._connections[pos];
        if (obj.item)
            obj.item.destroy();
        this._connections.splice(pos, 1);

        if (this._connections.length <= 1) {
            // We need to show the automatic connection again
            // (or in the case of NMDeviceWired, we want to hide
            // the only explicit connection)
            this._queueCreateSection();
        }
    },

    _findConnection: function(uuid) {
        for (let i = 0; i < this._connections.length; i++) {
            let obj = this._connections[i];
            if (obj.uuid == uuid)
                return i;
        }
        return -1;
    },

    _connectionSortFunction: function(one, two) {
        if (one.timestamp == two.timestamp)
            return GLib.utf8_collate(one.name, two.name);

        return two.timestamp - one.timestamp;
    },

    destroy: function() {
        this._setDevice(null);

        if (this._deferredWorkId) {
            // Just clear out, the actual removal is handled when the
            // actor is destroyed
            this._deferredWorkId = 0;
        }

        this._clearSection();
        if (this.statusItem)
            this.statusItem.destroy();
        this.section.destroy();
    },

    _setDevice: function(device) {
        if (device) {
            this.device = device;
            this.device._delegate = this;
            this._stateChangedId = this.device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
            this._activeConnectionChangedId = this.device.connect('notify::active-connection', Lang.bind(this, this._activeConnectionChanged));
        } else if (this.device) {
            this.device._delegate = null;

            if (this._stateChangedId) {
                // Need to go through GObject.Object.prototype because
                // nm_device_disconnect conflicts with g_signal_disconnect
                GObject.Object.prototype.disconnect.call(this.device, this._stateChangedId);
                this._stateChangedId = 0;
            }
            if (this._carrierChangedId) {
                GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
                this._carrierChangedId = 0;
            }
            if (this._firmwareChangedId) {
                GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
                this._firmwareChangedId = 0;
            }

            this.device = null;
        }
    },

    deactivate: function() {
        this.device.disconnect(null);
        return true;
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return true;

        // If there is only one connection available, use that
        // Otherwise, if no connection is currently configured,
        // try automatic configuration (or summon the config dialog)
        if (this._connections.length == 1) {
            this._client.activate_connection(this._connections[0].connection, this.device || null, null, null);
            return true;
        } else if (this._connections.length == 0) {
            return this._activateAutomaticConnection();
        }

        return false;
    },

    _activateAutomaticConnection: function() {
        let connection = new NetworkManager.Connection();
        this._client.add_and_activate_connection(connection, this.device, null, null);
        return true;
    },

    get connected() {
        return this.device && this.device.state == NetworkManager.DeviceState.ACTIVATED;
    },

    _activeConnectionChanged: function() {
        let activeConnection = this.device.active_connection;

        if (activeConnection == this._activeConnection)
            // nothing to do
            return;

        // remove any UI
        if (this._activeConnectionItem) {
            this._activeConnectionItem.destroy();
            this._activeConnectionItem = null;
        }

        this._activeConnection = activeConnection;

        this._queueCreateSection();
    },

    connectionValid: function(connection) {
        return this.device.connection_valid(connection);
    },

    getStatusLabel: function() {
        if (!this.device)
            return null;

        switch(this.device.state) {
        case NetworkManager.DeviceState.DISCONNECTED:
        case NetworkManager.DeviceState.ACTIVATED:
            return null;
        case NetworkManager.DeviceState.UNMANAGED:
            /* Translators: this is for network devices that are physically present but are not
               under NetworkManager's control (and thus cannot be used in the menu) */
            return _("unmanaged");
        case NetworkManager.DeviceState.DEACTIVATING:
            return _("disconnecting...");
        case NetworkManager.DeviceState.PREPARE:
        case NetworkManager.DeviceState.CONFIG:
        case NetworkManager.DeviceState.IP_CONFIG:
        case NetworkManager.DeviceState.IP_CHECK:
        case NetworkManager.DeviceState.SECONDARIES:
            return _("connecting...");
        case NetworkManager.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing, carrier not available), that are exposed by different properties
            // (whose state may or may not updated when we receive state-changed).
            if (!this._firmwareMissingId)
                this._firmwareMissingId = this.device.connect('notify::firmware-missing', Lang.bind(this, this._substateChanged));
            if (this.device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing */
                return _("firmware missing");
            }
            if (this.device.capabilities & NetworkManager.DeviceCapabilities.CARRIER_DETECT) {
                if (!this._carrierChangedId)
                    this._carrierChangedId = this.device.connect('notify::carrier', Lang.bind(this, this._substateChanged));
                if (!this.carrier) {
                    /* Translators: this is for wired network devices that are physically disconnected */
                    return _("cable unplugged");
                }
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage */
            return _("unavailable");
        case NetworkManager.DeviceState.FAILED:
            return _("connection failed");
        default:
            log('Device state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    syncDescription: function() {
        if (this.device && this.device._description)
            this.statusItem.label.text = this.device._description;
    },

    _queueCreateSection: function() {
        if (this._deferredWorkId) {
            this._clearSection();
            Main.queueDeferredWork(this._deferredWorkId);
        }
    },

    _clearSection: function() {
        // Clear everything
        this.section.removeAll();
        this._activeConnectionItem = null;
        for (let i = 0; i < this._connections.length; i++) {
            this._connections[i].item = null;
        }
    },

    _shouldShowConnectionList: function() {
        return (this.device.state >= NetworkManager.DeviceState.DISCONNECTED);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }
        if (this._connections.length > 0) {
            let activeOffset = this._activeConnectionItem ? 1 : 0;

            for(let j = 0; j < this._connections.length; ++j) {
                let obj = this._connections[j];
                if (this._activeConnection &&
                    obj.connection == this._activeConnection._connection)
                    continue;
                obj.item = this._createConnectionItem(obj);

                this.section.addMenuItem(obj.item);
            }
        }
    },

    _createConnectionItem: function(obj) {
        let connection = obj.connection;
        let item = new PopupMenu.PopupMenuItem(obj.name);

        item.connect('activate', Lang.bind(this, function() {
            this._client.activate_connection(connection, this.device, null, null);
        }));
        return item;
    },

    _createActiveConnectionItem: function() {
        let title;
        let active = this._activeConnection._connection;
        if (active) {
            title = active.get_id();
        } else {
            /* TRANSLATORS: this is the indication that a connection for another logged in user is active,
               and we cannot access its settings (including the name) */
            title = _("Connected (private)");
        }
        this._activeConnectionItem = new PopupMenu.PopupMenuItem(title, { reactive: false });
        this._activeConnectionItem.setOrnament(PopupMenu.Ornament.DOT);
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        if (oldstate == NetworkManager.DeviceState.ACTIVATED) {
            this.emit('network-lost');
        }

        this._updateStatusItem();

        this._queueCreateSection();
        this.emit('state-changed');
    },

    _updateStatusItem: function() {
        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }

        this.statusItem.setStatus(this.getStatusLabel());
        this.statusItem.setToggleState(this.connected);
    },

    _substateChanged: function() {
        this.statusItem.setStatus(this.getStatusLabel());

        this.emit('state-changed');
    }
});
Signals.addSignalMethods(NMDevice.prototype);

const NMDeviceSimple = new Lang.Class({
    Name: 'NMDeviceSimple',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        this.category = NMConnectionCategory.WIRED;

        this.parent(client, device, connections);
    },

    _createSection: function() {
        this.parent();

        // if we have only one connection (normal or automatic)
        // we hide the connection list, and use the switch to control
        // the device
        // we can do it here because addConnection and removeConnection
        // both call _createSection at some point
        this.section.actor.visible = this._connections.length > 1;
    }
});

const NMDeviceWired = new Lang.Class({
    Name: 'NMDeviceWired',
    Extends: NMDeviceSimple,

    _init: function(client, device, connections) {
        device._description = _("Wired");
        this.category = NMConnectionCategory.WIRED;

        this.parent(client, device, connections);
    },

    getIndicatorIcon: function(mc) {
        if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING)
            return 'network-wired-acquiring-symbolic';
        else
            return 'network-wired-symbolic';
    },
});

const NMDeviceModem = new Lang.Class({
    Name: 'NMDeviceModem',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        let is_wwan = false;

        device._description = _("Mobile broadband");
        this.mobileDevice = null;
        this._connectionType = 'ppp';

        this._capabilities = device.current_capabilities;
        // Support new ModemManager1 devices
        if (device.udi.indexOf('/org/freedesktop/ModemManager1/Modem') == 0) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.BroadbandModem(device.udi, device.current_capabilities);
            if (this._capabilities & NetworkManager.DeviceModemCapabilities.GSM_UMTS) {
                this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
            } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.LTE) {
                this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
            } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.CDMA_EVDO) {
                this._connectionType = NetworkManager.SETTING_CDMA_SETTING_NAME;
            }
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.GSM_UMTS) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemGsm(device.udi);
            this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.CDMA_EVDO) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemCdma(device.udi);
            this._connectionType = NetworkManager.SETTING_CDMA_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.LTE) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemGsm(device.udi);
            this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
        }

        if (is_wwan)
            this.category = NMConnectionCategory.WWAN;
        else
            this.category = NMConnectionCategory.WIRED;

        if (this.mobileDevice) {
            this._operatorNameId = this.mobileDevice.connect('notify::operator-name', Lang.bind(this, function() {
                if (this._operatorItem) {
                    let name = this.mobileDevice.operator_name;
                    if (name) {
                        this._operatorItem.label.text = name;
                        this._operatorItem.actor.show();
                    } else
                        this._operatorItem.actor.hide();
                }
            }));
            this._signalQualityId = this.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                this.emit('icon-changed');
            }));
        }

        this.parent(client, device, connections);
    },

    destroy: function() {
        if (this._operatorNameId) {
            this.mobileDevice.disconnect(this._operatorNameId);
            this._operatorNameId = 0;
        }
        if (this._signalQualityId) {
            this.mobileDevice.disconnect(this._signalQualityId);
            this._signalQualityId = 0;
        }

        this.parent();
    },

    _getSignalIcon: function() {
        return 'network-cellular-signal-' + signalToIcon(this.mobileDevice.signal_quality) + '-symbolic';
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this.mobileDevice) {
            // If operator_name is null, just pass the empty string, as the item is hidden anyway
            this._operatorItem = new PopupMenu.PopupMenuItem(this.mobileDevice.operator_name || '',
                                                             { style_class: 'popup-status-menu-item' });
            if (!this.mobileDevice.operator_name)
                this._operatorItem.actor.hide();
            this.section.addMenuItem(this._operatorItem);
        }

        this.parent();
    },

    _clearSection: function() {
        this._operatorItem = null;

        this.parent();
    },

    _activateAutomaticConnection: function() {
        // Mobile wizard is too complex for the shell UI and
        // is handled by the network panel
        Util.spawn(['gnome-control-center', 'network',
                    'connect-3g', this.device.get_path()]);
        return true;
    },

    getIndicatorIcon: function(mc) {
        if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING)
            return 'network-cellular-acquiring-symbolic';

        if (!this.mobileDevice) {
            // this can happen for bluetooth in PAN mode
            return 'network-cellular-connected-symbolic';
        }

        return this._getSignalIcon();
    }
});

const NMDeviceBluetooth = new Lang.Class({
    Name: 'NMDeviceBluetooth',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        device._description = _("Bluetooth");

        this.category = NMConnectionCategory.WWAN;

        this.parent(client, device, connections);
    },

    _activateAutomaticConnection: function() {
        // FIXME: DUN devices are configured like modems, so
        // We need to spawn the mobile wizard
        // but the network panel doesn't support bluetooth at the moment
        // so we just create an empty connection and hope
        // that this phone supports PAN

        return this.parent();
    },

    getIndicatorIcon: function(mc) {
        if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING)
            return 'network-wired-acquiring-symbolic';
        else
            return 'network-wired-symbolic';
    },
});

const NMWirelessDialogItem = new Lang.Class({
    Name: 'NMWirelessDialogItem',

    _init: function(network) {
        this._network = network;
        this._ap = network.accessPoints[0];

        this.actor = new St.Button({ style_class: 'nm-dialog-item',
                                     can_focus: true,
                                     x_fill: true });
        this.actor.connect('key-focus-in', Lang.bind(this, function() {
            this.emit('selected');
        }));
        this.actor.connect('clicked', Lang.bind(this, function() {
            this.actor.grab_key_focus();
            this.emit('selected');
        }));

        this._content = new St.BoxLayout({ style_class: 'nm-dialog-item-box' });
        this.actor.set_child(this._content);

        let title = ssidToLabel(this._ap.get_ssid());
        this._label = new St.Label({ text: title });

        this.actor.label_actor = this._label;
        this._content.add(this._label, { x_align: St.Align.START });

        this._icons = new St.BoxLayout({ style_class: 'nm-dialog-icons' });
        this._content.add(this._icons, { expand: true, x_fill: false, x_align: St.Align.END });

        this._secureIcon = new St.Icon({ style_class: 'nm-dialog-icon' });
        if (this._ap._secType != NMAccessPointSecurity.NONE)
            this._secureIcon.icon_name = 'network-wireless-encrypted-symbolic';
        this._icons.add_actor(this._secureIcon);

        this._signalIcon = new St.Icon({ icon_name: this._getIcon(),
                                         style_class: 'nm-dialog-icon' });
        this._icons.add_actor(this._signalIcon);
    },

    updateBestAP: function(ap) {
        this._ap = ap;
        this._signalIcon.icon_name = this._getIcon();
    },

    _getIcon: function() {
        if (this._ap.mode == NM80211Mode.ADHOC)
            return 'network-workgroup-symbolic';
        else
            return 'network-wireless-signal-' + signalToIcon(this._ap.strength) + '-symbolic';
    }
});
Signals.addSignalMethods(NMWirelessDialogItem.prototype);

const NMWirelessDialog = new Lang.Class({
    Name: 'NMWirelessDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function(client, device, settings) {
        this.parent({ styleClass: 'nm-dialog' });

        this._client = client;
        this._device = device;

        this._networks = [];
        this._buildLayout();

        let connections = settings.list_connections();
        this._connections = connections.filter(Lang.bind(this, function(connection) {
            return device.connection_valid(connection);
        }));

        this._apAddedId = device.connect('access-point-added', Lang.bind(this, this._accessPointAdded));
        this._apRemovedId = device.connect('access-point-removed', Lang.bind(this, this._accessPointRemoved));

        // accessPointAdded will also create dialog items
        let accessPoints = device.get_access_points() || [ ];
        accessPoints.forEach(Lang.bind(this, function(ap) {
            this._accessPointAdded(this.device, ap);
        }));

        this._selectedNetwork = null;
        this._updateSensitivity();
    },

    destroy: function() {
        if (this._apAddedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._apAddedId);
            this._apAddedId = 0;
        }

        if (this._apRemovedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._apRemovedId);
            this._apRemovedId = 0;
        }

        this.parent();
    },

    _updateSensitivity: function() {
        let connectSensitive = this._selectedNetwork != null;
        this._connectButton.reactive = connectSensitive;
        this._connectButton.can_focus = connectSensitive;
    },

    _buildLayout: function() {
        let headline = new St.BoxLayout({ style_class: 'nm-dialog-header-hbox' });

        let icon = new St.Icon({ style_class: 'nm-dialog-header-icon',
                                 icon_name: 'network-wireless-signal-excellent-symbolic' });

        let titleBox = new St.BoxLayout({ vertical: true });
        let title = new St.Label({ style_class: 'nm-dialog-header',
                                   text: _("Wi-Fi Networks") });
        let subtitle = new St.Label({ style_class: 'nm-dialog-subheader',
                                      text: _("Select a network") });
        titleBox.add(title);
        titleBox.add(subtitle);

        headline.add(icon);
        headline.add(titleBox);

        this.contentLayout.style_class = 'nm-dialog-content';
        this.contentLayout.add(headline);

        this._itemBox = new St.BoxLayout({ vertical: true });
        this._scrollView = new St.ScrollView({ style_class: 'nm-dialog-scroll-view' });
        this._scrollView.set_policy(Gtk.PolicyType.NEVER,
                                    Gtk.PolicyType.AUTOMATIC);
        this._scrollView.add_actor(this._itemBox);
        this.contentLayout.add(this._scrollView);

        this._disconnectButton = this.addButton({ action: Lang.bind(this, this.close),
                                                  label: _("Cancel"),
                                                  key: Clutter.Escape });
        this._connectButton = this.addButton({ action: Lang.bind(this, this._connect),
                                               label: _("Connect"),
                                               key: Clutter.Return },
                                             { expand: true,
                                               x_fill: false,
                                               x_align: St.Align.END });
    },

    _connect: function() {
        let network = this._selectedNetwork;
        let accessPoints = network.accessPoints;
        if (network.connections.length > 0) {
            let connection = network.connections[0];
            for (let i = 0; i < accessPoints.length; i++) {
                if (accessPoints[i].connection_valid(connection)) {
                    this._client.activate_connection(connection, this._device, accessPoints[i].dbus_path, null);
                    break;
                }
            }
        } else {
            if ((accessPoints[0]._secType == NMAccessPointSecurity.WPA2_ENT)
                || (accessPoints[0]._secType == NMAccessPointSecurity.WPA_ENT)) {
                // 802.1x-enabled APs require further configuration, so they're
                // handled in gnome-control-center
                Util.spawn(['gnome-control-center', 'network', 'connect-8021x-wifi',
                            this._device.get_path(), accessPoints[0].dbus_path]);
            } else {
                let connection = new NetworkManager.Connection();
                this._client.add_and_activate_connection(connection, this._device, accessPoints[0].dbus_path, null)
            }
        }

        this.close();
    },

    _notifySsidCb: function(accessPoint) {
        if (accessPoint.get_ssid() != null) {
            accessPoint.disconnect(accessPoint._notifySsidId);
            accessPoint._notifySsidId = 0;
            this._accessPointAdded(this._device, accessPoint);
        }
    },

    _getApSecurityType: function(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;

        let flags = accessPoint.flags;
        let wpa_flags = accessPoint.wpa_flags;
        let rsn_flags = accessPoint.rsn_flags;
        let type;
        if (rsn_flags != NM80211ApSecurityFlags.NONE) {
            /* RSN check first so that WPA+WPA2 APs are treated as RSN/WPA2 */
            if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
	        type = NMAccessPointSecurity.WPA2_ENT;
	    else if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA2_PSK;
        } else if (wpa_flags != NM80211ApSecurityFlags.NONE) {
            if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA_ENT;
            else if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA_PSK;
        } else {
            if (flags & NM80211ApFlags.PRIVACY)
                type = NMAccessPointSecurity.WEP;
            else
                type = NMAccessPointSecurity.NONE;
        }

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    },

    _networkSortFunction: function(one, two) {
        let oneHasConnection = one.connections.length != 0;
        let twoHasConnection = two.connections.length != 0;

        // place known connections first
        // (-1 = good order, 1 = wrong order)
        if (oneHasConnection && !twoHasConnection)
            return -1;
        else if (!oneHasConnection && twoHasConnection)
            return 1;

        let oneStrength = one.accessPoints[0].strength;
        let twoStrength = two.accessPoints[0].strength;

        // place stronger connections first
        if (oneStrength != twoStrength)
            return oneStrength < twoStrength ? 1 : -1;

        let oneHasSecurity = one.security != NMAccessPointSecurity.NONE;
        let twoHasSecurity = two.security != NMAccessPointSecurity.NONE;

        // place secure connections first
        // (we treat WEP/WPA/WPA2 the same as there is no way to
        // take them apart from the UI)
        if (oneHasSecurity && !twoHasSecurity)
            return -1;
        else if (!oneHasSecurity && twoHasSecurity)
            return 1;

        // sort alphabetically
        return GLib.utf8_collate(one.ssidText, two.ssidText);
    },

    _networkCompare: function(network, accessPoint) {
        if (!ssidCompare(network.ssid, accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    },

    _findExistingNetwork: function(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            let network = this._networks[i];
            for (let j = 0; j < network.accessPoints.length; j++) {
                if (network.accessPoints[j] == accessPoint)
                    return { network: i, ap: j };
            }
        }

        return null;
    },

    _findNetwork: function(accessPoint) {
        if (accessPoint.get_ssid() == null)
            return -1;

        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    },

    _accessPointAdded: function(device, accessPoint) {
        if (accessPoint.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            accessPoint._notifySsidId = accessPoint.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
            return;
        }

        let pos = this._findNetwork(accessPoint);
        let network;

        if (pos != -1) {
            network = this._networks[pos];
            if (network.accessPoints.indexOf(accessPoint) != -1) {
                log('Access point was already seen, not adding again');
                return;
            }

            Util.insertSorted(network.accessPoints, accessPoint, function(one, two) {
                return two.strength - one.strength;
            });
            network.item.updateBestAP(network.accessPoints[0]);
        } else {
            network = { ssid: accessPoint.get_ssid(),
                        mode: accessPoint.mode,
                        security: this._getApSecurityType(accessPoint),
                        connections: [ ],
                        item: null,
                        accessPoints: [ accessPoint ]
                      };
            network.ssidText = ssidToLabel(network.ssid);
        }

        // check if this enables new connections for this group
        this._connections.forEach(function(connection) {
            if (accessPoint.connection_valid(connection) &&
                network.connections.indexOf(connection) == -1) {
                network.connections.push(connection);
            }
        });

        if (pos != -1)
            this._networks.splice(pos, 1);

        let newPos = Util.insertSorted(this._networks, network, this._networkSortFunction);
        this._createNetworkItem(network);
        this._itemBox.insert_child_at_index(network.item.actor, newPos);
    },

    _removeNetwork: function() {
        network.item.destroy();
        this._networks.splice(res.network, 1);
    },

    _accessPointRemoved: function(device, accessPoint) {
        let res = this._findExistingNetwork(accessPoint);

        if (res == null) {
            log('Removing an access point that was never added');
            return;
        }

        let network = this._networks[res.network];
        network.accessPoints.splice(res.ap, 1);

        if (network.accessPoints.length == 0) {
        } else {
            network.item.updateBestAP(network.accessPoints[0]);
            this._resortItems();
        }
    },

    removeConnection: function(connection) {
        let pos = this._connections.indexOf(connection);
        if (pos == -1) {
            // removing connection that was never added
            return;
        }

        this._connections.splice(pos, 1);

        for (let i = 0; i < this._networks.length; i++) {
            let network = this._networks[i];
            let connections = network.connections;
            for (let k = 0; k < connections.length; k++) {
                if (connections[k].get_uuid() == connection.get_uuid()) {
                    // remove the connection from the access point group
                    connections.splice(k, 1);
                    if (connections.length === 0)
                        this._removeNetwork(network);
                    this._resortItems();
                    return;
                }
            }
        }
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection.get_id(),
            uuid: connection.get_uuid(),
        };
        this._connections.push(obj);

        // find an appropriate access point
        for (let i = 0; i < this._networks.length; i++) {
            let network = this._networks[i];

            // Check if connection is valid for any of these access points
            for (let k = 0; k < network.accessPoints.length; k++) {
                let ap = network.accessPoints[k];
                if (ap.connection_valid(connection)) {
                    network.connections.push(connection);
                    this._resortItems();
                    return;
                }
            }
        }
    },

    _resortItems: function() {
        let adjustment = this._scrollView.vscroll.adjustment;
        let scrollValue = adjustment.value;

        this._itemBox.remove_all_children();
        this._networks.forEach(Lang.bind(this, function(network) {
            this._itemBox.add_child(network.item.actor);
        }));

        adjustment.value = scrollValue;
    },

    _selectNetwork: function(network) {
        if (this._selectedNetwork)
            this._selectedNetwork.item.actor.checked = false;

        this._selectedNetwork = network;
        this._updateSensitivity();

        if (this._selectedNetwork)
            this._selectedNetwork.item.actor.checked = true;
    },

    _createNetworkItem: function(network) {
        network.item = new NMWirelessDialogItem(network);
        network.item.connect('selected', Lang.bind(this, function() {
            Util.ensureActorVisibleInScrollView(this._scrollView, network.item.actor);
            this._selectNetwork(network);
        }));
    },
});

const NMDeviceWireless = new Lang.Class({
    Name: 'NMDeviceWireless',
    category: NMConnectionCategory.WIRELESS,

    _init: function(client, device, connections, settings) {
        this._client = client;
        this.device = device;
        this.device._delegate = this;
        this._settings = settings;

        this._dialog = null;
        this._item = new PopupMenu.PopupBaseMenuItem({ reactive: true });
        this._item.connect('activate', Lang.bind(this, this._showDialog));
        this._nameLabel = new St.Label({ style_class: 'popup-subtitle-menu-item' });
        this._item.addActor(this._nameLabel);

        this._statusLabel = new St.Label({ style_class: 'popup-status-menu-item' });
        this._item.addActor(this._statusLabel, { align: St.Align.END });

        this.section = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._item);

        this.syncDescription();

        this._activeAccessPoint = null;
        this.device.connect('notify::active-access-point', Lang.bind(this, this._updateAccessPoint));
        // Also calls _syncStatusLabel
        this._updateAccessPoint();
    },

    checkConnection: function() {
    },

    removeConnection: function() {
    },

    syncDescription: function() {
        this._nameLabel.text = this.device._description || _("Wi-Fi");
    },

    _getStatus: function() {
        if (!this._activeAccessPoint)
            return _("off"); // XXX -- interpret actual status

        return ssidToLabel(this._activeAccessPoint.get_ssid());
    },

    _syncStatusLabel: function() {
        this._statusLabel.text = this._getStatus();
    },

    _showDialog: function() {
        this._dialog = new NMWirelessDialog(this._client, this.device, this._settings);
        this._dialog.connect('closed', Lang.bind(this, this._dialogClosed));
        this._dialog.open();
    },

    _dialogClosed: function() {
        this._dialog.destroy();
        this._dialog = null;
    },

    _updateAccessPoint: function() {
        let ap = this.device.active_access_point;
        if (this._activeAccessPoint == ap)
            return;

        if (this._activeAccessPoint) {
            this._activeAccessPoint.disconnect(this._strengthChangedId);
            this._strengthChangedId = 0;
        }

        this._activeAccessPoint = ap;

        if (this._activeAccessPoint) {
            this._strengthChangedId = this._activeAccessPoint.connect('notify::strength',
                                                                      Lang.bind(this, this._strengthChanged));
        }

        this._syncStatusLabel();
    },

    _strengthChanged: function() {
        this.emit('icon-changed');
    },

    getIndicatorIcon: function(mc) {
        if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING)
            return 'network-wireless-acquiring-symbolic';

        let ap = this.device.active_access_point;
        if (!ap) {
            if (this.device.mode != NM80211Mode.ADHOC)
                log('An active wireless connection, in infrastructure mode, involves no access point?');

            return 'network-wireless-connected-symbolic';
        }

        return 'network-wireless-signal-' + signalToIcon(ap.strength) + '-symbolic';
    },
});
Signals.addSignalMethods(NMDeviceWireless.prototype);

const NMDeviceVirtual = new Lang.Class({
    Name: 'NMDeviceVirtual',
    Extends: NMDeviceSimple,

    _init: function(client, iface, connections) {
        this.iface = iface;
        this.parent(client, null, connections);
        this.category = NMConnectionCategory.VIRTUAL;
    },

    _shouldShowConnectionList: function() {
        return this.hasConnections();
    },

    connectionValid: function(connection) {
        return connection.get_virtual_iface_name() == this.iface;
    },

    addConnection: function(connection) {
        if (!this.device && !this.hasConnections())
            this.statusItem.label.text = NMGtk.utils_get_connection_device_name(connection);

        this.parent(connection);
    },

    adoptDevice: function(device) {
        if (device.get_iface() == this.iface) {
            this._setDevice(device);
            if (device._description)
                this.syncDescription();
            this._updateStatusItem();
            this.emit('state-changed');
            return true;
        } else
            return false;
    },

    removeDevice: function(device) {
        if (device == this.device) {
            this._setDevice(null);
            this._updateStatusItem();
            this.emit('state-changed');
        }
    },

    hasConnections: function() {
        return this._connections.length != 0;
    },

    getIndicatorIcon: function(mc) {
        if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING)
            return 'network-wired-acquiring-symbolic';
        else
            return 'network-wired-connected-symbolic';
    },
});

const NMVPNSection = new Lang.Class({
    Name: 'NMVPNSection',
    category: NMConnectionCategory.VPN,

    _init: function(client) {
        this._client = client;
        this._connections = [];

        this.section = new PopupMenu.PopupMenuSection();
    },

    checkConnection: function(connection) {
        let exists = this._connections.indexOf(connection) >= 0;
        if (exists)
            return;

        this._createConnectionItem(connection);
        this.section.addMenuItem(connection.item);
        this._connections.push(connection);
    },

    removeConnection: function(connection) {
        connection.item.destroy();
        let pos = this._connections.indexOf(connection);
        this._connections.splice(pos, 1);
    },

    _getStatusLabel: function(activeConnection) {
        switch(activeConnection.vpn_state) {
        case NetworkManager.VPNConnectionState.DISCONNECTED:
        case NetworkManager.VPNConnectionState.ACTIVATED:
            return null;
        case NetworkManager.VPNConnectionState.PREPARE:
        case NetworkManager.VPNConnectionState.CONNECT:
        case NetworkManager.VPNConnectionState.IP_CONFIG_GET:
            return _("connecting...");
        case NetworkManager.VPNConnectionState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.VPNConnectionState.FAILED:
            return _("connection failed");
        default:
            log('VPN connection state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    _syncConnectionItem: function(activeConnection, connection) {
        let item = connection.item;
        if (activeConnection == null) {
            item.setToggleState(false);
            item.setStatus(null);
        } else {
            item.setToggleState(activeConnection.vpn_state == NetworkManager.VPNConnectionState.ACTIVATED);
            item.setStatus(this._getStatusLabel(activeConnection));
        }
    },

    _connectionStateChanged: function(activeConnection) {
        this._syncConnectionItem(activeConnection, activeConnection._connection);
    },

    removeActiveConnection: function(activeConnection) {
        activeConnection._connection._activeConnection = null;
        activeConnection.disconnect(activeConnection._stateChangedId);
        this._syncConnectionItem(null, activeConnection._connection);
    },

    addActiveConnection: function(activeConnection) {
        activeConnection._connection._activeConnection = activeConnection;
        activeConnection._stateChangedId = activeConnection.connect('vpn-state-changed',
                                                                    Lang.bind(this, this._connectionStateChanged));
        this._syncConnectionItem(activeConnection, activeConnection._connection);
    },

    _createConnectionItem: function(connection) {
        connection.item = new PopupMenu.PopupSwitchMenuItem(connection.get_id(), false,
                                                            { style_class: 'popup-subtitle-menu-item' });
        connection.item.connect('toggled', Lang.bind(this, function(menuItem) {
            if (menuItem.state) {
                this._client.activate_connection(connection, null, null);

                // Immediately go back to disconnected, until NM tells us to change
                menuItem.setToggleState(false);
            } else {
                this._client.deactivate_connection(connection._activeConnection);
            }
        }));
    },
});

const NMApplet = new Lang.Class({
    Name: 'NMApplet',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent('network-offline-symbolic');

        this.secondaryIcon = this.addIcon(new Gio.ThemedIcon({ name: 'network-vpn-symbolic' }));
        this.secondaryIcon.hide();

        // Device types
        this._dtypes = { };
        this._dtypes[NetworkManager.DeviceType.ETHERNET] = NMDeviceWired;
        this._dtypes[NetworkManager.DeviceType.WIFI] = NMDeviceWireless;
        this._dtypes[NetworkManager.DeviceType.MODEM] = NMDeviceModem;
        this._dtypes[NetworkManager.DeviceType.BT] = NMDeviceBluetooth;
        this._dtypes[NetworkManager.DeviceType.INFINIBAND] = NMDeviceSimple;
        // TODO: WiMax support

        // Virtual device types
        this._vtypes = { };
        this._vtypes[NetworkManager.SETTING_VLAN_SETTING_NAME] = NMDeviceVirtual;
        this._vtypes[NetworkManager.SETTING_BOND_SETTING_NAME] = NMDeviceVirtual;
        this._vtypes[NetworkManager.SETTING_BRIDGE_SETTING_NAME] = NMDeviceVirtual;

        // Connection types
        this._ctypes = { };
        this._ctypes[NetworkManager.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
        this._ctypes[NetworkManager.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPPOE_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPP_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_INFINIBAND_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_VLAN_SETTING_NAME] = NMConnectionCategory.VIRTUAL;
        this._ctypes[NetworkManager.SETTING_BOND_SETTING_NAME] = NMConnectionCategory.VIRTUAL;
        this._ctypes[NetworkManager.SETTING_BRIDGE_SETTING_NAME] = NMConnectionCategory.VIRTUAL;
        this._ctypes[NetworkManager.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;

        NMClient.Client.new_async(null, Lang.bind(this, this._clientGot));
        NMClient.RemoteSettings.new_async(null, null, Lang.bind(this, this._remoteSettingsGot));
    },

    _clientGot: function(obj, result) {
        this._client = NMClient.Client.new_finish(result);

        this._tryLateInit();
    },

    _remoteSettingsGot: function(obj, result) {
        this._settings = NMClient.RemoteSettings.new_finish(result);

        this._tryLateInit();
    },

    _tryLateInit: function() {
        if (!this._client || !this._settings)
            return;

        this._statusSection = new PopupMenu.PopupMenuSection();
        this._statusItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._statusSection.addMenuItem(this._statusItem);
        this._statusSection.addAction(_("Enable networking"), Lang.bind(this, function() {
            this._client.networking_enabled = true;
        }));
        this._statusSection.actor.hide();
        this.menu.addMenuItem(this._statusSection);

        this._activeConnections = [ ];
        this._connections = [ ];

        this._mainConnection = null;
        this._mainConnectionIconChangedId = 0;
        this._vpnConnection = null;

        this._nmDevices = [];
        this._devices = { };
        this._virtualDevices = [ ];

        this._devices.wired = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
        };
        this._devices.wired.section.actor.hide();
        this.menu.addMenuItem(this._devices.wired.section);

        this._devices.virtual = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
        };
        this._devices.virtual.section.actor.hide();
        this.menu.addMenuItem(this._devices.virtual.section);

        this._devices.wireless = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
        };
        this._devices.wireless.section.actor.hide();
        this.menu.addMenuItem(this._devices.wireless.section);

        this._devices.wwan = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
        };
        this._devices.wwan.section.actor.hide();
        this.menu.addMenuItem(this._devices.wwan.section);

        this._vpnSection = new NMVPNSection(this._client);
        this.menu.addMenuItem(this._vpnSection.section);

        this._readConnections();
        this._readDevices();
        this._syncNMState();

        this._client.connect('notify::manager-running', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::networking-enabled', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::state', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::active-connections', Lang.bind(this, this._updateIcon));
        this._client.connect('device-added', Lang.bind(this, this._deviceAdded));
        this._client.connect('device-removed', Lang.bind(this, this._deviceRemoved));
        this._settings.connect('new-connection', Lang.bind(this, this._newConnection));
    },

    _syncSectionTitle: function(category) {
        let devices = this._devices[category].devices;
        let section = this._devices[category].section;

        let visible;
        if (category == NMConnectionCategory.VIRTUAL)
            visible = !section.isEmpty();
        else
            visible = devices.length > 0;

        section.actor.visible = visible;
    },

    _readDevices: function() {
        let devices = this._client.get_devices() || [ ];
        for (let i = 0; i < devices.length; ++i) {
            this._deviceAdded(this._client, devices[i], true);
        }
        this._syncDeviceNames();
    },

    _syncDeviceNames: function() {
        let names = NMGtk.utils_disambiguate_device_names(this._nmDevices);
        for (let i = 0; i < this._nmDevices.length; i++) {
            let device = this._nmDevices[i];
            device._description = names[i];
            if (device._delegate)
                device._delegate.syncDescription();
        }
    },

    _deviceAdded: function(client, device, skipSyncDeviceNames) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }

        for (let i = 0; i < this._virtualDevices.length; i++) {
            if (this._virtualDevices[i].adoptDevice(device)) {
                this._nmDevices.push(device);
                if (!skipSyncDeviceNames)
                    this._syncDeviceNames();
                return;
            }
        }

        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = new wrapperClass(this._client, device, this._connections, this._settings);
            this._addDeviceWrapper(wrapper);

            this._nmDevices.push(device);
            if (!skipSyncDeviceNames)
                this._syncDeviceNames();
        }
    },

    _addDeviceWrapper: function(wrapper) {
        wrapper._deviceStateChangedId = wrapper.connect('state-changed', Lang.bind(this, function(dev) {
            this._syncSectionTitle(dev.category);
        }));

        let section = this._devices[wrapper.category].section;
        if (wrapper.statusItem)
            section.addMenuItem(wrapper.statusItem);
        section.addMenuItem(wrapper.section);

        let devices = this._devices[wrapper.category].devices;
        devices.push(wrapper);

        this._syncSectionTitle(wrapper.category);
    },

    _deviceRemoved: function(client, device) {
        let pos = this._nmDevices.indexOf(device);
        if (pos != -1) {
            this._nmDevices.splice(pos, 1);
            this._syncDeviceNames();
        }

        let wrapper = device._delegate;
        if (!wrapper) {
            log('Removing a network device that was not added');
            return;
        }

        if (wrapper instanceof NMDeviceVirtual)
            wrapper.removeDevice(device);
        else
            this._removeDeviceWrapper(wrapper);
    },

    _removeDeviceWrapper: function(wrapper) {
        wrapper.disconnect(wrapper._deviceStateChangedId);
        wrapper.destroy();

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);

        this._syncSectionTitle(wrapper.category)
    },

    _getSupportedActiveConnections: function() {
        let activeConnections = this._client.get_active_connections() || [ ];
        let supportedConnections = [];

        for (let i = 0; i < activeConnections.length; i++) {
            let devices = activeConnections[i].get_devices();
            if (!devices || !devices[0])
                continue;
            // Ignore connections via unrecognized device types
            if (!this._dtypes[devices[0].device_type])
                continue;

            // Ignore slave connections
            let connectionPath = activeConnections[i].connection;
            let connection = this._settings.get_connection_by_path(connectionPath)
            if (this._ignoreConnection(connection))
                continue;

            supportedConnections.push(activeConnections[i]);
        }
        return supportedConnections;
    },

    _syncActiveConnections: function() {
        let closedConnections = [ ];
        let newActiveConnections = this._getSupportedActiveConnections();
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];
            if (newActiveConnections.indexOf(a) == -1) // connection is removed
                closedConnections.push(a);
        }

        for (let i = 0; i < closedConnections.length; i++) {
            let active = closedConnections[i];
            if (active._vpnSection) {
                active._vpnSection.removeDevice(active);
                active._vpnSection = null;
            }
            if (active._inited) {
                active.disconnect(active._notifyStateId);
                active.disconnect(active._notifyDefaultId);
                active.disconnect(active._notifyDefault6Id);
                active._inited = false;
            }
        }

        if (this._mainConnectionIconChangedId > 0) {
            this._mainConnection._primaryDevice.disconnect(this._mainConnectionIconChangedId);
            this._mainConnectionIconChangedId = 0;
        }

        this._activeConnections = newActiveConnections;
        this._mainConnection = null;
        this._vpnConnection = null;

        let activating = null;
        let default_ip4 = null;
        let default_ip6 = null;
        let active_vpn = null;
        let active_any = null;
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];

            if (!a._inited) {
                a._notifyDefaultId = a.connect('notify::default', Lang.bind(this, this._updateIcon));
                a._notifyDefault6Id = a.connect('notify::default6', Lang.bind(this, this._updateIcon));
                a._notifyStateId = a.connect('notify::state', Lang.bind(this, this._notifyActivated));

                a._inited = true;
            }

            if (!a._connection) {
                a._connection = this._settings.get_connection_by_path(a.connection);

                if (a._connection) {
                    a._type = a._connection._type;
                    a._section = this._ctypes[a._type];
                } else {
                    a._connection = null;
                    a._type = null;
                    a._section = null;
                    log('Cannot find connection for active (or connection cannot be read)');
                }
            }

            if (a['default'])
                default_ip4 = a;
            if (a.default6)
                default_ip6 = a;

            if (a.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                activating = a;
            else if (a.state == NetworkManager.ActiveConnectionState.ACTIVE)
                active_any = a;

            if (a._type == 'vpn' &&
                (a.state == NetworkManager.ActiveConnectionState.ACTIVATING ||
                 a.state == NetworkManager.ActiveConnectionState.ACTIVE))
                active_vpn = a;

            if (!a._primaryDevice) {
                if (a._type != NetworkManager.SETTING_VPN_SETTING_NAME) {
                    // This list is guaranteed to have one device in it.
                    a._primaryDevice = a.get_devices()[0]._delegate;
                } else {
                    a._primaryDevice = this._vpnSection;
                    a._vpnSection = this._vpnSection;

                    this._vpnSection.addActiveConnection(a);
                }
            }
        }

        this._mainConnection = activating || default_ip4 || default_ip6 || active_any || null;
        this._vpnConnection = active_vpn;

        if (this._mainConnection) {
            let dev = this._mainConnection._primaryDevice;
            this._mainConnectionIconChangedId = dev.connect('icon-changed', Lang.bind(this, this._updateIcon));
        }
    },

    _notifyActivated: function(activeConnection) {
        this._updateIcon();
    },

    _ignoreConnection: function(connection) {
        let setting = connection.get_setting_connection();
        if (!setting)
            return true;

        // Ignore slave connections
        if (setting.get_master())
            return true;

        return false;
    },

    _addConnection: function(connection) {
        if (this._ignoreConnection(connection))
            return;
        if (connection._updatedId) {
            // connection was already seen
            return;
        }

        connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
        connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

        this._updateConnection(connection);
        this._connections.push(connection);
    },

    _readConnections: function() {
        let connections = this._settings.list_connections();
        connections.forEach(Lang.bind(this, this._addConnection));
    },

    _newConnection: function(settings, connection) {
        this._addConnection(connection);
        this._updateIcon();
    },

    _connectionRemoved: function(connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(connection, 1);

        let section = connection._section;

        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.removeConnection(connection);
        } else if (section != NMConnectionCategory.INVALID) {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++)
                devices[i].removeConnection(connection);
        }

        if (section == NMConnectionCategory.VIRTUAL) {
            let iface = connection.get_virtual_iface_name();
            let wrapper = this._findVirtualDevice(iface);
            if (wrapper && !wrapper.hasConnections())
                this._removeDeviceWrapper(wrapper);
        }

        connection.disconnect(connection._removedId);
        connection.disconnect(connection._updatedId);
        connection._removedId = connection._updatedId = 0;
    },

    _updateConnection: function(connection) {
        let connectionSettings = connection.get_setting_by_name(NetworkManager.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;
        connection._section = this._ctypes[connection._type] || NMConnectionCategory.INVALID;
        connection._timestamp = connectionSettings.timestamp;

        let section = connection._section;

        if (section == NMConnectionCategory.VIRTUAL) {
            let wrapperClass = this._vtypes[connection._type];
            if (!wrapperClass)
                return;

            let iface = connection.get_virtual_iface_name();
            let wrapper = this._findVirtualDevice(iface);
            if (!wrapper) {
                wrapper = new wrapperClass(this._client, iface, this._connections);
                this._addDeviceWrapper(wrapper);
                this._virtualDevices.push(wrapper);

                // We might already have a device for this connection
                for (let i = 0; i < this._nmDevices.length; i++) {
                    let device = this._nmDevices[i];
                    if (wrapper.adoptDevice(device))
                        break;
                }
            }
        }

        if (section == NMConnectionCategory.INVALID)
            return;
        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.checkConnection(connection);
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                devices[i].checkConnection(connection);
            }
        }
    },

    _findVirtualDevice: function(iface) {
        for (let i = 0; i < this._virtualDevices.length; i++) {
            if (this._virtualDevices[i].iface == iface)
                return this._virtualDevices[i];
        }

        return null;
    },

    _hideDevices: function() {
        this._devicesHidden = true;

        for (let category in this._devices)
            this._devices[category].section.actor.hide();
    },

    _showNormal: function() {
        if (!this._devicesHidden) // nothing to do
            return;
        this._devicesHidden = false;

        this._statusSection.actor.hide();

        this._syncSectionTitle(NMConnectionCategory.WIRED);
        this._syncSectionTitle(NMConnectionCategory.VIRTUAL);
        this._syncSectionTitle(NMConnectionCategory.WIRELESS);
        this._syncSectionTitle(NMConnectionCategory.WWAN);
    },

    _syncNMState: function() {
        this.mainIcon.visible = this._client.manager_running;
        this.indicators.visible = this.mainIcon.visible;

        if (!this._client.networking_enabled) {
            this.setIcon('network-offline-symbolic');
            this._hideDevices();
            this._statusItem.label.text = _("Networking is disabled");
            this._statusSection.actor.show();
            return;
        }

        this._showNormal();
        this._updateIcon();
    },

    _updateIcon: function() {
        this._syncActiveConnections();
        let mc = this._mainConnection;
        let hasApIcon = false;
        let hasMobileIcon = false;

        if (!mc) {
            this.setIcon('network-offline-symbolic');
        } else {
            let dev = mc._primaryDevice;
            if (!dev) {
                log('Active connection with no primary device?');
                return;
            }
            this.setIcon(dev.getIndicatorIcon(mc));
        }

        // update VPN indicator
        if (this._vpnConnection) {
            let vpnIconName = 'network-vpn-symbolic';
            if (this._vpnConnection.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                vpnIconName = 'network-vpn-acquiring-symbolic';

            // only show a separate icon when we're using a wireless/3g connection
            if (mc._section == NMConnectionCategory.WIRELESS || 
                mc._section == NMConnectionCategory.WWAN) {
                this.secondaryIcon.icon_name = vpnIconName;
                this.secondaryIcon.show();
            } else {
                this.setIcon(vpnIconName);
                this.secondaryIcon.hide();
            }
        } else {
            this.secondaryIcon.hide();
        }
    }
});
