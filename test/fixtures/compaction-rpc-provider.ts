import fs from 'node:fs';
import path from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

// A fake model for compaction tests. Pi runs its real agent loop, compaction
// and abort; only the model replies are scripted.
//
// What a prompt contains decides how the fixture answers:
// - `big:` reports a nearly full context, so Pi compacts on its own as soon
//   as the reply ends.
// - `slow-reply:` keeps the reply running until it is stopped.
// - `gated-summary` anywhere in the conversation holds the summary request
//   until the test creates RELEASE_FILE in Pi's working directory, or until
//   it is stopped.
// - anything else gets a short reply.
//
// The summary echoes the custom instructions (`Focus: ...`), so a test can
// see that they reached Pi.

export const PROVIDER = 'tau-compaction-fixture';
export const MODEL = 'summarizer';
export const CONTEXT_WINDOW = 100_000;
export const BIG_CONTEXT_TOKENS = 90_000;
export const SUMMARY_TEXT = 'Fixture summary of the earlier conversation.';
export const RELEASE_FILE = 'release-summary';
export const SLOW_REPLY_MS = 20_000;

type StreamSimple = NonNullable<ProviderConfig['streamSimple']>;
type Stream = ReturnType<StreamSimple>;
type AssistantMessage = Awaited<ReturnType<Stream['result']>>;

export default async function compactionRpcProvider(pi: ExtensionAPI): Promise<void> {
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
      const signal = options?.signal;
      await setImmediate(undefined, { signal });
      stream.push({ type: 'start', partial: output });
      const whole = JSON.stringify(context);
      const isSummary = whole.includes('context summarization assistant');
      const last = context.messages.at(-1);
      const prompt = last?.role === 'user'
        ? typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('')
        : '';
      let text: string;
      if (isSummary) {
        if (whole.includes('gated-summary')) {
          const gate = path.join(process.cwd(), RELEASE_FILE);
          while (!fs.existsSync(gate)) await delay(50, undefined, { signal });
        }
        const focus = /Additional focus: ([^\n]*)/.exec(prompt)?.[1]?.trim();
        text = focus ? `${SUMMARY_TEXT} Focus: ${focus}.` : SUMMARY_TEXT;
      } else {
        if (prompt.startsWith('slow-reply:')) await delay(SLOW_REPLY_MS, undefined, { signal });
        text = `Reply to ${prompt}`;
      }
      const input = !isSummary && prompt.startsWith('big:') ? BIG_CONTEXT_TOKENS : Math.ceil(whole.length / 4);
      output.usage.input = input;
      output.usage.output = Math.ceil(text.length / 4);
      output.usage.totalTokens = output.usage.input + output.usage.output;
      const block = { type: 'text' as const, text: '' };
      output.content.push(block);
      stream.push({ type: 'text_start', contentIndex: 0, partial: output });
      await setImmediate(undefined, { signal });
      block.text = text;
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
      signal?.throwIfAborted();
      output.stopReason = 'stop';
      stream.push({ type: 'done', reason: 'stop', message: output });
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
    api: 'tau-compaction-fixture-api',
    baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'not-a-real-api-key',
    models: [{
      id: MODEL, name: 'Compaction RPC fixture', reasoning: false, input: ['text'],
      contextWindow: CONTEXT_WINDOW, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple,
  });
}
