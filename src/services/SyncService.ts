import type { Sketch } from '../db/database';
import { db } from '../db/database';

export class SyncService {
  private static API_BASE = '/api/sketches';

  /**
   * Syncs a single sketch to the Rust backend server
   */
  public static async uploadSketch(sketch: Sketch): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('timerDurationSec', sketch.timerDurationSec.toString());
      formData.append('createdAt', sketch.createdAt.toISOString());
      formData.append('image', sketch.imageBlob, 'sketch.webp');
      formData.append('thumbnail', sketch.thumbnailBlob, 'thumb.webp');

      const res = await fetch(this.API_BASE, {
        method: 'POST',
        body: formData,
      });

      return res.ok;
    } catch {
      // Offline / server unreachable: silent fail, retained in local IndexedDB
      return false;
    }
  }

  /**
   * Pulls any sketches from server and caches them into IndexedDB
   */
  public static async syncFromServer(): Promise<void> {
    try {
      const res = await fetch(this.API_BASE);
      if (!res.ok) return;

      const serverSketches: Array<{
        id: number;
        created_at: string;
        timer_duration_sec: number;
      }> = await res.json();

      for (const item of serverSketches) {
        const existing = await db.sketches.where('createdAt').equals(new Date(item.created_at)).first();
        if (!existing) {
          // Fetch blobs
          const [imgRes, thumbRes] = await Promise.all([
            fetch(`${this.API_BASE}/${item.id}/image`),
            fetch(`${this.API_BASE}/${item.id}/thumbnail`),
          ]);

          if (imgRes.ok && thumbRes.ok) {
            const imageBlob = await imgRes.blob();
            const thumbnailBlob = await thumbRes.blob();
            await db.sketches.add({
              createdAt: new Date(item.created_at),
              timerDurationSec: item.timer_duration_sec,
              imageBlob,
              thumbnailBlob,
            });
          }
        }
      }
    } catch {
      // Offline
    }
  }
}
