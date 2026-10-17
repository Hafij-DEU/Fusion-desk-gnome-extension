// Panel container with overflow-safe allocation.
//
// GNOME's Panel always centers the center box and clamps the side boxes to
// half of the remaining width, so a busy right box gets squeezed ("…").
// This row gives the left and right boxes their natural width first and
// slides (then shrinks) the center box so everything fits.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const GAP = 16;

export const PanelRow = GObject.registerClass(
class FusionPanelRow extends St.Widget {
    _init(params = {}) {
        super._init({reactive: true, track_hover: true, ...params});
        this._left = this._center = this._right = null;
    }

    setBoxes(left, center, right) {
        this._left = left;
        this._center = center;
        this._right = right;
        for (const box of [left, center, right]) {
            box.get_parent()?.remove_child(box);
            this.add_child(box);
        }
    }

    releaseBoxes() {
        const boxes = [this._left, this._center, this._right].filter(Boolean);
        for (const box of boxes)
            this.remove_child(box);
        this._left = this._center = this._right = null;
        return boxes;
    }

    vfunc_get_preferred_width(forHeight) {
        let min = 0, nat = 0;
        for (const box of [this._left, this._center, this._right]) {
            if (!box)
                continue;
            const [m, n] = box.get_preferred_width(forHeight);
            min += m;
            nat += n;
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(forWidth) {
        let min = 0, nat = 0;
        for (const box of [this._left, this._center, this._right]) {
            if (!box)
                continue;
            const [m, n] = box.get_preferred_height(-1);
            min = Math.max(min, m);
            nat = Math.max(nat, n);
        }
        return [min, nat];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        if (!this._left)
            return;

        const content = this.get_theme_node().get_content_box(box);
        const x0 = content.x1, w = content.x2 - content.x1;
        const y1 = content.y1, y2 = content.y2;

        let [, leftW] = this._left.get_preferred_width(-1);
        let [, centerW] = this._center.get_preferred_width(-1);
        let [, rightW] = this._right.get_preferred_width(-1);

        // Sides first; if even they do not fit, the left side gives way.
        rightW = Math.min(rightW, w);
        leftW = Math.min(leftW, Math.max(0, w - rightW));

        const minX = leftW > 0 ? leftW + GAP : 0;
        const maxX = w - (rightW > 0 ? rightW + GAP : 0);
        centerW = Math.max(0, Math.min(centerW, maxX - minX));

        // Center on the panel, then slide inside the free gap.
        let cx = Math.round((w - centerW) / 2);
        cx = Math.max(minX, Math.min(cx, maxX - centerW));

        const alloc = (actor, xa, xb) => {
            const b = new Clutter.ActorBox({x1: x0 + xa, y1, x2: x0 + Math.max(xa, xb), y2});
            actor.allocate(b);
        };
        alloc(this._left, 0, leftW);
        alloc(this._center, cx, cx + centerW);
        alloc(this._right, w - rightW, w);
    }
});
