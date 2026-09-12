import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { Card } from '../components/Card';
import { EntryDialog, type EntryDialogDefaults } from '../components/EntryDialog';
import { showToast } from '../components/toast';
import { cellFromZoneDroppableId, isNoopDrop, resolveDrop, zoneDroppableId } from '../core/dnd';
import { SCOPE_LABEL_KEY, SCOPES, SOURCE_LABEL_KEY, SOURCES, locateEntry } from '../core/cells';
import { checklistStore } from '../core/store';
import type { CellId, ChecklistEntry, NewEntryInput } from '../core/types';
import { useLocale } from '../i18n/react';
import { recordDragEnd, recordDragOver, recordDragStart } from '../shared/dndTrace';
import { useChecklist, useHydrated, useTotalCount } from '../shared/useChecklist';
import { useOverflowsViewport } from './useOverflowsViewport';

/**
 * Anchor id for each zone (the jump buttons to the right of the column heading point at it).
 *
 * @param cell which of the four cells
 * @returns the zone's DOM id
 */
function zoneAnchorId(cell: CellId): string {
  return `zone-${cell}`;
}

/**
 * Whether the system has "reduce motion" turned on.
 *
 * @returns true when it's on, in which case scrolling should jump instead of smooth-scrolling
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Scroll to a zone.
 *
 * @param cell the cell to scroll to
 */
function scrollToZone(cell: CellId): void {
  document
    .getElementById(zoneAnchorId(cell))
    ?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/** Scroll back to the top of the page. */
function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** Current state of the entry dialog: creating, editing one entry, or closed. */
type DialogState =
  | { mode: 'create'; defaults: EntryDialogDefaults }
  | { mode: 'edit'; defaults: EntryDialogDefaults; editingId: string }
  | null;

/**
 * Drop detection: only looks at what the pointer is actually over, no nearest-neighbor.
 *
 * The reason we don't use closestCenter is that the four zones stack vertically. While
 * dragging, the card being dragged makes the list shorter, so a pointer that hasn't moved
 * can "fall into" the next zone -- the user just wanted to move the card further down in
 * this zone, but it gets read as a cross-zone move.
 *
 * @param args the collision scene dnd-kit passes in
 * @returns candidate drops; an empty array when the pointer is in the gap between zones, so the card snaps back
 */
const collisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const onCard = within.filter((c) => cellFromZoneDroppableId(String(c.id)) === null);
  if (onCard.length > 0) return [onCard[0]!];
  return within;
};

/**
 * Main Checklist page (CODING_PLAN §5).
 * Two columns (General / Individual) x two zones per column (Internal / External), one
 * DndContext for the whole page: each zone is a droppable, each card inside it is sortable,
 * and dragging across zones = changing scope/source.
 */
export function ChecklistView() {
  const hydrated = useHydrated();
  const total = useTotalCount();
  const { t } = useLocale();
  const cellsSnapshot = useChecklist((s) => s.doc.cells);
  // Jump/back-to-top only show up when the list is longer than one screen; on a short list there's nothing to jump to
  const overflows = useOverflowsViewport();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<CellId | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const sensors = useSensors(
    // Only attach listeners to the ⋮⋮ handle, plus a small movement threshold, so a click doesn't start a drag by accident
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!hydrated) {
    return (
      <main className="app__main">
        <p className="muted">{t('checklist.loading')}</p>
      </main>
    );
  }

  const cells = () => checklistStore.getState().doc.cells;

  const onDragStart = (e: DragStartEvent) => {
    recordDragStart(String(e.active.id));
    setActiveId(String(e.active.id));
  };

  const onDragOver = (e: DragOverEvent) => {
    const overId = e.over ? String(e.over.id) : null;
    recordDragOver(overId);
    const zone = cellFromZoneDroppableId(overId);
    setOverCell(zone ?? (overId ? locateEntry(cells(), overId)?.cell ?? null : null));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const current = cells();
    const overId = e.over ? String(e.over.id) : null;
    recordDragEnd(overId);
    const drop = resolveDrop(current, overId, id);
    setActiveId(null);
    setOverCell(null);

    if (!drop || isNoopDrop(current, id, drop)) return;

    const from = locateEntry(current, id);
    checklistStore.getState().moveEntry(id, drop.cell, drop.index);

    if (from && from.cell !== drop.cell) {
      const [scope, source] = drop.cell.split('-') as ['general' | 'individual', 'internal' | 'external'];
      showToast(
        t('checklist.movedTo', {
          scope: t(SCOPE_LABEL_KEY[scope]),
          source: t(SOURCE_LABEL_KEY[source]),
        }),
      );
    }
  };

  const activeFound = activeId ? locateEntry(cellsSnapshot, activeId) : null;
  const activeEntry: ChecklistEntry | null = activeFound?.entry ?? null;

  const submitDialog = (input: NewEntryInput) => {
    if (dialog?.mode === 'edit') {
      checklistStore.getState().updateEntry(dialog.editingId, {
        scope: input.scope,
        source: input.source,
        summary: input.summary,
        links: input.links ?? [],
        // Replaced wholesale (not "only include it when present"): after a link is deleted its
        // author has to go away too, otherwise it sticks around forever as an orphan key.
        linkAuthors: input.linkAuthors ?? {},
        note: input.note,
      });
      showToast(t('checklist.saved'));
    } else {
      checklistStore.getState().addEntry(input);
      showToast(t('checklist.added'));
    }
    setDialog(null);
  };

  return (
    <main className="app__main">
      <p className="view__meta">
        {t('checklist.meta1')}
        <strong>{total}</strong>
        {t('checklist.meta2')}
        <span aria-hidden="true">⋮⋮</span>
        {t('checklist.meta3')}
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        // Re-measure every zone's rect each frame. The default WhileDragging only measures at
        // the moment the drag starts, but here the layout can change mid-drag (another context
        // syncs an entry in, auto-scroll changes the viewport), and stale rects put the card
        // in the neighboring cell. The scale is "4 zones + N cards", so once a frame is cheap.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setOverCell(null);
        }}
      >
        <div className="cols">
          {SCOPES.map((scope) => (
            <section key={scope} className="col">
              <div className="col__head">
                <h2 className="col__heading">{t(SCOPE_LABEL_KEY[scope])}</h2>
                {overflows ? (
                  <div className="col__jump">
                    {SOURCES.map((source) => (
                      <button
                        key={source}
                        type="button"
                        className="col__jumpbtn"
                        onClick={() => scrollToZone(`${scope}-${source}`)}
                        title={t('checklist.jumpTo', {
                          scope: t(SCOPE_LABEL_KEY[scope]),
                          source: t(SOURCE_LABEL_KEY[source]),
                        })}
                      >
                        <ArrowDown size={12} aria-hidden="true" />
                        {t(SOURCE_LABEL_KEY[source])}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {SOURCES.map((source) => {
                const cell: CellId = `${scope}-${source}`;
                return (
                  <Zone
                    key={cell}
                    cell={cell}
                    isOver={overCell === cell && activeId !== null}
                    onAdd={() =>
                      setDialog({ mode: 'create', defaults: { scope, source } })
                    }
                    onEdit={(entry) =>
                      setDialog({
                        mode: 'edit',
                        editingId: entry.id,
                        defaults: {
                          scope: entry.scope,
                          source: entry.source,
                          summary: entry.summary,
                          links: entry.links,
                          linkAuthors: entry.linkAuthors,
                          note: entry.note,
                          sourceAuthor: entry.sourceAuthor,
                          meta: entry.meta,
                        },
                      })
                    }
                  />
                );
              })}
            </section>
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeEntry ? (
            <div className="card card--overlay">
              <span className="card__index">#{(activeFound?.index ?? 0) + 1}</span>
              <span className="card__summary">{activeEntry.summary || t('common.noSummary')}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Kept outside DndContext: it's fixed-positioned, and inside the drag container it would just be treated as a drop target */}
      {overflows ? (
        <button
          type="button"
          className="totop"
          onClick={scrollToTop}
          title={t('checklist.toTop')}
          aria-label={t('checklist.toTop')}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      ) : null}

      <EntryDialog
        open={dialog !== null}
        mode={dialog?.mode ?? 'create'}
        defaults={dialog?.defaults ?? { scope: 'general', source: 'internal' }}
        editingId={dialog?.mode === 'edit' ? dialog.editingId : undefined}
        onSubmit={submitDialog}
        onCancel={() => setDialog(null)}
      />
    </main>
  );
}

interface ZoneProps {
  /** Which of the four cells this zone is. */
  cell: CellId;
  /** A drag is currently hovering over this zone. */
  isOver: boolean;
  /** Click the "＋" in the zone to create an entry. */
  onAdd(): void;
  /** Click the edit button on a card to change that entry. */
  onEdit(entry: ChecklistEntry): void;
}

/** A zone: a header (source, count, add button) plus a list of cards. */
function Zone({ cell, isOver, onAdd, onEdit }: ZoneProps) {
  const entries = useChecklist((s) => s.doc.cells[cell]);
  const { setNodeRef } = useDroppable({ id: zoneDroppableId(cell) });
  const { t } = useLocale();
  const [scope, source] = cell.split('-') as ['general' | 'individual', 'internal' | 'external'];
  const scopeText = t(SCOPE_LABEL_KEY[scope]);
  const sourceText = t(SOURCE_LABEL_KEY[source]);

  return (
    // The id is used by the jump buttons to the right of the column heading: scroll-margin-top in CSS keeps it clear of the sticky top bar
    <div id={zoneAnchorId(cell)} className={`zone${isOver ? ' zone--over' : ''}`} data-cell={cell}>
      <div className="zone__head">
        <span className="zone__badge" data-source={source} aria-hidden="true" />
        <span className="zone__title">{sourceText}</span>
        <span className="zone__count">{entries.length}</span>
        <button
          type="button"
          className="zone__add"
          onClick={onAdd}
          title={t('checklist.addTo', { scope: scopeText, source: sourceText })}
          aria-label={t('checklist.addToAria', { scope: scopeText, source: sourceText })}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
        <ul className="zone__list" ref={setNodeRef} data-cell={cell}>
          {entries.length === 0 ? (
            <li className="zone__empty">
              {isOver ? (
                t('checklist.dropHere')
              ) : (
                <>
                  {/* The empty state is the handiest way in for "add": when there's nothing in the
                      zone the whole blank area just sits there, while the "＋" in the top right of
                      the zone header is only 22px and first-time users probably won't find it.
                      Once the empty state is filled in it disappears on its own, so it never
                      coexists with the "＋" as two long-term entry points. */}
                  <span>{t('checklist.dragHint', { source: sourceText })}</span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-action="zone-empty-add"
                    onClick={onAdd}
                    aria-label={t('checklist.addToAria', { scope: scopeText, source: sourceText })}
                  >
                    {t('checklist.addOne')}
                  </button>
                </>
              )}
            </li>
          ) : (
            entries.map((entry, i) => (
              <Card
                key={entry.id}
                entry={entry}
                index={i}
                onEdit={onEdit}
                onDelete={(id) => {
                  checklistStore.getState().removeEntry(id);
                  // The card disappearing is feedback in itself, but "it disappeared" and "I
                  // missed the click" look the same to the user -- especially on that two-step
                  // confirm button, which already changed appearance after the first click.
                  showToast(t('checklist.deleted'), 'info');
                }}
                onNoteChange={(id, note) => {
                  checklistStore.getState().updateEntry(id, { note: note || undefined });
                  // The note is edited in place: after the editor collapses all you get on the
                  // card is one more line of small text, so staying silent is easily read as
                  // "it didn't save".
                  showToast(t(note ? 'checklist.noteSaved' : 'checklist.noteCleared'), 'info');
                }}
              />
            ))
          )}
        </ul>
      </SortableContext>
    </div>
  );
}
