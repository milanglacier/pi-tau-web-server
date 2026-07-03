/**
 * Session Stats Card — the popover opened from the header context pill.
 *
 * Shows the same numbers pi's TUI status bar shows: context usage, input and
 * output tokens, cache read, cache hit rate, and session cost. The
 * authoritative data comes from pi's get_session_stats RPC (via the caller's
 * fetchStats); when that is unavailable — no live session, a transient fetch
 * failure, or null contextUsage right after compaction — the card degrades
 * gracefully to the caller's locally-tracked fallback numbers instead of
 * showing nothing.
 */

export type SessionStatsTokens = {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  total?: number | null;
};

export type SessionContextUsage = {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
};

export type SessionStats = {
  tokens?: SessionStatsTokens | null;
  cost?: number | null;
  contextUsage?: SessionContextUsage | null;
};

/** Locally-tracked numbers used when authoritative stats are unavailable. */
export type SessionStatsFallback = {
  usage: { input?: number; output?: number; cacheRead?: number } | null;
  cost: number;
  /** Last known context tokens (fresh input + cache read). 0 = unknown. */
  contextTokens: number;
  /** Model context window size. 0 = unknown. */
  contextWindow: number;
};

export type SessionStatsCardOptions = {
  pillEl: HTMLElement;
  cardEl: HTMLElement;
  /** Fetch authoritative stats; resolve null when unavailable. */
  fetchStats: () => Promise<SessionStats | null>;
  getFallback: () => SessionStatsFallback;
};

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Small inline icons matching the app's feather-style stroke icons.
function icon(paths: string) {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICONS = {
  input: icon('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  output: icon('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
  cacheRead: icon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
  cacheHit: icon('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
};

export function setupSessionStatsCard(options: SessionStatsCardOptions) {
  const { pillEl, cardEl, fetchStats, getFallback } = options;

  let lastStats: SessionStats | null = null;
  let refreshSeq = 0;

  function isOpen() {
    return !cardEl.classList.contains('hidden');
  }

  function render() {
    const fallback = getFallback();
    const tokens = lastStats?.tokens || null;

    const input = typeof tokens?.input === 'number' ? tokens.input : (fallback.usage?.input ?? null);
    const output = typeof tokens?.output === 'number' ? tokens.output : (fallback.usage?.output ?? null);
    const cacheRead = typeof tokens?.cacheRead === 'number' ? tokens.cacheRead : (fallback.usage?.cacheRead ?? null);
    const cost = typeof lastStats?.cost === 'number' ? lastStats.cost : (fallback.cost > 0 ? fallback.cost : null);

    // contextUsage may be absent, and its tokens/percent may be null right
    // after compaction — fall back to the last locally-known numbers.
    const cu = lastStats?.contextUsage || null;
    const ctxWindow = typeof cu?.contextWindow === 'number' && cu.contextWindow > 0
      ? cu.contextWindow
      : (fallback.contextWindow > 0 ? fallback.contextWindow : null);
    const ctxTokens = typeof cu?.tokens === 'number'
      ? cu.tokens
      : (fallback.contextTokens > 0 ? fallback.contextTokens : null);
    let pct = typeof cu?.percent === 'number' ? cu.percent : null;
    if (pct === null && ctxTokens !== null && ctxWindow) {
      pct = (ctxTokens / ctxWindow) * 100;
    }

    const hitDenominator = (input ?? 0) + (cacheRead ?? 0);
    const hitRate = cacheRead !== null && hitDenominator > 0 ? (cacheRead / hitDenominator) * 100 : null;

    const sections: string[] = [];

    if (pct !== null || (ctxTokens !== null && ctxWindow !== null)) {
      const detail = ctxTokens !== null && ctxWindow !== null
        ? `<span class="stats-context-detail">${formatTokens(ctxTokens)} / ${formatTokens(ctxWindow)}</span>`
        : '';
      sections.push(`
        <div class="stats-row">
          <span class="stats-label">Context</span>
          <span class="stats-value">${pct !== null ? `${pct.toFixed(1)}%` : '—'}${detail}</span>
        </div>`);
    }

    if (input !== null || output !== null || cacheRead !== null) {
      sections.push(`
        <div class="stats-row"><span class="stats-label"><span class="stats-icon">${ICONS.input}</span>Input</span><span class="stats-value">${input !== null ? formatTokens(input) : '—'}</span></div>
        <div class="stats-row"><span class="stats-label"><span class="stats-icon">${ICONS.output}</span>Output</span><span class="stats-value">${output !== null ? formatTokens(output) : '—'}</span></div>
        <div class="stats-row"><span class="stats-label"><span class="stats-icon">${ICONS.cacheRead}</span>Cache read</span><span class="stats-value">${cacheRead !== null ? formatTokens(cacheRead) : '—'}</span></div>
        <div class="stats-row"><span class="stats-label"><span class="stats-icon">${ICONS.cacheHit}</span>Cache hit</span><span class="stats-value">${hitRate !== null ? `${hitRate.toFixed(1)}%` : '—'}</span></div>`);
    }

    if (cost !== null) {
      sections.push(`
        <div class="stats-row">
          <span class="stats-label">Cost</span>
          <span class="stats-value">$${cost.toFixed(3)} (sub)</span>
        </div>`);
    }

    cardEl.innerHTML = sections.length
      ? sections.join('<div class="stats-sep"></div>')
      : '<div class="stats-empty">No usage data yet</div>';
  }

  // Re-fetch authoritative stats; re-render the card if it is showing.
  // Refreshes can overlap (turn end, snapshot load, card open, session
  // switch), so each carries a sequence number and only the newest one is
  // allowed to write — a slow stale response must never clobber fresh stats.
  async function refresh() {
    const seq = ++refreshSeq;
    const stats = await fetchStats();
    if (seq !== refreshSeq) return;
    lastStats = stats;
    if (isOpen()) render();
  }

  async function open() {
    render(); // show cached/fallback numbers immediately
    cardEl.classList.remove('hidden');
    pillEl.setAttribute('aria-expanded', 'true');
    await refresh();
  }

  function close() {
    cardEl.classList.add('hidden');
    pillEl.setAttribute('aria-expanded', 'false');
  }

  pillEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else void open();
  });

  document.addEventListener('click', (e) => {
    if (isOpen() && !cardEl.contains(e.target as Node) && !pillEl.contains(e.target as Node)) {
      close();
    }
  });

  return { refresh, close, isOpen };
}
