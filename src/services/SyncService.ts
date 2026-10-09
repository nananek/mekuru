import type { Sketch } from '../db/database';
import { db } from '../db/database';

/**
 * One row in the gallery: either a server-side sketch (authenticated fetch
 * via URLs) or a local outbox row (not yet uploaded, Blob URLs).
 * Local storage holds ONLY unsynced sketches: rows are deleted as soon as
 * the server confirms receipt, so a lost/stolen device without the passkey
 * exposes at most the not-yet-uploaded pages.
 */
export interface GalleryItem {
  key: string;
  serverId?: number;
  localId?: number;
  createdAt: Date;
  timerDurationSec: number;
  thumbUrl: string;
  imageUrl: string;
  imageBlob?: Blob;
  /** true = still only on this device */
  pending: boolean;
}

export interface ServerSketchMeta {
  id: number;
  user_id: string | null;
  timer_duration_sec: number;
  created_at: string;
}

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
   * Uploads every outbox sketch and DELETES locally confirmed ones.
   * Returns the number of sketches newly confirmed on the server.
   * Safe to call repeatedly: the server dedups by (user, created_at).
   */
  public static async flushOutbox(): Promise<number> {
    try {
      const pending = await db.sketches.orderBy('createdAt').toArray();
      let done = 0;
      for (const sketch of pending) {
        if (sketch.id === undefined) continue;
        if (await this.uploadSketch(sketch)) {
          await db.sketches.delete(sketch.id);
          done++;
        } else {
          break; // offline or logged out: stop here, try again later
        }
      }
      return done;
    } catch {
      return 0;
    }
  }

  /**
   * Counts outbox sketches (for status display).
   */
  public static async countOutbox(): Promise<number> {
    try {
      return await db.sketches.count();
    } catch {
      return 0;
    }
  }

  /**
   * Deletes one sketch: server-side for uploaded items, locally for outbox.
   */
  public static async deleteItem(item: GalleryItem): Promise<boolean> {
    try {
      if (item.serverId !== undefined) {
        const res = await fetch(`${this.API_BASE}/${item.serverId}`, {
          method: 'DELETE',
        });
        return res.ok;
      }
      if (item.localId !== undefined) {
        await db.sketches.delete(item.localId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Gallery source: server list (when logged in) merged with the local
   * outbox, newest first.
   */
  public static async getGalleryItems(): Promise<{ items: GalleryItem[]; serverAvailable: boolean }> {
    const [server, outbox] = await Promise.all([
      this.fetchServerList(),
      db.sketches.orderBy('createdAt').reverse().toArray().catch(() => [] as Sketch[]),
    ]);

    const list = server ?? [];

    const items: GalleryItem[] = list.map((m) => ({
      key: `server-${m.id}`,
      serverId: m.id,
      createdAt: new Date(m.created_at),
      timerDurationSec: m.timer_duration_sec,
      thumbUrl: `${this.API_BASE}/${m.id}/thumbnail`,
      imageUrl: `${this.API_BASE}/${m.id}/image`,
      pending: false,
    }));

    for (const sketch of outbox) {
      items.push({
        key: `local-${sketch.id}`,
        localId: sketch.id,
        createdAt: sketch.createdAt,
        timerDurationSec: sketch.timerDurationSec,
        thumbUrl: URL.createObjectURL(sketch.thumbnailBlob),
        imageUrl: URL.createObjectURL(sketch.imageBlob),
        imageBlob: sketch.imageBlob,
        pending: true,
      });
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items, serverAvailable: server !== null };
  }

  private static async fetchServerList(): Promise<ServerSketchMeta[] | null> {
    try {
      const res = await fetch(this.API_BASE);
      if (!res.ok) return null;
      return (await res.json()) as ServerSketchMeta[];
    } catch {
      return null;
    }
  }
}
