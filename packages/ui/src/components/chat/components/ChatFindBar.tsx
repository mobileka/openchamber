/**
 * The floating find bar for the chat column.
 *
 * Layout mirrors the Markdown preview find bar: a compact overlay anchored to
 * the transcript's top-right, so opening it never reflows the timeline. The
 * content and history toggles sit on a wrapped options row under the input and
 * remain usable on touch surfaces.
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

const OPTION_LABEL_CLASS = 'flex cursor-pointer items-center gap-1.5 px-1 typography-micro text-muted-foreground';

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
        'absolute right-3 top-3 z-30 flex w-[min(calc(100%-1.5rem),26rem)] flex-col gap-1 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-1.5 shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <Icon name="search" className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onChangeQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.find.placeholder')}
          aria-label={t('chat.find.placeholder')}
          className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 py-0 text-sm shadow-none focus-visible:ring-0"
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
          variant="ghost"
          size="xs"
          className="size-6 shrink-0 p-0 text-muted-foreground"
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
          className="size-6 shrink-0 p-0 text-muted-foreground"
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
          className="size-6 shrink-0 p-0 text-muted-foreground"
          onClick={onClose}
          title={t('chat.find.closeAria')}
          aria-label={t('chat.find.closeAria')}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1 pb-0.5">
        <Button
          type="button"
          variant="chip"
          size="xs"
          aria-pressed={settings.caseSensitive}
          onClick={() => onToggleSetting('caseSensitive')}
          title={t('chat.find.caseSensitive')}
          aria-label={t('chat.find.caseSensitive')}
        >
          Aa
        </Button>
        <Button
          type="button"
          variant="chip"
          size="xs"
          aria-pressed={settings.wholeWord}
          onClick={() => onToggleSetting('wholeWord')}
          title={t('chat.find.wholeWord')}
          aria-label={t('chat.find.wholeWord')}
        >
          ab|
        </Button>
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
          <span className="px-1 typography-micro text-muted-foreground/70">{t('chat.find.historyComplete')}</span>
        ) : null}
      </div>

      {hasHistoryError ? (
        <div className="flex items-center gap-1 px-1 pb-0.5 typography-micro text-[var(--status-error-text)]" role="status">
          <span>{t('chat.find.historyError')}</span>
          <Button type="button" variant="link" size="xs" className="h-auto px-0 py-0" onClick={onRetryHistory}>
            {t('chat.find.retryHistory')}
          </Button>
        </div>
      ) : null}

      {!hasHistoryError && trimmed.length > 0 && matchCount === 0 ? (
        <div className="px-1 pb-0.5 typography-micro text-muted-foreground" role="status">
          {isSearchingHistory ? t('chat.find.searchingHistory') : t('chat.find.noMatches')}
        </div>
      ) : null}

      {!hasHistoryError && !historyComplete && !settings.includeWholeHistory ? (
        <div className="px-1 pb-0.5 typography-micro text-muted-foreground/70" role="status">
          {t('chat.find.loadedOnly')}
        </div>
      ) : null}
    </div>
  );
};
