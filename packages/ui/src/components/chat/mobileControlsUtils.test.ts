import { describe, expect, test } from 'bun:test';

import type { Agent } from '@/lib/opencode/model';
import { getAgentDisplayName, getCycledPlanBuildAgentName } from './mobileControlsUtils';

const agent = (
  name: string,
  mode: Agent['mode'] = 'primary',
  displayName = name,
): Agent => ({
  id: name,
  name,
  displayName,
  mode,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

const plan = agent('plan', 'primary', 'Plan');
const build = agent('build', 'primary', 'Build');

describe('getCycledPlanBuildAgentName', () => {
  test('moves between plan and build in both directions', () => {
    expect(getCycledPlanBuildAgentName([plan, build], 'plan')).toBe('build');
    expect(getCycledPlanBuildAgentName([plan, build], 'build')).toBe('plan');
  });

  test('starts at plan from any other agent', () => {
    expect(getCycledPlanBuildAgentName([plan, build, agent('review')], 'review')).toBe('plan');
    expect(getCycledPlanBuildAgentName([plan, build], undefined)).toBe('plan');
  });

  test('moves to the only available candidate', () => {
    expect(getCycledPlanBuildAgentName([build, agent('review')], 'review')).toBe('build');
    expect(getCycledPlanBuildAgentName([plan, agent('review')], 'review')).toBe('plan');
  });

  test('returns null when the only candidate is already selected', () => {
    expect(getCycledPlanBuildAgentName([build, agent('review')], 'build')).toBeNull();
    expect(getCycledPlanBuildAgentName([plan, agent('review')], 'plan')).toBeNull();
  });

  test('ignores non-primary agents and returns null when neither is available', () => {
    const subagent = agent('plan', 'subagent');
    expect(getCycledPlanBuildAgentName([subagent, agent('review')], 'review')).toBeNull();
    expect(getCycledPlanBuildAgentName([], 'plan')).toBeNull();
  });
});

describe('getAgentDisplayName', () => {
  test('prefers a found agent and its display name', () => {
    expect(getAgentDisplayName([agent('code-reviewer', 'primary', 'Code Reviewer')], 'code-reviewer')).toBe('Code Reviewer');
  });

  test('capitalizes a name that has no matching agent', () => {
    expect(getAgentDisplayName([build], 'code-reviewer')).toBe('Code-Reviewer');
  });

  test('falls back to build for an unset agent', () => {
    expect(getAgentDisplayName([plan, build], undefined)).toBe('Build');
  });
});
