import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, StickyNote, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DIFFICULTY_LABEL_KEY } from '../core/difficulty';
import { prettyLink } from '../core/prettyLink';
import type { ChecklistEntry } from '../core/types';
import { useLocale } from '../i18n/react';
import { linkLabel } from './EntryDialog';

export interface CardProps {
  /** The entry to render; its `note` and `linkAuthors` are optional and may be absent. */
  entry: ChecklistEntry;
  /** The 0-based index within the zone; the number shown is index + 1 (the index isn't persisted, CODING_PLAN §5.2) */
  index: number;
  /** Click the edit button to open the dialog and change this entry. */
  onEdit(entry: ChecklistEntry): void;
  /** Delete this entry. The two-step confirm finishes inside the card before this is called. */
  onDelete(id: string): void;
  /** The note was changed (clearing the note passes an empty string). */
  onNoteChange(id: string, note: string): void;
}

/** A single card (CODING_PLAN §5.2): ⋮⋮ drag handle, index, summary, example links, note. */
export function Card({ entry, index, onEdit, onDelete, onNoteChange }: CardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.id });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useLocale();

  // Auto-revert the delete state if it isn't confirmed within 3 seconds, so a misclick doesn't leave it stuck in the dangerous state
  useEffect(() => {
    if (!confirmingDelete) return;
    // Don't call it `t` -- the translation function above already owns that name (it used to be `t`, which collided when i18n was added)
    const timer = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  useEffect(() => {
    if (noteDraft !== null) noteRef.current?.focus();
  }, [noteDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveNote = () => {
    if (noteDraft === null) return;
    const next = noteDraft.trim();
    if (next !== (entry.note ?? '')) onNoteChange(entry.id, next);
    setNoteDraft(null);
  };

  return (
    <li
      ref={setNodeRef}
      className={`card${isDragging ? ' card--dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-entry-id={entry.id}
    >
      <div className="card__head">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="card__handle"
          aria-label={t('card.dragLabel', {
            summary: entry.summary.slice(0, 20) || t('common.noSummary'),
          })}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>

        <span className="card__index">#{index + 1}</span>

        <span className="card__summary">{entry.summary || t('common.noSummary')}</span>

        {/* The tier is only meaningful on Individual entries; General ones keep the value in
            the data but show nothing (see ChecklistEntry.difficulty). */}
        {entry.difficulty && entry.scope === 'individual' ? (
          <span className="card__diff" data-difficulty={entry.difficulty}>
            <span className="card__diff-bar" aria-hidden="true" />
            {t(DIFFICULTY_LABEL_KEY[entry.difficulty])}
          </span>
        ) : null}

        <button
          type="button"
          className="card__iconbtn"
          aria-label={t('card.editAria')}
          title={t('card.edit')}
          onClick={() => onEdit(entry)}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={`card__iconbtn${confirmingDelete ? ' card__iconbtn--danger' : ''}`}
          aria-label={confirmingDelete ? t('card.confirmDelete') : t('card.deleteAria')}
          title={confirmingDelete ? t('card.confirmTitle') : t('card.delete')}
          onClick={() => (confirmingDelete ? onDelete(entry.id) : setConfirmingDelete(true))}
        >
          {confirmingDelete ? (
            <span className="card__confirm">{t('card.confirm')}</span>
          ) : (
            <Trash2 size={14} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Links and note share one row: the note button is pushed all the way right. When there
          are no links this row is just the note button, so it doesn't take a row's height of
          its own -- cards are scanned one by one, and saving a row vertically saves a row of
          visual noise. */}
      <div className="card__links">
        {entry.links.map((link, i) => (
          <a
            key={`${link}-${i}`}
            className="card__link"
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            title={link}
          >
            <span className="card__linkidx">{linkLabel(i)}</span>
            {linkAuthorName(entry, link, i) ?? prettyLink(link)}
          </a>
        ))}

        {noteDraft === null ? (
          <button
            type="button"
            className={`card__notebtn${entry.note ? '' : ' card__notebtn--empty'}`}
            onClick={() => setNoteDraft(entry.note ?? '')}
            title={entry.note ?? t('card.addNote')}
          >
            <StickyNote size={12} aria-hidden="true" />
            {entry.note ? (
              <span className="card__notepreview">{entry.note}</span>
            ) : (
              t('card.note')
            )}
          </button>
        ) : null}
      </div>

      {noteDraft !== null ? (
        <div className="card__noteedit">
          <textarea
            ref={noteRef}
            className="mc-textarea card__noteta"
            value={noteDraft}
            placeholder={t('card.notePlaceholder')}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNoteDraft(null);
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                saveNote();
              }
            }}
          />
          <div className="card__noteactions">
            <button type="button" className="btn" onClick={() => setNoteDraft(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn--accent" onClick={saveNote}>
              {t('card.saveNote')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The author name shown on a link button (CODING_PLAN §8.4).
 *
 * Two levels of source, preferring the link's own: first check `linkAuthors[url]` (resolved
 * from osu when this link was entered in the dialog), and only fall back to the entry-level
 * `sourceAuthor` when that's missing -- that one is the author the content script read
 * straight off the discussion page, carried along at creation time with no request needed.
 * The fallback applies to the first link only: the later links have no reason to share an
 * author.
 *
 * @param entry the entry
 * @param link the link URL
 * @param index the link's 0-based index within the entry
 * @returns the author name; undefined when there isn't one
 */
export function linkAuthorName(
  entry: ChecklistEntry,
  link: string,
  index: number,
): string | undefined {
  const perLink = entry.linkAuthors?.[link]?.username;
  if (perLink) return perLink;
  return index === 0 ? entry.sourceAuthor?.username : undefined;
}

