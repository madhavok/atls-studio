import { useAppStore, FileNode, Issue, ProjectProfile, FocusMatrix, IssueCounts, ALL_CATEGORIES } from '../stores/appStore';

export function transformIssues(raw: Issue[]): Issue[] {
  return raw.map(i => ({
    id: i.id,
    patternId: (i as any).pattern_id,
    file: i.file,
    line: i.line,
    message: i.message,
    severity: i.severity as 'high' | 'medium' | 'low',
    category: i.category,
  }));
}