// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Meta = imports.gi.Meta;

const Signals = imports.signals;
const Lang = imports.lang;
const Params = imports.misc.params;

const ICON_SIZE = 48;


const BaseIcon = new Lang.Class({
    Name: 'BaseIcon',

    _init : function(label, params) {
        params = Params.parse(params, { createIcon: null,
                                        setSizeManually: false,
                                        showLabel: true });
        this.actor = new St.Bin({ style_class: 'overview-icon',
                                  x_fill: true,
                                  y_fill: true });
        this.actor._delegate = this;
        this.actor.connect('style-changed',
                           Lang.bind(this, this._onStyleChanged));
        this.actor.connect('destroy',
                           Lang.bind(this, this._onDestroy));

        this._spacing = 0;

        let box = new Shell.GenericContainer();
        box.connect('allocate', Lang.bind(this, this._allocate));
        box.connect('get-preferred-width',
                    Lang.bind(this, this._getPreferredWidth));
        box.connect('get-preferred-height',
                    Lang.bind(this, this._getPreferredHeight));
        this.actor.set_child(box);

        this.iconSize = ICON_SIZE;
        this._iconBin = new St.Bin({ x_align: St.Align.MIDDLE,
                                     y_align: St.Align.MIDDLE });

        box.add_actor(this._iconBin);

        if (params.showLabel) {
            this.label = new St.Label({ text: label });
            box.add_actor(this.label);
        } else {
            this.label = null;
        }

        if (params.createIcon)
            this.createIcon = params.createIcon;
        this._setSizeManually = params.setSizeManually;

        this.icon = null;

        let cache = St.TextureCache.get_default();
        this._iconThemeChangedId = cache.connect('icon-theme-changed', Lang.bind(this, this._onIconThemeChanged));
    },

    _allocate: function(actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        let iconSize = availHeight;

        let [iconMinHeight, iconNatHeight] = this._iconBin.get_preferred_height(-1);
        let [iconMinWidth, iconNatWidth] = this._iconBin.get_preferred_width(-1);
        let preferredHeight = iconNatHeight;

        let childBox = new Clutter.ActorBox();

        if (this.label) {
            let [labelMinHeight, labelNatHeight] = this.label.get_preferred_height(-1);
            preferredHeight += this._spacing + labelNatHeight;

            let labelHeight = availHeight >= preferredHeight ? labelNatHeight
                                                             : labelMinHeight;
            iconSize -= this._spacing + labelHeight;

            childBox.x1 = 0;
            childBox.x2 = availWidth;
            childBox.y1 = iconSize + this._spacing;
            childBox.y2 = childBox.y1 + labelHeight;
            this.label.allocate(childBox, flags);
        }

        childBox.x1 = Math.floor((availWidth - iconNatWidth) / 2);
        childBox.y1 = Math.floor((iconSize - iconNatHeight) / 2);
        childBox.x2 = childBox.x1 + iconNatWidth;
        childBox.y2 = childBox.y1 + iconNatHeight;
        this._iconBin.allocate(childBox, flags);
    },

    _getPreferredWidth: function(actor, forHeight, alloc) {
        this._getPreferredHeight(actor, -1, alloc);
    },

    _getPreferredHeight: function(actor, forWidth, alloc) {
        let [iconMinHeight, iconNatHeight] = this._iconBin.get_preferred_height(forWidth);
        alloc.min_size = iconMinHeight;
        alloc.natural_size = iconNatHeight;

        if (this.label) {
            let [labelMinHeight, labelNatHeight] = this.label.get_preferred_height(forWidth);
            alloc.min_size += this._spacing + labelMinHeight;
            alloc.natural_size += this._spacing + labelNatHeight;
        }
    },

    // This can be overridden by a subclass, or by the createIcon
    // parameter to _init()
    createIcon: function(size) {
        throw new Error('no implementation of createIcon in ' + this);
    },

    setIconSize: function(size) {
        if (!this._setSizeManually)
            throw new Error('setSizeManually has to be set to use setIconsize');

        if (size == this.iconSize)
            return;

        this._createIconTexture(size);
    },

    _createIconTexture: function(size) {
        if (this.icon)
            this.icon.destroy();
        this.iconSize = size;
        this.icon = this.createIcon(this.iconSize);

        this._iconBin.child = this.icon;

        // The icon returned by createIcon() might actually be smaller than
        // the requested icon size (for instance StTextureCache does this
        // for fallback icons), so set the size explicitly.
        this._iconBin.set_size(this.iconSize, this.iconSize);
    },

    _onStyleChanged: function() {
        let node = this.actor.get_theme_node();
        this._spacing = node.get_length('spacing');

        let size;
        if (this._setSizeManually) {
            size = this.iconSize;
        } else {
            let [found, len] = node.lookup_length('icon-size', false);
            size = found ? len : ICON_SIZE;
        }

        if (this.iconSize == size && this._iconBin.child)
            return;

        this._createIconTexture(size);
    },

    _onDestroy: function() {
        if (this._iconThemeChangedId > 0) {
            let cache = St.TextureCache.get_default();
            cache.disconnect(this._iconThemeChangedId);
            this._iconThemeChangedId = 0;
        }
    },

    _onIconThemeChanged: function() {
        this._createIconTexture(this.iconSize);
    }
});

const IconGrid = new Lang.Class({
    Name: 'IconGrid',

    _init: function(params) {
        params = Params.parse(params, { rowLimit: null,
                                        columnLimit: null,
                                        fillParent: false,
                                        xAlign: St.Align.MIDDLE,
                                        usePagination: false});
        this._rowLimit = params.rowLimit;
        this._colLimit = params.columnLimit;
        this._xAlign = params.xAlign;
        this._fillParent = params.fillParent;
        this._usePagination = params.usePagination;
        
        if(this._usePagination) {
            this._nPages = 0;
            //Set this variable properly before allocate function is called
            this._viewForPageSize = null;
            this._firstPagesItems = [];
        }
        this.actor = new St.BoxLayout({ style_class: 'icon-grid',
                                        vertical: true });

        // Pulled from CSS, but hardcode some defaults here
        this._spacing = 0;
        this._hItemSize = this._vItemSize = ICON_SIZE;
        this._grid = new Shell.GenericContainer();
        this.actor.add(this._grid, { expand: true, y_align: St.Align.START });
        this.actor.connect('style-changed', Lang.bind(this, this._onStyleChanged));

        this._grid.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._grid.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._grid.connect('allocate', Lang.bind(this, this._allocate));
        
    },

    _getPreferredWidth: function (grid, forHeight, alloc) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return;

        let children = this._grid.get_children();
        let nColumns = this._colLimit ? Math.min(this._colLimit,
                children.length)
                : children.length;
        let spacing = this._fixedSpacing ? this._fixedSpacing : this._spacing;
        let totalSpacing = Math.max(0, nColumns - 1) * spacing;
        // Kind of a lie, but not really an issue right now.  If
        // we wanted to support some sort of hidden/overflow that would
        // need higher level design
        alloc.min_size = this._hItemSize;
        alloc.natural_size = nColumns * this._hItemSize + totalSpacing;
    },

    _getVisibleChildren: function() {
        let children = this._grid.get_children();
        children = children.filter(function(actor) {
            return actor.visible;
        });
        return children;
    },

    _getPreferredHeight: function (grid, forWidth, alloc) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return;

        let children = this._getVisibleChildren();
        let nColumns, spacing;
        if (forWidth < 0) {
            nColumns = children.length;
        } else {
            [nColumns, ] = this._computeLayout(forWidth);
        }
        
        let spacing = this._fixedSpacing ? this._fixedSpacing : this._spacing;
        
        let nRows;
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        let totalSpacing = Math.max(0, nRows - 1) * spacing;
        let height = nRows * this._vItemSize + totalSpacing;
        
        if(this._usePagination && this._nPages) {
            alloc.min_size = this._rowsPerPage * this._spacePerRow * this._nPages + this._spaceBetweenPagesTotal;
            alloc.natural_size = this._rowsPerPage * this._spacePerRow * this._nPages + this._spaceBetweenPagesTotal;
            return;
        }
        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _allocate: function (grid, box, flags) {
        if(this._fillParent) {
            // Reset the passed in box to fill the parent
            let parentBox = this.actor.get_parent().allocation;
            let gridBox = this.actor.get_theme_node().get_content_box(parentBox);
            box = this._grid.get_theme_node().get_content_box(gridBox);
        }

        let children = this._getVisibleChildren();
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        global.log("Size " + [availWidth, availHeight]);
        let spacing = this._fixedSpacing ? this._fixedSpacing : this._spacing;
        let [nColumns, usedWidth] = this._computeLayout(availWidth);        
        if(this._usePagination) {
            // ScrollView height
            let parentBox = this._viewForPageSize.allocation;
            let gridBox = this.actor.get_theme_node().get_content_box(parentBox);
            let customBox = this._grid.get_theme_node().get_content_box(gridBox);
            let availWidth = customBox.x2 - customBox.x1;
            let availHeightPerPage = customBox.y2 - customBox.y1;
            let nRows;
            if (nColumns > 0)
                nRows = Math.ceil(children.length / nColumns);
            else
                nRows = 0;
            if (this._rowLimit)
                nRows = Math.min(nRows, this._rowLimit);
            let oldNPages = this._nPages;
            global.log("NPAGES!!! " + this._nPages);
            this._calculatePaginationValues(availHeightPerPage, nColumns, nRows);
            if(oldNPages != this._nPages) {
                global.log("Next relayout");
                this.emit('n-pages-changed', this._nPages);
                Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, function() {
                    this._grid.queue_relayout();
                    return false;
                }));
            }
        }
        global.log("ICONGRID spacing " + spacing);
        let leftPadding;
        switch(this._xAlign) {
            case St.Align.START:
                leftPadding = 0;
                break;
            case St.Align.MIDDLE:
                leftPadding = Math.floor((availWidth - usedWidth) / 2);
                break;
            case St.Align.END:
                leftPadding = availWidth - usedWidth;
        }

        let x = box.x1 + leftPadding;
        let y = box.y1;
        let columnIndex = 0;
        let rowIndex = 0;
        
        if(children.length > 0) {
            this._firstPagesItems = [children[0]];
        }
        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildrenBox(children[i], x, y);
            if(!this._usePagination) {
                if (this._rowLimit && rowIndex >= this._rowLimit ||
                        this._fillParent && childBox.y2 >= availHeight) {
                    this._grid.set_skip_paint(children[i], true);
                } else {
                    global.log("childBox.y2 "+ [childBox.y1, childBox.y2, availHeight]);
                    children[i].allocate(childBox, flags);
                    this._grid.set_skip_paint(children[i], false);
                }
            } else {
                global.log("PAginatio childBox.y2 "+ [childBox.y1, childBox.y2, availHeight]);
                children[i].allocate(childBox, flags);
                this._grid.set_skip_paint(children[i], false);
            }
            
            columnIndex++;
            if (columnIndex == nColumns) {
                columnIndex = 0;
                rowIndex++;
            }

            if (columnIndex == 0) {
                y += this._vItemSize + spacing;
                if(this._usePagination) {
                    if((i + 1) % this._childrenPerPage == 0) {
                        y+= this._spaceBetweenPages;
                        if(i < children.length) {
                            this._firstPagesItems.push(children[i+1]);
                        }
                    }
                }
                x = box.x1 + leftPadding;
            } else {
                x += this._hItemSize + spacing;
            }
        }
        
    },
    
    _calculatePaginationValues: function (availHeightPerPage, nColumns, nRows) {
        let spacing = this._fixedSpacing ? this._fixedSpacing : this._spacing;
        global.log("### CALCULATING PAGES ###");
        global.log("availHeightPerPage "+ availHeightPerPage);
        global.log("nColumns "+ nColumns);
        global.log("nRows "+ nRows);
        global.log("spacing "+ spacing);
        this._spacePerRow = this._vItemSize + spacing;
        global.log("this._spacePerRow "+ this._spacePerRow);
        this._rowsPerPage = Math.floor(availHeightPerPage / this._spacePerRow);
        // Check if deleting spacing from bottom there's enough space for another row
        let spaceWithOneMoreRow = (this._rowsPerPage + 1) * this._spacePerRow - spacing;
        this._rowsPerPage = spaceWithOneMoreRow <= availHeightPerPage? this._rowsPerPage + 1 : this._rowsPerPage;
        global.log("this._rowsPerPage "+ this._rowsPerPage);
        this._nPages = Math.ceil(nRows / this._rowsPerPage);
        this._spaceBetweenPages = availHeightPerPage - (this._rowsPerPage * (this._vItemSize + spacing));
        this._spaceBetweenPagesTotal = this._spaceBetweenPages * (this._nPages);
        this._childrenPerPage = nColumns * this._rowsPerPage;
    },
    
    _calculateChildrenBox: function(child, x, y) {
        let [childMinWidth, childMinHeight, childNaturalWidth, childNaturalHeight]
        = child.get_preferred_size();

        /* Center the item in its allocation horizontally */
        let width = Math.min(this._hItemSize, childNaturalWidth);
        let childXSpacing = Math.max(0, width - childNaturalWidth) / 2;
        let height = Math.min(this._vItemSize, childNaturalHeight);
        let childYSpacing = Math.max(0, height - childNaturalHeight) / 2;
    
        let childBox = new Clutter.ActorBox();
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL) {
            let _x = box.x2 - (x + width);
            childBox.x1 = Math.floor(_x - childXSpacing);
        } else {
            childBox.x1 = Math.floor(x + childXSpacing);
        }
        childBox.y1 = Math.floor(y + childYSpacing);
        childBox.x2 = childBox.x1 + width;
        childBox.y2 = childBox.y1 + height;
        return childBox;
    },
    
    childrenInRow: function(rowWidth) {
        return this._computeLayout(rowWidth)[0];
    },

    getRowLimit: function() {
        return this._rowLimit;
    },
    
    _computeLayout: function (forWidth) {
        let nColumns = 0;
        let usedWidth = 0;
        let spacing = this._fixedSpacing ? this._fixedSpacing : this._spacing;

        while ((this._colLimit == null || nColumns < this._colLimit) &&
               (usedWidth + this._hItemSize <= forWidth)) {
            usedWidth += this._hItemSize + spacing;
            nColumns += 1;
        }

        if (nColumns > 0)
            usedWidth -= spacing;

        return [nColumns, usedWidth];
    },

    _onStyleChanged: function() {
        let themeNode = this.actor.get_theme_node();
        this._spacing = themeNode.get_length('spacing');
        this._hItemSize = themeNode.get_length('-shell-grid-horizontal-item-size') || ICON_SIZE;
        this._vItemSize = themeNode.get_length('-shell-grid-vertical-item-size') || ICON_SIZE;
        this._grid.queue_relayout();
    },

    removeAll: function() {
        this._grid.destroy_all_children();
    },

    addItem: function(actor, index) {
        if (index !== undefined)
            this._grid.insert_child_at_index(actor, index);
        else
            this._grid.add_actor(actor);
    },

    getItemAtIndex: function(index) {
        return this._grid.get_child_at_index(index);
    },

    visibleItemsCount: function() {
        return this._grid.get_n_children() - this._grid.get_n_skip_paint();
    },
    
    nPages: function() {
        return this._nPages;
    },

    getPagePosition: function(pageNumber) {
        if(!this._nPages)
            return;
        if(pageNumber < 0 || pageNumber > this._nPages) {
            throw new Error('Invalid page number ' + pageNumber);
        }
        let childBox = this._firstPagesItems[pageNumber].get_allocation_box();
        return [childBox.x1, childBox.y1];
    },
    
    setSpacing: function(spacing) {
            this._fixedSpacing = spacing;
            /*Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, function() {
                this._grid.queue_relayout();
                return false;
            }));*/
    },
    
    getSpacing: function() {
        return this._fixedSpacing ? this._fixedSpacing : this._spacing;
    },
    
});
Signals.addSignalMethods(IconGrid.prototype);
