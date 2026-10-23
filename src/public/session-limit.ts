/**
 * Decides which of a project's sessions the sidebar renders.
 */

export const SESSION_LIMIT = 10;

export type SessionLimitInput<T> = {
  /** The project's sessions, newest first. */
  sessions: T[];
  /** True when the user expanded this project to show every session. */
  expanded: boolean;
  /** True while the search box has text. Search needs every session. */
  searching: boolean;
  /** The session that is currently open, if any. */
  activeFilePath: string | null;
  limit?: number;
};

export type SessionLimitResult<T> = {
  visible: T[];
  /** Sessions beyond the limit. It is 0 when all of them are shown. */
  hiddenCount: number;
  /** True when the project has more sessions than the limit. */
  limited: boolean;
};

export function limitSessions<T extends { filePath?: string }>(input: SessionLimitInput<T>): SessionLimitResult<T> {
  const { sessions, expanded, searching, activeFilePath, limit = SESSION_LIMIT } = input;
  const limited = sessions.length > limit;
  if (!limited || expanded || searching) {
    return { visible: sessions, hiddenCount: 0, limited };
  }

  const visible = sessions.slice(0, limit);
  // The open session stays in the list even when it is older than the limit.
  if (activeFilePath) {
    const active = sessions.slice(limit).find((s) => s.filePath === activeFilePath);
    if (active) visible.push(active);
  }
  return { visible, hiddenCount: sessions.length - visible.length, limited };
}
