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
    // Shading triggers only when pen is noticeably tilted flat (< 0.38 rad / ~22 degrees).
    const isShading = altitudeAngle < 0.38;
    const tiltScale = isShading
      ? 1.0 + (1.0 - altitudeAngle / 0.38) * 3.0 // expand up to 4.0x
      : 1.0;

    const width = Math.max(3, Math.round(radius * 2 * tiltScale));
    const height = Math.max(3, Math.round(radius * 2));

    const stamp = document.createElement('canvas');
    stamp.width = width;
    stamp.height = height;
    const sctx = stamp.getContext('2d');
    if (!sctx) return stamp;

    const cx = width / 2;
    const cy = height / 2;
    const rx = width / 2;
    const ry = height / 2;

    // High density graphite gradient: deep black core fading softly at edges
    const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    if (isShading) {
      grad.addColorStop(0, 'rgba(24, 24, 24, 0.70)');
      grad.addColorStop(0.4, 'rgba(28, 28, 28, 0.45)');
      grad.addColorStop(0.75, 'rgba(35, 35, 35, 0.20)');
      grad.addColorStop(1, 'rgba(40, 40, 40, 0)');
    } else {
      grad.addColorStop(0, 'rgba(18, 18, 18, 0.95)');
      grad.addColorStop(0.5, 'rgba(24, 24, 24, 0.80)');
      grad.addColorStop(0.85, 'rgba(32, 32, 32, 0.35)');
      grad.addColorStop(1, 'rgba(40, 40, 40, 0)');
    }

    sctx.save();
    sctx.imageSmoothingEnabled = true;
    sctx.beginPath();
    sctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    sctx.fillStyle = grad;
    sctx.fill();

    // Subtle organic graphite texture without harsh pixelated edges
    const imgData = sctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 0) {
        // Very subtle micro-grain that preserves smooth antialiased silhouette
        const noise = (Math.random() - 0.5) * 18;
        data[i + 3] = Math.max(0, Math.min(255, alpha + noise));
      }
    }
    sctx.putImageData(imgData, 0, 0);
    sctx.restore();

    return stamp;
  }
}
