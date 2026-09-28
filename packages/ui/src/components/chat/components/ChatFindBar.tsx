/**
 * The floating find bar for the chat column.
 *
 * A full-width overlay pinned to the transcript's top, so opening it never
 * reflows the timeline. One search field holds the input and the two match
 * toggles (case, whole word) at its right edge; match count, stepping, and
 * close sit just outside it. The content and history checkboxes share the row
 * under the field and remain usable on touch surfaces.
 *
 * The bar owns only presentation and local focus/keys: match counts, history
 * state, and selection live in `useChatFind`.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  /** Whether the global Reasoning Traces setting renders reasoning at all. */
  reasoningVisible: boolean;
  historyComplete: boolean;
  isSearchingHistory: boolean;
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

const OPTION_LABEL_CLASS = 'flex cursor-pointer items-center gap-1.5 typography-micro text-muted-foreground';
const TOGGLE_CLASS = 'h-6 min-w-7 shrink-0 px-1 normal-case';

export const ChatFindBar: React.FC<ChatFindBarProps> = ({
  open,
  query,
  settings,
  matchCount,
  currentIndex,
  reasoningVisible,
  historyComplete,
  isSearchingHistory,
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
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

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
      inputRef.current?.focus();
    }
  }, [open]);

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

  const countLabel = matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : '';

  return (
    <div
      role="search"
      aria-label={t('chat.find.openAria')}
      className={cn(
        'absolute inset-x-3 top-3 z-30 flex flex-col gap-1.5 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-1.5 shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-background)] px-2 ring-1 ring-inset ring-border/60 transition duration-200 ease-out focus-within:ring-2 focus-within:ring-[var(--interactive-focus-ring)]">
          <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.find.placeholder')}
            aria-label={t('chat.find.placeholder')}
            className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:ring-0"
          />
          <span
            className="min-w-10 shrink-0 text-center typography-micro text-muted-foreground tabular-nums"
            aria-live="polite"
            aria-label={matchCount > 0 ? t('chat.find.countAria', { current: currentIndex + 1, total: matchCount }) : undefined}
          >
            {countLabel}
          </span>
          <Button
            type="button"
            variant="chip"
            size="xs"
            className={TOGGLE_CLASS}
            aria-pressed={settings.caseSensitive}
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
          disabled={matchCount === 0}
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
          disabled={matchCount === 0}
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <label className={cn(OPTION_LABEL_CLASS, !reasoningVisible && 'cursor-not-allowed opacity-60')}>
          <Checkbox
            checked={settings.includeReasoning}
            disabled={!reasoningVisible}
            onChange={() => onToggleSetting('includeReasoning')}
            ariaLabel={reasoningVisible ? t('chat.find.includeReasoning') : t('chat.find.includeReasoningDisabled')}
          />
          {t('chat.find.includeReasoning')}
        </label>
        <label className={OPTION_LABEL_CLASS}>
          <Checkbox
            checked={settings.includeTools}
            onChange={() => onToggleSetting('includeTools')}
            ariaLabel={t('chat.find.includeTools')}
          />
          {t('chat.find.includeTools')}
        </label>
        <label className={cn(OPTION_LABEL_CLASS, historyComplete && 'cursor-not-allowed opacity-60')}>
          <Checkbox
            checked={settings.includeWholeHistory}
            disabled={historyComplete}
            onChange={() => onToggleSetting('includeWholeHistory')}
            ariaLabel={t('chat.find.includeWholeHistory')}
          />
          {t('chat.find.includeWholeHistory')}
        </label>
        {historyComplete ? (
          <span className="typography-micro text-muted-foreground/70">{t('chat.find.historyComplete')}</span>
        ) : null}
      </div>

      {hasHistoryError ? (
        <div className="flex items-center gap-1 px-1 typography-micro text-[var(--status-error-text)]" role="status">
          <span>{t('chat.find.historyError')}</span>
          <Button type="button" variant="link" size="xs" className="h-auto px-0 py-0" onClick={onRetryHistory}>
            {t('chat.find.retryHistory')}
          </Button>
        </div>
      ) : null}

      {!hasHistoryError && trimmed.length > 0 && matchCount === 0 ? (
        <div className="px-1 typography-micro text-muted-foreground" role="status">
          {isSearchingHistory ? t('chat.find.searchingHistory') : t('chat.find.noMatches')}
        </div>
      ) : null}

      {!hasHistoryError && !historyComplete && !settings.includeWholeHistory ? (
        <div className="px-1 typography-micro text-muted-foreground/70" role="status">
          {t('chat.find.loadedOnly')}
        </div>
      ) : null}
    </div>
  );
};
