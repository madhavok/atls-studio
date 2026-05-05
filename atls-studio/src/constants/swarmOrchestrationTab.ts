/**
 * Sentinel tab id for the Swarm Orchestration panel.
 *
 * Mirrors the pattern used by INTERNALS_TAB_ID — kept in `constants/`
 * so non-UI modules (prompt assembly, services, tests) can detect the
 * sentinel without pulling SwarmPanel + React into their dep graph.
 *
 * When this id is in `openFiles` / `activeFile` in `appStore`, it signals
 * "the swarm dashboard is focused" — NOT a real repo path.
 */
export const SWARM_ORCHESTRATION_TAB_ID = '__swarm_orchestration__';
