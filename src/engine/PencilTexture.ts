/**
 * PencilTexture
 * Builds plain soft stamps for stroke rendering (grain-free by design).
 */

export class PencilTexture {
  // Reused stamps: no per-segment canvas allocation.
  private static stampCache = new Map<string, HTMLCanvasElement>();
  private static readonly STAMP_CACHE_LIMIT = 64;

  /**
   * Builds a cached soft stamp for stamping along the stroke path.
   * Width follows pen tilt (pencil-side shading); the shape has genuine
   * elliptical radial falloff with zero clipping or banding.
   */
  public static createStamp(
    radius: number,
    altitudeAngle: number
  ): HTMLCanvasElement {
    // Pen tilt: altitudeAngle is 0 (flat on table) to Math.PI / 2 (perpendicular).
    // Shading triggers when tilted (altitudeAngle < 0.45 rad / ~25.8 deg).
    const SHADING_THRESHOLD = 0.45;
    const isShading = altitudeAngle > 0 && altitudeAngle < SHADING_THRESHOLD;
    const tiltFactor = isShading
      ? Math.max(0, 1.0 - altitudeAngle / SHADING_THRESHOLD)
      : 0;
    // Expands smoothly from 1.0 (vertical) up to 4.2x (flat on paper)
    const tiltScale = 1.0 + tiltFactor * 3.2;

    // Fine-grained key: coarse quantization previously returned wrong-sized
    // stamps mid-stroke, which read as stripes along the line.
    const key = `${radius.toFixed(1)}:${tiltScale.toFixed(2)}`;
    const cached = this.stampCache.get(key);
    if (cached) return cached;

    const stamp = this.buildStamp(radius, tiltScale);
    if (this.stampCache.size >= this.STAMP_CACHE_LIMIT) {
      const oldest = this.stampCache.keys().next();
      if (!oldest.done) this.stampCache.delete(oldest.value);
    }
    this.stampCache.set(key, stamp);
    return stamp;
  }

  private static buildStamp(
    radius: number,
    tiltScale: number
  ): HTMLCanvasElement {
    const rx = Math.max(1.5, radius * tiltScale);
    const ry = Math.max(1.5, radius);

    // Padding ensures that antialiased edges taper to complete 0 opacity without clipping
    const width = Math.max(4, Math.ceil(rx * 2) + 4);
    const height = Math.max(4, Math.ceil(ry * 2) + 4);

    const stamp = document.createElement('canvas');
    stamp.width = width;
    stamp.height = height;
    const sctx = stamp.getContext('2d');
    if (!sctx) return stamp;

    const cx = width / 2;
    const cy = height / 2;

    // True elliptical gradient: scale the circular radial gradient by tiltScale
    // so every angle fades out completely to 0 alpha at radius ry.
    sctx.save();
    sctx.translate(cx, cy);
    sctx.scale(tiltScale, 1.0);

    const grad = sctx.createRadialGradient(0, 0, 0, 0, 0, ry);
    grad.addColorStop(0.0, 'rgba(28, 28, 28, 0.36)');
    grad.addColorStop(0.3, 'rgba(32, 32, 32, 0.22)');
    grad.addColorStop(0.65, 'rgba(38, 38, 38, 0.08)');
    grad.addColorStop(0.90, 'rgba(42, 42, 42, 0.015)');
    grad.addColorStop(1.0, 'rgba(42, 42, 42, 0)');

    sctx.beginPath();
    sctx.arc(0, 0, ry, 0, Math.PI * 2);
    sctx.fillStyle = grad;
    sctx.fill();
    sctx.restore();

    return stamp;
  }
}
