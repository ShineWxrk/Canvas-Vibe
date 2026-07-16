/** Full-viewport photo presentation: crossfade + Ken Burns + image auras. */

import {
	extractPalette,
	paintAuraLayer,
	removeAuraLayer,
	waitForImage,
} from "./imageAura";
import {
	DEFAULT_SPARKLE_CONFIG,
	normalizeSparkleConfig,
	VibeSparkleController,
	type VibeSparkleConfig,
} from "./vibeSparkles";
import { VibeTiltController, type VibeCard } from "./vibeTilt";

const ROOT_CLS = "intuition-photo-presentation";
const ROOT_ATTR = "data-intuition-photo-presentation";

export interface PresentationSlide {
	src: string;
	label?: string;
}

export interface PresentationOptions {
	/** Time each slide is fully visible before fading out (ms). */
	intervalMs?: number;
	/** Crossfade duration (ms). */
	fadeMs?: number;
	/** Slow zoom/pan on the active slide. */
	kenBurns?: boolean;
	/** Sparkle settings (defaults to plugin vibe sparkles). */
	sparkles?: Partial<VibeSparkleConfig> | null;
	/** Media tilt strength 0–100 (same as vibe tilt). */
	tiltStrength?: number;
	onClose?: () => void;
}

const DEFAULTS = {
	intervalMs: 7000 as number,
	fadeMs: 1200 as number,
	kenBurns: true as boolean,
};

const KEN_BURNS_VARIANTS = [
	"intuition-kb-a",
	"intuition-kb-b",
	"intuition-kb-c",
	"intuition-kb-d",
] as const;

export class PhotoPresentation {
	private root: HTMLElement | null = null;
	private layerA: HTMLElement | null = null;
	private layerB: HTMLElement | null = null;
	private frameA: HTMLElement | null = null;
	private frameB: HTMLElement | null = null;
	private motionA: HTMLElement | null = null;
	private motionB: HTMLElement | null = null;
	private imgA: HTMLImageElement | null = null;
	private imgB: HTMLImageElement | null = null;
	private metaEl: HTMLElement | null = null;
	private slides: PresentationSlide[] = [];
	private index = 0;
	private usingA = true;
	private timer = 0;
	private fadeMs = DEFAULTS.fadeMs;
	private intervalMs = DEFAULTS.intervalMs;
	private kenBurns = DEFAULTS.kenBurns;
	private onClose: (() => void) | null = null;
	private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
	private closed = true;
	private auraGen = 0;
	private sparkles: VibeSparkleController | null = null;
	private tilt: VibeTiltController | null = null;
	private sparkleAnchor: HTMLElement | null = null;
	private hostEl: HTMLElement | null = null;
	private kbClearTimer = 0;

	isActive(): boolean {
		return !this.closed && !!this.root;
	}

	start(
		host: HTMLElement,
		slides: PresentationSlide[],
		options: PresentationOptions = {},
	): boolean {
		const clean = slides.filter((s) => !!s.src);
		if (clean.length === 0) return false;

		this.stop();
		this.closed = false;
		this.slides = clean;
		this.index = 0;
		this.usingA = true;
		this.intervalMs = Math.max(
			1500,
			options.intervalMs ?? DEFAULTS.intervalMs,
		);
		this.fadeMs = Math.max(200, options.fadeMs ?? DEFAULTS.fadeMs);
		this.kenBurns = options.kenBurns ?? DEFAULTS.kenBurns;
		this.onClose = options.onClose ?? null;

		const root = document.createElement("div");
		root.className = ROOT_CLS;
		root.setAttribute(ROOT_ATTR, "1");
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-modal", "true");
		root.setAttribute("aria-label", "Photo presentation");
		root.style.setProperty("--intuition-present-fade", `${this.fadeMs}ms`);
		root.style.setProperty(
			"--intuition-present-hold",
			`${this.intervalMs}ms`,
		);

		const stage = document.createElement("div");
		stage.className = `${ROOT_CLS}__stage`;

		const makeLayer = (name: "a" | "b") => {
			const layer = document.createElement("div");
			layer.className = `${ROOT_CLS}__layer ${ROOT_CLS}__layer--${name}`;

			const frame = document.createElement("div");
			frame.className = `${ROOT_CLS}__frame`;

			const motion = document.createElement("div");
			motion.className = `${ROOT_CLS}__motion`;

			const photo = document.createElement("div");
			photo.className = `${ROOT_CLS}__photo`;

			const img = document.createElement("img");
			img.className = `${ROOT_CLS}__img`;
			img.draggable = false;
			img.alt = "";

			photo.appendChild(img);
			motion.appendChild(photo);
			frame.appendChild(motion);
			layer.appendChild(frame);
			stage.appendChild(layer);
			return { layer, frame, motion, img };
		};

		const a = makeLayer("a");
		const b = makeLayer("b");
		this.layerA = a.layer;
		this.layerB = b.layer;
		this.frameA = a.frame;
		this.frameB = b.frame;
		this.motionA = a.motion;
		this.motionB = b.motion;
		this.imgA = a.img;
		this.imgB = b.img;

		/* Stable sparkle host — survives slide swaps so particles don't reset. */
		const sparkleAnchor = document.createElement("div");
		sparkleAnchor.className = `${ROOT_CLS}__sparkle-anchor`;
		sparkleAnchor.setAttribute("aria-hidden", "true");
		stage.appendChild(sparkleAnchor);
		this.sparkleAnchor = sparkleAnchor;

		const chrome = document.createElement("div");
		chrome.className = `${ROOT_CLS}__chrome`;

		const meta = document.createElement("div");
		meta.className = `${ROOT_CLS}__meta`;
		this.metaEl = meta;

		const hint = document.createElement("div");
		hint.className = `${ROOT_CLS}__hint`;
		hint.textContent = "← →  ·  Space  ·  Esc";

		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.className = `${ROOT_CLS}__close`;
		closeBtn.setAttribute("aria-label", "Close presentation");
		closeBtn.textContent = "✕";
		closeBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.stop();
		});

		chrome.appendChild(meta);
		chrome.appendChild(hint);
		chrome.appendChild(closeBtn);

		root.appendChild(stage);
		root.appendChild(chrome);

		root.addEventListener("click", (ev) => {
			if (ev.target !== root && ev.target !== stage) return;
			const rect = root.getBoundingClientRect();
			const x = (ev as MouseEvent).clientX - rect.left;
			if (x < rect.width * 0.33) this.prev();
			else if (x > rect.width * 0.66) this.next(true);
		});

		host.appendChild(root);
		this.root = root;
		this.hostEl = host;
		host.classList.add("intuition-photo-presentation-active");

		this.sparkles = new VibeSparkleController();
		this.sparkles.attach(root, {
			getSuspended: () => false,
			getSelectionCount: () => 0,
			getZoom: () => 1,
		});
		this.sparkles.setCardHosts(() =>
			this.sparkleAnchor?.isConnected ? [this.sparkleAnchor] : [],
		);
		this.sparkles.setSpawnAroundCenter(true);
		const sparkleBase = normalizeSparkleConfig(
			options.sparkles ?? DEFAULT_SPARKLE_CONFIG,
		);
		/* Presentation has one host — bump density so sparkles read clearly. */
		this.sparkles.setConfig({
			...sparkleBase,
			amount: Math.min(500, Math.round(sparkleBase.amount * 2.4)),
			frequency: Math.min(200, Math.round(sparkleBase.frequency * 2.0)),
			size: Math.min(48, Math.round(sparkleBase.size * 1.2)),
			opacity: Math.min(100, Math.round(sparkleBase.opacity * 1.05)),
		});
		this.sparkles.setEnabled(true);

		this.tilt = new VibeTiltController();
		this.tilt.attach(root, {
			getSuspended: () => false,
			getSelectionCount: () => 0,
			getCards: () => this.activeTiltCards(),
			getZoom: () => 1,
			isolateGlobalClass: true,
			glareEnabled: false,
		});
		this.tilt.setStrength(
			typeof options.tiltStrength === "number" &&
				Number.isFinite(options.tiltStrength)
				? options.tiltStrength
				: 50,
		);
		this.tilt.setEnabled(true);

		this.keyHandler = (ev: KeyboardEvent) => {
			if (this.closed) return;
			if (ev.key === "Escape") {
				ev.preventDefault();
				this.stop();
				return;
			}
			if (ev.key === "ArrowRight" || ev.key === " " || ev.key === "Spacebar") {
				ev.preventDefault();
				this.next(true);
				return;
			}
			if (ev.key === "ArrowLeft") {
				ev.preventDefault();
				this.prev();
			}
		};
		window.addEventListener("keydown", this.keyHandler, true);

		this.showIndex(0, false);
		this.scheduleAdvance();
		return true;
	}

	stop() {
		this.auraGen += 1;
		if (this.timer) {
			window.clearTimeout(this.timer);
			this.timer = 0;
		}
		if (this.kbClearTimer) {
			window.clearTimeout(this.kbClearTimer);
			this.kbClearTimer = 0;
		}
		if (this.keyHandler) {
			window.removeEventListener("keydown", this.keyHandler, true);
			this.keyHandler = null;
		}
		if (this.frameA) removeAuraLayer(this.frameA);
		if (this.frameB) removeAuraLayer(this.frameB);
		if (this.motionA) removeAuraLayer(this.motionA);
		if (this.motionB) removeAuraLayer(this.motionB);
		this.sparkles?.destroy();
		this.sparkles = null;
		this.tilt?.destroy();
		this.tilt = null;
		this.sparkleAnchor = null;
		this.hostEl?.classList.remove("intuition-photo-presentation-active");
		this.hostEl = null;
		const wasOpen = !this.closed;
		this.closed = true;
		this.root?.remove();
		this.root = null;
		this.layerA = null;
		this.layerB = null;
		this.frameA = null;
		this.frameB = null;
		this.motionA = null;
		this.motionB = null;
		this.imgA = null;
		this.imgB = null;
		this.metaEl = null;
		this.slides = [];
		if (wasOpen && this.onClose) {
			const cb = this.onClose;
			this.onClose = null;
			cb();
		} else {
			this.onClose = null;
		}
	}

	destroy() {
		this.stop();
	}

	private scheduleAdvance() {
		if (this.timer) window.clearTimeout(this.timer);
		if (this.closed || this.slides.length <= 1) return;
		this.timer = window.setTimeout(() => {
			this.timer = 0;
			this.next(false);
		}, this.intervalMs + this.fadeMs);
	}

	private next(manual: boolean) {
		if (this.closed || this.slides.length === 0) return;
		const next = (this.index + 1) % this.slides.length;
		this.showIndex(next, true);
		if (manual || this.slides.length > 1) this.scheduleAdvance();
	}

	private prev() {
		if (this.closed || this.slides.length === 0) return;
		const prev =
			(this.index - 1 + this.slides.length) % this.slides.length;
		this.showIndex(prev, true);
		this.scheduleAdvance();
	}

	private showIndex(index: number, animate: boolean) {
		const slide = this.slides[index];
		if (
			!slide ||
			!this.imgA ||
			!this.imgB ||
			!this.layerA ||
			!this.layerB ||
			!this.motionA ||
			!this.motionB
		) {
			return;
		}

		if (this.kbClearTimer) {
			window.clearTimeout(this.kbClearTimer);
			this.kbClearTimer = 0;
		}

		if (!animate) {
			this.clearKenBurns(this.layerA);
			this.clearKenBurns(this.layerB);
			this.imgA.src = slide.src;
			this.imgA.alt = slide.label ?? "";
			this.layerA.style.opacity = "1";
			this.layerB.style.opacity = "0";
			this.layerA.classList.add(`${ROOT_CLS}__layer--in`);
			this.layerA.classList.remove(`${ROOT_CLS}__layer--out`);
			this.layerB.classList.add(`${ROOT_CLS}__layer--out`);
			this.layerB.classList.remove(`${ROOT_CLS}__layer--in`);
			if (this.kenBurns) {
				this.applyKenBurns(this.layerA, this.motionA, index);
			}
			void this.refreshAura(this.motionA, this.imgA, slide.src);
			this.usingA = true;
		} else {
			const incomingImg = this.usingA ? this.imgB : this.imgA;
			const incomingLayer = this.usingA ? this.layerB : this.layerA;
			const incomingMotion = this.usingA ? this.motionB : this.motionA;
			const outgoingLayer = this.usingA ? this.layerA : this.layerB;

			/* Freeze outgoing scale so fade doesn't snap from 1.14 → 1.0. */
			this.freezeKenBurns(outgoingLayer);
			this.clearKenBurns(incomingLayer);

			incomingImg.src = slide.src;
			incomingImg.alt = slide.label ?? "";
			incomingLayer.classList.add(`${ROOT_CLS}__layer--in`);
			incomingLayer.classList.remove(`${ROOT_CLS}__layer--out`);
			outgoingLayer.classList.add(`${ROOT_CLS}__layer--out`);
			outgoingLayer.classList.remove(`${ROOT_CLS}__layer--in`);
			incomingLayer.style.opacity = "1";
			outgoingLayer.style.opacity = "0";
			if (this.kenBurns) {
				this.applyKenBurns(incomingLayer, incomingMotion, index);
			}
			void this.refreshAura(incomingMotion, incomingImg, slide.src);
			this.usingA = !this.usingA;

			this.kbClearTimer = window.setTimeout(() => {
				this.kbClearTimer = 0;
				if (this.closed) return;
				this.clearKenBurns(outgoingLayer);
			}, this.fadeMs + 40);
		}

		this.index = index;

		if (this.metaEl) {
			const label = slide.label ? ` · ${slide.label}` : "";
			this.metaEl.textContent = `${index + 1} / ${this.slides.length}${label}`;
		}
	}

	private activeTiltCards(): VibeCard[] {
		const cards: VibeCard[] = [];
		for (const layer of [this.layerA, this.layerB]) {
			if (!layer?.isConnected) continue;
			if (!layer.classList.contains(`${ROOT_CLS}__layer--in`)) continue;
			if (Number.parseFloat(getComputedStyle(layer).opacity || "0") < 0.12) {
				continue;
			}
			const photo = layer.querySelector(`.${ROOT_CLS}__photo`);
			if (photo instanceof HTMLElement) {
				cards.push({ el: photo, kind: "media" });
			}
		}
		return cards;
	}

	private async refreshAura(
		host: HTMLElement,
		img: HTMLImageElement,
		seed: string,
	) {
		const gen = ++this.auraGen;
		try {
			await waitForImage(img);
			if (this.closed || gen !== this.auraGen) return;
			const palette = extractPalette(img);
			paintAuraLayer(host, {
				color: palette?.[0] ?? "#7a6bb5",
				palette: palette ?? undefined,
				strength: 42,
				size: 88,
				seed,
				shimmer: true,
			});
		} catch {
			if (this.closed || gen !== this.auraGen) return;
			paintAuraLayer(host, {
				color: "#7a6bb5",
				strength: 36,
				size: 84,
				seed,
				shimmer: true,
			});
		}
	}

	private applyKenBurns(
		layer: HTMLElement,
		motion: HTMLElement,
		index: number,
	) {
		const variant = KEN_BURNS_VARIANTS[index % KEN_BURNS_VARIANTS.length]!;
		/* Hold a bit past the crossfade so the last frame isn't a dead stop. */
		const dur = this.intervalMs + this.fadeMs + 80;
		motion.style.transform = "";
		motion.style.animationName = "";
		layer.classList.add(variant);
		motion.style.animationDuration = `${dur}ms`;
	}

	/** Keep the current scale while fading out — avoids a snap shrink. */
	private freezeKenBurns(layer: HTMLElement) {
		const motion = layer.querySelector(`.${ROOT_CLS}__motion`);
		if (!(motion instanceof HTMLElement)) return;
		const computed = getComputedStyle(motion).transform;
		for (const v of KEN_BURNS_VARIANTS) layer.classList.remove(v);
		motion.style.animationName = "none";
		motion.style.animationDuration = "";
		if (computed && computed !== "none") {
			motion.style.transform = computed;
		}
	}

	private clearKenBurns(layer: HTMLElement) {
		for (const v of KEN_BURNS_VARIANTS) layer.classList.remove(v);
		const motion = layer.querySelector(`.${ROOT_CLS}__motion`);
		if (motion instanceof HTMLElement) {
			motion.style.animationDuration = "";
			motion.style.animationName = "";
			motion.style.transform = "";
		}
	}
}
