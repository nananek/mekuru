/**
 * PencilTexture
 * Builds plain soft stamps for stroke rendering (grain-free by design).
 */

export class PencilTexture {
  // Reused stamps: no per-segment canvas allocation.
  private static stampCache = new Map<string, HTMLCanvasElement>();
  private static readonly STAMP_CACHE_LIMIT = 32;

  /**
   * Builds a cached soft stamp for stamping along the stroke path.
   * Width follows pen tilt (pencil-side shading); the shape is a plain
   * radial falloff with no speckle.
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
    // When tilted flat, the tip flattens into a wider ellipse. The expansion
    // is capped: tilt sensors can spike at contact, and an unbounded ellipse
    // reads as a stray dash at stroke starts.
    const isShading = altitudeAngle < 0.65;
    const tiltScale = isShading
      ? Math.min(2.0, 1.0 + (1.0 - altitudeAngle / 0.65) * 2.5)
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

    // Plain soft radial falloff, no speckle.
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
    sctx.restore();

    return stamp;
  }
}
