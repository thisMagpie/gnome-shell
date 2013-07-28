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
const MIN_COLUMNS = 4;
const MIN_ROWS = 4;

const INACTIVE_GRID_OPACITY = 77;
const INACTIVE_GRID_OPACITY_ANIMATION_TIME = 0.15;
const FOLDER_SUBICON_FRACTION = .4;

const MAX_APPS_PAGES = 20;
const PAGE_SWITCH_TIME = 0.3;
//fraction of page height the finger or mouse must reach before
//change page
const PAGE_SWITCH_TRESHOLD = 0.2;

const POPUP_FOLDER_VIEW_ANIMATION = 0.3;

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
                                             columnLimit: MAX_COLUMNS,
                                             minRows: MIN_ROWS,
                                             minColumns: MIN_COLUMNS,
                                             useSurroundingSpacing: true});

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
            this._grid.addItem(this._items[id]);
        }
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
        this.doingTransitions = false;
        this._popupExpansionNeeded = true;
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
    
    removeFolderPopUp: function(popup) {
        this._parent.removeFolderPopUp(popup);
    },
    
    /**
     * Pan view with items to make space for the folder view.
     * @param folderNVisibleRowsAtOnce this parameter tell how many rows the folder view has, but,
     * it is already constrianed to be at maximum of main grid rows least one, to ensure we have
     * enough space to show the folder view.
     */
    makeSpaceForPopUp: function(iconActor, side, folderNVisibleRowsAtOnce) {
        let rowsUp = [];
        let rowsDown = [];
        let mainIconYPosition = iconActor.actor.y;
        let currentPage = this._parent.currentPage();
        let mainIconRowReached = false;
        let isMainIconRow = false;
        let rows = this._grid.pageRows(currentPage);
        this._translatedRows = rows;
        for(let rowIndex in rows) {
            isMainIconRow = mainIconYPosition == rows[rowIndex][0].y;
            if(isMainIconRow)
                mainIconRowReached = true;
            if(!mainIconRowReached) {
                rowsUp.push(rows[rowIndex]);
            } else {
                if(isMainIconRow) {
                    if(side == St.Side.BOTTOM)
                        rowsDown.push(rows[rowIndex]);
                    else
                        rowsUp.push(rows[rowIndex]);
                } else
                    rowsDown.push(rows[rowIndex]);
            }
        }
        //The last page can have space without rows
        let emptyRows = this._grid._rowsPerPage - rows.length ;
        let panViewUpNRows = 0;
        let panViewDownNRows = 0;
        if(side == St.Side.BOTTOM) {
            // There's not need to pan view down
            if(rowsUp.length >= folderNVisibleRowsAtOnce)
                panViewUpNRows = folderNVisibleRowsAtOnce;
            else {
                panViewUpNRows = rowsUp.length;
                panViewDownNRows = folderNVisibleRowsAtOnce - rowsUp.length;
            }
        } else {
            // There's not need to pan view up
            if(rowsDown.length + emptyRows >= folderNVisibleRowsAtOnce){
                panViewDownNRows = folderNVisibleRowsAtOnce;
            }
            else {
                panViewDownNRows = rowsDown.length + emptyRows;
                panViewUpNRows = folderNVisibleRowsAtOnce - rowsDown.length - emptyRows;
            }
        }
        // Especial case, last page and no rows below the icon of the folder, no rows down neither rows up,
        // we call directly the popup
        this.updateIconOpacities(true);
        if(panViewDownNRows > 0 && rowsDown.length == 0 && rowsUp.length == 0) {
            this.displayingPopup = true;
            this._popupExpansionNeeded = false;
            iconActor.onCompleteMakeSpaceForPopUp();            
        } else {
            this._popupExpansionNeeded = true;
            this._panViewForFolderView(rowsUp, rowsDown, panViewUpNRows, panViewDownNRows, iconActor);
        }    
    },
    
    returnSpaceToOriginalPosition: function() {
        this.updateIconOpacities(false);
        if(!this._popupExpansionNeeded) {
            this.displayingPopup = false;
            return;
        }
        
        if(this._translatedRows) {
            for(let rowId in this._translatedRows) {
                for(let childrenId in this._translatedRows[rowId]) {
                    if(this._translatedRows[rowId][childrenId].translate_y){
                        let tweenerParams = { translate_y: 0,
                                time: POPUP_FOLDER_VIEW_ANIMATION,
                                onUpdate: function() {this.queue_relayout();},
                                transition: 'easeInOutQuad',
                                onComplete: Lang.bind(this, function(){this.displayingPopup = false;}
                                )};
                        Tweener.addTween(this._translatedRows[rowId][childrenId], tweenerParams);
                    }
                }
            }
        }
    },
    
    _panViewForFolderView: function(rowsUp, rowsDown, panViewUpNRows, panViewDownNRows, iconActor) {
        let rowHeight = this._grid.rowHeight();
        if(panViewUpNRows > 0) {
            this.displayingPopup = true;
            let height = rowHeight * panViewUpNRows;
            for(let rowId in rowsUp) {
                for(let childrenId in rowsUp[rowId]) {
                    rowsUp[rowId][childrenId].translate_y = 0;
                    let tweenerParams = { translate_y: - height,
                                          time: POPUP_FOLDER_VIEW_ANIMATION,
                                          onUpdate: function() {this.queue_relayout();},
                                          transition: 'easeInOutQuad' };
                    if((rowId == rowsUp.length - 1) && (childrenId == rowsUp[rowId].length - 1)) {
                        tweenerParams['onComplete'] = Lang.bind(iconActor, iconActor.onCompleteMakeSpaceForPopUp);
                    }
                    Tweener.addTween(rowsUp[rowId][childrenId], tweenerParams);
                }
            }
        }
        if(panViewDownNRows > 0) {
            this.displayingPopup = true;
            let height = rowHeight * panViewDownNRows;
            for(let rowId in rowsDown) {
                for(let childrenId in rowsDown[rowId]) {
                    rowsDown[rowId][childrenId].translate_y = 0;
                    let tweenerParams = { translate_y: height,
                                          time: POPUP_FOLDER_VIEW_ANIMATION,
                                          onUpdate: function() {this.queue_relayout();} };
                    if((rowId == rowsDown.length - 1) && (childrenId == rowsDown[rowId].length - 1)) {
                        tweenerParams['onComplete'] = Lang.bind(iconActor, iconActor.onCompleteMakeSpaceForPopUp);
                    }
                    Tweener.addTween(rowsDown[rowId][childrenId], tweenerParams);
                }
            }
        }
    },
    
    removeAll: function() {
        this._folderIcons = [];
        this.parent();
    },
    
    onUpdatedDisplaySize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        // Update grid dinamyc spacing based on display width
        this._grid.calculateResponsiveGrid(availWidth, availHeight);
        // Update folder views
        for(let id in this._folderIcons) {
            this._folderIcons[id].onUpdatedDisplaySize(width, height);
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
        
        // When the number of pages change (i.e. when changing screen resolution or during clutter false allocations)
        // we have to tell pagination that the adjustment is not correct (since the allocated size of pagination changed)
        // For that problem we return to the first page of pagination.
        // In fact it is not necesary with the current state of the gnome-shell since we can only change the resolution outside the overview,
        // so sicne we always start at page 0 of pagination when entering overview,we always already did that adjustment. BUT, who knows,
        // since it is a diferent case from the other, better to take it into account for future changes.
        this.invalidatePagination = false;
        
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
        box = this.get_theme_node().get_content_box(box);
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
        if(this.invalidatePagination) {
            //FLORIAN REVIEW
            // we can modify our adjustment, so we do that to show the first page, but we can't modify the indicators,
            // so we modify it before redraw (we won't see too much flickering at all)
            if(this._pages.nPages() > 1) {
                this.goToPage(0);
                Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, function() {this._parent.goToPage(0);}));
            }
        }
        this.invalidatePagination = false;
    },

    goToPage: function(pageNumber, action) {
        if(this._currentPage != pageNumber && this._pages.displayingPopup) {
            this._currentPopup.popdown();
        } else if(this._pages.displayingPopup){
            return;
        }
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
        if(this._pages.displayingPopup)
            return;
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
        popup.openStateId = popup.connect('open-state-changed', Lang.bind(this,
                function(popup, isOpen) {
                    this._eventBlocker.reactive = isOpen;
                    this._currentPopup = isOpen ? popup : null;
                }));
    },
    
    removeFolderPopUp: function(popup) {
        popup.disconnect(popup.openStateId);
        this._stack.remove_child(popup.actor);     
    },
    
    _onPan: function(action) {
        this._clickAction.release();
        if(this._pages.displayingPopup)
            return;
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._verticalAdjustment;
        adjustment.value -= (dy / this.height) * adjustment.page_size;
        return false;
    },
    
    _onPanEnd: function(action) {
        if(this._pages.displayingPopup)
            return;
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
    
    onUpdatedDisplaySize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._pages.onUpdatedDisplaySize(availWidth, availHeight);
    }
    
});

const PaginationIconIndicator = new Lang.Class({
    Name: 'PaginationIconIndicator',

    _init: function(parent, index) {

        this.actor = new St.Button({ style_class: 'pages-icon-indicator',
                                     button_mask: St.ButtonMask.ONE || St.ButtonMask.TWO,
                                     toggle_mode: true,
                                     can_focus: true });
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor._delegate = this;
        //Background image is 18x18 but it is a svg, so we have to put a size
        this.actor.set_size(18, 18);
        this._parent = parent;
        this.actor._index = index;
    },

    _onClicked: function(actor, button) {        
        this._parent.goToPage(this.actor._index); 
        return false;
    },

    setChecked: function (checked) {
        this.actor.set_checked(checked);
    }
});

const PaginationIndicator = new Lang.Class({
    Name:'PaginationIndicator',
    
    _init: function(params) {
        params['y_expand'] = true;
        this.actor = new Shell.GenericContainer(params);
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));
        this.actor.connect('style-changed', Lang.bind(this, this._styleChanged));
        this._spacing = 0;
    },
    
    _getPreferredHeight: function(actor, forWidth, alloc) {
        let [minHeight, natHeight] = this.actor.get_children()[0].get_preferred_height(forWidth);
        if(this._nPages) {
            let natHeightPerChild = natHeight + this._spacing;
            let totalUsedHeight =  this._nPages * natHeightPerChild - this._spacing;
            let minHeightPerChild = minHeight + this._spacing;
            minHeight = this._nPages * minHeightPerChild - this._spacing;
            natHeight = this._nPages * natHeightPerChild - this._spacing;
        } else
            minHeight = natHeight = 0;
        alloc.min_size = 0;
        alloc.natural_size = natHeight;
    },
    
    _getPreferredWidth: function(actor, forHeight, alloc) {
        let [minWidth, natWidth] = this.actor.get_children()[0].get_preferred_width(forHeight);
        let totalWidth = natWidth + this._spacing;
        alloc.min_size = totalWidth;
        alloc.natural_size = totalWidth;
    },

    _allocate: function(actor, box, flags) {
        let children = this.actor.get_children();
        for(let i in children)
            this.actor.set_skip_paint(children[i], true);
        if(children.length < 1)
            return;
        let availHeight = box.y2 - box.y1;
        let availWidth = box.x2 - box.x1;
        let [minHeight, natHeight] = children[0].get_preferred_height(availWidth);
        let heightPerChild = natHeight + this._spacing;
        let totalUsedHeight =  this._nPages * heightPerChild - this._spacing;
        
        let [minWidth, natWidth] = children[0].get_preferred_width(natHeight);
        let widthPerChild = natWidth + this._spacing * 2;
        let firstPosition = [this._spacing, availHeight / 2 - totalUsedHeight / 2];
        for(let i = 0; i < this._nPages; i++) {
            let childBox = new Clutter.ActorBox();
            childBox.x1 = 0;
            childBox.x2 = availWidth;
            childBox.y1 = firstPosition[1] + i * heightPerChild;
            childBox.y2 = childBox.y1 + heightPerChild;
            if(childBox.y2 > availHeight)
                break;
            children[i].allocate(childBox, flags);
            this.actor.set_skip_paint(children[i], false);
        }
    },
   
    _styleChanged: function() {
        this._spacing = this.actor.get_theme_node().get_length('spacing');
        this.actor.queue_relayout();
    }
});

const AllView = new Lang.Class({
    Name: 'AllView',
   
    _init: function() {
        let paginationScrollViewParams = {style_class: 'all-apps'};
        this._paginationIndicator = new PaginationIndicator({style_class: 'pages-indicator'});
        this._paginationIndicator._nPages = 0;
        this._paginationView = new PaginationScrollView(this, paginationScrollViewParams);

        let layout = new Clutter.BinLayout();
        this.actor = new St.Widget({ layout_manager: layout, 
                                     x_expand:true, y_expand:true });
        //FIXME Clutter align properties
        layout.add(this._paginationView, 2,2);
        if(Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            layout.add(this._paginationIndicator.actor, 2,2);
        else
            layout.add(this._paginationIndicator.actor, 3,2);
        for(let i = 0; i < MAX_APPS_PAGES; i++) {
            let indicatorIcon = new PaginationIconIndicator(this, i);
            if(i == 0) {
                indicatorIcon.setChecked(true);
            }
            this._paginationIndicator.actor.add_actor(indicatorIcon.actor);
        }

        this._paginationView._pages._grid.connect('n-pages-changed', Lang.bind(this, this._updatedNPages));
        // Always start at page 0 when we enter and quit overview
        Main.overview.connect('shown', Lang.bind(this, function() {this.goToPage(0);}));
    },
    
    _updatedNPages: function(iconGrid, nPages) {
        // We don't need a relayout because we already done it at iconGrid
        // when pages are calculated (and then the signal is emitted before that)");
        this._paginationIndicator._nPages = nPages;
        this._paginationView.invalidatePagination = true;
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
    },

    addFolder: function(dir) {
        let folderIcon = this._paginationView._pages.addItem(dir);
    },
   
    removeAll: function() {
        this._paginationView._pages.removeAll();
    },

    loadGrid: function() {
        this._paginationView._pages.loadGrid();
    },
    
    goToPage: function(index, action) {
        // Since we call this function also from shown signal of the overview, we can't assure the pagination is already calculated
        // so we first ask pagination if it has some page, if not, we return and that's it. (nevermind, because when creating for first time
        // pagination, that is when it can happens, paginations starts at page 0 already, so no problem here)
        if(!this._paginationView.nPages())
            return;
        // Since it can happens after a relayout, we have to ensure that all is unchecked
        let indicators = this._paginationIndicator.actor.get_children();
        for(let i in indicators)
            indicators[i].set_checked(false);
        this._paginationView.goToPage(index, action);
        this._paginationIndicator.actor.get_child_at_index(this._paginationView.currentPage()).set_checked(true);
    },
    
    onUpdatedDisplaySize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._paginationView.onUpdatedDisplaySize(availWidth, availHeight);
    }
});

const FrequentView = new Lang.Class({
    Name: 'FrequentView',

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             fillParent: true,
                                             columnLimit: MAX_COLUMNS,
                                             minRows: MIN_ROWS,
                                             minColumns: MIN_COLUMNS,
                                             useSurroundingSpacing: true });
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
            this._grid.addItem(appIcon, -1);
        }
    },
    
    onUpdatedDisplaySize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._grid.calculateResponsiveGrid(availWidth, availHeight);
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
    Extends: Clutter.BinLayout,
    
    vfunc_allocate: function (actor, box, flags) {        
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        // Prepare children of all views for the upcomming allocation, calculate all
        // the needed values in the responsive design we are trying to emulate
        this.emit('allocated-size-changed', availWidth, availHeight);
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
        this._viewStackLayout = new AppDisplayActor();
        this.actor.set_layout_manager(new Clutter.BoxLayout({vertical: true}));
        this._viewStackLayout.connect('allocated-size-changed', Lang.bind(this, this._onUpdatedDisplaySize));

        this._viewStack = new St.Widget({ 
                                          x_expand: true, y_expand: true });
        this._viewStack.set_layout_manager(this._viewStackLayout);
        this.actor.add_actor(this._viewStack, { expand: true });
        let layout = new ControlsBoxLayout({ homogeneous: true });
        this._controls = new St.Widget({ style_class: 'app-view-controls' });
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
    
    _onUpdatedDisplaySize: function(actor, width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        for (let i = 0; i < this._views.length; i++) {
            this._views[i].view.onUpdatedDisplaySize(availWidth, availHeight);
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

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             columnLimit: MAX_COLUMNS,
                                             minRows: MIN_ROWS,
                                             minColumns: MIN_COLUMNS,
                                             useSurroundingSpacing: true});
        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.actor.x_expand = true;
        
        this.actor = new St.ScrollView({overlay_scrollbars: true});
        this.actor.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this._box = new St.BoxLayout({vertical: true, reactive: true});
        this._widget = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._widget.add_child(this._grid.actor);
        this._box.add_actor(this._widget);
        this.actor.add_actor(this._box);
        this._items = {};
        this._allItems = [];
        
        this._boxPointerOffsets = {};
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
        //FIXME
        /*if(this._allItems.length > 0)
            return;*/
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
        //FIXME
      //let itemIcon2 = this._createItemIcon(item);
      //this._allItems.push(item);
        //this._items[id + 1] = itemIcon2;
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
            //FIXME
            //this._grid.addItem(this._items[id + 1].actor);
            this._grid.addItem(this._items[id]);
            
        }
    },
    
    onUpdatedDisplaySize: function(width, height) {
        this._appDisplayWidth = width;
        this._appDisplayHeight = height;
        // Update grid dinamyc spacing based on display width
        this._grid.calculateResponsiveGrid(width, height);
        
        if(!Object.keys(this._boxPointerOffsets).length)
            return;
        //We put the normal padding as spacing as we have in the main grid to do well the calculations for used rows, used columns etc, since
        // it is the behaviour we want to emulate. After that we will put the correct padding from calculations of the boxpointer offsets, to ensure
        //the boxpointer will be contained inside the view
        let spacing = this._grid.getSpacing();
        
        let boxPointerTotalOffset = this._boxPointerOffsets['arrowHeight'] + this._boxPointerOffsets['padding'] * 2 + this._boxPointerOffsets['closeButtonOverlap'];
        let offsetForEachSide = Math.ceil(boxPointerTotalOffset / 2);
        this._offsetForEachSide = offsetForEachSide;
        this._grid.top_padding = spacing - offsetForEachSide;
        this._grid.bottom_padding = spacing - offsetForEachSide;
        this._grid.left_padding = spacing - offsetForEachSide;
        this._grid.right_padding = spacing - offsetForEachSide;
    },
    
    _containerBox: function() {
        let pageBox = new Clutter.ActorBox();
        pageBox.x1 = 0;
        pageBox.y1 = 0;
        pageBox.x2 = this._appDisplayWidth;
        pageBox.y2 = this._appDisplayHeight;
        return this.actor.get_theme_node().get_content_box(pageBox);
    },
    
    usedWidth: function() {
        let box = this._containerBox();
        let availWidthPerPage = box.x2 - box.x1;
        // Since we want to do the calculation of the real width of the grid
        // taking into account the parent behaviour, we have to substract from the
        // avail width the padding we subsctratc before to the folder view
        // in its surrounding spacings
        availWidthPerPage -= 2 * this._offsetForEachSide;
        let maxUsedWidth = this._grid.usedWidth(availWidthPerPage);
        return maxUsedWidth;
    },
    
    usedHeight: function() {
        // Then calculate the real maxUsedHeight
        return this._grid.usedHeightForNRows(this.nRowsDisplayedAtOnce());
    },   
    
    nRowsDisplayedAtOnce: function() {
        let box = this._containerBox();
        let availHeightPerPage = box.y2 - box.y1;
        let availWidthPerPage = box.x2 - box.x1;
        //FIXME: if we do that, we really not showing the maximum of rows we can show on collection view
        // Since we want to do the calculation of the real width of the grid
        // taking into account the parent behaviour, we have to substract from the
        // avail width the padding we subsctratc before to the folder view
        // in its surrounding spacings
        availWidthPerPage -= 2 * this._offsetForEachSide;
        availHeightPerPage -= 2 * this._offsetForEachSide;
        
        let maxRowsDisplayedAtOnce = this.maxRowsDisplayedAtOnce();
        let usedRows = this._grid.nUsedRows(availWidthPerPage);
        usedRows = usedRows <= maxRowsDisplayedAtOnce ? usedRows : maxRowsDisplayedAtOnce;
        return usedRows;
    },
    
    maxRowsDisplayedAtOnce: function() {
        let box = this._containerBox();
        let availHeightPerPage = box.y2 - box.y1;
      //FIXME: if we do that, we really not showing the maximum of rows we can show on collection view
        // Since we want to do the calculation of the real width of the grid
        // taking into account the parent behaviour, we have to substract from the
        // avail width the padding we subsctratc before to the folder view
        // in its surrounding spacings
        availHeightPerPage -= 2 * this._offsetForEachSide;
        let maxRowsPerPage = this._grid.rowsForHeight(availHeightPerPage);
        //Then, we can only show that rows least one.
        maxRowsPerPage -= 1;
        return maxRowsPerPage;
    },
    
    updateBoxPointerOffsets: function(arrowHeight, padding, closeButtonOverlap) {
        // We have to ensure the close button doesn't go outside the allocation, so
        // if we are using all the possible rows, means the boxpointer goes until
        // the boundary of allocation, and then we have to take into account the close button
        // overlap and least it from padding
        this._boxPointerOffsets['arrowHeight'] = arrowHeight;
        this._boxPointerOffsets['padding'] = padding;
        this._boxPointerOffsets['closeButtonOverlap'] = closeButtonOverlap;
        
    },
    
    setScrollToStart: function() {
        this.actor.vscroll.adjustment.value = 0;
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
        // when changing screen resolution or during clutter false allocations
        // we have to tell folder view that the calculated values of boxpointer arrow side, position, etc 
        // are not correct (since the allocated size of pagination changed)
        // For that problem we calculate everything again and apply it maintaining current popup.
        this.invalidatePopUp = false;
        this._boxPointerOffsets = {};
        
        let label = this._dir.get_name();
        this.icon = new IconGrid.BaseIcon(label,
                                          { createIcon: Lang.bind(this, this._createIcon), setSizeManually: true });
        this.actor.set_child(this.icon.actor);
        this.actor.label_actor = this.icon.label;

        this.view = new FolderView();
        _loadCategory(dir, this.view);
        this.view.loadGrid();

        this.actor.connect('clicked', Lang.bind(this,
            function() {
                this._ensurePopup();
                this.view.setScrollToStart();
            }));
        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (!this.actor.mapped && this._popup)
                    this._popup.popdown();
            }));
        
        this.actor.connect('notify::allocation', Lang.bind(this, function() {
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, this._updatePopupPosition));
        }));
    },

    _createIcon: function(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    },
    
    getIconSize: function() {
        return this.icon.iconSize;
    },
    
    setIconSize: function(size) {
        this.icon.setIconSize(size);
    },
    
    _popUpGridWidth: function() {
        return this.view.usedWidth();
    },
    
    _popUpGridHeight: function() {
        let usedHeight = this.view.usedHeight();
        return usedHeight;   
    },
    
    _popUpHeight: function() {
        let usedHeight = this.view.usedHeight() + this._boxPointerOffsets['arrowHeight'] + this._boxPointerOffsets['padding'] * 2;
        return usedHeight;   
    },

    makeSpaceForPopUp: function() {
        this._parentView.makeSpaceForPopUp(this, this._boxPointerArrowside, this.view.nRowsDisplayedAtOnce());
    },
    
    returnSpaceToOriginalPosition: function() {
        this._parentView.returnSpaceToOriginalPosition();
    },
    
    onCompleteMakeSpaceForPopUp: function() {
        this._popup.popup();
    },
    
    _calculateBoxPointerArrowSide: function() {
        let absoluteActorYPosition = this.actor.get_transformed_position()[1];
        let spaceTop = absoluteActorYPosition;
        // Be careful, but doesn't matter, we don0t take into account the top panel height etc,
        // So maybe we put an arrow side "wrong", but anyway, the expanding of colelction view will
        // do the required space
        let spaceBottom = this.actor.get_stage().height - (absoluteActorYPosition + this.actor.height);
        return spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;
    },
    
    _updatePopUpSize: function() {
     // FLORIAN REVIEW
        /**
         * Why we need that: AppDiplay update width for the spacing for all
         * views Allview and frequent view and folder views calcualte spacing
         * with the items of icongrid with harcoded values
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
        this._boxPointerOffsets['arrowHeight'] = this._popup._boxPointer.actor.get_theme_node().get_length('-arrow-rise');
        this._boxPointerOffsets['padding'] = this._popup._boxPointer.bin.get_theme_node().get_length('padding');
        //It will be negative value, so we have to substract it, instead of plust it.
        this._boxPointerOffsets['closeButtonOverlap'] = - this._popup.closeButton.get_theme_node().get_length('-shell-close-overlap-y');

        this.view.updateBoxPointerOffsets(this._boxPointerOffsets['arrowHeight'], this._boxPointerOffsets['padding'], this._boxPointerOffsets['closeButtonOverlap']);
        this.view.onUpdatedDisplaySize(this._displayWidth, this._displayHeight);
        
        /*
         * Always make the grid (and therefore the boxpointer) to be the max
         * width it can be if it use full icon rows, althougth there's less
         * icons than necesary to full the row. In that manner the popup will be
         * more eye pleasant, fulling the parent view
         */
        this.view.actor.set_width(this._popUpGridWidth());

        /*
         * A folder view can only be, at a maximum, one row less than the parent
         * view, so calculate the maximum rows it can have, and then deduct one,
         * then calculate the maxUsedHeigth and the current Used height, if it
         * is more, strech to the maxUsedHeight
         */
        this.view.actor.set_height(this._popUpGridHeight());
    },
    
    _updatePopupPosition: function() {
        if(this._popup) {
            // Position the popup above or below the source icon
            if (this._boxPointerArrowside == St.Side.BOTTOM) {
                let closeButtonOffset = -this._popup.closeButton.translation_y;
                // FLORIAN REVIEW
                // We have to use this function, since this._popup.actor.height not always return a good value (32 px??)
                // and then all this calculation of position fails. To solve this in this function we calculate the used height with the grid
                // since we knoe all of the properties of grid. Then we add the padding, arrowheigth etc of boxpointer, and we have the
                // used height of the popup
                let y = this.actor.y - this._popUpHeight();
                let yWithButton = y - closeButtonOffset;
                this._popup.parentOffset = yWithButton < 0 ? -yWithButton : 0;
                this._popup.actor.y = Math.max(y, closeButtonOffset);
                this._popup.actor.y = y
            } else {
                this._popup.actor.y = this.actor.y + this.actor.height;
            }
        }
    },
    
    _ensurePopup: function() {
        if(this._popup && !this.invalidatePopUp){
            this.makeSpaceForPopUp();
            return;
        } else {
            
            this._boxPointerArrowside = this._calculateBoxPointerArrowSide();
            if(!this._popup) {
                this._popup = new AppFolderPopup(this, this._boxPointerArrowside);
                this._parentView.addFolderPopup(this._popup);
                this._popup.connect('open-state-changed', Lang.bind(this,
                        function(popup, isOpen) {
                    if (!isOpen) {
                        this.actor.checked = false;
                        this.returnSpaceToOriginalPosition();
                    }
                }));
            } else
                this._popup.updateBoxPointer(this._boxPointerArrowside);
            this._updatePopUpSize();
            this._updatePopupPosition();
            this.makeSpaceForPopUp();
            this.invalidatePopUp = false; 
        }
    },

    onUpdatedDisplaySize: function(width, height) {
        this._displayWidth = width;
        this._displayHeight = height;
        this.view.onUpdatedDisplaySize(width, height);
        this.invalidatePopUp = true;
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
        this._boxPointer.show(BoxPointer.PopupAnimation.FADE | BoxPointer.PopupAnimation.SLIDE);

        this._isOpen = true;
        this.emit('open-state-changed', true);
    },

    popdown: function() {
        if (!this._isOpen)
            return;

        this._boxPointer.hide(BoxPointer.PopupAnimation.FADE | BoxPointer.PopupAnimation.SLIDE);
        this._isOpen = false;
        this.emit('open-state-changed', false);
    },
    
    updateBoxPointer: function (side) {
        this._arrowSide = side;
        this._boxPointer._arrowSide = side;
        this._boxPointer._border.queue_repaint();
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
        iconParams['setSizeManually'] = true;
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
    
    getIconSize: function() {
        return this.icon.iconSize;
    },
    
    setIconSize: function(size) {
        this.icon.setIconSize(size);
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

