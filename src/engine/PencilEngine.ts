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

interface Point {
  x: number;
  y: number;
  pressure: number;
  altitudeAngle: number;
  azimuthAngle: number;
}

export class PencilEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number = 1;

  private isDrawing: boolean = false;
  private activePointerId: number | null = null;
  private lastPoint: Point | null = null;
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

    // Apply faint paper grain
    const noise = PencilTexture.getPaperNoisePattern(this.ctx);
    if (noise) {
      this.ctx.globalAlpha = 0.035;
      this.ctx.fillStyle = noise;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

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
    this.lastPoint = pt;

    // Stamp initial contact dot
    this.drawPencilDot(pt);
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
      const pt = this.extractPoint(subEvent);
      if (this.lastPoint) {
        this.drawPencilSegment(this.lastPoint, pt);
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
      this.isDrawing = false;
      this.activePointerId = null;
      this.lastPoint = null;
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

    return { x, y, pressure, altitudeAngle, azimuthAngle };
  }

  /**
   * Draws a pencil dot at initial contact
   */
  private drawPencilDot(pt: Point): void {
    const radius = Math.max(1, this.baseRadius * this.dpr * (0.4 + pt.pressure * 1.6));
    const stamp = PencilTexture.createStamp(radius, pt.altitudeAngle);

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';
    this.ctx.globalAlpha = Math.min(1.0, 0.4 + pt.pressure * 0.6);
    this.ctx.drawImage(stamp, pt.x - stamp.width / 2, pt.y - stamp.height / 2);
    this.ctx.restore();
  }

  /**
   * Draws interpolated pencil strokes with realistic spacing and graphite grain
   */
  private drawPencilSegment(p0: Point, p1: Point): void {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    if (dist === 0) return;

    // Interpolation step based on radius (closer steps for finer lines)
    const avgPressure = (p0.pressure + p1.pressure) / 2;
    const avgAltitude = (p0.altitudeAngle + p1.altitudeAngle) / 2;
    const radius = Math.max(1, this.baseRadius * this.dpr * (0.4 + avgPressure * 1.6));

    // For tilt shading: step is larger, stamp is wider
    const isShading = avgAltitude < 0.65;
    const stepSize = isShading ? Math.max(2, radius * 0.8) : Math.max(1.2, radius * 0.35);
    const steps = Math.max(1, Math.ceil(dist / stepSize));

    const stamp = PencilTexture.createStamp(radius, avgAltitude);
    const baseAlpha = isShading
      ? (0.15 + avgPressure * 0.25) // diffuse shading
      : (0.35 + avgPressure * 0.65); // crisp line

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';
    this.ctx.globalAlpha = Math.min(1.0, baseAlpha);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = p0.x + dx * t;
      const y = p0.y + dy * t;
      this.ctx.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
    }

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
