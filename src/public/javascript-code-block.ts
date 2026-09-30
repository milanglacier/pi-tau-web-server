const highlighter = await loadHighlighter();

async function loadHighlighter() {
  try {
    const [{ default: core }, { default: javascript }] = await Promise.all([
      import('./vendor/highlight/core.min.js'),
      import('./vendor/highlight/javascript.min.js'),
    ]);
    core.registerLanguage('javascript', javascript);
    return core;
  } catch {
    return undefined;
  }
}

/** Return highlighted HTML, or escaped source when highlighting is unavailable. */
export function highlightJavaScript(source: string): string {
  try {
    if (highlighter) {
      return highlighter.highlight(source, { language: 'javascript', ignoreIllegals: true }).value;
    }
  } catch {
    // Keep source readable if the highlighter cannot process it.
  }
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function createJavaScriptCodeBlock(source: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block-wrapper javascript-code-block';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const label = document.createElement('span');
  label.textContent = 'JavaScript';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-btn';
  button.textContent = 'Copy code';
  header.append(label, button);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-javascript';
  // Character references preserve carriage returns when HTML is parsed.
  code.innerHTML = highlightJavaScript(source).replace(/\r/g, '&#13;');
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
