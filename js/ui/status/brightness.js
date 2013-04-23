// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Signals = imports.signals;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';

const BrightnessInterface = <interface name="org.gnome.SettingsDaemon.Power.Screen">
<property name='Brightness' type='u' access='readwrite'/>
</interface>;

const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

const BrightnessSlider = new Lang.Class({
    Name: 'BrightnessSlider',

    _init: function(proxy) {
        this._proxy = proxy;
        this._proxy.connect('g-properties-changed', Lang.bind(this, this._updateBrightness));

        this.section = new PopupMenu.PopupMenuSection();
        this._item = new PopupMenu.PopupBaseMenuItem({ activate: false });

        this._actor = new St.BoxLayout({ style_class: 'popup-slider-icon-menu-item' });

        this._slider = new Slider.Slider(0);
        this._slider.connect('value-changed', Lang.bind(this, this._sliderChanged));

        this._actor.add(new St.Icon({ icon_name: 'display-brightness-symbolic', icon_size: 16 }));
        this._actor.add(this._slider.actor, { expand: true });
        this._actor.add(new St.Icon({ icon_name: 'display-brightness-symbolic', icon_size: 16 }));

        this._item.addActor(this._actor, { span: -1, expand: true });
        this.section.addMenuItem(this._item);

        this._updateBrightness();
    },

    _sliderChanged: function(slider, value) {
        let percent = value * 100;
        this._proxy.Brightness = percent;
    },

    _updateBrightness: function() {
        let visible = this._proxy.Brightness >= 0;
        this.section.actor.visible = visible;
        if (visible)
            this._slider.setValue(this._proxy.Brightness / 100.0);
    },
});

const Indicator = new Lang.Class({
    Name: 'BrightnessIndicator',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent('display-brightness-symbolic');
        this._proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH);
        this._brightnessSlider = new BrightnessSlider(this._proxy);
        this.menu.addMenuItem(this._brightnessSlider.section);
    },
});
