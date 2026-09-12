import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SCOPE_LABEL_KEY, SCOPES, SOURCE_LABEL_KEY, SOURCES } from '../core/cells';
import { findDuplicate } from '../core/dedupe';
import { parseAuthorLink, resolveLinkAuthor } from '../core/osuAuthor';
import type { EntryMeta, NewEntryInput, Scope, Source, SourceAuthor } from '../core/types';
import { useLocale } from '../i18n/react';
import { useChecklist } from '../shared/useChecklist';
import { Modal } from './Modal';

/** Circled digits used for link indices. */
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/**
 * The index marker in front of a link.
 *
 * @param index the link's 0-based index
 * @returns the circled digit; past 20 it falls back to the `(n)` notation
 */
export function linkLabel(index: number): string {
  return index < CIRCLED.length ? CIRCLED[index]! : `(${index + 1})`;
}

export interface EntryDialogDefaults {
  /** Which column it goes in. */
  scope: Scope;
  /** Which zone it goes in. */
  source: Source;
  /** Existing summary text; undefined (and then shown empty) when creating. */
  summary?: string;
  /** Existing links; empty when creating. */
  links?: string[];
  /** The existing "link -> author" map; carried in when editing so there's no re-resolving */
  linkAuthors?: Record<string, SourceAuthor>;
  /** Existing note; undefined when creating. */
  note?: string;
  /** Author read off the discussion page; passed through to the new entry on submit, never edited here. */
  sourceAuthor?: SourceAuthor;
  /** Beatmapset / difficulty context read off the page; passed through on submit. */
  meta?: EntryMeta;
}

/** The author resolution state for one link. `ok` isn't stored separately: once the author arrives it shows up as an entry in linkAuthors. */
type LinkProbe = 'pending' | 'none';

export interface EntryDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Whether this is a create or an edit. */
  mode: 'create' | 'edit';
  /** The initial values for each field when it opens. */
  defaults: EntryDialogDefaults;
  /** Excludes itself when editing, so it doesn't flag itself as a duplicate */
  editingId?: string;
  /** The source auto-detected from the author; shows "已按作者识别" when it equals the current selection */
  recommendedSource?: Source;
  /** The scope auto-detected from the discussion-page position; shows "已按位置识别" when it equals the current selection */
  recommendedScope?: Scope;
  /** Submit: hand off the filled-in content. */
  onSubmit(input: NewEntryInput): void;
  /** Cancel or close the dialog. */
  onCancel(): void;
}

/**
 * Create / edit dialog (CODING_PLAN §1.2, §5.3).
 * The app page's "＋" and the content script's "＋ 添加到 Checklist" share the same component
 * and the same set of fields.
 */
export function EntryDialog({
  open,
  mode,
  defaults,
  editingId,
  recommendedSource,
  recommendedScope,
  onSubmit,
  onCancel,
}: EntryDialogProps) {
  const cells = useChecklist((s) => s.doc.cells);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useLocale();

  const [scope, setScope] = useState<Scope>(defaults.scope);
  const [source, setSource] = useState<Source>(defaults.source);
  const [summary, setSummary] = useState(defaults.summary ?? '');
  const [links, setLinks] = useState<string[]>(defaults.links ?? []);
  const [linkAuthors, setLinkAuthors] = useState<Record<string, SourceAuthor>>(
    defaults.linkAuthors ?? {},
  );
  const [linkProbes, setLinkProbes] = useState<Record<string, LinkProbe>>({});
  const [note, setNote] = useState(defaults.note ?? '');

  // Reset from the current defaults each time it opens (the same instance gets reused over
  // and over). Only on the false->true edge of open: if defaults went into the dependencies it
  // would re-run on every render when the caller passes an object literal, wiping out what the
  // user is typing.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const d = defaultsRef.current;
      setScope(d.scope);
      setSource(d.source);
      setSummary(d.summary ?? '');
      setLinks(d.links ?? []);
      setLinkAuthors(d.linkAuthors ?? {});
      setLinkProbes({});
      setNote(d.note ?? '');
    }
    wasOpen.current = open;
  }, [open]);

  const cleanLinks = useMemo(
    () => links.map((l) => l.trim()).filter((l) => l.length > 0),
    [links],
  );

  /** Overlap check against existing entries' links (CODING_PLAN §2.3): a hit doesn't disable save, but it needs a clear notice. */
  const duplicate = useMemo(() => {
    if (cleanLinks.length === 0) return null;
    const hit = findDuplicate(cells, cleanLinks);
    return hit && hit.id !== editingId ? hit : null;
  }, [cells, cleanLinks, editingId]);

  const canSubmit = summary.trim().length > 0;

  /**
   * When a link loses focus, fetch that link's own author from osu (CODING_PLAN §8.4).
   *
   * Only links that can be pinned to a specific post are requested (the test is
   * `parseAuthorLink`): external docs, imgur, user profiles, discussion pages without a
   * number and the like can't be resolved anyway, so we don't even ask -- silence is less
   * intrusive than popping up a "解析失败". Results are keyed by URL, so changing the link
   * address makes the old author disappear naturally instead of getting attached to the
   * wrong thing.
   *
   * @param raw the raw text of that link in the input, trimmed first
   */
  const probeAuthor = useCallback(async (raw: string) => {
    const url = raw.trim();
    if (!url) return;
    if (!parseAuthorLink(url)) return;

    setLinkProbes((prev) => ({ ...prev, [url]: 'pending' }));
    const author = await resolveLinkAuthor(url);
    if (author) {
      setLinkAuthors((prev) => ({ ...prev, [url]: author }));
      setLinkProbes((prev) => {
        const next = { ...prev };
        delete next[url];
        return next;
      });
    } else {
      setLinkProbes((prev) => ({ ...prev, [url]: 'none' }));
    }
  }, []);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    // Keep only the links that are still there: after a link is deleted its author shouldn't stay in the data.
    const keptAuthors = Object.fromEntries(
      Object.entries(linkAuthors).filter(([url]) => cleanLinks.includes(url)),
    );
    onSubmit({
      scope,
      source,
      summary: summary.trim(),
      links: cleanLinks,
      linkAuthors: keptAuthors,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(defaults.sourceAuthor ? { sourceAuthor: defaults.sourceAuthor } : {}),
      ...(defaults.meta ? { meta: defaults.meta } : {}),
    });
  }, [canSubmit, onSubmit, scope, source, summary, cleanLinks, linkAuthors, note, defaults]);

  const patchLink = (index: number, value: string) =>
    setLinks((prev) => prev.map((l, i) => (i === index ? value : l)));

  return (
    <Modal
      open={open}
      title={t(mode === 'create' ? 'entry.titleCreate' : 'entry.titleEdit')}
      onClose={onCancel}
      initialFocusRef={summaryRef}
      footer={
        <>
          {duplicate ? (
            <span className="mc-field__hint">
              {t('entry.duplicateFooter', {
                summary: (duplicate.summary || t('common.noSummary')).slice(0, 24),
              })}
            </span>
          ) : null}
          <span className="mc-spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--accent"
            disabled={!canSubmit}
            title={canSubmit ? undefined : t('entry.summaryRequired')}
            onClick={submit}
          >
            {t(
              duplicate
                ? 'entry.submitDuplicate'
                : mode === 'create'
                  ? 'entry.submitAdd'
                  : 'entry.submitSave',
            )}
          </button>
        </>
      }
    >
      <div className="mc-field">
        <span className="mc-field__label">{t('entry.scopeLabel')}</span>
        <div className="mc-seg" role="group" aria-label={t('entry.scopeAria')}>
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              className={`mc-seg__opt${scope === s ? ' mc-seg__opt--on' : ''}`}
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
            >
              {t(SCOPE_LABEL_KEY[s])}
            </button>
          ))}
        </div>
        {recommendedScope && scope === recommendedScope ? (
          <span className="mc-rec">
            {t('entry.scopeDetected', { scope: t(SCOPE_LABEL_KEY[recommendedScope]) })}
          </span>
        ) : null}
      </div>

      <div className="mc-field">
        <span className="mc-field__label">{t('entry.sourceLabel')}</span>
        <div className="mc-seg" role="group" aria-label={t('entry.sourceAria')}>
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              className={`mc-seg__opt${source === s ? ' mc-seg__opt--on' : ''}`}
              aria-pressed={source === s}
              onClick={() => setSource(s)}
            >
              {t(SOURCE_LABEL_KEY[s])}
            </button>
          ))}
        </div>
        {recommendedSource && source === recommendedSource ? (
          <span className="mc-rec">
            {t('entry.sourceDetected', { source: t(SOURCE_LABEL_KEY[recommendedSource]) })}
          </span>
        ) : null}
      </div>

      <div className="mc-field">
        <label className="mc-field__label" htmlFor="mc-summary">
          {t('entry.summaryLabel')}
        </label>
        <textarea
          id="mc-summary"
          ref={summaryRef}
          className="mc-textarea"
          value={summary}
          placeholder={t('entry.summaryPlaceholder')}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <div className="mc-field">
        <span className="mc-field__label">{t('entry.linksLabel')}</span>
        {links.map((link, i) => {
          const url = link.trim();
          const author = linkAuthors[url];
          const probe = linkProbes[url];
          return (
            <div className="mc-linkrow" key={i}>
              <span className="mc-linkrow__idx">{linkLabel(i)}</span>
              <input
                className="mc-input"
                type="url"
                value={link}
                placeholder="https://osu.ppy.sh/beatmapsets/…"
                onChange={(e) => patchLink(i, e.target.value)}
                onBlur={(e) => void probeAuthor(e.target.value)}
              />
              {author ? (
                <span
                  className="mc-linkrow__author"
                  title={t('entry.linkAuthorTitle', { name: author.username })}
                >
                  {author.username}
                </span>
              ) : probe === 'pending' ? (
                <span className="mc-linkrow__author mc-linkrow__author--dim">
                  {t('entry.authorLoading')}
                </span>
              ) : probe === 'none' ? (
                <span
                  className="mc-linkrow__author mc-linkrow__author--dim"
                  title={t('entry.authorUnknownTitle')}
                >
                  {t('entry.authorUnknown')}
                </span>
              ) : null}
              <button
                type="button"
                className="mc-iconbtn"
                aria-label={t('entry.removeLink', { n: i + 1 })}
                onClick={() => setLinks((prev) => prev.filter((_, x) => x !== i))}
              >
                ✕
              </button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => setLinks((prev) => [...prev, ''])}
          >
            {t('entry.addLink')}
          </button>
        </div>
        {duplicate ? (
          <p className="mc-alert">
            <strong>{t('entry.duplicateHead')}</strong>
            {duplicate.summary || t('common.noSummary')}
            <br />
            {t('entry.duplicateTail')}
          </p>
        ) : null}
      </div>

      <div className="mc-field">
        <label className="mc-field__label" htmlFor="mc-note">
          {t('entry.noteLabel')}
        </label>
        <textarea
          id="mc-note"
          className="mc-textarea"
          value={note}
          placeholder={t('entry.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {defaults.sourceAuthor || defaults.meta ? (
        <p className="mc-field__hint">
          {defaults.sourceAuthor
            ? t('entry.author', { name: defaults.sourceAuthor.username })
            : ''}
          {/* `beatmapset #123` doesn't go into the catalog: a branded technical identifier, written the same in both languages */}
          {defaults.meta?.beatmapsetId ? ` · beatmapset #${defaults.meta.beatmapsetId}` : ''}
        </p>
      ) : null}
    </Modal>
  );
}
