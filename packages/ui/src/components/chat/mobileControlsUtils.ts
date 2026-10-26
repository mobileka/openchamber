import type { Agent } from '@/lib/opencode/model';
import { agentLabel } from '@/lib/agentLabel';
import { getProviderModelDisplayName, type DisplayProvider } from '@/lib/modelDisplay';

export type MobileControlsPanel = 'model' | 'agent' | 'variant' | null;

/** What agent cycling reads from an agent. */
type CyclableAgent = Pick<Agent, 'name' | 'mode'>;

export const isPrimaryMode = (mode?: string) => mode === 'primary' || mode === 'all' || mode === undefined || mode === null;

const getCyclablePrimaryAgents = (agents: readonly CyclableAgent[]) => agents.filter((agent) => isPrimaryMode(agent.mode));

/**
 * The agent Tab moves to. While any starred agent is available, the cycle runs
 * through the starred ones only (from a non-starred agent it enters at the
 * first or last of them); otherwise through every primary agent, as before.
 */
export const getCycledPrimaryAgentName = (
    agents: readonly CyclableAgent[],
    currentAgentName: string | undefined,
    direction: 1 | -1 = 1,
    favoriteAgentNames: readonly string[] = [],
) => {
    const primaryAgents = getCyclablePrimaryAgents(agents);
    const favorites = primaryAgents.filter((agent) => favoriteAgentNames.includes(agent.name));
    if (favorites.length > 0) {
        const index = favorites.findIndex((agent) => agent.name === currentAgentName);
        if (index < 0) return (direction === 1 ? favorites[0] : favorites[favorites.length - 1]).name;
        if (favorites.length === 1) return null;
        return favorites[(index + direction + favorites.length) % favorites.length].name;
    }
    if (primaryAgents.length <= 1) {
        return null;
    }

    const currentIndex = primaryAgents.findIndex((agent) => agent.name === currentAgentName);
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeCurrentIndex + direction + primaryAgents.length) % primaryAgents.length;
    return primaryAgents[nextIndex]?.name ?? null;
};

/** The two modes the Tab shortcut moves between, in cycle order. */
const PLAN_BUILD_AGENT_IDS = ['plan', 'build'] as const;

/**
 * The next agent for the Plan/Build Tab shortcut. Only those two ids are
 * candidates: an agent that is neither starts at `plan`, `plan` moves to
 * `build`, `build` moves back to `plan`. When a single candidate is available
 * the move returns null because there is nowhere to go.
 */
export const getCycledPlanBuildAgentName = (
    agents: Agent[],
    currentAgentName: string | undefined,
): string | null => {
    const candidates = PLAN_BUILD_AGENT_IDS
        .map((id) => agents.find((agent) => agent.name === id && isPrimaryMode(agent.mode)))
        .filter((agent): agent is Agent => agent !== undefined);

    if (candidates.length === 0) {
        return null;
    }

    const currentIndex = candidates.findIndex((agent) => agent.name === currentAgentName);
    if (currentIndex === -1) {
        return candidates[0].name;
    }

    const nextIndex = (currentIndex + 1) % candidates.length;
    return candidates[nextIndex].name === currentAgentName ? null : candidates[nextIndex].name;
};

const capitalizeLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const getAgentDisplayName = (agents: Agent[], agentName?: string) => {
    if (agentName) {
        const agent = agents.find((entry) => entry.name === agentName);
        return agent ? agentLabel(agent) : agentLabel({ name: agentName, displayName: '' });
    }

    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));
    const buildAgent = primaryAgents.find((agent) => agent.name === 'build');
    const fallbackAgent = buildAgent || primaryAgents[0] || agents[0];
    return fallbackAgent ? agentLabel(fallbackAgent) : 'Select agent';
};

export const getModelDisplayName = (
    provider: DisplayProvider,
    modelId: string | undefined,
    fallbackLabel = '',
) => {
    return getProviderModelDisplayName(provider, modelId, { fallbackLabel });
};

export const formatEffortLabel = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return 'Default';
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    return capitalizeLabel(trimmed);
};
