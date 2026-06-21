import { Launcher } from './launcher.js';

type LauncherPanelOptions = {
  launcherEl: HTMLElement;
  messagesContainer: HTMLElement;
  createSession(projectPath: string): Promise<void>;
};

export function setupLauncherPanel({ launcherEl, messagesContainer, createSession }: LauncherPanelOptions) {
  const launcher = new Launcher(launcherEl, createSession);

  async function init() {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.projects && data.projects.length > 0) {
        launcher.projects = data.projects;
        launcher.render();
        addLauncherNav();
      }
    } catch {}
  }

  function addLauncherNav() {
    const modeToggle = document.getElementById('mode-toggle');
    if (!modeToggle || modeToggle.querySelector('.mode-link-launcher')) return;

    const launcherLink = document.createElement('span');
    launcherLink.className = 'mode-link mode-link-launcher';
    launcherLink.title = 'Projects';
    launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    launcherLink.addEventListener('click', () => show());
    modeToggle.appendChild(launcherLink);
  }

  function isVisible() {
    return !!launcherEl && !launcherEl.classList.contains('hidden');
  }

  function show() {
    launcherEl.classList.remove('hidden');
    messagesContainer.style.display = 'none';
    document.querySelector<HTMLElement>('.input-area').style.display = 'none';
    document.querySelector('.welcome')?.remove();

    document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.mode-link-launcher')?.classList.add('active');

    launcher.load();
  }

  function hide() {
    launcherEl.classList.add('hidden');
    messagesContainer.style.display = '';
    document.querySelector<HTMLElement>('.input-area').style.display = '';

    document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.mode-link:first-child')?.classList.add('active');
  }

  document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
    hide();
  });

  return { init, isVisible, show, hide };
}
