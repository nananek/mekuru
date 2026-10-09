/**
 * UndoManager
 * High-performance, GPU-backed stroke history manager using an offscreen canvas ring stack.
 */

export class UndoManager {
  private maxHistory: number;
  private history: HTMLCanvasElement[] = [];

  constructor(maxHistory: number = 25) {
    this.maxHistory = maxHistory;
  }

  /**
   * Captures the current canvas state into an offscreen canvas snapshot.
   */
  public pushState(canvas: HTMLCanvasElement): void {
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    const sctx = snapshot.getContext('2d');
    if (sctx) {
      sctx.drawImage(canvas, 0, 0);
      this.history.push(snapshot);
      if (this.history.length > this.maxHistory) {
        this.history.shift();
      }
    }
  }

  /**
   * Restores the previous canvas state.
   * Returns true if an undo occurred, false if no states left.
   */
  public undo(canvas: HTMLCanvasElement): boolean {
    if (this.history.length === 0) {
      return false;
    }

    const previousSnapshot = this.history.pop();
    if (!previousSnapshot) return false;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform for exact copy
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(previousSnapshot, 0, 0);
    ctx.restore();

    return true;
  }

  public canUndo(): boolean {
    return this.history.length > 0;
  }

  public clear(): void {
    this.history = [];
  }
}
