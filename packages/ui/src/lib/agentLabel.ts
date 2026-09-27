import type { Agent } from '@/lib/opencode/model';
import { capitalizeWords } from '@/lib/utils';

/**
 * The name to show for an agent. OpenCode sends a display name next to the
 * agent id; the id (`build`) is only a fallback. Both are capitalized the same
 * way, so `code-reviewer` reads as `Code-Reviewer` whichever field carries it.
 */
export function agentLabel(agent: Pick<Agent, 'name' | 'displayName'>): string {
    return capitalizeWords(agent.displayName?.trim() || agent.name);
}
