/**
 * Sentinel tab id for the ATLS Internals dev panel.
 *
 * Kept in `constants/` (not in the React component that renders the panel)
 * so non-UI modules (prompt assembly, services, tests) can detect the
 * sentinel without pulling the component + React + section tree into
 * their dep graph.
 *
 * When this id is assigned to `activeFile` in `appStore`, it signals
 * "the dev panel is focused" — NOT a real repo path. Prompt assembly
 * must avoid surfacing it to the model as a workspace file.
 */
export const INTERNALS_TAB_ID = '__atls_internals__';
