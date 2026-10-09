import type { GalleryItem } from '../services/SyncService';
import { SketchService } from '../services/SketchService';
import { Toast } from '../ui/Toast';

export interface ViewerModalCallbacks {
  onDelete: (item: GalleryItem) => void;
  onClose: () => void;
}

export class ViewerModal {
  private container: HTMLElement;
  private sketches: GalleryItem[];
  private currentIndex: number;
  private callbacks: ViewerModalCallbacks;
  private touchStartX: number = 0;
  private touchEndX: number = 0;

  constructor(
    container: HTMLElement,
    sketches: GalleryItem[],
    initialIndex: number,
    callbacks: ViewerModalCallbacks
  ) {
    this.container = container;
    this.sketches = sketches;
    this.currentIndex = initialIndex;
    this.callbacks = callbacks;

    this.render();
    this.attachEvents();
  }

  private render(): void {
    const sketch = this.sketches[this.currentIndex];
    if (!sketch) return;

    const imgUrl = sketch.imageUrl;
    const dateStr = new Date(sketch.createdAt).toLocaleString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const timerLabel = sketch.timerDurationSec > 0 ? `${sketch.timerDurationSec}秒` : 'なし';

    this.container.innerHTML = `
      <div id="viewer-overlay" class="fixed inset-0 z-50 bg-[#1a1a1a]/95 backdrop-blur-md flex flex-col justify-between select-none">
        <!-- Top Toolbar -->
        <div class="flex items-center justify-between p-4 md:p-6 text-white/90 z-10">
          <button id="viewer-close-btn" class="p-2 rounded-full hover:bg-white/10 active:scale-95 transition-all" title="閉じる">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </button>

          <div class="flex flex-col items-center">
            <span class="text-sm font-medium tracking-wide">${this.currentIndex + 1} / ${this.sketches.length}</span>
            <span class="text-[11px] text-white/50">${dateStr} (${timerLabel})</span>
          </div>

          <div class="flex items-center gap-2">
            <button id="viewer-share-btn" class="p-2 rounded-full hover:bg-white/10 active:scale-95 transition-all text-white/90" title="画像保存・共有">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" x2="12" y1="15" y2="3"/>
              </svg>
            </button>
            <button id="viewer-delete-btn" class="p-2 rounded-full hover:bg-red-500/20 text-red-400 active:scale-95 transition-all" title="削除">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Main Image Area -->
        <div id="viewer-img-container" class="relative flex-1 flex items-center justify-center p-2 md:p-6 overflow-hidden cursor-pointer">
          <img id="viewer-img" src="${imgUrl}" alt="Sketch" class="max-w-full max-h-full object-contain rounded-md shadow-2xl transition-transform duration-200" />

          <!-- Left / Right Tap Controls -->
          <button id="viewer-prev-btn" class="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/80 hover:bg-black/60 transition-all ${this.currentIndex === 0 ? 'opacity-20 cursor-not-allowed' : 'opacity-80'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </button>
          <button id="viewer-next-btn" class="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/80 hover:bg-black/60 transition-all ${this.currentIndex === this.sketches.length - 1 ? 'opacity-20 cursor-not-allowed' : 'opacity-80'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          </button>
        </div>

        <!-- Bottom Page Indicator -->
        <div class="p-4 text-center text-xs text-white/40 tracking-wider">
          左右スワイプまたは矢印キーでめくる
        </div>
      </div>
    `;

    // NOTE: image URLs are stable per gallery item (server URL or a single
    // Blob URL for outbox rows), so they must NOT be revoked here.
  }

  private attachEvents(): void {
    const closeBtn = document.getElementById('viewer-close-btn');
    const shareBtn = document.getElementById('viewer-share-btn');
    const deleteBtn = document.getElementById('viewer-delete-btn');
    const prevBtn = document.getElementById('viewer-prev-btn');
    const nextBtn = document.getElementById('viewer-next-btn');
    const imgContainer = document.getElementById('viewer-img-container');

    closeBtn?.addEventListener('click', () => this.close());

    prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prev();
    });

    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.next();
    });

    shareBtn?.addEventListener('click', async () => {
      const sketch = this.sketches[this.currentIndex];
      if (!sketch) return;
      try {
        Toast.show('画像をエクスポート中...');
        const imageBlob =
          sketch.imageBlob ?? (await (await fetch(sketch.imageUrl)).blob());
        await SketchService.exportSketch({
          createdAt: sketch.createdAt,
          timerDurationSec: sketch.timerDurationSec,
          imageBlob,
          thumbnailBlob: imageBlob,
        });
      } catch {
        Toast.show('エクスポートに失敗しました');
      }
    });

    deleteBtn?.addEventListener('click', () => {
      if (confirm('このスケッチを削除しますか？')) {
        const sketch = this.sketches[this.currentIndex];
        if (sketch) {
          this.callbacks.onDelete(sketch);
          this.sketches.splice(this.currentIndex, 1);
          if (this.sketches.length === 0) {
            this.close();
          } else {
            if (this.currentIndex >= this.sketches.length) {
              this.currentIndex = this.sketches.length - 1;
            }
            this.render();
            this.attachEvents();
          }
        }
      }
    });

    // Touch swipe handling for iPad flipbook feel
    imgContainer?.addEventListener(
      'touchstart',
      (e) => {
        this.touchStartX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );

    imgContainer?.addEventListener(
      'touchend',
      (e) => {
        this.touchEndX = e.changedTouches[0].screenX;
        const diff = this.touchEndX - this.touchStartX;
        if (Math.abs(diff) > 50) {
          if (diff > 0) {
            this.prev();
          } else {
            this.next();
          }
        }
      },
      { passive: true }
    );

    // Keyboard navigation
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') this.prev();
      else if (e.key === 'ArrowRight') this.next();
      else if (e.key === 'Escape') this.close();
    };
    window.addEventListener('keydown', keyHandler);

    this.cleanupListener = () => {
      window.removeEventListener('keydown', keyHandler);
    };
  }

  private cleanupListener: (() => void) | null = null;

  public prev(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.render();
      this.attachEvents();
    }
  }

  public next(): void {
    if (this.currentIndex < this.sketches.length - 1) {
      this.currentIndex++;
      this.render();
      this.attachEvents();
    }
  }

  public close(): void {
    if (this.cleanupListener) {
      this.cleanupListener();
    }
    this.container.innerHTML = '';
    this.callbacks.onClose();
  }
}
