import { db, type Sketch } from '../db/database';

export class SketchService {
  /**
   * Asynchronously saves a canvas snapshot to IndexedDB.
   * Runs in the background without blocking the UI or main canvas drawing.
   */
  static async saveSketch(
    sourceCanvas: HTMLCanvasElement,
    timerDurationSec: number
  ): Promise<Sketch | null> {
    try {
      // 1. Generate full-resolution Blob (prefer webp, fallback to png)
      const fullBlob = await this.canvasToBlob(sourceCanvas);
      if (!fullBlob) {
        throw new Error('Failed to create full image blob');
      }

      // 2. Generate 200x200 thumbnail
      const thumbnailBlob = await this.createThumbnailBlob(sourceCanvas, 200);
      if (!thumbnailBlob) {
        throw new Error('Failed to create thumbnail blob');
      }

      // 3. Save to Dexie IndexedDB (outbox: deleted once the server confirms)
      const sketch: Sketch = {
        createdAt: new Date(),
        timerDurationSec,
        imageBlob: fullBlob,
        thumbnailBlob,
      };

      const id = await db.sketches.add(sketch);
      sketch.id = id;
      return sketch;
    } catch (err) {
      console.error('[SketchService] Error saving sketch:', err);
      return null;
    }
  }

  /**
   * Helper to convert canvas to Blob
   */
  private static canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            // Fallback to PNG if WebP export fails
            canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png');
          }
        },
        'image/webp',
        0.92
      );
    });
  }

  /**
   * Creates a downscaled square thumbnail Blob (200x200)
   */
  private static createThumbnailBlob(
    sourceCanvas: HTMLCanvasElement,
    targetSize: number = 200
  ): Promise<Blob | null> {
    return new Promise((resolve) => {
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = targetSize;
      thumbCanvas.height = targetSize;
      const ctx = thumbCanvas.getContext('2d');

      if (!ctx) {
        resolve(null);
        return;
      }

      // Fill background
      ctx.fillStyle = '#fdfbf7';
      ctx.fillRect(0, 0, targetSize, targetSize);

      // Maintain aspect ratio inside the thumbnail (fit or cover)
      const sw = sourceCanvas.width;
      const sh = sourceCanvas.height;
      const scale = Math.min(targetSize / sw, targetSize / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (targetSize - dw) / 2;
      const dy = (targetSize - dh) / 2;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(sourceCanvas, 0, 0, sw, sh, dx, dy, dw, dh);

      thumbCanvas.toBlob(
        (blob) => resolve(blob),
        'image/webp',
        0.85
      );
    });
  }

  /**
   * Retrieves all sketches ordered by createdAt descending (newest first)
   */
  static async getAllSketches(): Promise<Sketch[]> {
    return await db.sketches.orderBy('createdAt').reverse().toArray();
  }

  /**
   * Retrieves total count of sketches
   */
  static async getCount(): Promise<number> {
    return await db.sketches.count();
  }

  /**
   * Deletes a sketch by id
   */
  static async deleteSketch(id: number): Promise<void> {
    await db.sketches.delete(id);
  }

  /**
   * Exports an image blob: uses Web Share API if available on iPad/iOS,
   * otherwise triggers download.
   */
  static async exportSketch(sketch: Sketch): Promise<void> {
    const filename = `mekuru-${new Date(sketch.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    const file = new File([sketch.imageBlob], filename, { type: sketch.imageBlob.type || 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'Mekuru Croquis',
          text: `Sketch from ${new Date(sketch.createdAt).toLocaleDateString()}`,
        });
        return;
      } catch (err: unknown) {
        if ((err as Error).name !== 'AbortError') {
          console.warn('[SketchService] Share failed, falling back to download:', err);
        } else {
          return; // user cancelled share
        }
      }
    }

    // Fallback download link
    const url = URL.createObjectURL(sketch.imageBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
