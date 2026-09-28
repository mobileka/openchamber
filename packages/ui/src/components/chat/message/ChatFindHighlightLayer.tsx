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
 * Navigation scrolls the match's own range into the middle of the viewport
 * (`scrollToMessage` only guarantees the row is mounted), and keeps it there
 * across the reflows that follow until the reader takes over the scroll.
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

/** Keep the match clear of the find bar and the composer's bottom edge. */
const REVEAL_TOP_MARGIN_PX = 120;
const REVEAL_BOTTOM_MARGIN_PX = 40;

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
  /** True from a session switch until the reader picks a match themselves. */
  const sessionHoldRef = React.useRef(false);
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
        // center its match, while a genuine session switch still holds off.
        revealedRef.current = { sessionId, key: null };
        sessionHoldRef.current = false;
      }
      return;
    }

    const options: TextMatchOptions = { caseSensitive, wholeWord };
    const softRanges: Range[] = [];
    const currentRanges: Range[] = [];

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
    const isRangeInSight = (range: Range): boolean => {
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      return centerY >= containerRect.top + REVEAL_TOP_MARGIN_PX
        && centerY <= containerRect.bottom - REVEAL_BOTTOM_MARGIN_PX;
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
        const partRoot = messageElement.querySelector(`[data-part-id="${partId}"]`)
          ?? messageElement.querySelector(`[data-part-ids~="${partId}"]`);
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
        const messageRoot = messageElement.querySelector('[data-chat-quote-root]')
          ?? findChatQuoteRoot(container, messageId)
          ?? messageElement;
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
      const range = currentRanges[0] ?? null;

      if (revealedRef.current.sessionId !== sessionId) {
        // A parked run restored after a session switch must not pull the
        // viewport away from the reader's remembered position.
        revealedRef.current = { sessionId, key };
        sessionHoldRef.current = true;
        userScrolledRef.current = false;
        return;
      }

      if (!key || !range) {
        return;
      }
      if (revealedRef.current.key !== key) {
        // A new match is always centered, even when already on screen, so
        // stepping reads as movement. It also ends any previous hold: the
        // reader asked for this match.
        revealedRef.current = { sessionId, key };
        sessionHoldRef.current = false;
        userScrolledRef.current = false;
        centerRange(range);
        return;
      }
      if (sessionHoldRef.current || userScrolledRef.current) {
        return;
      }
      // Rows mount and reflow after navigation (a collapsed part expands, the
      // virtualized list measures, streaming rewrites): keep the current
      // match in sight until the reader scrolls away themselves.
      if (!isRangeInSight(range)) {
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
      paint(SOFT_HIGHLIGHT, [], 0);
      paint(CURRENT_HIGHLIGHT, [], 1);
    };
  }, [caseSensitive, currentMatch, isOpen, matchesByMessage, normalizedQuery, scrollNode, sessionId, wholeWord]);

  return null;
});
