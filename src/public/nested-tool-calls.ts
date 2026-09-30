export interface NestedCallsRecord {
  complete: boolean;
  calls: {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    argumentsBytes?: number;
    status: 'ok' | 'error' | 'unfinished';
    durationMs?: number;
    error?: string;
  }[];
}

export interface NestedCallSummary extends Omit<NestedCallsRecord['calls'][number], 'status'> {
  status: 'ok' | 'error' | 'unfinished' | 'running';
  parentId: string;
  depth: number;
  startedAt?: number;
}

export interface NestedCallsSummary {
  calls: NestedCallSummary[];
  complete: boolean;
  final: boolean;
}

type ExecutionEvent = {
  type?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

type Collection = {
  calls: Map<string, NestedCallSummary>;
  bytes: number;
  complete: boolean;
  final: boolean;
  saved: boolean;
};

const MAX_CALLS = 256;
const MAX_ARGUMENT_BYTES = 8192;
const MAX_TOTAL_ARGUMENT_BYTES = 32768;
const MAX_ERROR_CHARS = 500;
const encoder = new TextEncoder();

function collection(): Collection {
  return { calls: new Map(), bytes: 0, complete: true, final: false, saved: false };
}

function childOf(id: string, parent: string): boolean {
  return id.startsWith(`${parent}/`) && /^[1-9]\d*$/.test(id.slice(parent.length + 1));
}

function descendantOf(id: string, root: string): boolean {
  return id.startsWith(`${root}/`) && /^[1-9]\d*(\/[1-9]\d*)*$/.test(id.slice(root.length + 1));
}

function argumentsFor(call: NestedCallSummary, args: Record<string, unknown>, target: Collection): void {
  try {
    const json = JSON.stringify(args);
    const bytes = encoder.encode(json).length;
    if (bytes > MAX_ARGUMENT_BYTES || target.bytes + bytes > MAX_TOTAL_ARGUMENT_BYTES) {
      call.argumentsBytes = bytes;
      target.complete = false;
    } else {
      call.arguments = JSON.parse(json) as Record<string, unknown>;
      target.bytes += bytes;
    }
  } catch {
    target.complete = false;
  }
}

function errorText(result: unknown): string | undefined {
  if (typeof result === 'string') return result.slice(0, MAX_ERROR_CHARS) || undefined;
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    return undefined;
  }
  let text = '';
  for (const block of result.content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    text += `${text ? '\n' : ''}${block.text.slice(0, MAX_ERROR_CHARS - text.length)}`;
    if (text.length >= MAX_ERROR_CHARS) break;
  }
  return text.slice(0, MAX_ERROR_CHARS) || undefined;
}

/** Keeps bounded child summaries without retaining execution results. */
export class NestedToolCallsModel {
  private roots = new Map<string, Collection>();
  private pending = collection();
  private pendingDroppedParents = new Set<string>();

  registerRoot(id: string): string[] {
    if (this.roots.has(id)) return [];
    const changed = new Set<string>();
    const target = collection();
    this.roots.set(id, target);
    // A root definition takes priority over an assumed child with the same ID.
    for (const [sourceId, source] of [[undefined, this.pending], ...this.roots] as const) {
      if (source === target) continue;
      let removed = false;
      for (const [callId, call] of source.calls) {
        if (callId === id) {
          source.calls.delete(callId);
          removed = true;
        } else if (descendantOf(callId, id) && this.owner(callId) === id) {
          source.calls.delete(callId);
          removed = true;
          if (call.argumentsBytes !== undefined || call.status === 'unfinished') target.complete = false;
          if (target.calls.size >= MAX_CALLS) {
            target.complete = false;
            continue;
          }
          const args = call.arguments;
          const moved = { ...call };
          delete moved.arguments;
          if (args) argumentsFor(moved, args, target);
          target.calls.set(callId, moved);
        }
      }
      if (removed) {
        this.recount(source);
        if (sourceId !== undefined) changed.add(sourceId);
      }
    }
    for (const parent of this.pendingDroppedParents) {
      if (parent === id || descendantOf(parent, id)) {
        target.complete = false;
        this.pendingDroppedParents.delete(parent);
        changed.add(id);
      }
    }
    if (target.calls.size > 0 || !target.complete) changed.add(id);
    return [...changed];
  }

  observe(event: ExecutionEvent, now = performance.now()): string | undefined {
    const { toolCallId: id, parentToolCallId: parent, type } = event;
    if (!id || !parent || !childOf(id, parent) || this.roots.has(id)) return undefined;
    if (type !== 'tool_execution_start' && type !== 'tool_execution_end') return undefined;
    const owner = this.owner(id);
    const target = owner ? this.roots.get(owner)! : this.pending;
    if (target.final) return undefined;
    let call = target.calls.get(id);
    if (call && call.parentId !== parent) return undefined;
    if (!call) {
      if (target.calls.size >= MAX_CALLS) {
        const changed = target.complete;
        target.complete = false;
        if (!owner && this.pendingDroppedParents.size < MAX_CALLS) this.pendingDroppedParents.add(parent);
        return changed ? owner : undefined;
      }
      call = { id, name: event.toolName ?? '', parentId: parent, depth: 1, status: 'running' };
      target.calls.set(id, call);
      if (event.args || type === 'tool_execution_start') argumentsFor(call, event.args ?? {}, target);
    } else if (call.status !== 'running' || (type === 'tool_execution_start' && call.startedAt !== undefined)) {
      return undefined;
    }
    if (type === 'tool_execution_start') {
      call.startedAt = now;
    } else {
      call.status = event.isError ? 'error' : 'ok';
      if (call.startedAt !== undefined) call.durationMs = Math.max(0, Math.round(now - call.startedAt));
      if (event.isError) call.error = errorText(event.result);
    }
    return owner;
  }

  get(rootId: string): NestedCallsSummary | undefined {
    const target = this.roots.get(rootId);
    if (!target || (target.calls.size === 0 && target.complete)) return undefined;
    const calls = [...target.calls.values()];
    const placed = new Map<string, NestedCallSummary>();
    const place = (call: NestedCallSummary): NestedCallSummary => {
      const existing = placed.get(call.id);
      if (existing) return existing;
      const parent = descendantOf(call.id, rootId) && childOf(call.id, call.parentId)
        ? target.calls.get(call.parentId) : undefined;
      const parentCall = parent ? place(parent) : undefined;
      const row = { ...call, parentId: parentCall?.id ?? rootId, depth: parentCall ? parentCall.depth + 1 : 1 };
      placed.set(call.id, row);
      return row;
    };
    const rows = calls.map(place);
    const children = new Map<string, NestedCallSummary[]>();
    for (const row of rows) {
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row);
      children.set(row.parentId, siblings);
    }
    const ordered: NestedCallSummary[] = [];
    const visit = (id: string): void => {
      for (const row of children.get(id) ?? []) {
        ordered.push(row);
        visit(row.id);
      }
    };
    visit(rootId);
    return { calls: ordered, complete: target.complete, final: target.saved };
  }

  replace(rootId: string, record: NestedCallsRecord): void {
    this.registerRoot(rootId);
    const target = collection();
    target.complete = record.complete;
    target.final = true;
    target.saved = true;
    for (const entry of record.calls) {
      if (entry.id === rootId || this.roots.has(entry.id) || target.calls.has(entry.id)) continue;
      if (target.calls.size >= MAX_CALLS) {
        target.complete = false;
        break;
      }
      const call: NestedCallSummary = {
        id: entry.id, name: entry.name, status: entry.status,
        parentId: entry.id.slice(0, entry.id.lastIndexOf('/')), depth: 1,
      };
      if (entry.arguments) argumentsFor(call, entry.arguments, target);
      if (entry.argumentsBytes !== undefined) call.argumentsBytes = entry.argumentsBytes;
      if (entry.durationMs !== undefined) call.durationMs = entry.durationMs;
      if (entry.error) call.error = entry.error.slice(0, MAX_ERROR_CHARS);
      if (entry.status === 'unfinished' || entry.argumentsBytes !== undefined) target.complete = false;
      target.calls.set(call.id, call);
    }
    this.roots.set(rootId, target);
  }

  finish(rootId: string): void {
    const target = this.roots.get(rootId);
    if (!target || target.final) return;
    target.final = true;
    for (const call of target.calls.values()) {
      if (call.status === 'running') {
        call.status = 'unfinished';
        target.complete = false;
      }
    }
  }

  settle(): string[] {
    const changed: string[] = [];
    for (const [id, target] of this.roots) {
      if (!target.final && (target.calls.size > 0 || !target.complete)) {
        this.finish(id);
        changed.push(id);
      }
    }
    this.pending = collection();
    this.pendingDroppedParents.clear();
    return changed;
  }

  clear(): void {
    this.roots.clear();
    this.pending = collection();
    this.pendingDroppedParents.clear();
  }

  private owner(id: string): string | undefined {
    let owner: string | undefined;
    for (const root of this.roots.keys()) {
      if (descendantOf(id, root) && (owner === undefined || root.length > owner.length)) owner = root;
    }
    return owner;
  }

  private recount(target: Collection): void {
    target.bytes = 0;
    for (const call of target.calls.values()) {
      if (call.arguments) target.bytes += encoder.encode(JSON.stringify(call.arguments)).length;
    }
  }
}
