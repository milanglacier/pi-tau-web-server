# Render fenced code blocks inside lists and quotes instead of showing `%%CODEBLOCK_N%%`

## Context

Assistant replies sometimes show a literal `%%CODEBLOCK_2%%` where a code block
should be. An example is the dotfiles session whose first prompt asks what
Codex's `model_providers` setting does. Under "What's wrong: `--profile` is not
the only entry point", the reply puts a code block inside a numbered list item,
indented by three spaces:

```
1. **`-c` with no profile file at all.** ...:
   ```
   codex exec -c model=deepseek-flash ...
   ```
   Same command with the table absent anywhere: ...
```

`renderMarkdown` (`src/public/markdown.ts`) handles code blocks in two steps:

1. A regex, `` /```(\w*)\n([\s\S]*?)```/g ``, replaces each block with a
   placeholder `%%CODEBLOCK_<n>%%`. The regex can start anywhere on a line, so
   the indentation in front of the opening backticks stays in front of the
   placeholder: `   %%CODEBLOCK_2%%`.
2. The line loop turns a placeholder into a code block only when the whole line
   is the placeholder (`/^%%CODEBLOCK_(\d+)%%$/`). The indented line does not
   match, so it becomes a paragraph and the placeholder shows as text.

The same regex fails on other common inputs:

| Input | Current result |
|---|---|
| Fence indented under a `-` or `1.` item | Placeholder shows as text |
| Fence inside a `>` quote | Placeholder shows inside the quote |
| Text after the closing backticks on the same line | Placeholder shows as text |
| A fence shown inside a four-backtick block | Broken placeholders and stray backticks |
| A language such as `c++` or `objective-c` | Not a code block; backticks show as text |
| A `~~~` fence | Not a code block |

The code inside an indented block also keeps the list indentation, and the
closing fence's indentation ends up as trailing whitespace in the code.

A second problem shows up in the same reply. The list renderer only keeps
single-line items. The indented code block and the indented paragraph after it
end the list, and so does a blank line between items. Each following item then
starts a new `<ol>`, which the browser numbers from 1 again, so items 2 and 3
both display as "1.".

## Change

### 1. Find code blocks line by line (`src/public/markdown.ts`)

Replace the regex with a function that walks the lines once and follows the
CommonMark rules for fenced code blocks, loosened where models are sloppy:

- An opening fence is a line made of optional indentation, three or more
  backticks or tildes, and an optional info string. A backtick fence's info
  string may not contain a backtick, so a one-line `` ```code``` `` stays
  inline code. The language is the first word of the info string.
- The opening line may start with a `>` quote marker. Lines inside a quoted
  block lose the same marker, and a line without one ends the block.
- A closing fence uses the same character, is at least as long as the opening
  fence, has nothing after it but whitespace, and is indented at most three
  spaces more than the opening fence. A shorter fence or a fence of the other
  character is code.
- Each code line loses up to as many leading spaces as the opening fence had,
  so a block inside a list item is not shifted right.
- A fence that is never closed runs to the end of the text, as in CommonMark.
  Only finished messages reach `renderMarkdown`, so this mainly affects replies
  that were cut off mid-block; they show the partial code as code.
- Text before backticks on the same line (`Run this: ```bash`) is not an
  opening fence, as in CommonMark.

The block is replaced by one placeholder line that keeps the quote marker and
indentation of the opening fence, so the line loop knows where it belongs. The
placeholder is `%%CODEBLOCK<n>%%`, without an underscore, like the math and
inline placeholders, so the italic rule can never split it.

The line loop accepts the placeholder with leading indentation. The quote
renderer turns a placeholder line into a code block between the quoted text
lines. Quoted text is italic, so code blocks inside a quote reset the font
style.

### 2. Keep code blocks and continuation lines inside list items

- A list item stays open after its first line. An indented line that follows it
  and is not itself a list item belongs to the item: a code block placeholder
  adds the code block, any other text adds a paragraph.
- A blank line ends the list only when the next non-blank line is neither a
  list item nor indented, so loose lists with blank lines between items stay
  one list.
- An ordered list that starts at a number other than 1 gets a `start`
  attribute, so the browser shows the numbers the reply wrote.

Indented list items keep rendering as siblings in the same list, as they do
today. Real nesting is a separate change.

The two parts go in separate commits: the first fixes the leaked placeholder,
the second fixes lists.

## Tests

`test/markdown.test.ts`, written before the fix and failing on the current
code:

- the session excerpt above renders two code blocks inside the list items, with
  no placeholder text and no list indentation in the code;
- a fence under a `-` item;
- a fence inside a `>` quote, with the quote text around it;
- text after a closing fence keeps the block open;
- a four-backtick block shows the inner three-backtick fence as code;
- `c++` and `objective-c` language labels, and `~~~` fences;
- an unclosed fence renders the rest as code;
- a fence with text before it on the same line stays text;
- for lists: items separated by blank lines stay one `<ol>`; an indented
  paragraph after an item stays inside its `<li>`; an ordered list starting at
  3 gets `start="3"`; a paragraph that is not indented still ends the list.

## Verification

1. Run the new tests on the current code and confirm they fail.
2. Apply each part and rerun them until all pass.
3. Render the replies from the dotfiles session and confirm no placeholder text
   remains.
4. `npm run typecheck`, `npm test`, and `npm run test:e2e` (in the
   background).
5. `npm run benchmark:render -- --preset long --iterations 20` before and after.
   The baseline for "Markdown, 60 replies" is 6.5 to 6.7 ms.

## Results

- All new tests failed before each part and pass after it. `npm run
  typecheck`, `npm test` (332 tests), and `npm run test:e2e` (104 tests, about
  35 s) pass.
- Rendering all 6,565 assistant replies in the local session history with the
  old and new renderer: 75 replies showed a leftover placeholder before the
  fix and none after. The one remaining match is a reply that quotes the
  placeholder name in inline code. One reply that was cut off inside a code
  block now shows the partial code as code.
- The list change altered 482 replies. They split into lists that no longer
  break at blank lines or indented content (339), lists that show their real
  starting number (174), and indented paragraphs or code blocks that now stay
  inside their item (253). Some replies fall into more than one group.
- "Markdown, 60 replies" in `npm run benchmark:render -- --preset long`: 6.5 to
  6.7 ms on `main`, 6.8 to 7.0 ms after the code block change, and 6.9 to 7.0
  ms after the list change. That is about 0.3 ms more for all 60 replies,
  which is close to run-to-run noise.
