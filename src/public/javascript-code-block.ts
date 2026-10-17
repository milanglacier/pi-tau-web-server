export type CodeBlockLanguage = 'javascript' | 'bash';

export type CodeBlockOptions = {
  language?: CodeBlockLanguage;
  label?: string;
};

const highlighter = await loadHighlighter();

async function loadHighlighter() {
  try {
    const [{ default: core }, { default: javascript }, { default: bash }] = await Promise.all([
      import('./vendor/highlight/core.min.js'),
      import('./vendor/highlight/javascript.min.js'),
      import('./vendor/highlight/bash.min.js'),
    ]);
    core.registerLanguage('javascript', javascript);
    core.registerLanguage('bash', bash);
    return core;
  } catch {
    return undefined;
  }
}

function escapeSource(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function highlightSource(source: string, language?: CodeBlockLanguage): string {
  if (language) {
    try {
      if (highlighter) {
        return highlighter.highlight(source, { language, ignoreIllegals: true }).value;
      }
    } catch {
      // Keep source readable if the highlighter cannot process it.
    }
  }
  return escapeSource(source);
}

/** Return highlighted HTML, or escaped source when highlighting is unavailable. */
export function highlightJavaScript(source: string): string {
  return highlightSource(source, 'javascript');
}

/** Return highlighted HTML, or escaped source when highlighting is unavailable. */
export function highlightBash(source: string): string {
  return highlightSource(source, 'bash');
}

export function createCodeBlock(source: string, options: CodeBlockOptions = {}): HTMLElement {
  const { language } = options;
  const headerLabel = options.label ?? (language === 'javascript' ? 'JavaScript' : language === 'bash' ? 'Bash' : 'Text');
  const wrapper = document.createElement('div');
  wrapper.className = language ? `code-block-wrapper ${language}-code-block` : 'code-block-wrapper';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const label = document.createElement('span');
  label.textContent = headerLabel;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-btn';
  button.textContent = 'Copy code';
  header.append(label, button);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (language) code.className = `language-${language}`;
  // Character references preserve carriage returns when HTML is parsed.
  code.innerHTML = highlightSource(source, language).replace(/\r/g, '&#13;');
  pre.appendChild(code);
  wrapper.append(header, pre);

  button.addEventListener('click', async event => {
    event.stopPropagation();
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(source);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = source;
        textarea.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand('copy')) throw new Error('Copy failed');
        } finally {
          textarea.remove();
          button.focus();
        }
      }
      button.textContent = 'Copied!';
      button.classList.add('copied');
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy code';
      button.classList.remove('copied');
    }, 2000);
  });
  return wrapper;
}

export function createJavaScriptCodeBlock(source: string): HTMLElement {
  return createCodeBlock(source, { language: 'javascript', label: 'JavaScript' });
}
