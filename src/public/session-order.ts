/**
 * Decides the order of the sidebar's projects and which of their sessions it
 * renders. Sessions that are open as live tabs come first, in their own
 * project, and projects with open sessions come before the others.
 */

export const SESSION_LIMIT = 10;

/** A live tab, as far as the sidebar needs to know about it. */
export type OpenTab = {
  id: string;
  /** The tab's session file. Null until Pi reports it. */
  filePath: string | null;
  /** The tab's working directory. */
  cwd: string;
  name: string | null;
  /** When the tab was created, in milliseconds. */
  openedAt: number;
};

/**
 * An open tab and its row from the session list. `session` is null when the
 * list has no row for the tab yet, for example when Pi has not written the
 * session file.
 */
export type OpenRow<S> = { tab: OpenTab; session: S | null };

export type ArrangedProject<S, P> = {
  /** Null when no listed project has the tab's directory. */
  project: P | null;
  path: string;
  /** Open sessions, the most recently opened tab first. */
  open: OpenRow<S>[];
  /** The other sessions to render, newest first. */
  visible: S[];
  /** Other sessions beyond the limit. It is 0 when all of them are shown. */
  hiddenCount: number;
  /** True when the project has more other sessions than the limit. */
  limited: boolean;
  /** Every session of the project, including open tabs with no row yet. */
  total: number;
};

export type ArrangeInput<S, P> = {
  /** The projects, in their usual order, each with sessions newest first. */
  projects: P[];
  openTabs: OpenTab[];
  /** True when the user expanded this project to show every session. */
  isExpanded: (project: P) => boolean;
  /** True while the search box has text. Search needs every session. */
  searching: boolean;
  limit?: number;
};

type SessionLike = { filePath?: string };
type ProjectLike<S> = { path?: string; sessions?: S[] };

export function arrangeProjects<S extends SessionLike, P extends ProjectLike<S>>(input: ArrangeInput<S, P>): ArrangedProject<S, P>[] {
  const { projects, openTabs, isExpanded, searching, limit = SESSION_LIMIT } = input;
  const tabsByFile = new Map<string, OpenTab>();
  for (const tab of openTabs) if (tab.filePath) tabsByFile.set(tab.filePath, tab);

  const openRows = new Map<P, OpenRow<S>[]>();
  const placedTabs = new Set<OpenTab>();
  for (const project of projects) {
    const rows: OpenRow<S>[] = [];
    for (const session of project.sessions || []) {
      const tab = session.filePath ? tabsByFile.get(session.filePath) : undefined;
      if (tab && !placedTabs.has(tab)) {
        rows.push({ tab, session });
        placedTabs.add(tab);
      }
    }
    openRows.set(project, rows);
  }

  // Tabs with no row go to the project for their directory, or to a new
  // entry when no project has that directory.
  const extraProjects = new Map<string, OpenRow<S>[]>();
  for (const tab of openTabs) {
    if (placedTabs.has(tab)) continue;
    const project = projects.find((p) => (p.path || '') === tab.cwd);
    if (project) {
      openRows.get(project)!.push({ tab, session: null });
    } else {
      if (!extraProjects.has(tab.cwd)) extraProjects.set(tab.cwd, []);
      extraProjects.get(tab.cwd)!.push({ tab, session: null });
    }
  }

  const arranged: ArrangedProject<S, P>[] = projects.map((project) => {
    const open = sortOpen(openRows.get(project)!);
    const openSessions = new Set(open.map((row) => row.session).filter(Boolean));
    const rest = (project.sessions || []).filter((session) => !openSessions.has(session));
    const placeholders = open.length - openSessions.size;
    const total = (project.sessions || []).length + placeholders;
    const limited = rest.length > limit;
    if (!limited || searching || isExpanded(project)) {
      return { project, path: project.path || '', open, visible: rest, hiddenCount: 0, limited, total };
    }
    const visible = rest.slice(0, limit);
    return { project, path: project.path || '', open, visible, hiddenCount: rest.length - visible.length, limited, total };
  });
  for (const [path, rows] of extraProjects) {
    const open = sortOpen(rows);
    arranged.push({ project: null, path, open, visible: [], hiddenCount: 0, limited: false, total: open.length });
  }

  // Projects with open sessions first, the one whose newest tab was opened
  // last at the top. The others keep their order. Array.sort is stable.
  const newestOpen = (entry: ArrangedProject<S, P>) => entry.open[0]?.tab.openedAt ?? -Infinity;
  return arranged
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aOpen = a.entry.open.length > 0;
      const bOpen = b.entry.open.length > 0;
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      if (aOpen) return newestOpen(b.entry) - newestOpen(a.entry);
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function sortOpen<S>(rows: OpenRow<S>[]) {
  return [...rows].sort((a, b) => b.tab.openedAt - a.tab.openedAt);
}
