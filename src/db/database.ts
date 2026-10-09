import Dexie, { type Table } from 'dexie';

export interface Sketch {
  id?: number;
  createdAt: Date;
  timerDurationSec: number; // 使用したタイマー設定秒数（0 = なし）
  imageBlob: Blob;          // 原寸WebP画像（またはPNG）
  thumbnailBlob: Blob;      // 一覧用サムネイル (200x200程度)
}

export class MekuruDatabase extends Dexie {
  sketches!: Table<Sketch>;

  constructor() {
    super('MekuruDB');
    this.version(1).stores({
      sketches: '++id, createdAt, timerDurationSec'
    });
  }
}

export const db = new MekuruDatabase();
