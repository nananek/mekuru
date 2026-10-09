/**
 * UpdateService
 * Shows the running build and force-refreshes a stale PWA shell
 * (Service Worker + caches + reload).
 */

export class UpdateService {
  public static getVersion(): string {
    try {
      return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
    } catch {
      return 'dev';
    }
  }

  /**
   * Unregisters all Service Workers, clears Cache Storage, and reloads.
   * Drawing work is safe: sketches live in IndexedDB (untouched) and the
   * server, never in Cache Storage.
   */
  public static async forceUpdate(): Promise<void> {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } finally {
      window.location.reload();
    }
  }
}
