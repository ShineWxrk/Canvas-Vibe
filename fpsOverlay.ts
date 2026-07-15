/** Tiny FPS + live sparkle count readout for Canvas leaves. */

const CLS = "intuition-canvas-fps";
const ATTR = "data-intuition-fps";

export class FpsOverlay {
	private el: HTMLElement | null = null;
	private raf = 0;
	private frames = 0;
	private lastSample = 0;
	private running = false;
	private getSparkles: (() => number) | null = null;

	setSparkleCountProvider(fn: (() => number) | null) {
		this.getSparkles = fn;
	}

	attach(host: HTMLElement) {
		if (host.querySelector(`[${ATTR}]`)) {
			this.el = host.querySelector<HTMLElement>(`[${ATTR}]`);
			this.start();
			return;
		}
		const el = document.createElement("div");
		el.className = CLS;
		el.setAttribute(ATTR, "1");
		el.setAttribute("aria-hidden", "true");
		el.textContent = "— fps";
		host.appendChild(el);
		this.el = el;
		this.start();
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.frames = 0;
		this.lastSample = performance.now();
		const loop = (now: number) => {
			if (!this.running) return;
			this.frames++;
			const elapsed = now - this.lastSample;
			if (elapsed >= 500) {
				const fps = Math.round((this.frames * 1000) / elapsed);
				if (this.el) {
					const sparks = Math.max(0, Math.round(this.getSparkles?.() ?? 0));
					this.el.textContent = `${fps} fps · ${sparks} ✦`;
				}
				this.frames = 0;
				this.lastSample = now;
			}
			this.raf = window.requestAnimationFrame(loop);
		};
		this.raf = window.requestAnimationFrame(loop);
	}

	destroy() {
		this.running = false;
		if (this.raf) window.cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.getSparkles = null;
		this.el?.remove();
		this.el = null;
	}
}
