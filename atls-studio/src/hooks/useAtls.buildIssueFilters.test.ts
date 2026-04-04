import { afterEach, describe, expect, it } from 'vitest';
import { buildIssueFilters } from './useAtls';
import { useAppStore, DEFAULT_FOCUS_PROFILE, ALL_CATEGORIES, type FocusProfile } from '../stores/appStore';

describe('buildIssueFilters', () => {
  afterEach(() => {
    useAppStore.setState({
      focusProfileName: 'Full Scan',
      focusProfile: DEFAULT_FOCUS_PROFILE,
    });
  });

  it('returns no filters for Full Scan default profile', () => {
    useAppStore.setState({
      focusProfileName: 'Full Scan',
      focusProfile: DEFAULT_FOCUS_PROFILE,
    });
    const { catFilter, sevFilter } = buildIssueFilters();
    expect(catFilter).toBeUndefined();
    expect(sevFilter).toBeUndefined();
  });

  it('returns category and severity filters for a narrow profile', () => {
    const narrow: FocusProfile = {
      matrix: {
        security: ['high', 'medium'],
        correctness: ['high'],
      },
    };
    useAppStore.setState({
      focusProfileName: 'Security Audit',
      focusProfile: narrow,
    });
    const { catFilter, sevFilter } = buildIssueFilters();
    expect(catFilter?.sort()).toEqual(['correctness', 'security']);
    expect(sevFilter?.sort()).toEqual(['high', 'medium']);
  });

  it('treats all categories enabled as full scan even with a custom name', () => {
    const fullMatrix = Object.fromEntries(ALL_CATEGORIES.map(c => [c, ['high', 'medium', 'low']])) as FocusProfile['matrix'];
    useAppStore.setState({
      focusProfileName: 'Custom',
      focusProfile: { matrix: fullMatrix },
    });
    const { catFilter, sevFilter } = buildIssueFilters();
    expect(catFilter).toBeUndefined();
    expect(sevFilter).toBeUndefined();
  });
});
