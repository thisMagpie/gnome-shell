// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const GMenu = imports.gi.GMenu;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Atk = imports.gi.Atk;

const AppFavorites = imports.ui.appFavorites;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const Params = imports.misc.params;
const Util = imports.misc.util;

const MAX_APPLICATION_WORK_MILLIS = 75;
const MENU_POPUP_TIMEOUT = 600;
const MAX_COLUMNS = 6;
const MIN_COLUMNS = 4;
const MIN_ROWS = 4;

const INACTIVE_GRID_OPACITY = 77;
const INACTIVE_GRID_OPACITY_ANIMATION_TIME = 0.15;
const FOLDER_SUBICON_FRACTION = .4;

const PAGE_SWITCH_TIME = 0.3;

// Recursively load a GMenuTreeDirectory; we could put this in ShellAppSystem too
function _loadCategory(dir, view) {
    let iter = dir.iter();
    let appSystem = Shell.AppSystem.get_default();
    let nextType;
    while ((nextType = iter.next()) != GMenu.TreeItemType.INVALID) {
        if (nextType == GMenu.TreeItemType.ENTRY) {
            let entry = iter.get_entry();
            let app = appSystem.lookup_app_by_tree_entry(entry);
            if (!entry.get_app_info().get_nodisplay())
                view.addApp(app);
        } else if (nextType == GMenu.TreeItemType.DIRECTORY) {
            let itemDir = iter.get_directory();
            if (!itemDir.get_is_nodisplay())
                _loadCategory(itemDir, view);
        }
    }
};

const AlphabeticalView = new Lang.Class({
    Name: 'AlphabeticalView',
    Abstract: true,

    _init: function(params, gridParams) {
        gridParams = Params.parse(gridParams, { xAlign: St.Align.MIDDLE,
                                                columnLimit: MAX_COLUMNS,
                                                minRows: MIN_ROWS,
                                                minColumns: MIN_COLUMNS,
                                                fillParent: false });
        params = Params.parse(params, { usePagination: false });
        
        if(params['usePagination'])
            this._grid = new IconGrid.PaginatedIconGrid(gridParams);
        else
            this._grid = new IconGrid.IconGrid(gridParams);

        // Standard hack for ClutterBinLayout
        this._grid.actor.x_expand = true;

        this._items = {};
        this._allItems = [];
    },

    removeAll: function() {
        this._grid.removeAll();
        this._items = {};
        this._allItems = [];
    },

    _getItemId: function(item) {
        throw new Error('Not implemented');
    },

    _createItemIcon: function(item) {
        throw new Error('Not implemented');
    },

    _compareItems: function(a, b) {
        throw new Error('Not implemented');
    },

    _addItem: function(item) {
        let id = this._getItemId(item);
        if (this._items[id] !== undefined)
            return null;

        let itemIcon = this._createItemIcon(item);
        this._allItems.push(item);
        this._items[id] = itemIcon;

        return itemIcon;
    },

    loadGrid: function() {
        this._allItems.sort(this._compareItems);

        for (let i = 0; i < this._allItems.length; i++) {
            let id = this._getItemId(this._allItems[i]);
            if (!id)
                continue;
            this._grid.addItem(this._items[id].actor);
        }
    }
});

const PagesView = new Lang.Class({
    Name: 'PagesView',
    Extends: St.Bin,

    _init: function(parent, params) {
        params['reactive'] = true;
        this.parent(params);
        this._parent = parent;
    },

    vfunc_get_preferred_height: function (forWidth) {
        return [0, 0];
    },

    vfunc_get_preferred_width: function(forHeight) {
        return [0, 0];
    },

    vfunc_allocate: function(box, flags) {
        box = this.get_parent().allocation;
        box = this.get_theme_node().get_content_box(box);
        this.set_allocation(box, flags); 
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let childBox = new Clutter.ActorBox();
        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = availWidth;
        childBox.y2 = availHeight;
        let child = this.get_child();
        child.allocate(childBox, flags);
        this._parent.updateAdjustment(availHeight);
    }
});

const AllView = new Lang.Class({
    Name: 'AllView',
    Extends: AlphabeticalView,

    _init: function() {
        this.parent({ usePagination: true }, null);
        this._pagesView = new PagesView(this, { style_class: 'all-apps',
                                                x_align: St.Align.MIDDLE,
                                                y_align: St.Align.MIDDLE });
        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(), 
                                     x_expand:true, y_expand:true });
        this.actor.add_actor(this._pagesView);
        this._grid.connect('n-pages-changed', Lang.bind(this, this._onNPagesChanged));

        this._stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._box = new St.BoxLayout({ vertical: true });
        this._verticalAdjustment = new St.Adjustment();
        this._box.set_adjustments(new St.Adjustment() /* unused */, this._verticalAdjustment);

        this._currentPage = 0;
        this._stack.add_actor(this._grid.actor);
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker, {x_align:St.Align.MIDDLE});

        this._box.add_actor(this._stack);
        this._pagesView.add_actor(this._box);

        this._pagesView.connect('scroll-event', Lang.bind(this, this._onScroll));

        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', Lang.bind(this, function() {
            if (!this._currentPopup)
                return;

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor))
                this._currentPopup.popdown();
        }));
        this._eventBlocker.add_action(this._clickAction);
        // When the number of pages change (i.e. when changing screen resolution)
        // we have to tell pagination that the adjustment is not correct (since the allocated size of pagination changed)
        // For that problem we return to the first page of pagination.
        this._paginationInvalidated = false;
    },

    _onNPagesChanged: function(iconGrid, nPages) {
        this._paginationInvalidated = true;
    },

    goToPage: function(pageNumber) {
        this._currentPage = pageNumber;
        let params = { value: this._grid.getPageYPosition(this._currentPage),
                       time: PAGE_SWITCH_TIME,
                       transition: 'easeOutQuad' };
        Tweener.addTween(this._verticalAdjustment, params);
    },

    _onScroll: function(actor, event) {
        let direction = event.get_scroll_direction();
        let nextPage;
        if (direction == Clutter.ScrollDirection.UP) {
            if (this._currentPage > 0) {
                nextPage = this._currentPage - 1;
                this.goToPage(nextPage);
            }
        }
        if (direction == Clutter.ScrollDirection.DOWN) {
            if (this._currentPage < (this._grid.nPages() - 1)) {
                nextPage = this._currentPage + 1;
                this.goToPage(nextPage);
            }
        }
    },

    _getItemId: function(item) {
        if (item instanceof Shell.App)
            return item.get_id();
        else if (item instanceof GMenu.TreeDirectory)
            return item.get_menu_id();
        else
            return null;
    },

    _createItemIcon: function(item) {
        if (item instanceof Shell.App)
            return new AppIcon(item);
        else if (item instanceof GMenu.TreeDirectory)
            return new FolderIcon(item, this);
        else
            return null;
    },

    _compareItems: function(itemA, itemB) {
        // bit of a hack: rely on both ShellApp and GMenuTreeDirectory
        // having a get_name() method
        let nameA = GLib.utf8_collate_key(itemA.get_name(), -1);
        let nameB = GLib.utf8_collate_key(itemB.get_name(), -1);
        return (nameA > nameB) ? 1 : (nameA < nameB ? -1 : 0);
    },

    addApp: function(app) {
        this._addItem(app);
    },

    addFolder: function(dir) {
        this._addItem(dir);
    },

    addFolderPopup: function(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                this._eventBlocker.reactive = isOpen;
                this._currentPopup = isOpen ? popup : null;
                this._updateIconOpacities(isOpen);
            }));
    },

    updateAdjustment: function(availHeight) {
        this._verticalAdjustment.page_size = availHeight;
        this._verticalAdjustment.upper = this._stack.height;
        if (this._paginationInvalidated)
            this.goToPage(0);
        this._paginationInvalidated = false;
    },

    _updateIconOpacities: function(folderOpen) {
        for (let id in this._items) {
            let params;
            if (folderOpen && !this._items[id].actor.checked)
                params = { opacity: INACTIVE_GRID_OPACITY,
                               time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                               transition: 'easeOutQuad' };
            else
                params = { opacity: 255,
                           time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                           transition: 'easeOutQuad' };
            Tweener.addTween(this._items[id].actor, params);
        }
    },

    adaptToSize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._pagesView.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        // Update grid dinamyc spacing based on display width
        this._grid.updateSpacingForSize(availWidth, availHeight);
        // Calculate pagination values
        this._grid.computePages(availWidth, availHeight);
    }
});

const FrequentView = new Lang.Class({
    Name: 'FrequentView',
    Extends: AlphabeticalView,

    _init: function() {
        this.parent(null, { fillParent: true });
        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     x_expand: true, y_expand: true });
        this.actor.add_actor(this._grid.actor);

        this._usage = Shell.AppUsage.get_default();
    },

    loadApps: function() {
        let mostUsed = this._usage.get_most_used ("");
        for (let i = 0; i < mostUsed.length; i++) {
            if (!mostUsed[i].get_app_info().should_show())
                continue;
            let appIcon = new AppIcon(mostUsed[i]);
            this._grid.addItem(appIcon.actor, -1);
        }
    },

    adaptToSize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._grid.updateSpacingForSize(availWidth, availHeight);
    }
});

const Views = {
    FREQUENT: 0,
    ALL: 1
};

const ControlsBoxLayout = Lang.Class({
    Name: 'ControlsBoxLayout',
    Extends: Clutter.BoxLayout,

    /**
     * Override the BoxLayout behavior to use the maximum preferred width of all
     * buttons for each child
     */
    vfunc_get_preferred_width: function(container, forHeight) {
        let maxMinWidth = 0;
        let maxNaturalWidth = 0;
        for (let child = container.get_first_child();
             child;
             child = child.get_next_sibling()) {
             let [minWidth, natWidth] = child.get_preferred_width(forHeight);
             maxMinWidth = Math.max(maxMinWidth, minWidth);
             maxNaturalWidth = Math.max(maxNaturalWidth, natWidth);
        }
        let childrenCount = container.get_n_children();
        let totalSpacing = this.spacing * (childrenCount - 1);
        return [maxMinWidth * childrenCount + totalSpacing,
                maxNaturalWidth * childrenCount + totalSpacing];
    }
});

const ViewStackLayout = new Lang.Class({
    Name: 'ViewStackLayout',
    Extends: Clutter.BinLayout,

    vfunc_allocate: function (actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        // Prepare children of all views for the upcomming allocation, calculate all
        // the needed values to adapt available size
        this.emit('allocated-size-changed', availWidth, availHeight);
        this.parent(actor, box, flags);
    }
});
Signals.addSignalMethods(ViewStackLayout.prototype);

const AppDisplay = new Lang.Class({
    Name: 'AppDisplay',

    _init: function() {
        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connect('installed-changed', Lang.bind(this, function() {
            Main.queueDeferredWork(this._allAppsWorkId);
        }));
        Main.overview.connect('showing', Lang.bind(this, function() {
            Main.queueDeferredWork(this._frequentAppsWorkId);
        }));
        global.settings.connect('changed::app-folder-categories', Lang.bind(this, function() {
            Main.queueDeferredWork(this._allAppsWorkId);
        }));
        this._privacySettings = new Gio.Settings({ schema: 'org.gnome.desktop.privacy' });
        this._privacySettings.connect('changed::remember-app-usage',
                                      Lang.bind(this, this._updateFrequentVisibility));

        this._views = [];

        let view, button;
        view = new FrequentView();
        button = new St.Button({ label: _("Frequent"),
                                 style_class: 'app-view-control',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.FREQUENT] = { 'view': view, 'control': button };

        view = new AllView();
        button = new St.Button({ label: _("All"),
                                 style_class: 'app-view-control',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.ALL] = { 'view': view, 'control': button };

        this.actor = new St.Widget({ style_class: 'app-display',
                                     x_expand: true, y_expand: true });
        this.actor.set_layout_manager(new Clutter.BoxLayout({ vertical: true }));

        this._viewStack = new St.Widget({ x_expand: true, y_expand: true });
        this._viewStackLayout = new ViewStackLayout();
        this._viewStack.set_layout_manager(this._viewStackLayout);
        this._viewStackLayout.connect('allocated-size-changed', Lang.bind(this, this._onAllocateSizeChanged));

        this.actor.add_actor(this._viewStack, { expand: true });
        let layout = new ControlsBoxLayout({ homogeneous: true });
        this._controls = new St.Widget({ style_class: 'app-view-controls',
                                         layout_manager: layout });
        layout.hookup_style(this._controls);
        this.actor.add_actor(new St.Bin({ child: this._controls }));

        for (let i = 0; i < this._views.length; i++) {
            this._viewStack.add_actor(this._views[i].view.actor);
            this._controls.add_actor(this._views[i].control);

            let viewIndex = i;
            this._views[i].control.connect('clicked', Lang.bind(this,
                function(actor) {
                    this._showView(viewIndex);
                }));
        }
        this._showView(Views.FREQUENT);
        this._updateFrequentVisibility();

        // We need a dummy actor to catch the keyboard focus if the
        // user Ctrl-Alt-Tabs here before the deferred work creates
        // our real contents
        this._focusDummy = new St.Bin({ can_focus: true });
        this._viewStack.add_actor(this._focusDummy);

        this._allAppsWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplayAllApps));
        this._frequentAppsWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplayFrequentApps));
    },

    _showView: function(activeIndex) {
        for (let i = 0; i < this._views.length; i++) {
            let actor = this._views[i].view.actor;
            let params = { time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           opacity: (i == activeIndex) ? 255 : 0 };
            if (i == activeIndex)
                actor.visible = true;
            else
                params.onComplete = function() { actor.hide(); };
            Tweener.addTween(actor, params);

            if (i == activeIndex)
                this._views[i].control.add_style_pseudo_class('checked');
            else
                this._views[i].control.remove_style_pseudo_class('checked');
        }
    },

    _updateFrequentVisibility: function() {
        let enabled = this._privacySettings.get_boolean('remember-app-usage');
        this._views[Views.FREQUENT].control.visible = enabled;

        let visibleViews = this._views.filter(function(v) {
            return v.control.visible;
        });
        this._controls.visible = visibleViews.length > 1;

        if (!enabled && this._views[Views.FREQUENT].view.actor.visible)
            this._showView(Views.ALL);
    },

    _redisplay: function() {
        this._redisplayFrequentApps();
        this._redisplayAllApps();
    },

    _redisplayFrequentApps: function() {
        let view = this._views[Views.FREQUENT].view;

        view.removeAll();
        view.loadApps();
    },

    _redisplayAllApps: function() {
        let view = this._views[Views.ALL].view;

        view.removeAll();

        let tree = this._appSystem.get_tree();
        let root = tree.get_root_directory();

        let iter = root.iter();
        let nextType;
        let folderCategories = global.settings.get_strv('app-folder-categories');
        while ((nextType = iter.next()) != GMenu.TreeItemType.INVALID) {
            if (nextType == GMenu.TreeItemType.DIRECTORY) {
                let dir = iter.get_directory();
                if (dir.get_is_nodisplay())
                    continue;

                if (folderCategories.indexOf(dir.get_menu_id()) != -1)
                    view.addFolder(dir);
                else
                    _loadCategory(dir, view);
            }
        }
        view.loadGrid();

        if (this._focusDummy) {
            let focused = this._focusDummy.has_key_focus();
            this._focusDummy.destroy();
            this._focusDummy = null;
            if (focused)
                this.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
        }
    },

    _onAllocateSizeChanged: function(actor, width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this._viewStack.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        for (let i = 0; i < this._views.length; i++) {
            this._views[i].view.adaptToSize(availWidth, availHeight);
        }
    }
});

const AppSearchProvider = new Lang.Class({
    Name: 'AppSearchProvider',

    _init: function() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
    },

    getResultMetas: function(apps, callback) {
        let metas = [];
        for (let i = 0; i < apps.length; i++) {
            let app = apps[i];
            metas.push({ 'id': app,
                         'name': app.get_name(),
                         'createIcon': function(size) {
                             return app.create_icon_texture(size);
                         }
                       });
        }
        callback(metas);
    },

    getInitialResultSet: function(terms) {
        this.searchSystem.setResults(this, this._appSys.initial_search(terms));
    },

    getSubsearchResultSet: function(previousResults, terms) {
        this.searchSystem.setResults(this, this._appSys.subsearch(previousResults, terms));
    },

    activateResult: function(app) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;
        let openNewWindow = modifiers & Clutter.ModifierType.CONTROL_MASK;

        if (openNewWindow)
            app.open_new_window(-1);
        else
            app.activate();
    },

    dragActivateResult: function(id, params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        let app = this._appSys.lookup_app(id);
        app.open_new_window(workspace);
    },

    createResultActor: function (resultMeta, terms) {
        let app = resultMeta['id'];
        let icon = new AppIcon(app);
        return icon.actor;
    }
});

const FolderView = new Lang.Class({
    Name: 'FolderView',
    Extends: AlphabeticalView,

    _init: function() {
        this.parent(null, null);
        this.actor = this._grid.actor;
    },

    _getItemId: function(item) {
        return item.get_id();
    },

    _createItemIcon: function(item) {
        return new AppIcon(item);
    },

    _compareItems: function(a, b) {
        return a.compare_by_name(b);
    },

    addApp: function(app) {
        this._addItem(app);
    },

    createFolderIcon: function(size) {
        let icon = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                   style_class: 'app-folder-icon',
                                   width: size, height: size });
        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);

        let aligns = [ Clutter.ActorAlign.START, Clutter.ActorAlign.END ];
        for (let i = 0; i < Math.min(this._allItems.length, 4); i++) {
            let texture = this._allItems[i].create_icon_texture(subSize);
            let bin = new St.Bin({ child: texture,
                                   x_expand: true, y_expand: true });
            bin.set_x_align(aligns[i % 2]);
            bin.set_y_align(aligns[Math.floor(i / 2)]);
            icon.add_actor(bin);
        }

        return icon;
    }
});

const FolderIcon = new Lang.Class({
    Name: 'FolderIcon',

    _init: function(dir, parentView) {
        this._dir = dir;
        this._parentView = parentView;

        this.actor = new St.Button({ style_class: 'app-well-app app-folder',
                                     button_mask: St.ButtonMask.ONE,
                                     toggle_mode: true,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;

        let label = this._dir.get_name();
        this.icon = new IconGrid.BaseIcon(label,
                                          { createIcon: Lang.bind(this, this._createIcon) });
        this.actor.set_child(this.icon.actor);
        this.actor.label_actor = this.icon.label;

        this.view = new FolderView();
        this.view.actor.reactive = false;
        _loadCategory(dir, this.view);
        this.view.loadGrid();

        this.actor.connect('clicked', Lang.bind(this,
            function() {
                this._ensurePopup();
                this._popup.toggle();
            }));
        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (!this.actor.mapped && this._popup)
                    this._popup.popdown();
            }));
    },

    _createIcon: function(size) {
        return this.view.createFolderIcon(size);
    },

    _ensurePopup: function() {
        if (this._popup)
            return;

        let spaceTop = this.actor.y;
        let spaceBottom = this._parentView.actor.height - (this.actor.y + this.actor.height);
        let side = spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;

        this._popup = new AppFolderPopup(this, side);
        this._parentView.addFolderPopup(this._popup);

        // Position the popup above or below the source icon
        if (side == St.Side.BOTTOM) {
            this._popup.actor.show();
            let closeButtonOffset = -this._popup.closeButton.translation_y;
            let y = this.actor.y - this._popup.actor.height;
            let yWithButton = y - closeButtonOffset;
            this._popup.parentOffset = yWithButton < 0 ? -yWithButton : 0;
            this._popup.actor.y = Math.max(y, closeButtonOffset);
            this._popup.actor.hide();
        } else {
            this._popup.actor.y = this.actor.y + this.actor.height;
        }

        this._popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                if (!isOpen)
                    this.actor.checked = false;
            }));
    },
});

const AppFolderPopup = new Lang.Class({
    Name: 'AppFolderPopup',

    _init: function(source, side) {
        this._source = source;
        this._view = source.view;
        this._arrowSide = side;

        this._isOpen = false;
        this.parentOffset = 0;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     visible: false,
                                     // We don't want to expand really, but look
                                     // at the layout manager of our parent...
                                     //
                                     // DOUBLE HACK: if you set one, you automatically
                                     // get the effect for the other direction too, so
                                     // we need to set the y_align
                                     x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.START });
        this._boxPointer = new BoxPointer.BoxPointer(this._arrowSide,
                                                     { style_class: 'app-folder-popup-bin',
                                                       x_fill: true,
                                                       y_fill: true,
                                                       x_align: St.Align.START });

        this._boxPointer.actor.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer.actor);
        this._boxPointer.bin.set_child(this._view.actor);

        this.closeButton = Util.makeCloseButton();
        this.closeButton.connect('clicked', Lang.bind(this, this.popdown));
        this.actor.add_actor(this.closeButton);

        this._boxPointer.actor.bind_property('opacity', this.closeButton, 'opacity',
                                             GObject.BindingFlags.SYNC_CREATE);

        global.focus_manager.add_group(this.actor);

        source.actor.connect('destroy', Lang.bind(this,
            function() {
                this.actor.destroy();
            }));
        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPress));
    },

    _onKeyPress: function(actor, event) {
        if (!this._isOpen)
            return false;

        if (event.get_key_symbol() != Clutter.KEY_Escape)
            return false;

        this.popdown();
        return true;
    },

    toggle: function() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    },

    popup: function() {
        if (this._isOpen)
            return;

        this.actor.show();
        this.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);

        this._boxPointer.setArrowActor(this._source.actor);
        this._boxPointer.show(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE);

        this._isOpen = true;
        this.emit('open-state-changed', true);
    },

    popdown: function() {
        if (!this._isOpen)
            return;

        this._boxPointer.hide(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE);
        this._isOpen = false;
        this.emit('open-state-changed', false);
    }
});
Signals.addSignalMethods(AppFolderPopup.prototype);

const AppIcon = new Lang.Class({
    Name: 'AppIcon',

    _init : function(app, iconParams) {
        this.app = app;
        this.actor = new St.Button({ style_class: 'app-well-app',
                                     reactive: true,
                                     button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;

        if (!iconParams)
            iconParams = {};

        iconParams['createIcon'] = Lang.bind(this, this._createIcon);
        this.icon = new IconGrid.BaseIcon(app.get_name(), iconParams);
        this.actor.set_child(this.icon.actor);

        this.actor.label_actor = this.icon.label;

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('popup-menu', Lang.bind(this, this._onKeyboardPopupMenu));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this._draggable = DND.makeDraggable(this.actor);
        this._draggable.connect('drag-begin', Lang.bind(this,
            function () {
                this._removeMenuTimeout();
                Main.overview.beginItemDrag(this);
            }));
        this._draggable.connect('drag-cancelled', Lang.bind(this,
            function () {
                Main.overview.cancelledItemDrag(this);
            }));
        this._draggable.connect('drag-end', Lang.bind(this,
            function () {
               Main.overview.endItemDrag(this);
            }));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state',
                                                Lang.bind(this,
                                                          this._onStateChanged));
        this._onStateChanged();
    },

    _onDestroy: function() {
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;
        this._removeMenuTimeout();
    },

    _createIcon: function(iconSize) {
        return this.app.create_icon_texture(iconSize);
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    _onStateChanged: function() {
        if (this.app.state != Shell.AppState.STOPPED)
            this.actor.add_style_class_name('running');
        else
            this.actor.remove_style_class_name('running');
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._removeMenuTimeout();
            this._menuTimeoutId = Mainloop.timeout_add(MENU_POPUP_TIMEOUT,
                Lang.bind(this, function() {
                    this.popupMenu();
                }));
        } else if (button == 3) {
            this.popupMenu();
            return true;
        }
        return false;
    },

    _onClicked: function(actor, button) {
        this._removeMenuTimeout();

        if (button == 1) {
            this._onActivate(Clutter.get_current_event());
        } else if (button == 2) {
            // Last workspace is always empty
            let launchWorkspace = global.screen.get_workspace_by_index(global.screen.n_workspaces - 1);
            launchWorkspace.activate(global.get_current_time());
            this.emit('launching');
            this.app.open_new_window(-1);
            Main.overview.hide();
        }
        return false;
    },

    _onKeyboardPopupMenu: function() {
        this.popupMenu();
        this._menu.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    getId: function() {
        return this.app.get_id();
    },

    popupMenu: function() {
        this._removeMenuTimeout();
        this.actor.fake_release();
        this._draggable.fakeRelease();

        if (!this._menu) {
            this._menu = new AppIconMenu(this);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window);
            }));
            this._menu.connect('open-state-changed', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));
            Main.overview.connect('hiding', Lang.bind(this, function () { this._menu.close(); }));

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();

        return false;
    },

    activateWindow: function(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    },

    _onMenuPoppedDown: function() {
        this.actor.sync_hover();
        this.emit('menu-state-changed', false);
    },

    _onActivate: function (event) {
        this.emit('launching');
        let modifiers = event.get_state();

        if (modifiers & Clutter.ModifierType.CONTROL_MASK
            && this.app.state == Shell.AppState.RUNNING) {
            this.app.open_new_window(-1);
        } else {
            this.app.activate();
        }

        Main.overview.hide();
    },

    shellWorkspaceLaunch : function(params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    },

    getDragActor: function() {
        return this.app.create_icon_texture(Main.overview.dashIconSize);
    },

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource: function() {
        return this.icon.icon;
    }
});
Signals.addSignalMethods(AppIcon.prototype);

const AppIconMenu = new Lang.Class({
    Name: 'AppIconMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        this.parent(source.actor, 0.5, side);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.connect('activate', Lang.bind(this, this._onActivate));

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        source.actor.connect('notify::mapped', Lang.bind(this, function () {
            if (!source.actor.mapped)
                this.close();
        }));
        source.actor.connect('destroy', Lang.bind(this, function () { this.actor.destroy(); }));

        Main.uiGroup.add_actor(this.actor);
    },

    _redisplay: function() {
        this.removeAll();

        let windows = this._source.app.get_windows();

        // Display the app windows menu items and the separator between windows
        // of the current desktop and other windows.
        let activeWorkspace = global.screen.get_active_workspace();
        let separatorShown = windows.length > 0 && windows[0].get_workspace() != activeWorkspace;

        for (let i = 0; i < windows.length; i++) {
            if (!separatorShown && windows[i].get_workspace() != activeWorkspace) {
                this._appendSeparator();
                separatorShown = true;
            }
            let item = this._appendMenuItem(windows[i].title);
            item._window = windows[i];
        }

        if (!this._source.app.is_window_backed()) {
            if (windows.length > 0)
                this._appendSeparator();

            let isFavorite = AppFavorites.getAppFavorites().isFavorite(this._source.app.get_id());

            this._newWindowMenuItem = this._appendMenuItem(_("New Window"));
            this._appendSeparator();

            this._toggleFavoriteMenuItem = this._appendMenuItem(isFavorite ? _("Remove from Favorites")
                                                                : _("Add to Favorites"));
        }
    },

    _appendSeparator: function () {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    },

    _appendMenuItem: function(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    },

    popup: function(activatingButton) {
        this._redisplay();
        this.open();
    },

    _onActivate: function (actor, child) {
        if (child._window) {
            let metaWindow = child._window;
            this.emit('activate-window', metaWindow);
        } else if (child == this._newWindowMenuItem) {
            this._source.app.open_new_window(-1);
            this.emit('activate-window', null);
        } else if (child == this._toggleFavoriteMenuItem) {
            let favs = AppFavorites.getAppFavorites();
            let isFavorite = favs.isFavorite(this._source.app.get_id());
            if (isFavorite)
                favs.removeFavorite(this._source.app.get_id());
            else
                favs.addFavorite(this._source.app.get_id());
        }
        this.close();
    }
});
Signals.addSignalMethods(AppIconMenu.prototype);
