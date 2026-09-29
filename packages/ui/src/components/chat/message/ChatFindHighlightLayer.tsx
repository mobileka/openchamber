/**
 * Paints chat find matches with the CSS Custom Highlight API.
 *
 * The index counts matches from message data, but a range can only be painted
 * where it is mounted, so this layer re-scans the currently mounted message
 * roots on every mutation the virtualized list makes (a row mounting, the live
 * message streaming, an expanded block revealing content). Unlike the quote
 * layer it never touches the DOM, so it produces no mutations of its own and
 * needs no self-mutation filter.
 *
 * This layer also owns the current match's position. Navigation only brings a
 * missing row into the rendered window and releases auto-follow; the layer
 * centers the match's own range and keeps re-centering through the mount and
 * reflow that follow (a collapsed turn expanding, virtualizer measurement,
 * streaming), until the reader takes over the scroll.
 *
 * Highlight names are shared across columns (`oc-chat-find`,
 * `oc-chat-find-current`): only the focused column can own an open bar, so a
 * second column cannot paint over the first. Runtimes without
 * `CSS.highlights` fall back to scroll-only navigation.
 */

import React from 'react';

import { findChatQuoteRoot, rangeFromStreamOffsets } from '@/lib/chatQuoteAnchor';
import { findTextMatches, type TextMatchOptions } from '@/lib/search/textMatches';

import type { ChatFindMatch } from '../lib/search/types';

const SOFT_HIGHLIGHT = 'oc-chat-find';
const CURRENT_HIGHLIGHT = 'oc-chat-find-current';

/**
 * A navigation keeps re-centering for this many frames. Rows mount and reflow
 * asynchronously (expansion, measurement), and none of that is guaranteed to
 * announce itself with a DOM mutation.
 */
const REVEAL_SETTLE_FRAMES = 40;
/** Consecutive frames a match must hold its centered position to count as settled. */
const REVEAL_SETTLED_FRAMES = 3;
const REVEAL_CENTER_TOLERANCE_PX = 8;
/** Frames without a mounted row before asking the timeline to bring it in. */
const REVEAL_MOUNT_RETRY_FRAMES = [6, 20] as const;
/** A match counts as visible only between the find bar and the composer. */
const REVEAL_VISIBLE_TOP_MARGIN_PX = 120;
const REVEAL_VISIBLE_BOTTOM_MARGIN_PX = 140;

const supportsHighlights = (): boolean =>
  globalThis.Highlight !== undefined && globalThis.CSS !== undefined && 'highlights' in globalThis.CSS;

const paint = (name: string, ranges: Range[], priority: number): void => {
  if (!supportsHighlights()) {
    return;
  }
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  const highlight = new Highlight(...ranges);
  highlight.priority = priority;
  CSS.highlights.set(name, highlight);
};

type ChatFindHighlightLayerProps = {
  scrollNode: HTMLElement | null;
  /** Current session, so a restored search does not force a scroll. */
  sessionId: string | null;
  isOpen: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: ChatFindMatch[];
  currentMatch: ChatFindMatch | null;
  /** Ask the timeline to mount a message that is not in the rendered window. */
  onRequestMessageMount: (messageId: string) => void;
};

export const ChatFindHighlightLayer = React.memo(function ChatFindHighlightLayer({
  scrollNode,
  sessionId,
  isOpen,
  query,
  caseSensitive,
  wholeWord,
  matches,
  currentMatch,
  onRequestMessageMount,
}: ChatFindHighlightLayerProps) {
  const matchesByMessage = React.useMemo(() => {
    const byMessage = new Map<string, ChatFindMatch[]>();
    for (const match of matches) {
      const list = byMessage.get(match.messageId);
      if (list) {
        list.push(match);
      } else {
        byMessage.set(match.messageId, [match]);
      }
    }
    return byMessage;
  }, [matches]);

  const normalizedQuery = query.trim();
  const revealedRef = React.useRef<{ sessionId: string | null; key: string | null }>({
    sessionId: null,
    key: null,
  });
  /** True once the reader scrolls the transcript, so find stops following. */
  const userScrolledRef = React.useRef(false);

  React.useEffect(() => {
    const container = scrollNode;
    if (!container) {
      return;
    }
    const markUserScroll = (): void => {
      userScrolledRef.current = true;
    };
    container.addEventListener('wheel', markUserScroll, { passive: true });
    container.addEventListener('touchstart', markUserScroll, { passive: true });
    container.addEventListener('pointerdown', markUserScroll, { passive: true });
    return () => {
      container.removeEventListener('wheel', markUserScroll);
      container.removeEventListener('touchstart', markUserScroll);
      container.removeEventListener('pointerdown', markUserScroll);
    };
  }, [scrollNode]);

  React.useEffect(() => {
    const container = scrollNode;
    if (!container || !isOpen || normalizedQuery.length === 0 || matchesByMessage.size === 0) {
      paint(SOFT_HIGHLIGHT, [], 0);
      paint(CURRENT_HIGHLIGHT, [], 1);
      if (!isOpen) {
        // Remember the session so the first query typed after opening can
        // center its match.
        revealedRef.current = { sessionId, key: null };
      }
      return;
    }

    const options: TextMatchOptions = { caseSensitive, wholeWord };
    const softRanges: Range[] = [];
    const currentRanges: Range[] = [];

    const findMessageElement = (messageId: string): HTMLElement | null =>
      container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);

    const resolveMessageRoot = (messageElement: HTMLElement, messageId: string): Element =>
      messageElement.querySelector('[data-chat-quote-root]')
        ?? findChatQuoteRoot(container, messageId)
        ?? messageElement;

    const centerRange = (range: Range): void => {
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const delta = rect.top - containerRect.top - (containerRect.height - rect.height) / 2;
      if (Math.abs(delta) < 1) {
        return;
      }
      container.scrollTop += delta;
    };

    // A match range can be taller than the viewport; the middle is what the
    // reader is looking at, so it decides whether the range still counts as
    // in sight.
    const isRangeInBand = (range: Range): boolean => {
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      return centerY >= containerRect.top + REVEAL_VISIBLE_TOP_MARGIN_PX
        && centerY <= containerRect.bottom - REVEAL_VISIBLE_BOTTOM_MARGIN_PX;
    };

    // Fallback for a match whose text does not resolve in the DOM (markdown
    // transforms it away): at least show the message that contains it.
    const ensureMessageVisible = (messageElement: HTMLElement): void => {
      const rect = messageElement.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const top = containerRect.top + REVEAL_VISIBLE_TOP_MARGIN_PX;
      const bottom = containerRect.bottom - REVEAL_VISIBLE_BOTTOM_MARGIN_PX;
      if (rect.top >= top && rect.bottom <= bottom) {
        return;
      }
      container.scrollTop += rect.top - top;
    };

    const resolveCurrentRange = (
      messageElement: HTMLElement,
      messageRoot: Element,
      messageId: string,
    ): Range | null => {
      if (!currentMatch) {
        return null;
      }
      if (currentMatch.partId) {
        const partId = CSS.escape(currentMatch.partId);
        const partRoot = messageElement.querySelector(`[data-part-id="${partId}"]`);
        if (partRoot) {
          const partRanges = findTextMatches(partRoot.textContent ?? '', normalizedQuery, options);
          const candidate = partRanges[currentMatch.occurrence] ?? partRanges[0];
          const range = candidate ? rangeFromStreamOffsets(partRoot, candidate.start, candidate.end) : null;
          if (range) {
            return range;
          }
        }
      }
      const messageMatches = matchesByMessage.get(messageId) ?? [];
      const ordinal = messageMatches.findIndex((candidate) => candidate.key === currentMatch.key);
      const ranges = findTextMatches(messageRoot.textContent ?? '', normalizedQuery, options);
      const candidate = (ordinal >= 0 ? ranges[ordinal] : undefined)
        ?? ranges[currentMatch.occurrence]
        ?? ranges[0];
      return candidate ? rangeFromStreamOffsets(messageRoot, candidate.start, candidate.end) : null;
    };

    // The reveal loop is the only thing that positions the viewport for the
    // current match. It runs right after navigation and stops as soon as the
    // match holds a stable position, the frame budget runs out, or the reader
    // takes over the scroll.
    let revealFrame: number | null = null;
    let revealFrames = 0;
    let revealSettled = 0;
    let revealMissing = 0;
    let mountRetries = 0;
    let revealRange: Range | null = null;

    const stopReveal = (): void => {
      if (revealFrame !== null) {
        window.cancelAnimationFrame(revealFrame);
        revealFrame = null;
      }
    };

    const stepReveal = (): void => {
      revealFrame = null;
      const match = currentMatch;
      const key = match?.key ?? null;
      if (!match || !key || userScrolledRef.current) {
        stopReveal();
        return;
      }
      if (revealedRef.current.key === key) {
        stopReveal();
        return;
      }

      const messageElement = findMessageElement(match.messageId);
      let range = revealRange;
      if (range && !range.startContainer.isConnected) {
        range = null;
      }
      if (!range && messageElement) {
        range = resolveCurrentRange(messageElement, resolveMessageRoot(messageElement, match.messageId), match.messageId);
        revealRange = range;
      }

      if (range) {
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          // Hidden content (a collapsed turn): the reveal request will mount
          // it, keep the loop alive for that. Until then, at least keep the
          // message itself in sight.
          revealRange = null;
          revealSettled = 0;
          if (messageElement) {
            ensureMessageVisible(messageElement);
          }
        } else {
          const containerRect = container.getBoundingClientRect();
          const delta = rect.top - containerRect.top - (containerRect.height - rect.height) / 2;
          if (Math.abs(delta) > REVEAL_CENTER_TOLERANCE_PX) {
            container.scrollTop += delta;
            revealSettled = 0;
          } else {
            revealSettled += 1;
          }
          if (revealSettled >= REVEAL_SETTLED_FRAMES) {
            revealedRef.current = { sessionId, key };
            stopReveal();
            return;
          }
        }
      } else if (messageElement) {
        ensureMessageVisible(messageElement);
        revealSettled += 1;
        if (revealSettled >= REVEAL_SETTLED_FRAMES) {
          revealedRef.current = { sessionId, key };
          stopReveal();
          return;
        }
      } else {
        revealMissing += 1;
        const retryAt = REVEAL_MOUNT_RETRY_FRAMES[mountRetries];
        if (retryAt !== undefined && revealMissing >= retryAt) {
          mountRetries += 1;
          onRequestMessageMount(match.messageId);
        }
      }

      revealFrames += 1;
      if (revealFrames >= REVEAL_SETTLE_FRAMES) {
        revealedRef.current = { sessionId, key };
        stopReveal();
        return;
      }
      revealFrame = window.requestAnimationFrame(stepReveal);
    };

    const startReveal = (): void => {
      if (revealFrame !== null) {
        return;
      }
      revealFrames = 0;
      revealSettled = 0;
      revealMissing = 0;
      mountRetries = 0;
      revealRange = null;
      revealFrame = window.requestAnimationFrame(stepReveal);
    };

    const repaint = (): void => {
      softRanges.length = 0;
      currentRanges.length = 0;
      let currentResolved = false;

      const messageElements = container.querySelectorAll<HTMLElement>('[data-message-id]');
      for (const messageElement of messageElements) {
        const messageId = messageElement.getAttribute('data-message-id');
        if (!messageId || !matchesByMessage.has(messageId)) {
          continue;
        }
        const messageRoot = resolveMessageRoot(messageElement, messageId);
        const ranges = findTextMatches(messageRoot.textContent ?? '', normalizedQuery, options);
        for (const matchRange of ranges) {
          const range = rangeFromStreamOffsets(messageRoot, matchRange.start, matchRange.end);
          if (range) {
            softRanges.push(range);
          }
        }
        if (!currentResolved && currentMatch?.messageId === messageId) {
          const resolved = resolveCurrentRange(messageElement, messageRoot, messageId);
          if (resolved) {
            currentRanges.push(resolved);
            currentResolved = true;
          }
        }
      }

      paint(SOFT_HIGHLIGHT, softRanges, 0);
      paint(CURRENT_HIGHLIGHT, currentRanges, 1);

      const key = currentMatch?.key ?? null;
      if (revealedRef.current.sessionId !== sessionId) {
        // Returning to a session with a parked search puts the reader back on
        // the match they were on before leaving; a restored run without a
        // current match leaves the timeline's own viewport restore in charge.
        revealedRef.current = { sessionId, key };
        userScrolledRef.current = false;
        if (key) {
          startReveal();
        } else {
          stopReveal();
        }
        return;
      }
      if (!key) {
        stopReveal();
        return;
      }
      if (revealedRef.current.key !== key) {
        // A new match always gets positioned, even when already on screen, so
        // stepping reads as movement.
        userScrolledRef.current = false;
        startReveal();
        return;
      }
      if (userScrolledRef.current) {
        return;
      }
      // Rows can reflow after the reveal settled (a collapsed turn expands,
      // streaming rewrites); keep the match in sight until the reader scrolls.
      const range = currentRanges[0] ?? null;
      if (range && !isRangeInBand(range)) {
        centerRange(range);
      }
    };

    let frame: number | null = null;
    const scheduleRepaint = (): void => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    };

    const observer = new MutationObserver(scheduleRepaint);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    repaint();

    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      stopReveal();
      paint(SOFT_HIGHLIGHT, [], 0);
      paint(CURRENT_HIGHLIGHT, [], 1);
    };
  }, [
    caseSensitive,
    currentMatch,
    isOpen,
    matchesByMessage,
    normalizedQuery,
    onRequestMessageMount,
    scrollNode,
    sessionId,
    wholeWord,
  ]);

  return null;
});
