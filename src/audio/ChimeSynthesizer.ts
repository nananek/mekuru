/**
 * ChimeSynthesizer
 * Generates an elegant, unobtrusive chime / bell sound using the Web Audio API.
 * Requires zero external audio files, operates fully offline.
 */

export class ChimeSynthesizer {
  private static audioCtx: AudioContext | null = null;

  private static getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  /**
   * Plays a gentle, peaceful two-tone croquis timer chime
   */
  public static playChime(): void {
    try {
      const ctx = this.getAudioContext();
      const now = ctx.currentTime;

      // Note 1: E6 (~1318.5 Hz)
      this.playTone(ctx, 1318.5, now, 0.8, 0.12);
      // Note 2: A5 (~880.0 Hz) slightly following
      this.playTone(ctx, 880.0, now + 0.12, 1.2, 0.16);
    } catch (e) {
      console.warn('[ChimeSynthesizer] Could not play chime:', e);
    }
  }

  private static playTone(
    ctx: AudioContext,
    freq: number,
    startTime: number,
    duration: number,
    gainLevel: number
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    // Smooth envelope attack and exponential decay
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(gainLevel, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}
