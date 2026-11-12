/**
 * Finds the `@` file reference or `/` command that the caret is in, using the
 * same rules as Pi's terminal editor, so the chat input behaves like it.
 * These functions only look at text, so they run without a browser.
 */

// Letters of Chinese, Japanese and Korean stay part of a word. Only their
// punctuation ends a word, so a path can follow "，" or "。".
const CJK_LETTER = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const CJK_PUNCTUATION = new RegExp(`(?:(?=\\p{Punctuation})${CJK_LETTER.source}|[，．：；！？（）［］｛｝“”‘’…—])`, 'u');
const SEPARATOR = new RegExp(`(?:\\s|${CJK_PUNCTUATION.source})`, 'u');
const TOKEN_START = new RegExp(`(?:^|${SEPARATOR.source})$`, 'u');

// Characters that end a word, besides spaces.
const DELIMITERS = new Set([' ', '\t', '"', "'", '=']);
// Opening characters that may sit right before a path in prose, with the
// character that closes each of them.
const WRAPPERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>', '`': '`' };

export type AtToken = {
  /** Where the `@` is in the text before the caret. */
  start: number;
  /** What was typed after `@`, without the opening quote of a quoted reference. */
  query: string;
  /** True when the reference was started as `@"`. */
  quoted: boolean;
};

export type SlashToken = {
  /** Always 0: a command is only recognized at the very start of the input. */
  start: number;
  /** The command name typed so far, without the `/`. */
  query: string;
};

function lastDelimiterIndex(text: string) {
  let last = -1;
  let index = 0;
  for (const character of text) {
    index += character.length;
    if (DELIMITERS.has(character) || SEPARATOR.test(character)) last = index - 1;
  }
  return last;
}

// "(~/Dev" becomes "~/Dev". A wrapper stays when the word also contains its
// closer, as in "app/[slug]/pa".
function stripLeadingWrappers(word: string) {
  let result = word;
  while (result.length > 0) {
    const closer = WRAPPERS[result[0]];
    if (!closer || result.includes(closer, 1)) break;
    result = result.slice(1);
  }
  return result;
}

function unclosedQuoteStart(text: string) {
  let open = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    open = !open;
    if (open) start = i;
  }
  return open ? start : null;
}

function startsWord(text: string, index: number) {
  let start = index;
  while (start > 0 && WRAPPERS[text[start - 1]]) start--;
  return DELIMITERS.has(text[start - 1] ?? '') || TOKEN_START.test(text.slice(0, start));
}

/**
 * Find the `@` file reference that ends at the caret. Only the caret's own
 * line counts. The `@` must start a word, so `a@b` (an email address) does
 * not match, but `(@src/a` and `` `@src/a `` do. `@"my fi` is a quoted
 * reference, so the name may contain spaces.
 */
export function findAtToken(textBeforeCaret: string): AtToken | null {
  const lineStart = textBeforeCaret.lastIndexOf('\n') + 1;
  const line = textBeforeCaret.slice(lineStart);

  const quoteStart = unclosedQuoteStart(line);
  if (quoteStart !== null && quoteStart > 0 && line[quoteStart - 1] === '@' && startsWord(line, quoteStart - 1)) {
    return { start: lineStart + quoteStart - 1, query: line.slice(quoteStart + 1), quoted: true };
  }

  const wordStart = lastDelimiterIndex(line) + 1;
  const rawWord = line.slice(wordStart);
  const word = stripLeadingWrappers(rawWord);
  if (!word.startsWith('@')) return null;
  return { start: lineStart + wordStart + (rawWord.length - word.length), query: word.slice(1), quoted: false };
}

/**
 * Find the `/` command name that ends at the caret. The whole text before
 * the caret must be a `/` followed by characters other than whitespace, so
 * `/rev` matches but `/review src` and `look at /tmp` do not.
 */
export function findSlashToken(textBeforeCaret: string): SlashToken | null {
  const match = /^\/(\S*)$/.exec(textBeforeCaret);
  return match ? { start: 0, query: match[1] } : null;
}

/**
 * The text that replaces an `@` reference once a suggestion is accepted.
 *
 * `path` is what comes after `@`, and a path that ends with `/` is a folder.
 * A name with spaces, or a reference typed as `@"`, is wrapped in quotes. A
 * file gets a space after it. A folder does not, so the user can go on to
 * pick something inside it, and its caret stays before a closing quote.
 */
export function formatFileInsertion(path: string, quoted: boolean): { text: string; caretOffset: number } {
  const isFolder = path.endsWith('/');
  const needsQuotes = quoted || SEPARATOR.test(path);
  const reference = needsQuotes ? `@"${path}"` : `@${path}`;
  if (!isFolder) return { text: `${reference} `, caretOffset: reference.length + 1 };
  return { text: reference, caretOffset: needsQuotes ? reference.length - 1 : reference.length };
}
