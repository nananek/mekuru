import { GestureRecognizer } from './GestureRecognizer';
import { PencilTexture } from './PencilTexture';
import { SplineStroke, StrokePoint } from './SplineStroke';
import { UndoManager } from './UndoManager';

export interface PencilEngineOptions {
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
  onUndoChange?: (canUndo: boolean) => void;
  onTwoFingerTap?: () => void;
  onTwoFingerSwipe?: (direction: 'left' | 'right') => void;
}

export class PencilEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private activeCanvas: HTMLCanvasElement;
  private activeCtx: CanvasRenderingContext2D;
  private dpr: number = 1;

  private isDrawing: boolean = false;
  private activePointerId: number | null = null;
  private splineStroke: SplineStroke;
  private strokeCount: number = 0;

  private undoManager: UndoManager;
  private gestureRecognizer: GestureRecognizer;
  private options: PencilEngineOptions;

  // Pencil properties
  private baseRadius: number = 1.6; // Base pencil tip radius
  private allowMouse: boolean = true; // Permitted for testing and fallback

  constructor(canvas: HTMLCanvasElement, options: PencilEngineOptions = {}) {
    this.canvas = canvas;
    this.options = options;

    const context = canvas.getContext('2d', {
      desynchronized: true,
      alpha: false,
    });
    if (!context) {
      throw new Error('Could not get 2d context for canvas');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    this.ctx = context;

    // Overlay active canvas for zero-artifact, banding-free real-time stroke rendering
    this.activeCanvas = document.createElement('canvas');
    this.activeCanvas.id = 'active-stroke-canvas';
    this.activeCanvas.className =
      'absolute inset-0 w-full h-full block pointer-events-none touch-none';
    this.activeCanvas.style.zIndex = '10';
    this.activeCanvas.style.mixBlendMode = 'multiply';
    if (this.canvas.parentElement) {
      this.canvas.parentElement.insertBefore(this.activeCanvas, this.canvas.nextSibling);
    } else {
      document.body.appendChild(this.activeCanvas);
    }

    const actx = this.activeCanvas.getContext('2d', {
      desynchronized: true,
    });
    if (!actx) {
      throw new Error('Could not get 2d context for active canvas');
    }
    actx.imageSmoothingEnabled = true;
    actx.imageSmoothingQuality = 'high';
    this.activeCtx = actx;

    this.splineStroke = new SplineStroke(0.35);
    this.undoManager = new UndoManager(25);
    this.gestureRecognizer = new GestureRecognizer({
      onTwoFingerTap: () => {
        this.undo();
        this.options.onTwoFingerTap?.();
      },
      onTwoFingerSwipe: (dir) => {
        this.options.onTwoFingerSwipe?.(dir);
      },
    });

    this.setupCanvasSize();
    this.attachEventListeners();
    this.fillPaperBackground();
  }

  /**
   * Configures canvas dimensions with Retina scaling for both main and active layers
   */
  public setupCanvasSize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Snapshot current drawing if resizing
    let tempCanvas: HTMLCanvasElement | null = null;
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.canvas.width;
      tempCanvas.height = this.canvas.height;
      const tctx = tempCanvas.getContext('2d');
      if (tctx) {
        tctx.drawImage(this.canvas, 0, 0);
      }
    }

    const pixelWidth = Math.round(width * this.dpr);
    const pixelHeight = Math.round(height * this.dpr);

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.activeCanvas.width = pixelWidth;
    this.activeCanvas.height = pixelHeight;
    this.activeCanvas.style.width = `${width}px`;
    this.activeCanvas.style.height = `${height}px`;

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.activeCtx.imageSmoothingEnabled = true;
    this.activeCtx.imageSmoothingQuality = 'high';

    this.fillPaperBackground();

    // Restore previous drawing if there was one
    if (tempCanvas) {
      this.ctx.drawImage(tempCanvas, 0, 0);
    }
  }

  /**
   * Cleans canvas and fills with warm paper color
   */
  public fillPaperBackground(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#fdfbf7';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  /**
   * Attaches pointer and gesture event listeners
   */
  private attachEventListeners(): void {
    const el = this.canvas;

    el.addEventListener('pointerdown', this.onPointerDown.bind(this), { passive: false });
    window.addEventListener('pointermove', this.onPointerMove.bind(this), { passive: false });
    window.addEventListener('pointerup', this.onPointerUp.bind(this), { passive: false });
    window.addEventListener('pointercancel', this.onPointerCancel.bind(this), { passive: false });

    window.addEventListener('resize', () => {
      this.setupCanvasSize();
    });

    // Prevent default gesture zooms / touches on iOS Safari
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
  }

  private isDrawingPointer(e: PointerEvent): boolean {
    if (e.pointerType === 'pen') return true;
    if (this.allowMouse && e.pointerType === 'mouse') return true;
    return false;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.gestureRecognizer.handlePointerDown(e);
      return;
    }

    if (!this.isDrawingPointer(e)) return;

    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    this.isDrawing = true;

    // Snapshot state for undo BEFORE beginning new stroke
    this.undoManager.pushState(this.canvas);
    this.options.onUndoChange?.(this.undoManager.canUndo());
    this.options.onStrokeStart?.();

    const pt = this.extractPoint(e);
    this.splineStroke.clear();
    this.splineStroke.addPoint(pt);
    this.renderActiveStroke();
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.gestureRecognizer.handlePointerMove(e);
      return;
    }

    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    e.preventDefault();

    // 120Hz Coalesced Events recovery for iPad Pro / Apple Pencil
    const coalescedEvents =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];

    for (let i = 0; i < coalescedEvents.length; i++) {
      const subEvent = coalescedEvents[i];
      // Apple Pencil hover reports pressure 0. Never draw from hover
      if (subEvent.pointerType === 'pen' && subEvent.pressure === 0) {
        continue;
      }
      const pt = this.extractPoint(subEvent);
      this.splineStroke.addPoint(pt);
    }

    // Safety rolling flush if single continuous gesture is extraordinarily long (> 250 points)
    if (this.splineStroke.getPointCount() > 250) {
      this.flushLongStrokeChunk();
    }

    this.renderActiveStroke();
  }

  /**
   * Flushes early segment of an extraordinarily long stroke to main canvas
   * while preserving the last 4 points for seamless spline tangent continuation.
   */
  private flushLongStrokeChunk(): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';
    this.ctx.drawImage(this.activeCanvas, 0, 0);
    this.ctx.restore();

    this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);

    const pts = this.splineStroke.getPoints();
    const keep = pts.slice(-4);
    this.splineStroke.clear();
    for (const p of keep) {
      this.splineStroke.addPoint(p);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.gestureRecognizer.handlePointerUp(e);
      return;
    }

    if (e.pointerId === this.activePointerId) {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }

      const pt = this.extractPoint(e);
      this.splineStroke.addPoint(pt);
      this.renderActiveStroke();

      // Bake completed stroke to main canvas
      this.ctx.save();
      this.ctx.globalCompositeOperation = 'multiply';
      this.ctx.drawImage(this.activeCanvas, 0, 0);
      this.ctx.restore();

      // Clear active stroke layer
      this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
      this.splineStroke.clear();

      this.isDrawing = false;
      this.activePointerId = null;
      this.strokeCount++;

      this.options.onStrokeEnd?.();
      this.options.onUndoChange?.(this.undoManager.canUndo());
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.gestureRecognizer.handlePointerCancel(e);
      return;
    }

    if (e.pointerId === this.activePointerId) {
      this.isDrawing = false;
      this.activePointerId = null;
      this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
      this.splineStroke.clear();
    }
  }

  private extractPoint(e: PointerEvent): StrokePoint {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * this.dpr;
    const y = (e.clientY - rect.top) * this.dpr;

    let pressure = e.pressure;
    if (pressure === 0 && e.pointerType === 'mouse') {
      pressure = 0.5; // fallback for mouse
    } else if (pressure === 0 && e.pointerType === 'pen') {
      pressure = 0.1;
    }

    // altitudeAngle: 0 (flat) to PI/2 (vertical)
    let altitudeAngle = e.altitudeAngle !== undefined ? e.altitudeAngle : Math.PI / 2;
    if (altitudeAngle === undefined || Number.isNaN(altitudeAngle)) {
      altitudeAngle = Math.PI / 2;
    }

    const azimuthAngle = e.azimuthAngle || 0;

    return { x, y, pressure, altitudeAngle, azimuthAngle, time: e.timeStamp };
  }

  /**
   * Renders the active stroke cleanly onto the overlay canvas.
   * By drawing onto a dedicated active layer, overlapping segments never multiply
   * against each other, completely eliminating node blobs and banding stripes.
   */
  private renderActiveStroke(): void {
    const pts = this.splineStroke.getPoints();
    if (pts.length === 0) return;

    this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);

    // Determine if tilt shading is active (< 0.38 rad / ~22 degrees)
    const latestPt = pts[pts.length - 1];
    const isShading = latestPt.altitudeAngle < 0.38;

    this.activeCtx.save();

    if (isShading) {
      this.renderShadingStroke(pts);
    } else {
      this.renderLineStroke();
    }

    this.activeCtx.restore();
  }

  /**
   * Normal Line Mode: Renders a unified spline ribbon with dual-pass graphite texture.
   * No segment caps or discrete steps — resulting in a perfectly solid, continuous stroke.
   */
  private renderLineStroke(): void {
    // Pass 1: Soft graphite powder bloom / halo
    const haloPath = this.splineStroke.createRibbonPath(this.baseRadius, this.dpr, 1.18);
    if (haloPath) {
      this.activeCtx.fillStyle = '#262626';
      this.activeCtx.globalAlpha = 0.16;
      this.activeCtx.fill(haloPath);
    }

    // Pass 2: High-density core graphite line
    const corePath = this.splineStroke.createRibbonPath(this.baseRadius, this.dpr, 1.0);
    if (corePath) {
      this.activeCtx.fillStyle = '#141414';
      this.activeCtx.globalAlpha = 0.88;
      this.activeCtx.fill(corePath);
    }
  }

  /**
   * Tilt Shading Mode: High-density graphite stamps along Catmull-Rom spline path
   * with deterministic micro-jitter to prevent periodic moire / caterpillar stripes.
   */
  private renderShadingStroke(pts: StrokePoint[]): void {
    const len = pts.length;
    if (len === 1) {
      const p = pts[0];
      const radius = Math.max(1, this.baseRadius * this.dpr * (0.5 + p.pressure * 1.5));
      const stamp = PencilTexture.createStamp(radius, p.altitudeAngle);
      this.activeCtx.globalAlpha = Math.min(0.65, 0.25 + p.pressure * 0.4);
      this.activeCtx.save();
      this.activeCtx.translate(p.x, p.y);
      const angle = p.azimuthAngle ? p.azimuthAngle + Math.PI / 2 : 0;
      this.activeCtx.rotate(angle);
      this.activeCtx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
      this.activeCtx.restore();
      return;
    }

    for (let i = 0; i < len - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < len ? pts[i + 2] : p2;

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const avgPressure = (p1.pressure + p2.pressure) / 2;
      const radius = Math.max(1, this.baseRadius * this.dpr * (0.5 + avgPressure * 1.5));

      // Ultra-fine step size (18% of radius) to eliminate stamp gaps and banding
      const stepSize = Math.max(1.2, radius * 0.18);
      const steps = Math.max(1, Math.ceil(dist / stepSize));

      const avgAzimuth = (p1.azimuthAngle + p2.azimuthAngle) / 2;
      const angle = avgAzimuth
        ? avgAzimuth + Math.PI / 2
        : Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2;

      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const invT = 1 - t;
        const bx =
          invT * invT * invT * p1.x +
          3 * invT * invT * t * cp1x +
          3 * invT * t * t * cp2x +
          t * t * t * p2.x;
        const by =
          invT * invT * invT * p1.y +
          3 * invT * invT * t * cp1y +
          3 * invT * t * t * cp2y +
          t * t * t * p2.y;

        const pressure = p1.pressure + (p2.pressure - p1.pressure) * t;
        const altitude = p1.altitudeAngle + (p2.altitudeAngle - p1.altitudeAngle) * t;
        const stamp = PencilTexture.createStamp(radius, altitude);

        // Deterministic trigonometric micro-jitter breaks periodic banding without flickering
        const jitterX = Math.sin(s * 12.9898 + i * 78.233) * 0.6;
        const jitterY = Math.cos(s * 12.9898 + i * 78.233) * 0.6;

        this.activeCtx.globalAlpha = Math.min(0.55, 0.18 + pressure * 0.35);
        this.activeCtx.save();
        this.activeCtx.translate(bx + jitterX, by + jitterY);
        this.activeCtx.rotate(angle);
        this.activeCtx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
        this.activeCtx.restore();
      }
    }
  }

  /**
   * Reverts to the previous stroke state
   */
  public undo(): boolean {
    this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
    this.splineStroke.clear();
    const success = this.undoManager.undo(this.canvas);
    if (success && this.strokeCount > 0) {
      this.strokeCount--;
    }
    this.options.onUndoChange?.(this.undoManager.canUndo());
    return success;
  }

  /**
   * Clears the canvas and resets undo history for a fresh white page (Mekuru)
   */
  public clearCanvas(): void {
    this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
    this.splineStroke.clear();
    this.fillPaperBackground();
    this.undoManager.clear();
    this.strokeCount = 0;
    this.options.onUndoChange?.(false);
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public hasStrokes(): boolean {
    return this.strokeCount > 0;
  }

  public getStrokeCount(): number {
    return this.strokeCount;
  }
}
