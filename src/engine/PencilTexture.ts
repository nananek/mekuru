/**
 * PencilTexture
 * Generates organic graphite grain stamps and handles blending for realistic pencil feel.
 */

export class PencilTexture {
  private static grainPattern: CanvasPattern | null = null;

  // Reused stamps: same grain along a stroke (consistent pencil feel) and
  // no per-segment getImageData cost. Keyed by quantized radius + shading.
  private static stampCache = new Map<string, HTMLCanvasElement>();
  private static readonly STAMP_CACHE_LIMIT = 32;

  /**
   * Initializes or gets the seamless paper noise pattern
   */
  public static getPaperNoisePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.grainPattern) return this.grainPattern;

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const gctx = canvas.getContext('2d');
    if (!gctx) return null;

    const imgData = gctx.createImageData(size, size);
    const data = imgData.data;

    // Generate high-frequency paper grain noise
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.floor(235 + Math.random() * 20); // soft warm paper grain
      data[i] = v;     // R
      data[i + 1] = v; // G
      data[i + 2] = v; // B
      data[i + 3] = 255;
    }
    gctx.putImageData(imgData, 0, 0);

    this.grainPattern = ctx.createPattern(canvas, 'repeat');
    return this.grainPattern;
  }

  /**
   * Creates an offscreen graphite particle stamp for stamping along the stroke path.
   * Modulates width, aspect ratio (for pen tilt / altitudeAngle), and grain density.
   * Results are cached: a stroke reuses identical grain instead of re-rolling
   * speckle per segment (which read as dirt).
   */
  public static createStamp(
    radius: number,
    altitudeAngle: number
  ): HTMLCanvasElement {
    const isShading = altitudeAngle < 0.65;
    const key = `${Math.round(radius * 2) / 2}:${isShading ? 1 : 0}`;
    const cached = this.stampCache.get(key);
    if (cached) return cached;

    const stamp = this.buildStamp(radius, altitudeAngle);
    if (this.stampCache.size >= this.STAMP_CACHE_LIMIT) {
      const oldest = this.stampCache.keys().next();
      if (!oldest.done) this.stampCache.delete(oldest.value);
    }
    this.stampCache.set(key, stamp);
    return stamp;
  }

  private static buildStamp(
    radius: number,
    altitudeAngle: number
  ): HTMLCanvasElement {
    // Pen tilt: altitudeAngle is 0 (flat on table) to Math.PI / 2 (perpendicular).
    // When tilted flat (< 0.6 rad), the pencil tip flattens into an ellipse (shading with pencil side).
    const isShading = altitudeAngle < 0.65;
    const tiltScale = isShading
      ? 1.0 + (1.0 - altitudeAngle / 0.65) * 2.5 // expand up to 3.5x
      : 1.0;

    const width = Math.max(2, Math.round(radius * 2 * tiltScale));
    const height = Math.max(2, Math.round(radius * 2));

    const stamp = document.createElement('canvas');
    stamp.width = width;
    stamp.height = height;
    const sctx = stamp.getContext('2d');
    if (!sctx) return stamp;

    const cx = width / 2;
    const cy = height / 2;
    const rx = width / 2;
    const ry = height / 2;

    // Radial gradient with graphite grain falloff
    const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grad.addColorStop(0, 'rgba(26, 26, 26, 0.45)');
    grad.addColorStop(0.5, 'rgba(35, 35, 35, 0.25)');
    grad.addColorStop(0.85, 'rgba(40, 40, 40, 0.08)');
    grad.addColorStop(1, 'rgba(40, 40, 40, 0)');

    sctx.save();
    sctx.beginPath();
    sctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    sctx.fillStyle = grad;
    sctx.fill();

    // Speckle graphite grain noise. Kept subtle and biased to the stamp
    // core so edges stay clean: alpha jitter scales with existing alpha.
    const imgData = sctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 0) {
        const noise = (Math.random() - 0.5) * 56 * (alpha / 255);
        data[i + 3] = Math.max(0, Math.min(255, alpha + noise));
      }
    }
    sctx.putImageData(imgData, 0, 0);
    sctx.restore();

    return stamp;
  }
}
