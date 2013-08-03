// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Meta = imports.gi.Meta;

const Signals = imports.signals;
const Lang = imports.lang;
const Params = imports.misc.params;

const ICON_SIZE = 96;
const MIN_ICON_SIZE = 16;

const BaseIcon = new Lang.Class({
    Name: 'BaseIcon',

    _init : function(label, params) {
        params = Params.parse(params, { createIcon: null,
                                        setSizeManually: false,
                                        showLabel: true });
        let binParams = { style_class: 'overview-icon',
                x_fill: true,
                y_fill: true };
        if(params['showLabel'])
            binParams['style_class'] = 'overview-icon-with-label';
        this.actor = new St.Bin(binParams);
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
        this._getPreferredHeight(null, forHeight, alloc);
        /*let minLabelWidth = 0;
        let natLabelWidth = 0;
        if(this.label)
            [minLabelWidth, natLabelWidth] = this.label.get_preferred_width(forHeight);

        let [minIconWidth, natIconWidth] = this._iconBin.get_preferred_width(forHeight);
        // We want square containers, so take the largest
        let simAlloc = new Object();
        this._getPreferredHeight(null, forHeight, simAlloc);
        alloc.min_size = Math.max(simAlloc.min_size, Math.max(minLabelWidth, minIconWidth));
        alloc.natural_size = Math.max(simAlloc.natural_size, Math.max(natLabelWidth, natIconWidth));*/
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
                                        minRows: 1,
                                        minColumns: 1,
                                        fillParent: false,
                                        xAlign: St.Align.MIDDLE,
                                        usePagination: false,
                                        useSurroundingSpacing: true});
        this._rowLimit = params.rowLimit;
        this._colLimit = params.columnLimit;
        this._minRows = params.minRows;
        this._minColumns = params.minColumns;
        this._xAlign = params.xAlign;
        this._fillParent = params.fillParent;
        this._usePagination = params.usePagination;
        this._useSurroundingSpacing = params.useSurroundingSpacing;
        
        this.top_padding = 0;
        this.bottom_padding = 0;
        this.right_padding = 0;
        this.left_padding = 0;
        
        if(this._usePagination) {
            this._nPages = 0;
            this._firstPagesItems = [];
        }
        this.actor = new St.BoxLayout({ style_class: 'icon-grid',
                                        vertical: true });
        this._items = [];
        // Pulled from CSS, but hardcode some defaults here
        this._spacing = 0;
        this._hItemSize = this._vItemSize = ICON_SIZE;
        this._fixedHItemSize = this._fixedVItemSize = undefined;
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
        let totalSpacing = Math.max(0, nColumns - 1) * this.getSpacing();
        // Kind of a lie, but not really an issue right now.  If
        // we wanted to support some sort of hidden/overflow that would
        // need higher level design
        alloc.min_size = this.getHItemSize() + this.left_padding + this.right_padding;
        alloc.natural_size = nColumns * this.getHItemSize() + totalSpacing + this.left_padding + this.right_padding;
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
        let spacing = this.getSpacing();
        
        let nRows;
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        let totalSpacing = Math.max(0, nRows - 1) * spacing;
        let height = nRows * this.getVItemSize() + totalSpacing + this.top_padding + this.bottom_padding;     
        if(this._usePagination && this._nPages) {
            alloc.min_size =  this.usedHeightPerPage() * this._nPages + this._spaceBetweenPagesTotal;
            alloc.natural_size = this.usedHeightPerPage() * this._nPages + this._spaceBetweenPagesTotal;
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
        let spacing = this.getSpacing();
        let [nColumns, usedWidth] = this._computeLayout(availWidth);
        let leftEmptySpace;
        switch(this._xAlign) {
            case St.Align.START:
                leftEmptySpace = 0;
                break;
            case St.Align.MIDDLE:
                leftEmptySpace = Math.floor((availWidth - usedWidth) / 2);
                break;
            case St.Align.END:
                leftEmptySpace = availWidth - usedWidth;
        }
        
        let x = box.x1 + leftEmptySpace + this.left_padding;
        let y = box.y1 + this.top_padding;
        let columnIndex = 0;
        let rowIndex = 0;
        if(this._usePagination && children.length > 0) {
            this._firstPagesItems = [children[0]];
        }
        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildrenBox(children[i], x, y, box);
            if(children[i].translate_y) {
                childBox.y1 += children[i].translate_y;
                childBox.y2 += children[i].translate_y;
            }
            if(!this._usePagination) {
                if (this._rowLimit && rowIndex >= this._rowLimit ||
                        this._fillParent && childBox.y2 > availHeight - this.bottom_padding) {
                    this._grid.set_skip_paint(children[i], true);
                } else {
                    children[i].allocate(childBox, flags);
                    this._grid.set_skip_paint(children[i], false);
                }
            } else {
                children[i].allocate(childBox, flags);
                this._grid.set_skip_paint(children[i], false);
            }
            
            columnIndex++;
            if (columnIndex == nColumns) {
                columnIndex = 0;
                rowIndex++;
            }

            if (columnIndex == 0) {
                y += this.getVItemSize() + spacing;
                if(this._usePagination) {
                    if((i + 1) % this._childrenPerPage == 0) {
                        y+= this._spaceBetweenPages + this.top_padding;
                        if(i < children.length) {
                            this._firstPagesItems.push(children[i+1]);
                        }
                    }
                }
                x = box.x1 + leftEmptySpace + this.left_padding;
            } else {
                x += this.getHItemSize() + spacing;
            }
        }
    },
    
    _calculatePaginationValues: function (availWidthPerPage, availHeightPerPage) {
        let [nColumns, usedWidth] = this._computeLayout(availWidthPerPage);
        let nRows;
        let children = this._getVisibleChildren();
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        let oldHeightUsedPerPage = this.usedHeightPerPage();
        let oldNPages = this._nPages;
        
        let spacing = this.getSpacing();
        this._spacePerRow = this.getVItemSize() + spacing;
        // We want to contain the grid inside the parent box with padding
        availHeightPerPage -= this.top_padding + this.bottom_padding;
        this._rowsPerPage = Math.floor(availHeightPerPage / this._spacePerRow);
        // Check if deleting spacing from bottom there's enough space for another row
        let spaceWithOneMoreRow = (this._rowsPerPage + 1) * this._spacePerRow - spacing;
        this._rowsPerPage = spaceWithOneMoreRow <= availHeightPerPage? this._rowsPerPage + 1 : this._rowsPerPage;
        this._nPages = Math.ceil(nRows / this._rowsPerPage);
        this._spaceBetweenPages = availHeightPerPage - (this._rowsPerPage * (this.getVItemSize() + spacing) - spacing);
        this._spaceBetweenPagesTotal = this._spaceBetweenPages * (this._nPages);
        this._childrenPerPage = nColumns * this._rowsPerPage;

        // Take into account when the number of pages changed (then the height of the entire grid changed for sure)
        // and also when the spacing is changed, sure the hegiht per page changed and the entire grid height changes, althougt
        // maybe the number of pages doesn't change
        if(oldNPages != this._nPages || oldHeightUsedPerPage != this.usedHeightPerPage()) {
            this.emit('n-pages-changed', this._nPages);
            /*Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, function() {
                this._grid.queue_relayout();
                return false;
            }));*/
        }
    },
    
    _calculateChildrenBox: function(child, x, y, box) {
        let [childMinWidth, childMinHeight, childNaturalWidth, childNaturalHeight]
        = child.get_preferred_size();

        /* Center the item in its allocation horizontally */
        let width = Math.min(this.getHItemSize(), childNaturalWidth);
        let childXSpacing = Math.max(0, width - childNaturalWidth) / 2;
        let height = Math.min(this.getVItemSize(), childNaturalHeight);
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

    _computeLayout: function (forWidth) {
        let nColumns = 0;
        let usedWidth = this.left_padding + this.right_padding;
        let spacing = this.getSpacing();
        while ((this._colLimit == null || nColumns < this._colLimit) &&
               (usedWidth + this.getHItemSize() <= forWidth)) {
            usedWidth += this.getHItemSize() + spacing;
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
    
    columnsForWidth: function(rowWidth) {
        return this._computeLayout(rowWidth)[0];
    },

    getRowLimit: function() {
        return this._rowLimit;
    },

    nUsedRows: function(forWidth) {
        let children = this._getVisibleChildren();
        let nColumns;
        if (forWidth < 0) {
            nColumns = children.length;
        } else {
            [nColumns, ] = this._computeLayout(forWidth);
        }
        let nRows;
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        return nRows;
    },

    rowsForHeight: function(forHeight) {
        forHeight -= this.top_padding + this.bottom_padding;
        let spacePerRow = this.getVItemSize() + this.getSpacing();
        let rowsPerPage = Math.floor(forHeight / spacePerRow);
        // Check if deleting spacing from bottom there's enough space for another row
        let spaceWithOneMoreRow = (rowsPerPage + 1) * spacePerRow - this.getSpacing();
        rowsPerPage = spaceWithOneMoreRow <= forHeight? rowsPerPage + 1 : rowsPerPage;
        return rowsPerPage;
    },

    usedHeightForNRows: function(nRows) {
        let spacePerRow = this.rowHeight();
        return spacePerRow * nRows - this.getSpacing() + this.top_padding + this.bottom_padding;
    },

    usedHeightPerPage: function() {
        return this._rowsPerPage * this._spacePerRow - this.getSpacing() + this.top_padding + this.bottom_padding;
    },

    usedWidth: function(forWidth) {
        let columnsForWidth = this.columnsForWidth(forWidth);
        let usedWidth = columnsForWidth  * (this.getHItemSize() + this.getSpacing());
        usedWidth -= this.getSpacing();
        return usedWidth + this.left_padding + this.right_padding;
    },
    
    usedWidthForNColumns: function(columns) {
        let usedWidth = columns  * (this.getHItemSize() + this.getSpacing());
        usedWidth -= this.getSpacing();
        return usedWidth + this.left_padding + this.right_padding;
    },

    removeAll: function() {
        this._items = [];
        this._grid.destroy_all_children();
    },

    addItem: function(item, index) {
        this._items.push(item);
        if (index !== undefined)
            this._grid.insert_child_at_index(item.actor, index);
        else
            this._grid.add_actor(item.actor);
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
        return [childBox.x1 - this.top_padding, childBox.y1 - this.top_padding];
    },
    
    setSpacing: function(spacing) {
            this._fixedSpacing = spacing;
    },
    
    getSpacing: function() {
        return this._fixedSpacing ? this._fixedSpacing : this._spacing;
    },
    
    getHItemSize: function() {
        return this._fixedHItemSize ? this._fixedHItemSize : this._hItemSize;
    },
    
    getVItemSize: function() {
        return this._fixedVItemSize ? this._fixedVItemSize : this._vItemSize;
    },

    /**
     * This function is intended to use before iconGrid allocation, to know how much spacing can we have at the grid
     * but also to set manually the top/bottom rigth/left padding accordnly to the spacing calculated here.
     * To take into account the spacing also for before the first row and for after the last row mark usingSurroundingSpacing true
     * This function doesn't take into account the dynamic padding rigth now, since in fact we want to calculate also that.
     */
    maxSpacingForWidthHeight: function(availWidth, availHeight) {
        // Maximum spacing will be the icon item size. It doesn't make any sense to have more spacing than items.
        let maxSpacing = Math.floor(Math.min(this.getVItemSize(), this.getHItemSize()));
        let minEmptyVerticalArea = (availHeight - this._minRows * this.getVItemSize());
        let minEmptyHorizontalArea = (availWidth - this._minColumns * this.getHItemSize());
        let spacing;
        if(this._useSurroundingSpacing) {
            // minRows + 1 because we want to put spacing before the first row, so it is like we have one more row
            // to divide the empty space
            let maxSpacingForRows = Math.floor(minEmptyVerticalArea / (this._minRows +1));
            let maxSpacingForColumns = Math.floor(minEmptyHorizontalArea / (this._minColumns +1));
            let spacingToEnsureMinimums = Math.min(maxSpacingForRows, maxSpacingForColumns);
            let spacingNotTooBig = Math.min(spacingToEnsureMinimums, maxSpacing);
            spacing = Math.max(this._spacing, spacingNotTooBig);
        } else {
            let maxSpacingForRows, maxSpacingForColumns;
            if(this._minRows == 1) {
                maxSpacingForRows = Math.floor(minEmptyVerticalArea / this._minRows);
                maxSpacingForColumns = Math.floor(minEmptyHorizontalArea / this._minColumns);
            } else {
                maxSpacingForRows = Math.floor(minEmptyVerticalArea / (this._minRows - 1));
                maxSpacingForColumns = Math.floor(minEmptyHorizontalArea / (this._minColumns - 1));
            }
            let spacingToEnsureMinimums = Math.min(maxSpacingForRows, maxSpacingForColumns);
            let spacingNotTooBig = Math.min(spacingToEnsureMinimums, maxSpacing);
            spacing = Math.max(this._spacing, spacingNotTooBig); 
        }
        return spacing;
    },
    
    calculateResponsiveGrid: function(availWidth, availHeight) {
        this._fixedHItemSize = this._hItemSize;
        this._fixedVItemSize = this._vItemSize;

        let spacing = this.maxSpacingForWidthHeight(availWidth, availHeight);
        this.setSpacing(spacing);
        if(this._useSurroundingSpacing)
            this.top_padding = this.bottom_padding = this.right_padding = this.left_padding = spacing;

        let count = 0;
        if(this.columnsForWidth(availWidth) < this._minColumns || this.rowsForHeight(availHeight) < this._minRows) {
            let neededWidth, neededHeight;
            if(this._useSurroundingSpacing)
                neededWidth = this.usedWidthForNColumns(this._minColumns) - availWidth ;
            else
                neededWidth = this.usedWidthForNColumns(this._minColumns) - availWidth ;

            if(this._useSurroundingSpacing)
                neededHeight = this.usedHeightForNRows(this._minRows) - availHeight;
            else
                neededHeight = this.usedHeightForNRows(this._minRows) - availHeight ;

            if(neededWidth > neededHeight) {
                let neededSpaceForEachItem = Math.ceil(neededWidth / this._minColumns);
                this._fixedHItemSize = this._hItemSize - neededSpaceForEachItem;
                this._fixedVItemSize = this._vItemSize - neededSpaceForEachItem;
            } else {
                let neededSpaceForEachItem = Math.ceil(neededHeight / this._minRows);
                this._fixedHItemSize = this._hItemSize - neededSpaceForEachItem;
                this._fixedVItemSize = this._vItemSize - neededSpaceForEachItem;
            }
            
            if(this._fixedHItemSize < MIN_ICON_SIZE)
                this._fixedHItemSize = MIN_ICON_SIZE;
            if(this._fixedVItemSize < MIN_ICON_SIZE)
                this._fixedVItemSize = MIN_ICON_SIZE;
            
            let spacing = this.maxSpacingForWidthHeight(availWidth, availHeight);
            this.setSpacing(spacing);
            if(this._useSurroundingSpacing)
                this.top_padding = this.bottom_padding = this.right_padding = this.left_padding = spacing;
        }
        
        let scale = Math.min(this._fixedHItemSize, this._fixedVItemSize) / Math.max(this._hItemSize, this._vItemSize);
        this.updateChildrenScale(scale);
        if(this._usePagination)
            this._calculatePaginationValues(availWidth, availHeight);
    },
    /**
     * FLORIAN REVIEW
     * We are supossing that the this._items contain some item that we can set its size. 
     * Also, we suposse that they are icons, and the original size is ICON_SIZE, to let the good icon size when updating the size.
     * Also, we supose that we need a Meta.later, since when we call calculateResponsiveGrid that calls updateChildrenScale
     * we are inside the allocation of the AppDisplay, and modifinyg icon size can cause allocation cycles
     * So this functions is not intentded to be called outside this class, lets think a little about that. Now reescaling icons
     * works fine at least.
     */
    updateChildrenScale: function(scale) {
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this, function() {
            for(let i in this._items) {
                let newIconSize = Math.floor(ICON_SIZE * scale);
                this._items[i].setIconSize(newIconSize);
            }
        }));
    },
    
    pageRows: function(pageNumber) {
        let pagePosition = this.getPagePosition(pageNumber);
        let currentRowItemsYPosition = pagePosition;
        let rows = [];
        let currentItem = this._firstPagesItems[pageNumber];
        let children = this._grid.get_children();
        let index = 0;
        // Positioning to the first element of the page
        while(children[index] != this._firstPagesItems[pageNumber])
            index++;
        for( let rowIndex = 0; rowIndex < this._rowsPerPage && index < children.length; rowIndex++) {
            rows[rowIndex] = [];
            while(index < children.length && children[index].y == currentItem.y ) {
                rows[rowIndex].push(children[index]);
                index++;
            }
            currentItem = children[index];
        }
        return rows;
    },
    
    rowHeight: function() {
        return this.getVItemSize() + this.getSpacing();
    }
    
});
Signals.addSignalMethods(IconGrid.prototype);
