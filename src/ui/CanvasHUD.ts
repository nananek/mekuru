import type { CroquisTimer } from '../timer/CroquisTimer';

export interface CanvasHUDCallbacks {
  onMekuru: () => void;
  onUndo: () => void;
  onOpenGallery: () => void;
  onOpenSettings: () => void;
}

export class CanvasHUD {
  private container: HTMLElement;
  private timer: CroquisTimer;
  private callbacks: CanvasHUDCallbacks;

  private undoBtn!: HTMLButtonElement;
  private timerBtn!: HTMLButtonElement;
  private autoFlipBtn!: HTMLButtonElement;
  private timerText!: HTMLElement;
  private mekuruBtn!: HTMLButtonElement;
  private hudWrapper!: HTMLElement;

  constructor(container: HTMLElement, timer: CroquisTimer, callbacks: CanvasHUDCallbacks) {
    this.container = container;
    this.timer = timer;
    this.callbacks = callbacks;

    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div id="hud-wrapper" class="w-full h-full p-4 md:p-6 flex flex-col justify-between transition-opacity duration-300 opacity-60 hover:opacity-100">
        <!-- Top Row -->
        <div class="flex justify-between items-start pointer-events-none">
          <!-- Top Left: Minimal Timer & Auto-flip toggle -->
          <div class="flex items-center gap-2 pointer-events-auto">
            <button id="hud-timer-btn" class="hud-btn flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 border border-black/10 shadow-sm text-xs font-mono text-[#1a1a1a]">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span id="hud-timer-text">OFF</span>
            </button>
            <button id="hud-autoflip-btn" title="タイムアップ時の自動めくり切替" class="hud-btn px-2.5 py-1.5 rounded-full bg-white/80 border border-black/10 shadow-sm text-[11px] font-mono text-black/40">
              Auto: OFF
            </button>
          </div>

          <!-- Top Right: Gallery & Settings -->
          <div class="flex items-center gap-2 pointer-events-auto">
            <button id="hud-settings-btn" title="設定（アカウント / アプリ更新）" class="hud-btn p-2 rounded-full bg-white/80 border border-black/10 shadow-sm text-[#1a1a1a]">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <button id="hud-gallery-btn" title="スケッチ一覧（ギャラリー）" class="hud-btn flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/80 border border-black/10 shadow-sm text-xs text-[#1a1a1a]">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
                <circle cx="9" cy="9" r="2"></circle>
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>
              </svg>
              <span>一覧</span>
            </button>
          </div>
        </div>

        <!-- Bottom Row -->
        <div class="flex justify-between items-end pointer-events-none">
          <!-- Bottom Left: Undo Button -->
          <div class="pointer-events-auto">
            <button id="hud-undo-btn" title="直前のストロークを取り消し (2本指タップ)" class="hud-btn flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-white/80 border border-black/10 shadow-sm text-xs text-black/30 cursor-not-allowed">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7v6h6"></path>
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
              </svg>
              <span>Undo</span>
            </button>
          </div>

          <!-- Bottom Right: Mekuru (Next Page) -->
          <div class="pointer-events-auto">
            <button id="hud-mekuru-btn" title="保存して白紙へめくる (2本指スワイプ)" class="hud-btn flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#1a1a1a] text-[#fdfbf7] shadow-lg text-sm font-medium tracking-wide">
              <span>めくる</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    this.hudWrapper = document.getElementById('hud-wrapper') as HTMLElement;
    this.timerBtn = document.getElementById('hud-timer-btn') as HTMLButtonElement;
    this.autoFlipBtn = document.getElementById('hud-autoflip-btn') as HTMLButtonElement;
    this.timerText = document.getElementById('hud-timer-text') as HTMLElement;
    this.undoBtn = document.getElementById('hud-undo-btn') as HTMLButtonElement;
    this.mekuruBtn = document.getElementById('hud-mekuru-btn') as HTMLButtonElement;

    const galleryBtn = document.getElementById('hud-gallery-btn') as HTMLButtonElement;
    const settingsBtn = document.getElementById('hud-settings-btn') as HTMLButtonElement;

    this.timerBtn.addEventListener('click', () => {
      this.timer.cycleNextPreset();
      this.updateTimerDisplay();
    });

    this.autoFlipBtn.addEventListener('click', () => {
      const active = this.timer.toggleAutoFlip();
      this.autoFlipBtn.textContent = `Auto: ${active ? 'ON' : 'OFF'}`;
      this.autoFlipBtn.className = `hud-btn px-2.5 py-1.5 rounded-full border shadow-sm text-[11px] font-mono ${
        active ? 'bg-black text-white border-black' : 'bg-white/80 text-black/40 border-black/10'
      }`;
    });

    this.undoBtn.addEventListener('click', () => {
      this.callbacks.onUndo();
    });

    this.mekuruBtn.addEventListener('click', () => {
      this.callbacks.onMekuru();
    });

    galleryBtn.addEventListener('click', () => {
      this.callbacks.onOpenGallery();
    });

    settingsBtn.addEventListener('click', () => {
      this.callbacks.onOpenSettings();
    });
  }

  public setDrawingState(isDrawing: boolean): void {
    if (isDrawing) {
      this.hudWrapper.classList.remove('opacity-60');
      this.hudWrapper.classList.add('opacity-15');
    } else {
      this.hudWrapper.classList.remove('opacity-15');
      this.hudWrapper.classList.add('opacity-60');
    }
  }

  public setCanUndo(canUndo: boolean): void {
    if (canUndo) {
      this.undoBtn.classList.remove('text-black/30', 'cursor-not-allowed');
      this.undoBtn.classList.add('text-[#1a1a1a]', 'cursor-pointer');
    } else {
      this.undoBtn.classList.add('text-black/30', 'cursor-not-allowed');
      this.undoBtn.classList.remove('text-[#1a1a1a]', 'cursor-pointer');
    }
  }

  public updateTimerDisplay(): void {
    const duration = this.timer.getDuration();
    const remaining = this.timer.getRemaining();

    if (duration === 0) {
      this.timerText.textContent = 'OFF';
      return;
    }

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    this.timerText.textContent = `${min > 0 ? min + 'm ' : ''}${sec}s`;
  }
}
