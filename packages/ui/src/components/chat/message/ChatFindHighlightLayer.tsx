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

  React.useEffect(() => {
    const container = scrollNode;
    if (!container || !isOpen || normalizedQuery.length === 0 || matchesByMessage.size === 0) {
      paint(SOFT_HIGHLIGHT, [], 0);
      paint(CURRENT_HIGHLIGHT, [], 1);
      return;
    }

    const options: TextMatchOptions = { caseSensitive, wholeWord };
    const softRanges: Range[] = [];
    const currentRanges: Range[] = [];

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
      const sessionChanged = revealedRef.current.sessionId !== sessionId;
      if (!sessionChanged && key && key !== revealedRef.current.key && currentRanges[0]) {
        currentRanges[0].startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      revealedRef.current = { sessionId, key };
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
