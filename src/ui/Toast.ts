/**
 * Toast
 * Minimalist notification pill for canvas interactions
 */

export class Toast {
  public static show(message: string, durationMs: number = 1800): void {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className =
      'pointer-events-none px-4 py-1.5 rounded-full bg-[#1a1a1a]/85 text-[#fdfbf7] text-xs font-mono tracking-wide shadow-md backdrop-blur-md opacity-0 translate-y-2 transition-all duration-200';
    el.textContent = message;

    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => {
      el.classList.remove('opacity-0', 'translate-y-2');
      el.classList.add('opacity-100', 'translate-y-0');
    });

    // Animate out and remove
    setTimeout(() => {
      el.classList.remove('opacity-100', 'translate-y-0');
      el.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }, 250);
    }, durationMs);
  }
}
