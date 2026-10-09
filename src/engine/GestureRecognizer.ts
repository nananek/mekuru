/**
 * GestureRecognizer
 * Recognizes multi-touch gestures (2-finger tap for Undo, 2-finger swipe for Mekuru)
 * while ensuring touch inputs NEVER cause accidental strokes (Palm Rejection).
 */

export interface GestureCallbacks {
  onTwoFingerTap?: () => void;
  onTwoFingerSwipe?: (direction: 'left' | 'right') => void;
}

interface TouchPoint {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startTime: number;
}

export class GestureRecognizer {
  private activeTouches: Map<number, TouchPoint> = new Map();
  private callbacks: GestureCallbacks;
  private twoFingerSessionActive = false;
  private startAvgX = 0;
  private startAvgY = 0;
  private maxMovement = 0;
  private swipeTriggered = false;

  constructor(callbacks: GestureCallbacks) {
    this.callbacks = callbacks;
  }

  public handlePointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;

    const touch: TouchPoint = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      startTime: performance.now(),
    };
    this.activeTouches.set(e.pointerId, touch);

    if (this.activeTouches.size === 2) {
      this.twoFingerSessionActive = true;
      this.swipeTriggered = false;
      this.maxMovement = 0;

      const touches = Array.from(this.activeTouches.values());
      this.startAvgX = (touches[0].startX + touches[1].startX) / 2;
      this.startAvgY = (touches[0].startY + touches[1].startY) / 2;
    } else if (this.activeTouches.size > 2) {
      // 3 or more fingers: cancel 2-finger gesture
      this.twoFingerSessionActive = false;
    }
  }

  public handlePointerMove(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;

    const touch = this.activeTouches.get(e.pointerId);
    if (!touch) return;

    touch.currentX = e.clientX;
    touch.currentY = e.clientY;

    if (this.twoFingerSessionActive && this.activeTouches.size === 2) {
      const touches = Array.from(this.activeTouches.values());
      const currentAvgX = (touches[0].currentX + touches[1].currentX) / 2;
      const currentAvgY = (touches[0].currentY + touches[1].currentY) / 2;

      const deltaX = currentAvgX - this.startAvgX;
      const deltaY = currentAvgY - this.startAvgY;
      const moveDist = Math.hypot(deltaX, deltaY);
      if (moveDist > this.maxMovement) {
        this.maxMovement = moveDist;
      }

      // 2-finger swipe recognition threshold: horizontal swipe >= 90px and deltaX > 2 * deltaY
      if (!this.swipeTriggered && Math.abs(deltaX) > 90 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
        this.swipeTriggered = true;
        const direction = deltaX < 0 ? 'left' : 'right';
        this.callbacks.onTwoFingerSwipe?.(direction);
      }
    }
  }

  public handlePointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;

    const touch = this.activeTouches.get(e.pointerId);
    const now = performance.now();

    if (this.twoFingerSessionActive && this.activeTouches.size === 2) {
      const duration = now - (touch ? touch.startTime : now);
      // If 2-finger tap: duration < 350ms, minimal movement (< 25px), and swipe not triggered
      if (!this.swipeTriggered && duration < 350 && this.maxMovement < 25) {
        this.callbacks.onTwoFingerTap?.();
      }
    }

    this.activeTouches.delete(e.pointerId);
    if (this.activeTouches.size < 2) {
      this.twoFingerSessionActive = false;
    }
  }

  public handlePointerCancel(e: PointerEvent): void {
    this.activeTouches.delete(e.pointerId);
    if (this.activeTouches.size < 2) {
      this.twoFingerSessionActive = false;
    }
  }

  public reset(): void {
    this.activeTouches.clear();
    this.twoFingerSessionActive = false;
    this.swipeTriggered = false;
  }
}
