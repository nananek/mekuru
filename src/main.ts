import './style.css';
import { PencilEngine } from './engine/PencilEngine';
import { CroquisTimer } from './timer/CroquisTimer';
import { CanvasHUD } from './ui/CanvasHUD';
import { SketchService } from './services/SketchService';
import { SyncService } from './services/SyncService';
import { db } from './db/database';
import { GalleryModal } from './gallery/GalleryModal';
import { AuthModal } from './ui/AuthModal';
import { Toast } from './ui/Toast';
import { DebugService } from './services/DebugService';
import { registerSW } from 'virtual:pwa-register';

// Register Service Worker for PWA
registerSW({ immediate: true });

document.addEventListener('DOMContentLoaded', () => {
  const canvasEl = document.getElementById('sketch-canvas') as HTMLCanvasElement;
  const hudContainer = document.getElementById('hud-container') as HTMLElement;
  const galleryRoot = document.getElementById('gallery-root') as HTMLElement;
  const viewerRoot = document.getElementById('viewer-root') as HTMLElement;

  let engine: PencilEngine;
  let hud: CanvasHUD;
  let timer: CroquisTimer;

  // Outbox flush: upload pending sketches and delete locally confirmed
  // ones. Runs at startup, every minute, and when the page becomes visible
  // (back online / logged in later / other device drew meanwhile).
  let syncRunning = false;
  const runOutboxFlush = async (announce: boolean) => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      const done = await SyncService.flushOutbox();
      if (announce && done > 0) {
        Toast.show(`サーバーに${done}件保存しました`);
      }
    } finally {
      syncRunning = false;
    }
  };
  runOutboxFlush(false).catch(() => {});
  window.setInterval(() => {
    runOutboxFlush(false).catch(() => {});
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      runOutboxFlush(true).catch(() => {});
    }
  });

  // Page Flip ("めくる") execution routine
  const executeMekuru = async () => {
    // If user drew nothing, just refresh canvas
    const hasStrokes = engine.hasStrokes();
    const duration = timer.getDuration();

    if (hasStrokes) {
      // 1. Snapshot canvas instantly
      const mainCanvas = engine.getCanvas();
      const snapshot = document.createElement('canvas');
      snapshot.width = mainCanvas.width;
      snapshot.height = mainCanvas.height;
      const sctx = snapshot.getContext('2d');
      if (sctx) {
        sctx.drawImage(mainCanvas, 0, 0);
      }

      // 2. Clear canvas IMMEDIATELY (<16ms) so user can draw without waiting
      engine.clearCanvas();
      Toast.show('めくりました');

      // 3. Save to the outbox (IndexedDB) in background; the flusher
      // uploads it and deletes the local copy on server confirmation.
      SketchService.saveSketch(snapshot, duration).then(async (savedSketch) => {
        if (savedSketch?.id !== undefined) {
          try {
            if (await SyncService.uploadSketch(savedSketch)) {
              await db.sketches.delete(savedSketch.id);
            }
            // On failure the periodic flusher picks it up later.
          } catch {
            // ignore: periodic flusher picks it up later
          }
        }
      });
    } else {
      engine.clearCanvas();
    }

    // Reset timer countdown if active
    if (duration > 0) {
      timer.reset();
    }
  };

  // Timer Initialization
  timer = new CroquisTimer({
    onTick: () => {
      hud.updateTimerDisplay();
    },
    onTimeUp: () => {
      Toast.show('タイムアップ！');
    },
    onAutoFlip: () => {
      executeMekuru();
    },
  });

  // Pencil Engine Initialization
  engine = new PencilEngine(canvasEl, {
    onStrokeStart: () => {
      hud.setDrawingState(true);
      if (DebugService.isDebugEnabled()) {
        DebugService.startStroke();
      }
      // Auto-start timer on first stroke of page if timer preset is set and not running
      if (timer.getDuration() > 0 && !timer.getIsRunning()) {
        timer.start();
      }
    },
    onPoint: (pt) => {
      if (DebugService.isDebugEnabled()) {
        DebugService.recordPoint(pt);
      }
    },
    onStrokeEnd: () => {
      hud.setDrawingState(false);
      if (DebugService.isDebugEnabled()) {
        DebugService.finishStroke(canvasEl);
      }
    },
    onUndoChange: (canUndo) => {
      hud.setCanUndo(canUndo);
    },
    onTwoFingerTap: () => {
      Toast.show('取り消し (Undo)');
    },
    onTwoFingerSwipe: () => {
      executeMekuru();
    },
  });

  // Start background live bridge and HUD badge if debug mode is on
  if (DebugService.isDebugEnabled()) {
    DebugService.startBridgeWorker();

    const debugBadge = document.createElement('div');
    debugBadge.id = 'debug-status-badge';
    debugBadge.className =
      'fixed top-2 left-2 z-50 px-2 py-1 bg-black/70 backdrop-blur-sm text-green-400 text-xs font-mono rounded pointer-events-none select-none border border-green-500/30 transition-opacity';
    debugBadge.textContent = '● DEBUG API ACTIVE';
    document.body.appendChild(debugBadge);

    DebugService.onStatus((status) => {
      debugBadge.textContent = `● ${status}`;
      debugBadge.style.opacity = '1';
      setTimeout(() => {
        debugBadge.textContent = '● DEBUG API ACTIVE';
      }, 3500);
    });
  }

  // Corner HUD Initialization
  hud = new CanvasHUD(hudContainer, timer, {
    onMekuru: () => {
      executeMekuru();
    },
    onUndo: () => {
      if (engine.undo()) {
        Toast.show('取り消し (Undo)');
      }
    },
    onOpenGallery: () => {
      new GalleryModal(galleryRoot, viewerRoot, () => {});
    },
    onOpenSettings: () => {
      new AuthModal(galleryRoot, () => {});
    },
  });

  // Double check resize
  window.addEventListener('resize', () => {
    engine.setupCanvasSize();
  });
});
