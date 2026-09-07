import { setImmediate } from 'node:timers/promises';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

export const PROVIDER = 'tau-permission-fixture';
export const MODEL = 'sentinel';
export const BASH_TIMEOUT_SECONDS = 1;
export const SENTINEL = 'unapproved-command-executed';
export const RUNNING_PID = 'running-bash.pid';
export const RUNNING_STARTED = 'running-bash-started';
export const RUNNING_FINISHED = 'running-bash-finished';
export const RECOVERY_TEXT = 'The new prompt completed.';

// Use Pi's actual provider/message/stream types without requiring Tau to add
// pi-ai as a direct dependency. Pi's shrinkwrap may keep it nested or hoisted.
type StreamSimple = NonNullable<ProviderConfig['streamSimple']>;
type Stream = ReturnType<StreamSimple>;
type AssistantMessage = Awaited<ReturnType<Stream['result']>>;

/** Only the model is fake: Pi owns the agent loop, built-in bash, dialogs and abort. */
export default async function permissionRpcProvider(pi: ExtensionAPI): Promise<void> {
  // The extension loader supplies this core module even when Pi keeps its npm
  // dependency nested. The signature below is derived from Pi's public API.
  const aiModule: string = '@earendil-works/pi-ai';
  const { createAssistantMessageEventStream } = await import(aiModule) as {
    createAssistantMessageEventStream: () => Stream;
  };

  const streamSimple: StreamSimple = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending', timestamp: Date.now(),
    };
    void (async () => {
      // Yield between stream phases, just as a network provider would. There is
      // deliberately no HTTP request, credential lookup, or fake RPC response.
      await setImmediate(undefined, { signal: options?.signal });
      stream.push({ type: 'start', partial: output });
      await setImmediate(undefined, { signal: options?.signal });
      const last = context.messages.at(-1);
      const prompt = last?.role === 'user'
        ? typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('')
        : undefined;
      if (prompt === 'permission:sentinel' || prompt === 'permission:running') {
        const command = prompt === 'permission:sentinel'
          ? `printf 'executed\\n' > ${SENTINEL}`
          : `printf '%s\\n' "$$" > ${RUNNING_PID}; printf 'started\\n' > ${RUNNING_STARTED}; printf 'bash is running\\n'; sleep 30; printf 'finished\\n' > ${RUNNING_FINISHED}`;
        const args = { command, timeout: prompt === 'permission:sentinel' ? BASH_TIMEOUT_SECONDS : 35 };
        const toolCall = { type: 'toolCall' as const, id: `bash-${context.messages.length}`, name: 'bash', arguments: {} };
        output.content.push(toolCall);
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output });
        await setImmediate(undefined, { signal: options?.signal });
        toolCall.arguments = args;
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial: output });
        await setImmediate(undefined, { signal: options?.signal });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: output });
        output.stopReason = 'toolUse';
      } else {
        if (prompt !== 'permission:recovery' && last?.role !== 'toolResult') {
          throw new Error(`Unexpected fixture prompt: ${prompt}`);
        }
        const block = { type: 'text' as const, text: '' };
        output.content.push(block);
        stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        await setImmediate(undefined, { signal: options?.signal });
        block.text = prompt === 'permission:recovery' ? RECOVERY_TEXT : 'The tool call finished.';
        stream.push({ type: 'text_delta', contentIndex: 0, delta: block.text, partial: output });
        stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: output });
        output.stopReason = 'stop';
      }
      options?.signal?.throwIfAborted();
      if (output.stopReason !== 'stop' && output.stopReason !== 'toolUse') {
        throw new Error(`Unexpected fixture stop reason: ${output.stopReason}`);
      }
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    })().catch((error: unknown) => {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    });
    return stream;
  };

  pi.registerProvider(PROVIDER, {
    api: 'tau-permission-fixture-api',
    baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'not-a-real-api-key',
    models: [{
      id: MODEL, name: 'Permission RPC fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple,
  });
}
