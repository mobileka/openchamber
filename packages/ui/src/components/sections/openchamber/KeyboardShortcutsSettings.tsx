import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { SettingsFieldRow, SettingsSection, SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  UNASSIGNED_SHORTCUT,
  type ShortcutActionId,
  type ShortcutCategory,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { rankVisibleShortcutActions } from './shortcutFiltering';
import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';
import { ShortcutSearchDialog } from './ShortcutSearchDialog';

const CATEGORIES: ShortcutCategory[] = ['session', 'models', 'panels', 'navigation', 'application'];

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);
  const [editingAction, setEditingAction] = React.useState<CustomizableShortcutAction | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [shortcutFilter, setShortcutFilter] = React.useState<ShortcutCombo | null>(null);
  const [isShortcutSearchOpen, setShortcutSearchOpen] = React.useState(false);

  const actions = React.useMemo(() => {
    const all = getCustomizableShortcutActions();
    return isVSCodeRuntime() ? all.filter((action) => action.id !== 'toggle_prompt_navigator') : all;
  }, []);

  const rankById = React.useMemo(() => {
    const ranked = rankVisibleShortcutActions(actions, {
      query: searchQuery,
      shortcutFilter,
      overrides: shortcutOverrides,
      labelOf: (action) => t(action.settingsLabelKey),
    });
    return new Map(ranked.map((action, index) => [action.id, index]));
  }, [actions, searchQuery, shortcutFilter, shortcutOverrides, t]);

  const visibleCategories = React.useMemo(() => (
    CATEGORIES
      .map((category) => ({
        category,
        actions: actions
          .filter((action) => action.category === category && rankById.has(action.id))
          .sort((left, right) => (rankById.get(left.id) ?? 0) - (rankById.get(right.id) ?? 0)),
      }))
      .filter((entry) => entry.actions.length > 0)
  ), [actions, rankById]);

  const persist = (nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  };
  const save = (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => {
    const nextOverrides = { ...shortcutOverrides, [actionId]: combo };
    if (replaceActionId) nextOverrides[replaceActionId] = UNASSIGNED_SHORTCUT;
    setShortcutOverride(actionId, combo);
    if (replaceActionId) setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
    persist(nextOverrides);
  };
  const resetOne = (actionId: ShortcutActionId) => {
    const nextOverrides = { ...shortcutOverrides };
    delete nextOverrides[actionId];
    clearShortcutOverride(actionId);
    persist(nextOverrides);
  };
  const shortcutDisplay = (action: CustomizableShortcutAction): string => {
    const isPrefixStyle = 'prefixStyle' in action && action.prefixStyle;
    const combo = isPrefixStyle
      ? getEffectiveShortcutPrefix(action.id, shortcutOverrides)
      : getEffectiveShortcutCombo(action.id, shortcutOverrides);
    const formatted = formatShortcutForDisplay(
      combo,
      t('settings.openchamber.keyboardShortcuts.unassigned'),
    );
    if (!isPrefixStyle || !combo || combo === UNASSIGNED_SHORTCUT) return formatted;
    const suffix = action.id === 'switch_session_tab'
      ? t('settings.openchamber.keyboardShortcuts.action.switch_session_tab.suffix')
      : t('settings.openchamber.keyboardShortcuts.action.switch_context_surface.suffix');
    return `${formatted}${suffix}`;
  };
  const applyShortcutFilter = (combo: ShortcutCombo) => {
    setShortcutFilter(combo);
    // The recorded shortcut is the whole filter; leftover text would only
    // hide the very binding the person just searched for.
    setSearchQuery('');
  };
  const formattedShortcutFilter = shortcutFilter ? formatShortcutForDisplay(shortcutFilter) : '';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 @xl:max-w-[24rem]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchQuery.trim()) {
                event.preventDefault();
                setSearchQuery('');
              }
            }}
            placeholder={t('settings.openchamber.keyboardShortcuts.search.placeholder')}
            aria-label={t('settings.openchamber.keyboardShortcuts.search.aria')}
            className="h-8 pl-8 pr-8"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label={t('settings.openchamber.keyboardShortcuts.search.clear')}
              className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShortcutSearchOpen(true)}
        >
          {t('settings.openchamber.keyboardShortcuts.search.byShortcut')}
        </Button>
        {shortcutFilter ? (
          <span className="flex items-center gap-1">
            <kbd
              aria-label={t('settings.openchamber.keyboardShortcuts.search.filterLabel', { shortcut: formattedShortcutFilter })}
              className="rounded-md border border-border bg-muted px-2 py-1 font-mono typography-meta text-foreground"
            >
              {formattedShortcutFilter}
            </kbd>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.openchamber.keyboardShortcuts.search.resetFilter')}
              title={t('settings.openchamber.keyboardShortcuts.search.resetFilter')}
              onClick={() => setShortcutFilter(null)}
            >
              <Icon name="close" className="size-4" />
            </Button>
          </span>
        ) : null}
      </div>

      {visibleCategories.length === 0 ? (
        <p className="py-6 text-center typography-ui text-muted-foreground">
          {shortcutFilter
            ? t('settings.openchamber.keyboardShortcuts.search.noShortcutResults')
            : t('settings.openchamber.keyboardShortcuts.search.noResults')}
        </p>
      ) : visibleCategories.map(({ category, actions: categoryActions }, categoryIndex) => (
        <SettingsSection
          key={category}
          settingsItem={categoryIndex === 0 ? 'shortcuts.keyboard-shortcuts' : undefined}
          title={t(`settings.openchamber.keyboardShortcuts.category.${category}`)}
          divider={categoryIndex !== 0}
          info={categoryIndex === 0 ? t('settings.openchamber.keyboardShortcuts.tooltip') : undefined}
          headerAction={categoryIndex === 0 ? (
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => {
              resetAllShortcutOverrides();
              persist({});
            }}>
              {t('settings.openchamber.keyboardShortcuts.actions.resetAll')}
            </Button>
          ) : undefined}
        >
          <div className="space-y-2">
            {categoryActions.map((action) => (
              <SettingsFieldRow key={action.id} label={t(action.settingsLabelKey)}>
                <kbd
                  className="min-w-32 rounded-md border border-border bg-muted px-2 py-1 text-center typography-meta font-mono text-foreground"
                >
                  {shortcutDisplay(action)}
                </kbd>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="!font-normal"
                  onClick={() => setEditingAction(action)}
                >
                  {t('settings.openchamber.keyboardShortcuts.actions.edit')}
                </Button>
                {action.id in shortcutOverrides ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal"
                    onClick={() => resetOne(action.id)}
                  >
                    {t('settings.common.actions.reset')}
                  </Button>
                ) : null}
              </SettingsFieldRow>
            ))}
          </div>
        </SettingsSection>
      ))}

      <ShortcutRecordingDialog
        action={editingAction}
        overrides={shortcutOverrides}
        onSave={save}
        onOpenChange={(open) => {
          if (!open) setEditingAction(null);
        }}
      />
      <ShortcutSearchDialog
        open={isShortcutSearchOpen}
        onOpenChange={setShortcutSearchOpen}
        onApply={applyShortcutFilter}
      />
    </>
  );
};
