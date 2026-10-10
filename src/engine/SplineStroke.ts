/**
 * SplineStroke.ts
 * High-performance spline inference and smooth ribbon outline generator for pencil strokes.
 * Inspired by industry-standard drawing engines (perfect-freehand, Procreate Streamline, Catmull-Rom splines).
 */

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  altitudeAngle: number;
  azimuthAngle: number;
  time?: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export class SplineStroke {
  private rawPoints: StrokePoint[] = [];
  private smoothedPoints: StrokePoint[] = [];
  private streamlineFactor: number = 0.35; // Balances Apple Pencil responsiveness with jitter suppression

  constructor(streamlineFactor: number = 0.35) {
    this.streamlineFactor = streamlineFactor;
  }

  public clear(): void {
    this.rawPoints = [];
    this.smoothedPoints = [];
  }

  public getPointCount(): number {
    return this.smoothedPoints.length;
  }

  public getPoints(): StrokePoint[] {
    return this.smoothedPoints;
  }

  /**
   * Adds an input point with adaptive streamlining to suppress micro-jitter and quantization noise.
   */
  public addPoint(pt: StrokePoint): void {
    this.rawPoints.push(pt);

    if (this.smoothedPoints.length === 0) {
      this.smoothedPoints.push({ ...pt });
      return;
    }

    const last = this.smoothedPoints[this.smoothedPoints.length - 1];
    const dx = pt.x - last.x;
    const dy = pt.y - last.y;
    const dist = Math.hypot(dx, dy);

    // Filter out redundant subpixel jitter (< 0.4px)
    if (dist < 0.4 && this.smoothedPoints.length > 1) {
      return;
    }

    // Adaptive low-pass filter (Streamline)
    const factor = 1 - this.streamlineFactor;
    const smoothX = last.x + dx * factor;
    const smoothY = last.y + dy * factor;
    const smoothPressure = last.pressure * 0.5 + pt.pressure * 0.5;
    const smoothAltitude = last.altitudeAngle * 0.5 + pt.altitudeAngle * 0.5;

    this.smoothedPoints.push({
      x: smoothX,
      y: smoothY,
      pressure: smoothPressure,
      altitudeAngle: smoothAltitude,
      azimuthAngle: pt.azimuthAngle,
      time: pt.time,
    });
  }

  /**
   * Generates a closed polygon ribbon Path2D for the entire stroke using Catmull-Rom
   * spline inference and continuous variable-width normal offsets.
   *
   * By rendering as a single unified polygon fill, overlapping segment caps and banding
   * artifacts are mathematically eliminated.
   */
  public createRibbonPath(
    baseRadius: number,
    dpr: number,
    scaleMultiplier: number = 1.0
  ): Path2D | null {
    const pts = this.smoothedPoints;
    const len = pts.length;
    if (len === 0) return null;

    const path = new Path2D();

    // Single point contact dot
    if (len === 1) {
      const p = pts[0];
      const r = Math.max(1, baseRadius * dpr * (0.45 + p.pressure * 1.55) * scaleMultiplier);
      path.arc(p.x, p.y, r, 0, Math.PI * 2);
      return path;
    }

    // 2+ points: Catmull-Rom spline sampling into continuous ribbon outline
    interface SampledPoint {
      x: number;
      y: number;
      radius: number;
      tanX: number;
      tanY: number;
    }

    const samples: SampledPoint[] = [];

    for (let i = 0; i < len - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < len ? pts[i + 2] : p2;

      // Catmull-Rom to Cubic Bezier control points (C1 continuous tangents)
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      // Adaptive step count: ~3px per sample for smooth curvature
      const steps = Math.max(2, Math.ceil(segDist / 3));

      const isLastSeg = i === len - 2;
      const maxS = isLastSeg ? steps : steps - 1;

      for (let s = 0; s <= maxS; s++) {
        // Avoid duplicate point at segment junctions
        if (s === 0 && samples.length > 0) continue;

        const t = s / steps;
        const invT = 1 - t;

        // Cubic Bezier position
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

        // Tangent vector B'(t)
        const tx =
          3 * invT * invT * (cp1x - p1.x) +
          6 * invT * t * (cp2x - cp1x) +
          3 * t * t * (p2.x - cp2x);
        const ty =
          3 * invT * invT * (cp1y - p1.y) +
          6 * invT * t * (cp2y - cp1y) +
          3 * t * t * (p2.y - cp2y);

        // Smoothly interpolated pressure
        const pressure = p1.pressure + (p2.pressure - p1.pressure) * t;

        // Radius calculation
        let radius = Math.max(
          1,
          baseRadius * dpr * (0.45 + pressure * 1.55) * scaleMultiplier
        );

        // Taper start and end points slightly for natural pencil entry/exit
        const globalSampleIdx = i * steps + s;
        const totalEstimatedSamples = (len - 1) * steps;
        if (globalSampleIdx < 3) {
          radius *= 0.65 + (globalSampleIdx / 3) * 0.35;
        } else if (totalEstimatedSamples - globalSampleIdx < 3) {
          radius *= 0.65 + ((totalEstimatedSamples - globalSampleIdx) / 3) * 0.35;
        }

        samples.push({ x: bx, y: by, radius, tanX: tx, tanY: ty });
      }
    }

    if (samples.length < 2) return null;

    // Calculate left and right offset contour points
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];

    for (let k = 0; k < samples.length; k++) {
      const s = samples[k];
      const tLen = Math.hypot(s.tanX, s.tanY) || 1;
      const nx = -s.tanY / tLen;
      const ny = s.tanX / tLen;

      leftPts.push({ x: s.x + nx * s.radius, y: s.y + ny * s.radius });
      rightPts.push({ x: s.x - nx * s.radius, y: s.y - ny * s.radius });
    }

    // Build unified closed polygon ribbon path
    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];

    const fLen = Math.hypot(firstSample.tanX, firstSample.tanY) || 1;
    const fDirX = firstSample.tanX / fLen;
    const fDirY = firstSample.tanY / fLen;

    const lLen = Math.hypot(lastSample.tanX, lastSample.tanY) || 1;
    const lDirX = lastSample.tanX / lLen;
    const lDirY = lastSample.tanY / lLen;

    // Start Cap: Rounded hemisphere from rightPts[0] through back0 to leftPts[0]
    const back0 = {
      x: firstSample.x - fDirX * firstSample.radius,
      y: firstSample.y - fDirY * firstSample.radius,
    };
    const ctrlStart1 = {
      x: rightPts[0].x - fDirX * firstSample.radius,
      y: rightPts[0].y - fDirY * firstSample.radius,
    };
    const ctrlStart2 = {
      x: leftPts[0].x - fDirX * firstSample.radius,
      y: leftPts[0].y - fDirY * firstSample.radius,
    };

    path.moveTo(rightPts[0].x, rightPts[0].y);
    path.quadraticCurveTo(ctrlStart1.x, ctrlStart1.y, back0.x, back0.y);
    path.quadraticCurveTo(ctrlStart2.x, ctrlStart2.y, leftPts[0].x, leftPts[0].y);

    // Left side contour: Midpoint quadratic smoothing
    for (let j = 0; j < leftPts.length - 1; j++) {
      const midX = (leftPts[j].x + leftPts[j + 1].x) / 2;
      const midY = (leftPts[j].y + leftPts[j + 1].y) / 2;
      path.quadraticCurveTo(leftPts[j].x, leftPts[j].y, midX, midY);
    }
    path.lineTo(leftPts[leftPts.length - 1].x, leftPts[leftPts.length - 1].y);

    // End Cap: Rounded hemisphere from leftPts[last] through frontEnd to rightPts[last]
    const frontEnd = {
      x: lastSample.x + lDirX * lastSample.radius,
      y: lastSample.y + lDirY * lastSample.radius,
    };
    const ctrlEnd1 = {
      x: leftPts[leftPts.length - 1].x + lDirX * lastSample.radius,
      y: leftPts[leftPts.length - 1].y + lDirY * lastSample.radius,
    };
    const ctrlEnd2 = {
      x: rightPts[rightPts.length - 1].x + lDirX * lastSample.radius,
      y: rightPts[rightPts.length - 1].y + lDirY * lastSample.radius,
    };

    path.quadraticCurveTo(ctrlEnd1.x, ctrlEnd1.y, frontEnd.x, frontEnd.y);
    path.quadraticCurveTo(ctrlEnd2.x, ctrlEnd2.y, rightPts[rightPts.length - 1].x, rightPts[rightPts.length - 1].y);

    // Right side contour in reverse: Midpoint quadratic smoothing
    for (let j = rightPts.length - 1; j > 0; j--) {
      const midX = (rightPts[j].x + rightPts[j - 1].x) / 2;
      const midY = (rightPts[j].y + rightPts[j - 1].y) / 2;
      path.quadraticCurveTo(rightPts[j].x, rightPts[j].y, midX, midY);
    }
    path.lineTo(rightPts[0].x, rightPts[0].y);

    path.closePath();
    return path;
  }
}
