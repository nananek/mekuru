import { GestureRecognizer } from './GestureRecognizer';
import { PencilTexture } from './PencilTexture';
import { UndoManager } from './UndoManager';

export interface PencilEngineOptions {
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
  onUndoChange?: (canUndo: boolean) => void;
  onTwoFingerTap?: () => void;
  onTwoFingerSwipe?: (direction: 'left' | 'right') => void;
}

export interface Point {
  x: number;
  y: number;
  pressure: number;
  altitudeAngle: number;
  azimuthAngle: number;
  pointerType: string;
}

export class PencilEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number = 1;

  private isDrawing: boolean = false;
  private activePointerId: number | null = null;
  private lastPoint: Point | null = null;
  private currentDrawPoint: { x: number; y: number } | null = null;
  private smoothedPressure: number = 0.5;
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
   * Configures canvas dimensions with Retina scaling
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

    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

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
    this.smoothedPressure = pt.pressure;
    this.drawPencilDot(pt);
    this.lastPoint = pt;
    this.currentDrawPoint = { x: pt.x, y: pt.y };
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.gestureRecognizer.handlePointerMove(e);
      return;
    }

    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    e.preventDefault();

    // 120Hz Coalesced Events recovery for iPad Pro / Apple Pencil
    const coalescedEvents = (typeof e.getCoalescedEvents === 'function')
      ? e.getCoalescedEvents()
      : [e];

    for (let i = 0; i < coalescedEvents.length; i++) {
      const subEvent = coalescedEvents[i];
      // Apple Pencil hover reports pressure 0. Never draw from hover:
      // with a missed pointerup this would streak from the stale lastPoint.
      // (Contact moves always carry pressure > 0 on pen.)
      if (subEvent.pointerType === 'pen' && subEvent.pressure === 0) {
        continue;
      }
      const pt = this.extractPoint(subEvent);
      if (this.lastPoint && this.currentDrawPoint) {
        this.drawPencilCurveSegment(this.lastPoint, pt);
      }
      this.lastPoint = pt;
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

      // Finalize the last remaining line segment to the release point
      if (this.lastPoint && this.currentDrawPoint) {
        this.finishStrokeSegment(this.currentDrawPoint, this.lastPoint);
      }

      this.isDrawing = false;
      this.activePointerId = null;
      this.lastPoint = null;
      this.currentDrawPoint = null;
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
      this.lastPoint = null;
      this.currentDrawPoint = null;
    }
  }

  private extractPoint(e: PointerEvent): Point {
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
    const pointerType = e.pointerType;

    return { x, y, pressure, altitudeAngle, azimuthAngle, pointerType };
  }

  /**
   * Draws a pencil dot at initial contact
   */
  private drawPencilDot(pt: Point): void {
    const isShading =
      pt.pointerType === 'pen' &&
      pt.altitudeAngle > 0 &&
      pt.altitudeAngle < 0.38;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';

    if (isShading) {
      const radius = Math.max(1, this.baseRadius * this.dpr * (0.4 + pt.pressure * 1.6));
      const stamp = PencilTexture.createStamp(radius, pt.altitudeAngle);
      this.ctx.globalAlpha = Math.min(1.0, 0.15 + pt.pressure * 0.25);
      this.ctx.translate(pt.x, pt.y);
      const angle = pt.azimuthAngle ? pt.azimuthAngle + Math.PI / 2 : 0;
      this.ctx.rotate(angle);
      this.ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
    } else {
      const radius = Math.max(1, this.baseRadius * this.dpr * (0.5 + pt.pressure * 1.5));
      // 1. Soft graphite feathered edge (antialiasing bloom)
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, radius * 1.15, 0, Math.PI * 2);
      this.ctx.fillStyle = '#222222';
      this.ctx.globalAlpha = Math.min(0.25, 0.10 + pt.pressure * 0.15);
      this.ctx.fill();

      // 2. High-precision antialiased dark graphite core
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
      this.ctx.fillStyle = '#121212';
      this.ctx.globalAlpha = Math.min(1.0, 0.70 + pt.pressure * 0.30);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  /**
   * Smoothly draws a pencil curve segment using Midpoint Quadratic Bezier
   * interpolation with dual-pass antialiasing for line mode.
   * Shading mode stamps per-interpolated pressure/altitude along the same
   * bezier path so fast strokes don't show pair-constant banding.
   */
  private drawPencilCurveSegment(pPrev: Point, pNext: Point): void {
    const dx = pNext.x - pPrev.x;
    const dy = pNext.y - pPrev.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.1) return;

    // Smooth pressure transitions to eliminate step artifacts
    this.smoothedPressure = this.smoothedPressure * 0.6 + pNext.pressure * 0.4;
    const avgAltitude = (pPrev.altitudeAngle + pNext.altitudeAngle) / 2;
    const isShading =
      pNext.pointerType === 'pen' &&
      avgAltitude > 0 &&
      avgAltitude < 0.38;

    // Midpoint between previous point and current point (quadratic smoothing)
    const midX = (pPrev.x + pNext.x) / 2;
    const midY = (pPrev.y + pNext.y) / 2;

    const startX = this.currentDrawPoint ? this.currentDrawPoint.x : pPrev.x;
    const startY = this.currentDrawPoint ? this.currentDrawPoint.y : pPrev.y;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';

    if (isShading) {
      // Tilt Shading: diffuse graphite stamps along the bezier path,
      // aligned with pen tilt azimuth. Width and density interpolate
      // PER STAMP so long fast pairs don't band.
      const radiusAt = (pressure: number): number =>
        Math.max(1, this.baseRadius * this.dpr * (0.4 + pressure * 1.6));
      const rMax = Math.max(radiusAt(pPrev.pressure), radiusAt(pNext.pressure));
      const stepSize = Math.max(1.5, rMax * 0.35);
      const steps = Math.max(1, Math.ceil(dist / stepSize));

      const avgAzimuth = (pPrev.azimuthAngle + pNext.azimuthAngle) / 2;
      const angle = avgAzimuth ? avgAzimuth + Math.PI / 2 : Math.atan2(dy, dx) + Math.PI / 2;

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const invT = 1 - t;
        const x = invT * invT * startX + 2 * invT * t * pPrev.x + t * t * midX;
        const y = invT * invT * startY + 2 * invT * t * pPrev.y + t * t * midY;

        const pressure = pPrev.pressure + (pNext.pressure - pPrev.pressure) * t;
        const altitude = pPrev.altitudeAngle + (pNext.altitudeAngle - pPrev.altitudeAngle) * t;
        const stamp = PencilTexture.createStamp(radiusAt(pressure), altitude);
        this.ctx.globalAlpha = Math.min(1.0, 0.15 + pressure * 0.25);

        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.rotate(angle);
        this.ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
        this.ctx.restore();
      }
    } else {
      const radius = Math.max(1, this.baseRadius * this.dpr * (0.5 + this.smoothedPressure * 1.5));
      // Normal Line Mode: Dual-pass antialiased Quadratic Bezier curve
      // Pass 1: Soft feathering halo (prevents harsh staircases while preserving graphite look)
      this.ctx.beginPath();
      this.ctx.moveTo(startX, startY);
      this.ctx.quadraticCurveTo(pPrev.x, pPrev.y, midX, midY);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.lineWidth = radius * 2.3;
      this.ctx.strokeStyle = '#222222';
      this.ctx.globalAlpha = Math.min(0.25, 0.10 + this.smoothedPressure * 0.15);
      this.ctx.stroke();

      // Pass 2: High-contrast solid core with native subpixel antialiasing
      this.ctx.beginPath();
      this.ctx.moveTo(startX, startY);
      this.ctx.quadraticCurveTo(pPrev.x, pPrev.y, midX, midY);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.lineWidth = radius * 2.0;
      this.ctx.strokeStyle = '#121212';
      this.ctx.globalAlpha = Math.min(1.0, 0.70 + this.smoothedPressure * 0.30);
      this.ctx.stroke();
    }

    this.ctx.restore();

    // Advance drawing cursor to midpoint
    this.currentDrawPoint = { x: midX, y: midY };
  }

  /**
   * Finalizes the stroke from the last midpoint to the final release point
   */
  private finishStrokeSegment(startPt: { x: number; y: number }, endPt: Point): void {
    const avgPressure = this.smoothedPressure;
    const radius = Math.max(1, this.baseRadius * this.dpr * (0.5 + avgPressure * 1.5));
    const isShading =
      endPt.pointerType === 'pen' &&
      endPt.altitudeAngle > 0 &&
      endPt.altitudeAngle < 0.38;

    if (isShading) return;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';

    // Soft feathering halo
    this.ctx.beginPath();
    this.ctx.moveTo(startPt.x, startPt.y);
    this.ctx.lineTo(endPt.x, endPt.y);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = radius * 2.3;
    this.ctx.strokeStyle = '#222222';
    this.ctx.globalAlpha = Math.min(0.25, 0.10 + avgPressure * 0.15);
    this.ctx.stroke();

    // Solid core line
    this.ctx.beginPath();
    this.ctx.moveTo(startPt.x, startPt.y);
    this.ctx.lineTo(endPt.x, endPt.y);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = radius * 2.0;
    this.ctx.strokeStyle = '#121212';
    this.ctx.globalAlpha = Math.min(1.0, 0.70 + avgPressure * 0.30);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Reverts to the previous stroke state
   */
  public undo(): boolean {
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
