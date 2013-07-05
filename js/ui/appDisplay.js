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
const Gdk = imports.gi.Gdk;

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

const INACTIVE_GRID_OPACITY = 77;
const INACTIVE_GRID_OPACITY_ANIMATION_TIME = 0.15;
const FOLDER_SUBICON_FRACTION = .4;

const MAX_APPS_PAGES = 20;
const PAGE_SWITCH_TIME = 0.3;
//fraction of page height the finger or mouse must reach before
//change page
const PAGE_SWITCH_TRESHOLD = 0.2;

// Recursively load a GMenuTreeDirectory; we could put this in ShellAppSystem
// too
function _loadCategory(dir, list) {
    let iter = dir.iter();
    let appSystem = Shell.AppSystem.get_default();
    let nextType;
    while ((nextType = iter.next()) != GMenu.TreeItemType.INVALID) {
        if (nextType == GMenu.TreeItemType.ENTRY) {
            let entry = iter.get_entry();
            let app = appSystem.lookup_app_by_tree_entry(entry);
            if (!entry.get_app_info().get_nodisplay())
                list.addApp(app);
        } else if (nextType == GMenu.TreeItemType.DIRECTORY) {
            let itemDir = iter.get_directory();
            if (!itemDir.get_is_nodisplay())
                _loadCategory(itemDir, list);
        }
    }
};

const AlphabeticalView = new Lang.Class({
    Name: 'AlphabeticalView',
    Abstract: true,

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             usePagination: true,
                                             columnLimit: MAX_COLUMNS });

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

const FolderView = new Lang.Class({
    Name: 'FolderView',

    _init: function(parentView) {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
            columnLimit: MAX_COLUMNS });
        // Standard hack for ClutterBinLayout
        this._grid.actor.x_expand = true;
        this._parentView = parentView;

        this.actor = new St.ScrollView({x_expand: true, y_expand:true, y_fill: true, x_fill:true, overlay_scrollbars: true});
        this.actor.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this._box = new St.BoxLayout({vertical:true});
        this._widget = new St.Widget({x_expand: true, y_expand:true});
        this._widget.add_actor(this._grid.actor);
        this._box.add(this._widget, { expand: true });
        this.actor.add_actor(this._box);
        this._items = {};
        this._allItems = [];
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
    },
    
    removeAll: function() {
        this._grid.removeAll();
        this._items = {};
        this._allItems = [];
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
    },
    
    updateSpacing: function(width) {
        let itemWidth = this._grid._hItemSize * MAX_COLUMNS;
        let emptyArea = width - itemWidth;
        let spacing;
        spacing = Math.max(this._grid._spacing, emptyArea / ( 2 *  MAX_COLUMNS));
        spacing = Math.round(spacing);
        this._grid.setSpacing(spacing);
    }
});

const AppPages = new Lang.Class({
    Name: 'AppPages',
    Extends: AlphabeticalView,
   
    _init: function(parent) {
        this.parent();
        this.actor = this._grid.actor;
        this._parent = parent;
        this._folderIcons = [];
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
        else if (item instanceof GMenu.TreeDirectory) {
            let folderIcon = new FolderIcon(item, this);
            this._folderIcons.push(folderIcon);
            return folderIcon;
        } else
            return null;
    },

    _compareItems: function(itemA, itemB) {
        // bit of a hack: rely on both ShellApp and GMenuTreeDirectory
        // having a get_name() method
        let nameA = GLib.utf8_collate_key(itemA.get_name(), -1);
        let nameB = GLib.utf8_collate_key(itemB.get_name(), -1);
        return (nameA > nameB) ? 1 : (nameA < nameB ? -1 : 0);
    },
    
    updateIconOpacities: function(folderOpen) {
        for (let id in this._items) {
            if (folderOpen && !this._items[id].actor.checked) {
                let params = { opacity: INACTIVE_GRID_OPACITY,
                        time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                        transition: 'easeOutQuad'
                       };
                Tweener.addTween(this._items[id].actor, params);
            }
            else {
                let params = { opacity: 255,
                        time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                        transition: 'easeOutQuad'
                       };
                Tweener.addTween(this._items[id].actor, params);
            }
        }
    },
    
    addItem: function(item) {
        this._addItem(item);
    },
    
    nPages: function() {
        return this._grid.nPages();
    },
    
    getPagePosition: function(pageNumber) {
        return this._grid.getPagePosition(pageNumber);
    },
    
    setViewForPageSize: function(view) {
        this._grid._viewForPageSize= view;
    },
    
    addFolderPopup: function(popup) {
        this._parent.addFolderPopup(popup);
    },
    
    removeAll: function() {
        this._folderIcons = [];
        this.parent();
    },
    
    updateSpacing: function(width) {
        let itemWidth = this._grid._hItemSize * MAX_COLUMNS;
        let emptyArea = width - itemWidth;
        let spacing;
        spacing = Math.max(this._grid._spacing, emptyArea / ( 2 *  MAX_COLUMNS));
        spacing = Math.round(spacing);
        this._grid.setSpacing(spacing);
        for(let id in this._folderIcons) {
            this._folderIcons[id].updateFolderViewSpacing(width);
        }
    }
});

const PaginationScrollView = new Lang.Class({
    Name: 'PaginationScrollView',
    Extends: St.Bin,
    
    _init: function(parent, params) {
        params['reactive'] = true;
        this.parent(params);
        this._verticalAdjustment = new St.Adjustment();
        this._horizontalAdjustment = new St.Adjustment();

        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout()});        
        this._box = new St.BoxLayout({vertical: true});
        this._pages = new AppPages(this);
        this._pages.setViewForPageSize(this);
        
        this._stack.add_actor(this._pages.actor);
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker, {x_align:St.Align.MIDDLE});
        
        this._box.add_actor(this._stack);
        this._box.set_adjustments(this._horizontalAdjustment, this._verticalAdjustment);
        this.add_actor(this._box);

        this._currentPage = 0;
        this._parent = parent;
        
        this.connect('scroll-event', Lang.bind(this, this._onScroll));
        
        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', Lang.bind(this, this._onPan));
        panAction.connect('gesture-cancel', Lang.bind(this, function() {
            this._onPanEnd(this._panAction);
        }));
        panAction.connect('gesture-end', Lang.bind(this, function() {
            this._onPanEnd(this._panAction);
        }));
        this._panAction = panAction;
        this.add_action(panAction);
        
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
    },
    
    vfunc_get_preferred_height: function (forWidht) {
        return [0, 0];
    },

    vfunc_get_preferred_width: function(forHeight) {
        return [0, 0];
    },
    
    vfunc_allocate: function(box, flags) {
        box = this.get_parent().allocation;
        this.set_allocation(box, flags);        
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let childBox = new Clutter.ActorBox();
        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = availWidth;
        childBox.y2 = availHeight;   
        this._box.allocate(childBox, flags);
        
        this._verticalAdjustment.page_size = availHeight;
        this._verticalAdjustment.upper = this._stack.height;
    },

    goToPage: function(pageNumber, action) {
        let velocity;
        if(!action)
            velocity = 0;
        else
            velocity = Math.abs(action.get_velocity(0)[2]);
        // Tween the change between pages.
        // If velocity is not specified (i.e. scrolling with mouse wheel),
        // use the same speed regardless of original position
        // if velocity is specified, it's in pixels per milliseconds
        let diffFromPage =  this._diffToPage(pageNumber);
        let childBox = this.get_allocation_box();
        let totalHeight = childBox.y2 - childBox.y1;
        let time;
        // Only take into account the velocity if we change of page, if not,
        // we returns smoothly with default velocity to the current page
        if(this._currentPage != pageNumber) {
            let min_velocity = totalHeight / (PAGE_SWITCH_TIME * 1000);
            velocity = Math.max(min_velocity, velocity);
            time = (diffFromPage / velocity) / 1000;
            
        } else
            time = PAGE_SWITCH_TIME * diffFromPage / totalHeight;
        // Take care when we are changing more than one page, maximum time
        // regardless the velocity is the default one
        time = Math.min(time, PAGE_SWITCH_TIME);
        if(pageNumber < this._pages.nPages() && pageNumber >= 0) {
            this._currentPage = pageNumber;
            let params = { value: this._pages.getPagePosition(this._currentPage)[1],
                           time: time,
                           transition: 'easeOutQuad'
                          };
            Tweener.addTween(this._verticalAdjustment, params);
        }
    },

    nPages: function() {
      return this._pages.nPages();  
    },

    currentPage: function() {
        return this._currentPage;
    },

    _diffToPage: function (pageNumber) {
        let currentScrollPosition = this._verticalAdjustment.value;
        return Math.abs(currentScrollPosition - this._pages._grid.getPagePosition(pageNumber)[1]);
    },

    _nearestPage: function() {
        let currentNearestPage = 0;
        let diff = this._diffToPage(currentNearestPage);
        let oldDiff = diff;
        
        while(diff <= oldDiff && currentNearestPage < (this._pages.nPages() - 1)) {
            currentNearestPage++;
            oldDiff = diff;
            diff = this._diffToPage(currentNearestPage);            
        }
        if(diff > oldDiff)
            currentNearestPage--;

        return currentNearestPage; 
    },

    _goToNearestPage: function(action) {
        this._parent.goToPage(this._nearestPage(), action);
    },

    _onScroll: function(actor, event) {
        let direction = event.get_scroll_direction();
        let nextPage;
        if (direction == Clutter.ScrollDirection.UP)
            if(this._currentPage > 0) {
                nextPage = this._currentPage - 1;
                this._parent.goToPage(nextPage);
            }
        if (direction == Clutter.ScrollDirection.DOWN)
            if(this._currentPage < (this.nPages() - 1)) {
                nextPage = this._currentPage + 1;
                this._parent.goToPage(nextPage);
            }
    },
    
    addFolderPopup: function(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', Lang.bind(this,
                function(popup, isOpen) {
                    this._eventBlocker.reactive = isOpen;
                    this._currentPopup = isOpen ? popup : null;
                    this._pages.updateIconOpacities(isOpen);
                }));
    },
    
    _onPan: function(action) {
        this._clickAction.release();
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._verticalAdjustment;
        adjustment.value -= (dy / this.height) * adjustment.page_size;
        return false;
    },
    
    _onPanEnd: function(action) {
        let diffCurrentPage = this._diffToPage(this._currentPage);
        if(diffCurrentPage > this.height * PAGE_SWITCH_TRESHOLD) {
            if(action.get_velocity(0)[2] > 0 && this._currentPage > 0) {
                this._parent.goToPage(this._currentPage - 1, action);
            } else if(this._currentPage < this.nPages() - 1) {
                this._parent.goToPage(this._currentPage + 1, action);
            }
        } else
            this._parent.goToPage(this._currentPage, action);
    },
    
    updateSpacing: function(width) {
        this._pages.updateSpacing(width);
    }
    
});

const PaginationIconIndicator = new Lang.Class({
    Name: 'PaginationIconIndicator',

    _init: function(parent, index) {

        this.actor = new St.Button({ style_class: 'show-apps',
                                     button_mask: St.ButtonMask.ONE || St.ButtonMask.TWO,
                                     toggle_mode: true,
                                     can_focus: true });
        this._icon = new St.Icon({ icon_name: 'process-stop-symbolic',
                                   icon_size: 32,
                                   style_class: 'show-apps-icon',
                                   track_hover: true});
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.set_child(this._icon);
        this.actor._delegate = this;
        this._parent = parent;
        this._index = index;
    },

    _createIcon: function(size) {
        this._icon = new St.Icon({ icon_name: 'process-stop-symbolic',
                                   icon_size: size,
                                   style_class: 'show-apps-icon',
                                   track_hover: true });
        return this._icon;
    },

    _onClicked: function(actor, button) {
        this._parent.goToPage(this._index); 
        return false;
    },

    setChecked: function (checked) {
        this.actor.set_checked(checked);
    }
});

const IndicatorLayout = Lang.Class({
    Name:'IndicatorLayout',
    Extends: Clutter.BoxLayout,
    
    vfunc_get_preferred_height: function(container, forHeight) {
        return [0, 0];
    },
    
    vfunc_get_preferred_width: function(container, forHeight) {
        let [minWidth, natWidth] = container.get_children()[0].get_preferred_width(forHeight);
        let totalWidth = natWidth + this.spacing * 2;
        return [totalWidth, totalWidth];
    },

    vfunc_allocate: function(container, box, flags) {
        let children = container.get_children();
        if(children.length < 1)
            return;
        let availHeight = box.y2 - box.y1;
        let availWidth = box.x2 - box.x1;
        let [minHeight, natHeight] = children[0].get_preferred_height(availWidth);
        let totalUsedHeight = this._nPages  * this.spacing * 2  - this.spacing + this._nPages * natHeight;
        let heightPerChild = totalUsedHeight / this._nPages;
        let [minWidth, natWidth] = children[0].get_preferred_width(natHeight);
        let widthPerChild = natWidth + this.spacing * 2;
        let firstPosition = [this.spacing, availHeight / 2 - totalUsedHeight / 2];

        for(let i = 0; i < this._nPages; i++) {
            let childBox = new Clutter.ActorBox();
            childBox.x1 = 0;
            childBox.x2 = availWidth;
            childBox.y1 = firstPosition[1] + i * heightPerChild;
            childBox.y2 = childBox.y1 + heightPerChild;
            children[i].allocate(childBox, flags);
        }
    },

    vfunc_set_container: function(container) {
        if(this._styleChangedId) {
            this._container.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }        
        if(container != null)
            this._styleChangedId = container.connect('style-changed', Lang.bind(this,
                    function() { this.spacing = this._container.get_theme_node().get_length('spacing'); }));
        this._container = container;
    }
});

const AllView = new Lang.Class({
    Name: 'AllView',
   
    _init: function() {
        let paginationScrollViewParams = {style_class: 'all-apps'};
        this._paginationView = new PaginationScrollView(this, paginationScrollViewParams);

        this._paginationIndicatorLayout = new IndicatorLayout({orientation: Clutter.Orientation.VERTICAL});
        this._paginationIndicatorLayout._nPages = 0;
        
        this._paginationIndicator = new St.Widget({ style_class: 'pages-indicator',
                                                    y_expand:true});
        this._paginationIndicator.set_layout_manager(this._paginationIndicatorLayout);
        let layout = new Clutter.BinLayout();
        this.actor = new St.Widget({ layout_manager: layout, 
                                     x_expand:true, y_expand:true });
        layout.add(this._paginationView, 2,2);
        layout.add(this._paginationIndicator, 3,2);
        for(let i = 0; i < MAX_APPS_PAGES; i++) {
            let indicatorIcon = new PaginationIconIndicator(this, i);
            if(i == 0) {
                indicatorIcon.setChecked(true);
            }
            this._paginationIndicator.add_child(indicatorIcon.actor);
        }

        this._paginationView._pages._grid.connect('n-pages-changed', Lang.bind(this, this._updatedNPages));
    },
    
    _updatedNPages: function(iconGrid, nPages) {
        // We don't need a relayout because we already done it at iconGrid
        // when pages are calculated (and then the signal is emitted before that)
        this._paginationIndicatorLayout._nPages = nPages;        
    },
    
    _onKeyRelease: function(actor, event) {
        if (event.get_key_symbol() == Clutter.KEY_Up) {
            this._paginationView.goToNextPage();
            return true;
        } else if(event.get_key_symbol() == Clutter.KEY_Down) {
            this._paginationView.goToPreviousPage();
            return true;
        }

        return false;
    },

    addApp: function(app) {
       let appIcon = this._paginationView._pages.addItem(app);
        /*
         * if (appIcon) appIcon.actor.connect('key-focus-in', Lang.bind(this,
         * this._ensureIconVisible));
         */
    },

    addFolder: function(dir) {
        let folderIcon = this._paginationView._pages.addItem(dir);
        /*
         * if (folderIcon) folderIcon.actor.connect('key-focus-in',
         * Lang.bind(this, this._ensureIconVisible));
         */
    },
   
    removeAll: function() {
        this._paginationView._pages.removeAll();
    },

    loadGrid: function() {
        this._paginationView._pages.loadGrid();
    },
    
    goToPage: function(index, action) {
        this._paginationIndicator.get_child_at_index(this._paginationView.currentPage()).set_checked(false);
        this._paginationView.goToPage(index, action);
        this._paginationIndicator.get_child_at_index(this._paginationView.currentPage()).set_checked(true);
    },
    
    updateSpacing: function(width) {
        this._paginationView.updateSpacing(width);
    }
});

const FrequentView = new Lang.Class({
    Name: 'FrequentView',

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             fillParent: true,
                                             columnLimit: MAX_COLUMNS });
        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     x_expand: true, y_expand: true });
        this.actor.add_actor(this._grid.actor);

        this._usage = Shell.AppUsage.get_default();
    },

    removeAll: function() {
        this._grid.removeAll();
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
    
    updateSpacing: function(width) {
        let itemWidth = this._grid._hItemSize * MAX_COLUMNS;
        let emptyArea = width - itemWidth;
        let spacing;
        spacing = Math.max(this._grid._spacing, emptyArea / ( 2 *  MAX_COLUMNS));
        spacing = Math.round(spacing);
        this._grid.setSpacing(spacing);
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
    },

    vfunc_set_container: function(container) {
        if(this._styleChangedId) {
            this._container.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }
        if(container != null)
            this._styleChangedId = container.connect('style-changed', Lang.bind(this,
                    function() { this.spacing = this._container.get_theme_node().get_length('spacing'); }));
        this._container = container;
    }
});

const AppDisplayActor = new Lang.Class({
    Name: 'AppDisplayActor',
    Extends: Clutter.BoxLayout,
    
    vfunc_allocate: function (actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availheight = box.y2 - box.y1;
        this.emit('allocated-width-changed', availWidth);
        this.parent(actor, box, flags);
    },
    
    vfunc_set_container: function(container) {
        if(this._styleChangedId) {
            this._container.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }
        if(container != null)
            this._styleChangedId = container.connect('style-changed', Lang.bind(this,
                    function() { this.spacing = this._container.get_theme_node().get_length('spacing'); }));
        this._container = container;
    }
});
Signals.addSignalMethods(AppDisplayActor.prototype);

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
        this._actorLayout = new AppDisplayActor({vertical: true});
        this.actor.set_layout_manager(this._actorLayout);
        this._actorLayout.connect('allocated-width-changed', Lang.bind(this, this._updateViewsSpacing));

        this._viewStack = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                          x_expand: true, y_expand: true });
        //FIXME
        this.actor.add_actor(this._viewStack, { expand: true });

        let layout = new ControlsBoxLayout({ homogeneous: true });
        this._controls = new St.Widget({ style_class: 'app-view-controls' });
        //FIXME
        this._controls.set_layout_manager(layout);
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

        /*for (let i = 0; i < this._views.length; i++) {
            this._views[i].view.updateSpacing(1920);
        }*/
        
        
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
    
    _updateViewsSpacing: function(actor, width) {
        for (let i = 0; i < this._views.length; i++) {
            this._views[i].view.updateSpacing(width);
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

const FolderIcon = new Lang.Class({
    Name: 'FolderIcon',

    _init: function(dir, parentView) {
        this._dir = dir;

        this.actor = new St.Button({ style_class: 'app-well-app app-folder',
                                     button_mask: St.ButtonMask.ONE,
                                     toggle_mode: true,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;
        this._parentView = parentView;

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
        //this.view.actor.connect('notify::allocation', Lang.bind(this, this._updatePopupPosition));
    },

    _createIcon: function(size) {
        return this.view.createFolderIcon(size, this);
    },
    
    _updatePopupPosition: function() {
        if(this._popup) {
            // Position the popup above or below the source icon
            if (this._side == St.Side.BOTTOM) {
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
        }
    },
    
    _ensurePopup: function() {
        if(this._popup){
            return;
        }
        let previousPopUp = this._popup;
        let spaceTop = this.actor.y;
        let spaceBottom = this._parentView.actor.height - (this.actor.y + this.actor.height);
        this._side = spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;
        this._popup = new AppFolderPopup(this, this._side);
        this._parentView.addFolderPopup(this._popup);
        /**
         * AppDiplay update width for the spacing for all views Allview and
         * frequent view and folder views calcualte spacing with the items of
         * icongrid with harcoded values
         * 
         * Open overview, then iconSizes changes in allview and frequent view
         * icongrids, which is the actors who are added to the main AppDisplay.
         * Then a relayout occurs. AppDiplay update width for the spacing for
         * all views Allview and frequent view and folder views calcualte
         * spacing with the items of icongrid, which allview and frequetn view
         * has the new values, but folderview has the hardcoded values, since
         * folderview icongrid is not still added to the main Actor, and then,
         * they didn't emitted style changed signal with new valuesw of item
         * sizes. Then, frequent view and all view has correct spacing and item
         * size values, and fodler view has incorrect size and spacing values.
         * Then, we click icon folder, a folderIcon popup is created and added
         * to the parent actor, then the style changes, and item size changes,
         * but spacing is the old one. Then, we calculate the position of the
         * popup, but, the required height is with the old spacing and new item
         * sizes, so the height is bigger, then the position is bad. Then,
         * appDisplay allocate all views updating spacing, and set the good
         * spacing to folder view, then allocate the folder view, but the
         * positoon of the boxpointer is already calcualted with the old
         * spacing, so the boxpointer is displaced.
         * 
         * Solution: ensure style of the grid just after we add it to the parent
         * and before the calculation of the position.
         */
        this.view._grid.actor.ensure_style();
        this.view.updateSpacing(this._parentWidth);
        this._updatePopupPosition();
        
        this._popup.connect('open-state-changed', Lang.bind(this,
                function(popup, isOpen) {
            if (!isOpen)
                this.actor.checked = false;
        }));
    },
    
    updateFolderViewSpacing: function(width) {
        
        this.view.updateSpacing(width);
        //this.view.actor.ensure_style();
        this._parentWidth = width;
        //this._updatePopupPosition();
    }
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
                                                       x_expand: true,
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
        this._boxPointer.show(BoxPointer.PopupAnimation.FADE);

        this._isOpen = true;
        this.emit('open-state-changed', true);
    },

    popdown: function() {
        if (!this._isOpen)
            return;

        this._boxPointer.hide(BoxPointer.PopupAnimation.FADE);
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

