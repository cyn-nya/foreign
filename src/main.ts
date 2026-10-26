import { Game } from './game/Game';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;

declare global {
  interface Window {
    __game?: Game;
  }
}

const game = new Game(canvas);
window.__game = game;

game.init().catch((error: unknown) => {
  console.error('[foreign] init failed', error);
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
      <div class="panel">
        <h1 class="title" style="font-size:26px">启动失败<span class="sub">ERROR</span></h1>
        <p class="tagline">${String(error)}</p>
        <div class="actions"><button class="primary" onclick="location.reload()">重试</button></div>
      </div>`;
  }
});
