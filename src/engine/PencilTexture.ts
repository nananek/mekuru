/**
 * PencilTexture
 * Generates organic graphite grain stamps and handles blending for realistic pencil feel.
 */

export class PencilTexture {
  private static grainPattern: CanvasPattern | null = null;

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
   */
  public static createStamp(
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

    // Speckle graphite grain noise
    const imgData = sctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 0) {
        // Random graphite speckling
        const noise = (Math.random() - 0.5) * 80;
        data[i + 3] = Math.max(0, Math.min(255, alpha + noise));
      }
    }
    sctx.putImageData(imgData, 0, 0);
    sctx.restore();

    return stamp;
  }
}
