/**
 * The floating find bar for the chat column.
 *
 * A full-width overlay pinned to the transcript's top, so opening it never
 * reflows the timeline. One search field holds the input and the two match
 * toggles (case, whole word) at its right edge; the match count, stepping, and
 * close sit just outside it.
 *
 * The bar owns only presentation and local focus/keys: match counts, history
 * state, and selection live in `useChatFind`.
 *
 * Until whole-history coverage is complete the bar is a gate rather than a
 * search box: the field is replaced by a status note and focus sits on the
 * bar root, so Escape still works without summoning a mobile keyboard.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChatFindSettings } from '@/stores/useChatFindStore';

type ChatFindBarProps = {
  open: boolean;
  query: string;
  settings: ChatFindSettings;
  matchCount: number;
  currentIndex: number;
  isHistoryLoading: boolean;
  hasHistoryError: boolean;
  /** Bumped when the open shortcut is pressed again to re-focus the input. */
  focusNonce: number;
  className?: string;
  onChangeQuery: (value: string) => void;
  onToggleSetting: (key: keyof ChatFindSettings) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onRetryHistory: () => void;
};

const TOGGLE_CLASS = 'h-6 min-w-7 shrink-0 px-1 normal-case';

export const ChatFindBar: React.FC<ChatFindBarProps> = ({
  open,
  query,
  settings,
  matchCount,
  currentIndex,
  isHistoryLoading,
  hasHistoryError,
  focusNonce,
  className,
  onChangeQuery,
  onToggleSetting,
  onNext,
  onPrevious,
  onClose,
  onRetryHistory,
}) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);
  /** True once the field has taken focus in the current unblocked phase. */
  const focusedFieldRef = React.useRef(false);

  const blocked = isHistoryLoading || hasHistoryError;

  // Opening records the return target and, while coverage loads, puts focus
  // on the bar root: the field is a status note then, and the root keeps
  // Escape working without summoning the mobile keyboard. A session switch
  // can take an open bar back to loading, and a retry back to waiting, so
  // the block re-focuses rather than only handling the first open.
  React.useEffect(() => {
    if (!open) {
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      const previous = document.activeElement;
      if (previous instanceof HTMLElement) {
        returnFocusRef.current = previous;
      }
    }
    if (blocked) {
      rootRef.current?.focus();
    }
  }, [blocked, isHistoryLoading, open]);

  // Closing from any path (button, Escape, session switch) returns focus.
  React.useEffect(() => {
    if (open) {
      return;
    }
    wasOpenRef.current = false;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, [open]);

  // Complete coverage folds the field back in; put the cursor there once per
  // unblocked phase, because a session switch can re-block the bar while it
  // stays open.
  React.useEffect(() => {
    if (!open || blocked) {
      focusedFieldRef.current = false;
      return;
    }
    if (focusedFieldRef.current) {
      return;
    }
    focusedFieldRef.current = true;
    inputRef.current?.focus();
  }, [blocked, open]);

  // A repeated open shortcut re-focuses and selects the query. While blocked
  // the input is unmounted, so the same call is a no-op.
  React.useEffect(() => {
    if (open && focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusNonce, open]);

  if (!open) {
    return null;
  }

  const trimmed = query.trim();
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  // While blocked the root holds focus, so Escape arrives here instead of on
  // the unmounted input; the input's own handler stops propagation otherwise.
  const handleRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const countLabel = matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : '';

  return (
    <div
      ref={rootRef}
      role="search"
      aria-label={t('chat.find.openAria')}
      tabIndex={blocked ? -1 : undefined}
      onKeyDown={handleRootKeyDown}
      className={cn(
        'oc-chat-find-bar absolute inset-x-3 top-3 z-30 flex flex-col gap-1.5 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-1.5 shadow-lg outline-none',
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <div className="oc-chat-find-field flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-background)] px-2 ring-1 ring-inset ring-border/60 transition duration-200 ease-out focus-within:ring-2 focus-within:ring-[var(--interactive-focus-ring)]">
          <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
          {blocked ? (
            isHistoryLoading ? (
              <span
                role="status"
                className="min-w-0 flex-1 truncate text-sm italic text-muted-foreground"
              >
                {t('chat.find.loadingHistory')}
              </span>
            ) : null
          ) : (
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => onChangeQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.find.placeholder')}
              aria-label={t('chat.find.placeholder')}
              className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:ring-0"
            />
          )}
          {blocked ? null : (
            <span
              className="min-w-10 shrink-0 text-center typography-micro text-muted-foreground tabular-nums"
              aria-live="polite"
              aria-label={matchCount > 0 ? t('chat.find.countAria', { current: currentIndex + 1, total: matchCount }) : undefined}
            >
              {countLabel}
            </span>
          )}
          <Button
            type="button"
            variant="chip"
            size="xs"
            className={TOGGLE_CLASS}
            aria-pressed={settings.caseSensitive}
            disabled={blocked}
            onClick={() => onToggleSetting('caseSensitive')}
            title={t('chat.find.caseSensitive')}
            aria-label={t('chat.find.caseSensitive')}
          >
            <span aria-hidden="true">Aa</span>
          </Button>
          <Button
            type="button"
            variant="chip"
            size="xs"
            className={TOGGLE_CLASS}
            aria-pressed={settings.wholeWord}
            disabled={blocked}
            onClick={() => onToggleSetting('wholeWord')}
            title={t('chat.find.wholeWord')}
            aria-label={t('chat.find.wholeWord')}
          >
            <span aria-hidden="true" className="underline decoration-[1.5px] underline-offset-2">wd</span>
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="size-7 shrink-0 p-0 text-muted-foreground"
          onClick={onPrevious}
          title={t('chat.find.previousAria')}
          aria-label={t('chat.find.previousAria')}
          disabled={blocked || matchCount === 0}
        >
          <Icon name="arrow-up" className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="size-7 shrink-0 p-0 text-muted-foreground"
          onClick={onNext}
          title={t('chat.find.nextAria')}
          aria-label={t('chat.find.nextAria')}
          disabled={blocked || matchCount === 0}
        >
          <Icon name="arrow-down" className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="size-7 shrink-0 p-0 text-muted-foreground"
          onClick={onClose}
          title={t('chat.find.closeAria')}
          aria-label={t('chat.find.closeAria')}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>

      {hasHistoryError ? (
        <div className="flex items-center gap-1 px-1 typography-micro text-[var(--status-error-text)]" role="status">
          <span>{t('chat.find.historyError')}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto gap-1 px-0 py-0"
            onClick={onRetryHistory}
            title={t('chat.find.retryHistory')}
            aria-label={t('chat.find.retryHistory')}
          >
            <Icon name="refresh" className="size-3" />
            {t('chat.find.retryHistory')}
          </Button>
        </div>
      ) : null}

      {!blocked && trimmed.length > 0 && matchCount === 0 ? (
        <div className="px-1 typography-micro text-muted-foreground" role="status">
          {t('chat.find.noMatches')}
        </div>
      ) : null}
    </div>
  );
};
