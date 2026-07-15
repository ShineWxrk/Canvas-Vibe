/** Canvas-rendered sparkles around visible Canvas cards (vibe mode).
 *
 * One <canvas> overlay draws all particles — far cheaper than N DOM nodes.
 * Previous per-card DOM implementation: restore from git if needed.
 */

const LAYER_CLS = "intuition-vibe-sparkles-canvas";
const LAYER_ATTR = "data-intuition-vibe-sparkles-canvas";
const HOOK_ATTR = "data-intuition-vibe-sparkle-hook";

/** Prefer class selectors — :has() is costly when scanned every tick. */
const CARD_SEL = ".canvas-node.is-text, .canvas-node.is-file, .canvas-node.is-media";

export interface VibeSparkleConfig {
	/** Max simultaneous sparkles (absolute count) */
	amount: number;
	/** Spawn rate (absolute intensity) */
	frequency: number;
	/** Base size in px */
	size: number;
	/** Lifetime in ms (base, ±45% random) */
	lifetime: number;
	/** Hex color */
	color: string;
	/** 0–100 peak opacity */
	opacity: number;
	/** Upward drift strength (absolute intensity) */
	drift: number;
}

export const SPARKLE_LIMITS = {
	amount: { min: 0, max: 500 },
	frequency: { min: 0, max: 200 },
	size: { min: 2, max: 48 },
	lifetime: { min: 600, max: 8000 },
	opacity: { min: 5, max: 100 },
	drift: { min: 0, max: 300 },
} as const;

export const DEFAULT_SPARKLE_CONFIG: VibeSparkleConfig = {
	amount: 80,
	frequency: 40,
	size: 8,
	lifetime: 2800,
	color: "#ffffff",
	opacity: 90,
	drift: 80,
};

export function normalizeSparkleConfig(
	partial?: Partial<VibeSparkleConfig> | null,
): VibeSparkleConfig {
	const p = partial ?? {};
	const L = SPARKLE_LIMITS;
	return {
		amount: clamp(p.amount ?? DEFAULT_SPARKLE_CONFIG.amount, L.amount.min, L.amount.max),
		frequency: clamp(
			p.frequency ?? DEFAULT_SPARKLE_CONFIG.frequency,
			L.frequency.min,
			L.frequency.max,
		),
		size: clamp(p.size ?? DEFAULT_SPARKLE_CONFIG.size, L.size.min, L.size.max),
		lifetime: clamp(
			p.lifetime ?? DEFAULT_SPARKLE_CONFIG.lifetime,
			L.lifetime.min,
			L.lifetime.max,
		),
		color: normalizeHex(p.color ?? DEFAULT_SPARKLE_CONFIG.color),
		opacity: clamp(
			p.opacity ?? DEFAULT_SPARKLE_CONFIG.opacity,
			L.opacity.min,
			L.opacity.max,
		),
		drift: clamp(p.drift ?? DEFAULT_SPARKLE_CONFIG.drift, L.drift.min, L.drift.max),
	};
}

/** Convert legacy %-based sparkle settings (scale &lt; 3) into absolute units. */
export function migrateLegacySparkleConfig(
	partial?: Partial<VibeSparkleConfig> & { hideZoom?: number } | null,
): VibeSparkleConfig {
	const p = { ...(partial ?? {}) };
	if (typeof p.size === "number" && p.size >= 40) {
		p.size = Math.round((p.size / 100) * 8);
	}
	if (typeof p.frequency === "number" && p.frequency > 200) {
		p.frequency = Math.round((p.frequency / 300) * 200);
	}
	delete p.hideZoom;
	return normalizeSparkleConfig(p);
}

type SuspendCheck = () => boolean;
type ZoomProvider = () => number;

interface Particle {
	host: HTMLElement;
	xPct: number;
	yPct: number;
	size: number;
	rot: number;
	dx: number;
	dy: number;
	color: string;
	peak: number;
	born: number;
	dur: number;
}

export class VibeSparkleController {
	private enabled = false;
	private cfg: VibeSparkleConfig = { ...DEFAULT_SPARKLE_CONFIG };
	private root: HTMLElement | null = null;
	private getSuspended: SuspendCheck = () => false;
	private getSelectionCount: () => number = () => 0;
	private getZoom: ZoomProvider = () => 1;
	private zoom = 1;
	private panning = false;

	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private particles: Particle[] = [];
	private readonly counts = new WeakMap<HTMLElement, number>();

	private spawnTimer = 0;
	private raf = 0;
	private originX = 0;
	private originY = 0;
	private cssW = 0;
	private cssH = 0;

	private cardCache: HTMLElement[] = [];
	private cardCacheAt = 0;
	private readonly cardCacheMs = 400;

	private onVisibility = () => {
		if (document.hidden) {
			this.stopSpawn();
			this.stopRaf();
		} else if (this.enabled) {
			this.scheduleSpawn(80);
			this.startRaf();
		}
	};

	attach(
		root: HTMLElement,
		opts: {
			getSuspended: SuspendCheck;
			getSelectionCount: () => number;
			getZoom?: ZoomProvider;
		},
	) {
		this.root = root;
		this.getSuspended = opts.getSuspended;
		this.getSelectionCount = opts.getSelectionCount;
		if (opts.getZoom) this.getZoom = opts.getZoom;
		if (root.getAttribute(HOOK_ATTR) === "1") {
			this.ensureCanvas();
			return;
		}
		root.setAttribute(HOOK_ATTR, "1");
		document.addEventListener("visibilitychange", this.onVisibility);
		this.ensureCanvas();
	}

	setZoom(zoom: number) {
		const z =
			typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
		this.zoom = z;
		this.trimToBudget();
	}

	private liveZoom(): number {
		const z = this.getZoom();
		if (typeof z === "number" && Number.isFinite(z) && z > 0) return z;
		return this.zoom > 0 ? this.zoom : 1;
	}

	setPanning(on: boolean) {
		const was = this.panning;
		this.panning = !!on;
		/* Canvas sparkles are cheap — keep them while panning. */
		if (was && !this.panning && this.enabled) this.scheduleSpawn(60);
	}

	getEffectiveMax() {
		return this.effectiveMaxActive();
	}

	getActiveCount() {
		return this.particles.length;
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		if (!on) {
			this.stopSpawn();
			this.clearAll();
			this.stopRaf();
			return;
		}
		this.ensureCanvas();
		this.scheduleSpawn(40);
		this.startRaf();
	}

	setConfig(partial: Partial<VibeSparkleConfig>) {
		this.cfg = normalizeSparkleConfig({ ...this.cfg, ...partial });
		this.trimToBudget();
		if (this.cfg.amount <= 0 && this.cfg.frequency <= 0) {
			this.clearAll();
			if (this.enabled) this.scheduleSpawn(400);
			return;
		}
		if (this.enabled) this.scheduleSpawn(50);
	}

	/** @deprecated prefer setConfig */
	setIntensity(amount: number) {
		this.setConfig({ amount });
	}

	private effectiveMaxActive(): number {
		return Math.max(0, this.cfg.amount);
	}

	private trimToBudget() {
		const max = this.effectiveMaxActive();
		if (max <= 0) {
			if (this.particles.length) this.clearAll();
			return;
		}
		while (this.particles.length > max) {
			this.removeParticle(this.particles.length - 1);
		}
	}

	destroy() {
		this.stopSpawn();
		this.stopRaf();
		this.clearAll();
		document.removeEventListener("visibilitychange", this.onVisibility);
		this.canvas?.remove();
		this.canvas = null;
		this.ctx = null;
		this.root?.removeAttribute(HOOK_ATTR);
		this.root = null;
		this.enabled = false;
	}

	private stopSpawn() {
		if (this.spawnTimer) {
			window.clearTimeout(this.spawnTimer);
			this.spawnTimer = 0;
		}
	}

	private scheduleSpawn(ms: number) {
		this.stopSpawn();
		if (!this.enabled || document.hidden) return;
		this.spawnTimer = window.setTimeout(() => this.spawnTick(), ms);
	}

	private startRaf() {
		if (this.raf || !this.enabled) return;
		const loop = (now: number) => {
			this.raf = 0;
			if (!this.enabled || document.hidden) return;
			this.paint(now);
			this.raf = window.requestAnimationFrame(loop);
		};
		this.raf = window.requestAnimationFrame(loop);
	}

	private stopRaf() {
		if (this.raf) window.cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	private viewportHost(): HTMLElement {
		const root = this.root!;
		return (
			(root.closest(".workspace-leaf-content") as HTMLElement | null) ??
			(root.classList.contains("canvas-wrapper")
				? root
				: (root.querySelector(".canvas-wrapper") as HTMLElement | null)) ??
			root
		);
	}

	private ensureCanvas() {
		if (!this.root) return;
		const host = this.viewportHost();
		if (getComputedStyle(host).position === "static") {
			host.style.position = "relative";
		}
		if (!this.canvas || !this.canvas.isConnected) {
			host.querySelector(`[${LAYER_ATTR}]`)?.remove();
			const el = document.createElement("canvas");
			el.className = LAYER_CLS;
			el.setAttribute(LAYER_ATTR, "1");
			el.setAttribute("aria-hidden", "true");
			host.appendChild(el);
			this.canvas = el;
			this.ctx = el.getContext("2d");
		}
	}

	private syncCanvasSize() {
		this.ensureCanvas();
		if (!this.canvas || !this.ctx) return false;
		const host = this.viewportHost();
		const r = host.getBoundingClientRect();
		this.originX = r.left;
		this.originY = r.top;
		const w = Math.max(1, Math.round(r.width));
		const h = Math.max(1, Math.round(r.height));
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (this.cssW !== w || this.cssH !== h || this.canvas.width !== Math.round(w * dpr)) {
			this.cssW = w;
			this.cssH = h;
			this.canvas.width = Math.round(w * dpr);
			this.canvas.height = Math.round(h * dpr);
			this.canvas.style.width = `${w}px`;
			this.canvas.style.height = `${h}px`;
			this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		return true;
	}

	private spawnTick() {
		this.spawnTimer = 0;
		if (!this.root || !this.enabled || document.hidden) return;

		const maxCount = this.cfg.amount;
		const freq = this.cfg.frequency;
		if (maxCount <= 0 || freq <= 0) {
			this.scheduleSpawn(400);
			return;
		}

		const amountN = Math.min(1, maxCount / SPARKLE_LIMITS.amount.max);
		const freqN = Math.min(1, freq / SPARKLE_LIMITS.frequency.max);

		const view = this.viewportRect();
		const cards = this.getCards();
		const maxActive = this.effectiveMaxActive();
		if (maxActive <= 0) {
			this.clearAll();
			this.scheduleSpawn(400);
			return;
		}
		this.trimToBudget();

		const targets: HTMLElement[] = [];
		for (let i = 0; i < cards.length; i++) {
			const node = cards[i];
			if (node.classList.contains("is-group")) continue;
			if (!this.intersectsViewport(node, view)) continue;
			targets.push(node);
		}
		if (!targets.length) {
			this.scheduleSpawn(280);
			return;
		}

		const load = this.particles.length / Math.max(1, maxActive);
		const spawnChance = Math.min(
			0.95,
			(0.15 + freqN * 0.7) * (0.4 + amountN * 0.5) * (1 - load * 0.35),
		);

		/* Emptiest first — even spread, no per-card ceiling. */
		targets.sort(
			(a, b) => (this.counts.get(a) ?? 0) - (this.counts.get(b) ?? 0),
		);

		const deficit = Math.max(0, maxActive - this.particles.length);
		const passes = Math.min(
			deficit,
			Math.max(1, Math.ceil((2 + freqN * 8) / Math.max(1, Math.sqrt(targets.length)))),
		);

		const now = performance.now();
		for (let pass = 0; pass < passes && this.particles.length < maxActive; pass++) {
			for (let i = 0; i < targets.length; i++) {
				if (this.particles.length >= maxActive) break;
				if (Math.random() >= spawnChance) continue;
				this.spawn(targets[i], now);
			}
		}

		this.startRaf();

		const delay = Math.max(
			35,
			(160 + (1 - freqN) * 260) * (1.1 - amountN * 0.25) +
				Math.random() * 50 +
				load * 35,
		);
		this.scheduleSpawn(delay);
	}

	private paint(now: number) {
		if (!this.syncCanvasSize() || !this.ctx || !this.canvas) return;
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.cssW, this.cssH);

		if (!this.enabled) {
			return;
		}

		const rectCache = new Map<HTMLElement, DOMRect>();
		const rectOf = (el: HTMLElement) => {
			let r = rectCache.get(el);
			if (!r) {
				r = el.getBoundingClientRect();
				rectCache.set(el, r);
			}
			return r;
		};

		for (let i = this.particles.length - 1; i >= 0; i--) {
			const p = this.particles[i];
			const t = (now - p.born) / p.dur;
			if (t >= 1 || !p.host.isConnected) {
				this.removeParticle(i);
				continue;
			}
			const r = rectOf(p.host);
			if (r.width < 2 || r.height < 2) {
				this.removeParticle(i);
				continue;
			}

			const ease = t;
			const x =
				r.left -
				this.originX +
				(p.xPct / 100) * r.width +
				p.dx * ease;
			const y =
				r.top -
				this.originY +
				(p.yPct / 100) * r.height +
				p.dy * ease;
			const alpha = sparkleAlpha(t) * p.peak;
			const scale = sparkleScale(t);
			drawStar(ctx, x, y, p.size * scale, p.rot, alpha, p.color);
		}
	}

	private getCards(): HTMLElement[] {
		const now = performance.now();
		if (
			this.cardCache.length &&
			now - this.cardCacheAt < this.cardCacheMs &&
			this.root
		) {
			return this.cardCache;
		}
		if (!this.root) return [];
		const found = Array.from(this.root.querySelectorAll<HTMLElement>(CARD_SEL));
		if (!found.length) {
			const loose = this.root.querySelectorAll<HTMLElement>(".canvas-node");
			this.cardCache = Array.from(loose).filter(
				(n) =>
					n.classList.contains("is-text") ||
					!!n.querySelector("img, .media-embed, .image-embed"),
			);
		} else {
			this.cardCache = found;
		}
		this.cardCacheAt = now;
		return this.cardCache;
	}

	private viewportRect(): DOMRect {
		return this.viewportHost().getBoundingClientRect();
	}

	private intersectsViewport(el: HTMLElement, view: DOMRect): boolean {
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4) return false;
		/* Any overlap (plus a small margin) — never require full containment. */
		const m = 24;
		return (
			r.right > view.left - m &&
			r.left < view.right + m &&
			r.bottom > view.top - m &&
			r.top < view.bottom + m
		);
	}

	private spawn(node: HTMLElement, now = performance.now()) {
		if (this.particles.length >= this.effectiveMaxActive()) return;

		const pos = this.randomNearEdge();
		const base = this.cfg.size;
		const size = base * (0.7 + Math.random() * 0.65);
		const life = this.cfg.lifetime;
		const dur = life * (0.75 + Math.random() * 0.55);
		const driftAmt = this.cfg.drift / 100;
		const speedScale = dur / DEFAULT_SPARKLE_CONFIG.lifetime;
		const rot = ((-8 + Math.random() * 16) * Math.PI) / 180;
		const dx =
			(-1.5 + Math.random() * 3) * (0.35 + driftAmt * 0.4) * speedScale;
		const dy =
			(-4 - Math.random() * 8) * (0.35 + driftAmt * 1.1) * speedScale;
		const peakOp = this.cfg.opacity / 100;
		const peak = peakOp * (0.65 + Math.random() * 0.35);

		this.particles.push({
			host: node,
			xPct: pos.x,
			yPct: pos.y,
			size,
			rot,
			dx,
			dy,
			color: this.cfg.color,
			peak,
			born: now,
			dur,
		});
		this.counts.set(node, (this.counts.get(node) ?? 0) + 1);
	}

	private removeParticle(index: number) {
		const p = this.particles[index];
		if (!p) return;
		this.particles.splice(index, 1);
		const n = (this.counts.get(p.host) ?? 1) - 1;
		if (n <= 0) this.counts.delete(p.host);
		else this.counts.set(p.host, n);
	}

	private randomNearEdge(): { x: number; y: number } {
		const pad = 10 + Math.random() * 8;
		const side = Math.floor(Math.random() * 4);
		const t = Math.random();
		if (side === 0)
			return { x: -pad + t * (100 + pad * 2), y: -pad + Math.random() * 14 };
		if (side === 1)
			return {
				x: -pad + t * (100 + pad * 2),
				y: 86 + Math.random() * (pad + 14),
			};
		if (side === 2)
			return { x: -pad + Math.random() * 14, y: -pad + t * (100 + pad * 2) };
		return {
			x: 86 + Math.random() * (pad + 14),
			y: -pad + t * (100 + pad * 2),
		};
	}

	clearAll() {
		this.particles.length = 0;
		this.cardCache = [];
		this.cardCacheAt = 0;
		if (this.ctx && this.canvas) {
			this.ctx.clearRect(0, 0, this.cssW || this.canvas.width, this.cssH || this.canvas.height);
		}
	}
}

function sparkleAlpha(t: number): number {
	if (t < 0.2) return (t / 0.2) * 0.55;
	if (t < 0.45) return 0.55 + ((t - 0.2) / 0.25) * 0.45;
	if (t < 0.75) return 1 - ((t - 0.45) / 0.3) * 0.65;
	return Math.max(0, 0.35 * (1 - (t - 0.75) / 0.25));
}

function sparkleScale(t: number): number {
	if (t < 0.2) return 0.75 + (t / 0.2) * 0.25;
	if (t < 0.75) return 1;
	return 1 - ((t - 0.75) / 0.25) * 0.15;
}

/** Original CSS-mask star path (viewBox 0 0 32 32), soft concave spikes. */
const STAR_PATH = new Path2D(
	"M16 1C16.4 9.2 9.2 16.4 1 16C9.2 16.4 16.4 22.8 16 31C15.6 22.8 22.8 16.4 31 16C22.8 15.6 15.6 9.2 16 1Z",
);

function drawStar(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	rot: number,
	alpha: number,
	color: string,
) {
	if (alpha <= 0.01 || size < 0.5) return;
	/* Path spans ~30 units centered on (16,16). */
	const s = size / 30;
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate(rot);
	ctx.scale(s, s);
	ctx.translate(-16, -16);
	ctx.globalAlpha = alpha;
	ctx.fillStyle = color;
	ctx.fill(STAR_PATH);
	ctx.restore();
}

function clamp(n: number, min: number, max: number) {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

function normalizeHex(value: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(value)) {
		const r = value[1];
		const g = value[2];
		const b = value[3];
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	return DEFAULT_SPARKLE_CONFIG.color;
}
