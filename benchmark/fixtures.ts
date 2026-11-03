import zlib from 'node:zlib';

// Synthetic Pi session files for the benchmarks. The shapes and sizes follow
// real coding sessions: each user turn starts a run of tool steps, and each
// step is an assistant message (thinking plus one tool call) followed by its
// tool result. Thinking is about 5 KB per step, tool output is usually a few
// KB with a long tail up to about 50 KB, and image sessions carry 1 MB-class
// screenshots as base64. The output is deterministic for a given seed.

export type FixtureOptions = {
  /** User turns in the session. */
  rounds: number;
  /** Tool steps per user turn. */
  toolStepsPerRound: number;
  /** Characters of thinking per assistant message. */
  thinkingChars: number;
  /** Characters of Markdown in the final reply of each turn. */
  replyChars: number;
  /** Typical tool output size; some outputs are several times larger. */
  toolOutputChars: number;
  /** Attach an image to every Nth user message. 0 means no images. */
  imageEvery: number;
  /** Width and height of each attached PNG, in pixels. */
  imageSide: number;
};

export const PRESETS: Record<string, FixtureOptions> = {
  // About the size of the largest real coding sessions: ~500 entries, ~3 MB.
  typical: { rounds: 15, toolStepsPerRound: 16, thinkingChars: 5000, replyChars: 2500, toolOutputChars: 2500, imageEvery: 0, imageSide: 0 },
  // A long-running session: ~2000 entries, ~13 MB.
  long: { rounds: 60, toolStepsPerRound: 16, thinkingChars: 5000, replyChars: 2500, toolOutputChars: 2500, imageEvery: 0, imageSide: 0 },
  // A short chat with several large screenshots: ~8 MB, mostly base64.
  images: { rounds: 14, toolStepsPerRound: 2, thinkingChars: 3000, replyChars: 2000, toolOutputChars: 2000, imageEvery: 2, imageSide: 560 },
};

export type Fixture = {
  entries: Array<Record<string, unknown>>;
  /** Text that appears only in the last history item. */
  tailMarker: string;
};

const WORDS = (
  'the session render history message tool card output state server client browser snapshot entry ' +
  'function value result error check update stream thinking model provider context window token ' +
  'cache layout scroll anchor chunk idle frame paint parse request response handler event queue ' +
  'test build config path file line diff edit write read bash grep pattern option default limit'
).split(' ');

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

const pick = <T>(random: Random, list: T[]) => list[Math.floor(random() * list.length)];

function sentence(random: Random) {
  const length = 8 + Math.floor(random() * 12);
  const words = Array.from({ length }, () => pick(random, WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ') + '.';
}

function prose(random: Random, chars: number) {
  let text = '';
  while (text.length < chars) text += sentence(random) + (random() < 0.15 ? '\n\n' : ' ');
  return text;
}

function codeLines(random: Random, count: number) {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${pick(random, WORDS)}${pick(random, WORDS)[0].toUpperCase()}${pick(random, WORDS).slice(1)}`;
    const indent = '  '.repeat(Math.floor(random() * 3));
    lines.push(random() < 0.3
      ? `${indent}const ${name} = ${pick(random, WORDS)}(${pick(random, WORDS)}, ${Math.floor(random() * 100)});`
      : random() < 0.5
        ? `${indent}if (${name} !== undefined) return ${pick(random, WORDS)}.${pick(random, WORDS)}();`
        : `${indent}// ${sentence(random)}`);
  }
  return lines;
}

// Markdown with the constructs the renderer handles: headings, emphasis,
// inline code, lists, a fenced code block, a table, and inline math.
function markdown(random: Random, chars: number) {
  let text = `## ${sentence(random)}\n\n`;
  while (text.length < chars) {
    const kind = random();
    if (kind < 0.35) {
      text += `${sentence(random)} Use \`${pick(random, WORDS)}()\` with **${pick(random, WORDS)}** and *${pick(random, WORDS)}*. ${sentence(random)}\n\n`;
    } else if (kind < 0.55) {
      for (let i = 0; i < 4; i++) text += `- ${sentence(random)}\n`;
      text += '\n';
    } else if (kind < 0.75) {
      text += '```ts\n' + codeLines(random, 8).join('\n') + '\n```\n\n';
    } else if (kind < 0.85) {
      text += '| Name | Value | Note |\n| --- | ---: | --- |\n';
      for (let i = 0; i < 4; i++) text += `| ${pick(random, WORDS)} | ${Math.floor(random() * 1000)} | ${sentence(random)} |\n`;
      text += '\n';
    } else {
      text += `The cost grows as $O(n \\log n)$ when $n_${Math.floor(random() * 9)}$ ${sentence(random)}\n\n`;
    }
  }
  return text;
}

// Most outputs are near the typical size; one in five is about 5x larger and
// one in twenty about 20x larger, matching the long tail of real sessions.
function outputSize(random: Random, typical: number) {
  const roll = random();
  const scale = roll < 0.05 ? 20 : roll < 0.25 ? 5 : 0.5 + random();
  return Math.floor(typical * scale);
}

function linesOfSize(random: Random, chars: number, makeLine: () => string) {
  const lines: string[] = [];
  let size = 0;
  while (size < chars) {
    const line = makeLine();
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

type ToolStep = { name: string; args: Record<string, unknown>; output: string };

// Real sessions call bash and read most, then edit and grep; write is rare.
const TOOL_MIX: Array<[string, number]> = [['bash', 0.45], ['read', 0.25], ['edit', 0.15], ['grep', 0.1], ['write', 0.05]];

function pickTool(random: Random) {
  let roll = random();
  for (const [name, share] of TOOL_MIX) {
    if ((roll -= share) < 0) return name;
  }
  return TOOL_MIX[0][0];
}

function toolStep(random: Random, step: number, outputChars: number): ToolStep {
  const file = `src/${pick(random, WORDS)}/${pick(random, WORDS)}-${step}.ts`;
  const size = outputSize(random, outputChars);
  switch (pickTool(random)) {
    case 'bash':
      return {
        name: 'bash',
        args: { command: `npm test -- --grep "${pick(random, WORDS)} ${pick(random, WORDS)}" 2>&1 | tail -n 80` },
        output: linesOfSize(random, size, () => `${random() < 0.9 ? 'ok' : 'not ok'} ${Math.floor(random() * 500)} - ${sentence(random)}`),
      };
    case 'read':
      return {
        name: 'read',
        args: { path: file, offset: 1, limit: 400 },
        output: linesOfSize(random, size, () => codeLines(random, 1)[0]),
      };
    case 'edit': {
      const before = codeLines(random, 20 + Math.floor(random() * 30));
      const after = before.map(line => (random() < 0.2 ? codeLines(random, 1)[0] : line));
      after.splice(Math.floor(random() * after.length), 0, ...codeLines(random, 5));
      return {
        name: 'edit',
        args: { path: file, edits: [{ oldText: before.join('\n'), newText: after.join('\n') }] },
        output: `Successfully replaced text in ${file}.`,
      };
    }
    case 'grep':
      return {
        name: 'grep',
        args: { pattern: `${pick(random, WORDS)}\\(`, path: 'src' },
        output: linesOfSize(random, size, () => `${file}:${Math.floor(random() * 900)}: ${codeLines(random, 1)[0].trim()}`),
      };
    default: {
      // Half the writes target .js files, which the page highlights.
      const content = codeLines(random, 120 + Math.floor(random() * 120)).join('\n');
      return {
        name: 'write',
        args: { path: random() < 0.5 ? file.replace(/\.ts$/, '.js') : file, content },
        output: `Successfully wrote ${content.length} bytes to ${file}.`,
      };
    }
  }
}

// A noisy RGB PNG. Noise does not compress, so the base64 size and the
// browser's decode cost are close to a real screenshot of the same size.
function noisePng(random: Random, side: number) {
  const row = 1 + side * 3;
  const raw = Buffer.alloc(row * side);
  for (let y = 0; y < side; y++) {
    raw[y * row] = 0;
    for (let x = 1; x < row; x++) raw[y * row + x] = Math.floor(random() * 256);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function usage(random: Random, turn: number) {
  const input = 20000 + turn * 400;
  return {
    input: 200 + Math.floor(random() * 400),
    output: 300 + Math.floor(random() * 900),
    cacheRead: input,
    cacheWrite: 0,
    totalTokens: input + 1000,
    cost: { input: 0.001, output: 0.004, cacheRead: 0.002, cacheWrite: 0, total: 0.007 },
  };
}

function assistant(random: Random, turn: number, content: Array<Record<string, unknown>>, stopReason: string) {
  return {
    type: 'message',
    message: {
      role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-benchmark',
      usage: usage(random, turn), stopReason, timestamp: 1_760_000_000_000 + turn,
    },
  };
}

function thinking(random: Random, chars: number) {
  // Providers attach an opaque signature to each thinking block. It is sent
  // to the browser with the snapshot but never shown.
  return { type: 'thinking', thinking: prose(random, chars), thinkingSignature: Buffer.from(prose(random, 600)).toString('base64') };
}

/** Build a session file's entries. `tag` keeps markers unique per session. */
export function buildSession(options: FixtureOptions, tag: string, cwd: string, seed = 1): Fixture {
  const random = makeRandom(seed);
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', version: 3, id: `benchmark-${tag}`, timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'model_change', provider: 'anthropic', modelId: 'claude-benchmark' },
  ];
  let turn = 0;
  let tailMarker = '';
  for (let round = 0; round < options.rounds; round++) {
    const text = `benchmark-${tag}-user-${round} ${prose(random, 300)}`;
    const withImage = options.imageEvery > 0 && round % options.imageEvery === 0;
    entries.push({
      type: 'message',
      message: {
        role: 'user',
        content: withImage
          ? [{ type: 'text', text }, { type: 'image', data: noisePng(random, options.imageSide), mimeType: 'image/png' }]
          : text,
        timestamp: 1_760_000_000_000 + turn,
      },
    });
    for (let step = 0; step < options.toolStepsPerRound; step++) {
      const tool = toolStep(random, round * options.toolStepsPerRound + step, options.toolOutputChars);
      const toolCallId = `call-${tag}-${round}-${step}`;
      entries.push(assistant(random, turn++, [
        thinking(random, options.thinkingChars),
        { type: 'toolCall', id: toolCallId, name: tool.name, arguments: tool.args },
      ], 'toolUse'));
      entries.push({
        type: 'message',
        message: {
          role: 'toolResult', toolCallId, toolName: tool.name,
          content: [{ type: 'text', text: tool.output }], isError: false, timestamp: 1_760_000_000_000 + turn,
        },
      });
    }
    tailMarker = `benchmark-${tag}-end-${round}`;
    entries.push(assistant(random, turn++, [
      thinking(random, options.thinkingChars),
      { type: 'text', text: `${markdown(random, options.replyChars)}\n\n${tailMarker}` },
    ], 'stop'));
  }
  entries.push({ type: 'session_info', name: `Benchmark ${tag}` });
  return { entries, tailMarker };
}
