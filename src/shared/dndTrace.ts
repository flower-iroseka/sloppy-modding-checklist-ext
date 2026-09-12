/**
 * Drag trace recording (debug only).
 *
 * dnd-kit's hit testing is a black box -- inside `onDragEnd`, only dnd-kit knows who `over` really
 * is. The e2e smoke scripts need that answer to explain "why did the card land in this cell";
 * without it they can only guess. Exposed only through window.__mc in `app.html?debug=1`.
 */
export interface DndTrace {
  /** The id of the item being dragged. null when not dragging. */
  active: string | null;
  /** The position id the most recent dragOver landed on. */
  over: string | null;
  /** The over at the moment the mouse was released -- it decides the final drop. */
  overAtEnd: string | null;
}

const trace: DndTrace = { active: null, over: null, overAtEnd: null };

/**
 * Record the start of a drag.
 *
 * @param id the id of the item being dragged
 */
export function recordDragStart(id: string | null): void {
  trace.active = id;
  trace.over = null;
  trace.overAtEnd = null;
}

/**
 * Record a drag passing over something.
 *
 * @param overId the position id currently hovered
 */
export function recordDragOver(overId: string | null): void {
  trace.over = overId;
}

/**
 * Record the end of a drag, clearing active while we're at it.
 *
 * @param overId the position id it landed on at release
 */
export function recordDragEnd(overId: string | null): void {
  trace.over = overId;
  trace.overAtEnd = overId;
  trace.active = null;
}

/**
 * Read the current trace.
 *
 * @returns a copy, so the caller can't modify the internal state
 */
export function readDndTrace(): DndTrace {
  return { ...trace };
}
