import { SyncService, type GalleryItem } from '../services/SyncService';
import { ViewerModal } from './ViewerModal';
import { Toast } from '../ui/Toast';

export class GalleryModal {
  private container: HTMLElement;
  private viewerRoot: HTMLElement;
  private onCloseCallback: () => void;
  private sketches: GalleryItem[] = [];
  private serverAvailable = false;

  constructor(container: HTMLElement, viewerRoot: HTMLElement, onClose: () => void) {
    this.container = container;
    this.viewerRoot = viewerRoot;
    this.onCloseCallback = onClose;

    this.loadAndRender();
  }

  public async loadAndRender(): Promise<void> {
    const { items, serverAvailable } = await SyncService.getGalleryItems();
    this.sketches = items;
    this.serverAvailable = serverAvailable;
    this.render();
    this.attachEvents();
  }

  private render(): void {
    const totalCount = this.sketches.length;
    const pendingCount = this.sketches.filter((s) => s.pending).length;

    let gridHtml = '';
    if (totalCount === 0) {
      gridHtml = `
        <div class="flex-1 flex flex-col items-center justify-center p-8 text-center text-black/40">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mb-3 opacity-60">
            <path d="M12 19l7-7 3 3-7 7-3-3z"/>
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
          </svg>
          <p class="text-sm font-medium">まだスケッチがありません</p>
          <p class="text-xs text-black/30 mt-1">白紙キャンバスにApple Pencilでクロッキーを描いて「めくる」を押すと、ここに一覧表示されます。</p>
        </div>
      `;
    } else {
      const items = this.sketches
        .map((sketch, index) => {
          const thumbUrl = sketch.thumbUrl;
          const date = new Date(sketch.createdAt);
          const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
          const timerLabel = sketch.timerDurationSec > 0 ? `${sketch.timerDurationSec}s` : '手動';
          const pendingBadge = sketch.pending
            ? '<span class="px-1.5 py-0.5 rounded bg-amber-400/80 font-mono">未送信</span>'
            : '';

          return `
            <div class="sketch-card group relative aspect-square bg-white rounded-xl overflow-hidden border border-black/5 shadow-sm hover:shadow-md transition-all cursor-pointer" data-index="${index}">
              <img src="${thumbUrl}" alt="Thumbnail" class="w-full h-full object-contain p-1 group-hover:scale-105 transition-transform duration-200" />
              <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent p-2 flex justify-between items-end text-[10px] text-white">
                <span class="font-mono opacity-90">${timeStr}</span>
                <span class="flex gap-1">${pendingBadge}<span class="px-1.5 py-0.5 rounded bg-white/20 backdrop-blur-sm font-mono">${timerLabel}</span></span>
              </div>
            </div>
          `;
        })
        .join('');

      gridHtml = `
        <div class="flex-1 overflow-y-auto p-4 md:p-6">
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 md:gap-4">
            ${items}
          </div>
        </div>
      `;
    }

    this.container.innerHTML = `
      <div id="gallery-backdrop" class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm flex justify-center items-center">
        <div class="w-full max-w-4xl h-[92vh] bg-[#fdfbf7] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-black/10">
          <!-- Gallery Header -->
          <div class="px-6 py-4 border-b border-black/5 flex items-center justify-between bg-white/50 backdrop-blur-md">
            <div class="flex items-center gap-3">
              <h2 class="text-base font-semibold tracking-wide text-[#1a1a1a]">ギャラリー</h2>
              <span class="px-2 py-0.5 rounded-full bg-black/5 text-[11px] font-mono text-black/60">${totalCount} 枚</span>
              ${pendingCount > 0 ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-[11px] font-mono text-amber-800">未送信 ${pendingCount} 枚</span>` : ''}
              ${!this.serverAvailable && totalCount > 0 ? `<span class="px-2 py-0.5 rounded-full bg-black/5 text-[11px] font-mono text-black/40">オフライン表示</span>` : ''}
            </div>
            <div class="flex items-center gap-2">
              <button id="gallery-close-btn" class="p-2 rounded-full hover:bg-black/5 active:scale-95 transition-all text-[#1a1a1a]" title="閉じる">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- Gallery Content -->
          ${gridHtml}
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    const backdrop = document.getElementById('gallery-backdrop');
    const closeBtn = document.getElementById('gallery-close-btn');

    closeBtn?.addEventListener('click', () => this.close());
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.close();
      }
    });

    // Card click opens viewer
    const cards = this.container.querySelectorAll('.sketch-card');
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        const index = parseInt(card.getAttribute('data-index') || '0', 10);
        this.openViewer(index);
      });
    });
  }

  private openViewer(index: number): void {
    new ViewerModal(this.viewerRoot, this.sketches, index, {
      onDelete: async (item) => {
        const ok = await SyncService.deleteItem(item);
        Toast.show(ok ? 'スケッチを削除しました' : '削除に失敗しました');
        await this.loadAndRender();
      },
      onClose: () => {
        this.loadAndRender();
      },
    });
  }

  public close(): void {
    this.container.innerHTML = '';
    this.onCloseCallback();
  }
}
