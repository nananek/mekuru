import { ChimeSynthesizer } from '../audio/ChimeSynthesizer';

export interface CroquisTimerCallbacks {
  onTick?: (remaining: number, total: number) => void;
  onTimeUp?: () => void;
  onAutoFlip?: () => void;
}

export class CroquisTimer {
  private durationSec: number = 0; // 0 = off
  private remainingSec: number = 0;
  private intervalId: number | null = null;
  private isRunning: boolean = false;
  private autoFlip: boolean = false; // User confirmed: default OFF
  private callbacks: CroquisTimerCallbacks;

  // Preset list
  public static readonly PRESETS = [0, 30, 60, 120, 300];

  constructor(callbacks: CroquisTimerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setDuration(seconds: number): void {
    this.durationSec = seconds;
    this.remainingSec = seconds;
    if (this.isRunning) {
      this.stop();
      if (seconds > 0) {
        this.start();
      }
    }
    this.callbacks.onTick?.(this.remainingSec, this.durationSec);
  }

  public start(): void {
    if (this.durationSec <= 0) return;
    this.isRunning = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
    }

    this.intervalId = window.setInterval(() => {
      this.tick();
    }, 1000);
  }

  public pause(): void {
    this.isRunning = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public stop(): void {
    this.pause();
    this.remainingSec = this.durationSec;
    this.callbacks.onTick?.(this.remainingSec, this.durationSec);
  }

  public reset(): void {
    this.remainingSec = this.durationSec;
    this.callbacks.onTick?.(this.remainingSec, this.durationSec);
    if (this.durationSec > 0) {
      this.start();
    }
  }

  private tick(): void {
    if (this.remainingSec > 0) {
      this.remainingSec--;
      this.callbacks.onTick?.(this.remainingSec, this.durationSec);

      if (this.remainingSec === 0) {
        this.handleTimeUp();
      }
    }
  }

  private handleTimeUp(): void {
    this.stop();

    // 1. Audio chime
    ChimeSynthesizer.playChime();

    // 2. Visual flash feedback
    this.triggerFlashNotification();

    // 3. Callback
    this.callbacks.onTimeUp?.();

    // 4. Auto-flip (if enabled)
    if (this.autoFlip) {
      this.callbacks.onAutoFlip?.();
      // Restart for the next page
      this.reset();
    }
  }

  private triggerFlashNotification(): void {
    const flashEl = document.getElementById('timer-flash');
    if (flashEl) {
      flashEl.style.opacity = '0.35';
      setTimeout(() => {
        flashEl.style.opacity = '0';
      }, 350);
    }
  }

  public cycleNextPreset(): number {
    const currentIndex = CroquisTimer.PRESETS.indexOf(this.durationSec);
    const nextIndex = (currentIndex + 1) % CroquisTimer.PRESETS.length;
    const nextDuration = CroquisTimer.PRESETS[nextIndex];
    this.setDuration(nextDuration);
    return nextDuration;
  }

  public setAutoFlip(val: boolean): void {
    this.autoFlip = val;
  }

  public toggleAutoFlip(): boolean {
    this.autoFlip = !this.autoFlip;
    return this.autoFlip;
  }

  public getAutoFlip(): boolean {
    return this.autoFlip;
  }

  public getDuration(): number {
    return this.durationSec;
  }

  public getRemaining(): number {
    return this.remainingSec;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}
