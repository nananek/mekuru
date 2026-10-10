import { Point, PencilEngine } from '../engine/PencilEngine';

export interface DebugStrokeRecord {
  id?: string;
  label?: string;
  points: Point[];
  metadata?: Record<string, any>;
  image_base64?: string;
}

export interface RenderJob {
  id: string;
  points: Point[];
  width: number;
  height: number;
  dpr: number;
}

export class DebugService {
  private static isDebugModeCache: boolean | null = null;
  private static currentStrokePoints: Point[] = [];
  private static strokeCounter = 0;
  private static isBridgeRunning = false;
  private static onStatusChangeListeners: ((status: string) => void)[] = [];

  /**
   * Checks whether debug recording mode is currently enabled
   */
  public static isDebugEnabled(): boolean {
    if (this.isDebugModeCache !== null) {
      return this.isDebugModeCache;
    }
    const params = new URLSearchParams(window.location.search);
    const hasQuery = params.has('debug') && params.get('debug') !== '0';
    const hasStorage = localStorage.getItem('mekuru_debug') === '1';
    this.isDebugModeCache = hasQuery || hasStorage;
    return this.isDebugModeCache;
  }

  public static setDebugEnabled(enabled: boolean): void {
    this.isDebugModeCache = enabled;
    if (enabled) {
      localStorage.setItem('mekuru_debug', '1');
    } else {
      localStorage.removeItem('mekuru_debug');
    }
    this.notifyStatus(enabled ? 'デバッグモード有効' : 'デバッグモード無効');
  }

  public static onStatus(listener: (status: string) => void): () => void {
    this.onStatusChangeListeners.push(listener);
    return () => {
      this.onStatusChangeListeners = this.onStatusChangeListeners.filter((l) => l !== listener);
    };
  }

  private static notifyStatus(status: string): void {
    this.onStatusChangeListeners.forEach((l) => l(status));
  }

  /**
   * Starts buffering points for a new stroke
   */
  public static startStroke(): void {
    if (!this.isDebugEnabled()) return;
    this.currentStrokePoints = [];
  }

  /**
   * Records a point during stroke drawing
   */
  public static recordPoint(point: Point): void {
    if (!this.isDebugEnabled()) return;
    this.currentStrokePoints.push({ ...point });
  }

  /**
   * Finalizes the current stroke, captures canvas image, and transmits to debug API
   */
  public static async finishStroke(
    canvas: HTMLCanvasElement,
    label?: string
  ): Promise<void> {
    if (!this.isDebugEnabled()) return;
    if (this.currentStrokePoints.length === 0) return;

    this.strokeCounter++;
    const pointsCopy = [...this.currentStrokePoints];
    this.currentStrokePoints = [];

    // Calculate stroke statistics
    let sumPressure = 0;
    let minAltitude = Math.PI / 2;
    for (const p of pointsCopy) {
      sumPressure += p.pressure;
      if (p.altitudeAngle < minAltitude) {
        minAltitude = p.altitudeAngle;
      }
    }
    const avgPressure = sumPressure / pointsCopy.length;
    const strokeId = `stroke-${Date.now()}-${this.strokeCounter}`;
    const autoLabel = label || (minAltitude < 0.45 ? 'tilt_shading' : 'line');

    // Capture canvas snapshot
    let imageBase64: string | undefined;
    try {
      imageBase64 = canvas.toDataURL('image/png');
    } catch {
      // Ignore security or context errors
    }

    const payload: DebugStrokeRecord = {
      id: strokeId,
      label: autoLabel,
      points: pointsCopy,
      metadata: {
        strokeNumber: this.strokeCounter,
        pointCount: pointsCopy.length,
        avgPressure: Math.round(avgPressure * 1000) / 1000,
        minAltitude: Math.round(minAltitude * 1000) / 1000,
        dpr: window.devicePixelRatio || 1,
        screenWidth: window.innerWidth,
        screenHeight: window.innerHeight,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        userAgent: navigator.userAgent,
      },
      image_base64: imageBase64,
    };

    try {
      this.notifyStatus(`ストローク #${this.strokeCounter} 送信中 (${pointsCopy.length} pts)...`);
      const res = await fetch('/api/debug/strokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        this.notifyStatus(
          `[DEBUG] ストローク #${this.strokeCounter} 送信完了 (${pointsCopy.length} pts, 傾き: ${minAltitude.toFixed(2)} rad)`
        );
      } else {
        this.notifyStatus(`[DEBUG] 送信エラー: HTTP ${res.status}`);
      }
    } catch {
      this.notifyStatus(`[DEBUG] 送信失敗 (オフライン)`);
    }
  }

  /**
   * Starts the background Live Bridge worker.
   * Listens for rendering requests sent from LLM via /api/debug/render
   * and renders them directly on an in-browser canvas using PencilEngine.
   */
  public static startBridgeWorker(): void {
    if (this.isBridgeRunning) return;
    this.isBridgeRunning = true;

    const pollLoop = async () => {
      while (this.isBridgeRunning) {
        try {
          const res = await fetch('/api/debug/bridge/poll');
          if (res.ok) {
            const data = await res.json();
            if (data.job) {
              await this.handleRenderJob(data.job);
            }
          }
        } catch {
          // Retry after delay on connection failure
          await new Promise((r) => setTimeout(r, 2000));
        }
        // Small interval to avoid pegging CPU
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    pollLoop();
  }

  public static stopBridgeWorker(): void {
    this.isBridgeRunning = false;
  }

  /**
   * Handles a render job from server: draws with PencilEngine and returns PNG
   */
  private static async handleRenderJob(job: RenderJob): Promise<void> {
    const offscreenCanvas = document.createElement('canvas');
    const dpr = job.dpr || window.devicePixelRatio || 1;
    offscreenCanvas.width = Math.round(job.width * dpr);
    offscreenCanvas.height = Math.round(job.height * dpr);
    offscreenCanvas.style.width = `${job.width}px`;
    offscreenCanvas.style.height = `${job.height}px`;

    // Instantiate engine for offscreen canvas
    const testEngine = new PencilEngine(offscreenCanvas);
    testEngine.fillPaperBackground();

    // Replay points
    testEngine.replayStroke(job.points);

    // Snapshot image
    const imageBase64 = offscreenCanvas.toDataURL('image/png');

    // Post response back
    try {
      await fetch('/api/debug/bridge/response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: job.id,
          image_base64: imageBase64,
        }),
      });
      this.notifyStatus(`[BRIDGE] ジョブ ${job.id.slice(0, 8)} をレンダリングして返送しました`);
    } catch {
      // ignore
    }
  }

  /**
   * Fetches latest debug presets from backend
   */
  public static async fetchPresets(): Promise<Record<string, any>> {
    const res = await fetch('/api/debug/presets');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  /**
   * Fetches recent debug strokes
   */
  public static async fetchRecentStrokes(limit = 30): Promise<any[]> {
    const res = await fetch(`/api/debug/strokes?limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.strokes || [];
  }

  /**
   * Fetches detail for a specific stroke
   */
  public static async fetchStrokeDetail(id: string): Promise<any> {
    const res = await fetch(`/api/debug/strokes/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }
}
