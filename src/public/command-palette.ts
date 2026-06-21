type CommandPaletteItem = {
  icon: string;
  label: string;
  desc: string;
  action(): void;
};

export function setupCommandPalette(commands: CommandPaletteItem[]) {
  const commandBtn = document.getElementById('command-btn');
  const commandPalette = document.getElementById('command-palette');
  const commandPaletteOverlay = document.getElementById('command-palette-overlay');
  const commandList = document.getElementById('command-list');

  function open() {
    commandList.innerHTML = '';
    commands.forEach(cmd => {
      const el = document.createElement('div');
      el.className = 'command-item';
      el.innerHTML = `
        <div class="command-icon">${cmd.icon}</div>
        <div>
          <div class="command-label">${cmd.label}</div>
          <div class="command-desc">${cmd.desc}</div>
        </div>
      `;
      el.addEventListener('click', () => {
        close();
        cmd.action();
      });
      commandList.appendChild(el);
    });
    commandPalette.classList.remove('hidden');
    commandPaletteOverlay.classList.remove('hidden');
  }

  function close() {
    commandPalette.classList.add('hidden');
    commandPaletteOverlay.classList.add('hidden');
  }

  function closeIfOpen() {
    if (commandPalette.classList.contains('hidden')) return false;
    close();
    return true;
  }

  commandBtn.addEventListener('click', open);
  commandPaletteOverlay.addEventListener('click', close);

  return { close, closeIfOpen };
}
