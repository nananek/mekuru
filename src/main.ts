import './style.css';
import { PencilEngine } from './engine/PencilEngine';
import { CroquisTimer } from './timer/CroquisTimer';
import { CanvasHUD } from './ui/CanvasHUD';
import { SketchService } from './services/SketchService';
import { SyncService } from './services/SyncService';
import { GalleryModal } from './gallery/GalleryModal';
import { AuthModal } from './ui/AuthModal';
import { Toast } from './ui/Toast';
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

  // Initial Sync from server in background if available
  SyncService.syncFromServer().catch(() => {});

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

      // 3. Save asynchronously to IndexedDB in background
      SketchService.saveSketch(snapshot, duration).then((savedSketch) => {
        if (savedSketch) {
          SyncService.uploadSketch(savedSketch).catch(() => {});
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
      // Auto-start timer on first stroke of page if timer preset is set and not running
      if (timer.getDuration() > 0 && !timer.getIsRunning()) {
        timer.start();
      }
    },
    onStrokeEnd: () => {
      hud.setDrawingState(false);
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
    onOpenAuth: () => {
      new AuthModal(galleryRoot, () => {});
    },
  });

  // Double check resize
  window.addEventListener('resize', () => {
    engine.setupCanvasSize();
  });
});
