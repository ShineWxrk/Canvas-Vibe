/** Full-viewport photo presentation: collage table + fly-up focus, Ken Burns, auras, sparkles. */

import { boundingBox } from "./collageLayout";
import {
	extractPalette,
	paintAuraLayer,
	removeAuraLayer,
	waitForImage,
} from "./imageAura";
import {
	DEFAULT_PRESENTATION_SETTINGS,
	normalizePresentationSettings,
	normalizePresentationTransition,
	type PresentationSettings,
	type PresentationTransition,
} from "./presentationSettings";
import { VibeSparkleController } from "./vibeSparkles";
import { VibeTiltController, type VibeCard } from "./vibeTilt";

const ROOT_CLS = "intuition-photo-presentation";
const ROOT_ATTR = "data-intuition-photo-presentation";

export interface PresentationSlide {
	src: string;
	label?: string;
	/** Canvas position/size (px) — used to lay the photo out on the collage "table". */
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface PresentationOptions {
	settings?: Partial<PresentationSettings>;
	/** Media tilt strength 0–100 (already halved by caller if desired). */
	tiltStrength?: number;
	onClose?: () => void;
}

const KEN_BURNS_VARIANTS = [
	"intuition-kb-a",
	"intuition-kb-b",
	"intuition-kb-c",
	"intuition-kb-d",
] as const;

interface PercentRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Focused/large view: centered box, contained within the stage (matches sparkle anchor). */
const FOCUS_RECT: PercentRect = { left: 7, top: 7, width: 86, height: 86 };

/** Collage table padding as a fraction of the stage — keep air top/bottom. */
const COLLAGE_PAD_X = 0.08;
const COLLAGE_PAD_Y = 0.14;

const FLY_Z_FRONT = "6";
const FLY_Z_BACK = "5";
const FLY_Z_IDLE = "1";
/** Shared ascend/descend curve: slow → fast → slow. */
const FLY_EASE_IN_OUT = "cubic-bezier(0.45, 0.05, 0.55, 0.95)";

/** Soft collision: keep a gap between crossing fly cards. */
const COLLISION_PAD_PX = 22;
const COLLISION_MAX_PUSH_PX = 48;
/** How quickly the desired push eases in/out (lower = softer). */
const COLLISION_TARGET_LERP = 0.05;
/** How quickly the cards follow that push (lower = softer). */
const COLLISION_OFFSET_LERP = 0.07;
const COLLISION_PUSH_GAIN = 0.32;

function flyMotionTransition(ms: number, classic: boolean): string {
	const ease = FLY_EASE_IN_OUT;
	if (classic) {
		return [
			`opacity ${ms}ms ${ease}`,
			`transform ${ms}ms ${ease}`,
		].join(", ");
	}
	return [
		`left ${ms}ms ${ease}`,
		`top ${ms}ms ${ease}`,
		`width ${ms}ms ${ease}`,
		`height ${ms}ms ${ease}`,
	].join(", ");
}

type FlyId = "a" | "b";

export class PhotoPresentation {
	private root: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	private collageBoard: HTMLElement | null = null;
	private tiles: HTMLElement[] = [];
	private collageRects: PercentRect[] = [];
	private flyA: HTMLElement | null = null;
	private flyB: HTMLElement | null = null;
	private motionA: HTMLElement | null = null;
	private motionB: HTMLElement | null = null;
	private imgA: HTMLImageElement | null = null;
	private imgB: HTMLImageElement | null = null;
	private metaEl: HTMLElement | null = null;
	private slides: PresentationSlide[] = [];
	private index = 0;
	private currentWhich: FlyId = "a";
	private currentIndex = -1;
	private timer = 0;
	private fadeMs = DEFAULT_PRESENTATION_SETTINGS.fadeMs;
	private intervalMs = DEFAULT_PRESENTATION_SETTINGS.intervalSec * 1000;
	private kenBurnsStrength = DEFAULT_PRESENTATION_SETTINGS.kenBurnsStrength;
	private transition: PresentationTransition =
		DEFAULT_PRESENTATION_SETTINGS.transition;
	private aurasEnabled = true;
	private sparklesEnabled = true;
	private paletteBg = true;
	private onClose: (() => void) | null = null;
	private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
	private closed = true;
	private auraGen = 0;
	private sparkles: VibeSparkleController | null = null;
	private tilt: VibeTiltController | null = null;
	private sparkleAnchor: HTMLElement | null = null;
	private hostEl: HTMLElement | null = null;
	private settleTimers: Record<FlyId, number> = { a: 0, b: 0 };
	private restTimers: Record<FlyId, number> = { a: 0, b: 0 };
	/** Mid-cross z-index swap while one card rises and the other falls. */
	private zSwapTimer = 0;
	/** RAF soft-separation while two fly cards cross. */
	private collisionRaf = 0;
	private collisionUntil = 0;
	/** Keep separating until the rising card finishes its CSS travel. */
	private collisionAscendUntil = 0;
	private collisionAscendStart = 0;
	private collisionIn: FlyId | null = null;
	private collisionOut: FlyId | null = null;
	private collisionOffset: Record<FlyId, { x: number; y: number }> = {
		a: { x: 0, y: 0 },
		b: { x: 0, y: 0 },
	};
	/** Separation axis locked for the whole cross (avoids 180° flips mid-pass). */
	private collisionAxisNx = 1;
	private collisionAxisNy = 0;
	private collisionAxisReady = false;
	/** Smoothed push magnitude along the locked axis. */
	private collisionPush = 0;
	/** Slide index currently bound to each fly layer (−1 = none). */
	private flyOwnedIndex: Record<FlyId, number> = { a: -1, b: -1 };
	private tiltStrength = 50;
	/** True when we successfully entered native OS fullscreen for this run. */
	private fullscreenActive = false;
	private onFullscreenChange: (() => void) | null = null;
	/** Sticky player reparented into fullscreen root for the duration of the show. */
	private adoptedSticky: HTMLElement | null = null;
	private stickyHome: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

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
		this.currentWhich = "a";
		this.currentIndex = -1;

		const cfg = normalizePresentationSettings(options.settings);
		if (cfg.shuffle) this.shuffleSlidesInPlace(this.slides);
		this.intervalMs = Math.round(cfg.intervalSec * 1000);
		this.fadeMs = cfg.fadeMs;
		this.kenBurnsStrength = cfg.kenBurnsStrength;
		this.transition = normalizePresentationTransition(cfg.transition);
		this.aurasEnabled = cfg.auras;
		this.sparklesEnabled = cfg.sparkles;
		this.paletteBg = cfg.paletteBg;
		this.tiltStrength =
			typeof options.tiltStrength === "number" &&
			Number.isFinite(options.tiltStrength)
				? options.tiltStrength
				: 50;
		this.onClose = options.onClose ?? null;

		const root = document.createElement("div");
		root.className = ROOT_CLS;
		root.setAttribute(ROOT_ATTR, "1");
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-modal", "true");
		root.setAttribute("aria-label", "Photo presentation");
		root.classList.toggle(`${ROOT_CLS}--palette-bg`, this.paletteBg);
		root.classList.toggle(`${ROOT_CLS}--vignette`, cfg.vignette);
		root.classList.toggle(`${ROOT_CLS}--letterbox`, cfg.letterbox);
		root.classList.toggle(`${ROOT_CLS}--fly`, this.transition === "fly");
		root.dataset.transition = this.transition;
		root.style.setProperty("--intuition-present-fade", `${this.fadeMs}ms`);
		root.style.setProperty(
			"--intuition-present-hold",
			`${this.intervalMs}ms`,
		);

		const stage = document.createElement("div");
		stage.className = `${ROOT_CLS}__stage`;
		this.stageEl = stage;

		const collageBoard = document.createElement("div");
		collageBoard.className = `${ROOT_CLS}__collage`;
		collageBoard.setAttribute("aria-hidden", "true");
		stage.appendChild(collageBoard);
		this.collageBoard = collageBoard;

		this.tiles = this.slides.map((slide) => {
			const tile = document.createElement("div");
			tile.className = `${ROOT_CLS}__tile`;

			const img = document.createElement("img");
			img.className = `${ROOT_CLS}__tile-img`;
			img.draggable = false;
			img.alt = "";
			img.loading = "lazy";
			img.src = slide.src;

			tile.appendChild(img);
			collageBoard.appendChild(tile);
			return tile;
		});
		this.relayoutCollage();
		this.resizeObserver?.disconnect();
		this.resizeObserver = new ResizeObserver(() => {
			if (this.closed) return;
			this.relayoutCollage();
		});
		this.resizeObserver.observe(stage);

		const makeFly = (name: FlyId) => {
			const fly = document.createElement("div");
			fly.className = `${ROOT_CLS}__fly ${ROOT_CLS}__fly--${name}`;

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
			fly.appendChild(motion);
			stage.appendChild(fly);
			return { fly, motion, img };
		};

		const a = makeFly("a");
		const b = makeFly("b");
		this.flyA = a.fly;
		this.flyB = b.fly;
		this.motionA = a.motion;
		this.motionB = b.motion;
		this.imgA = a.img;
		this.imgB = b.img;

		const sparkleAnchor = document.createElement("div");
		sparkleAnchor.className = `${ROOT_CLS}__sparkle-anchor`;
		sparkleAnchor.setAttribute("aria-hidden", "true");
		stage.appendChild(sparkleAnchor);
		this.sparkleAnchor = sparkleAnchor;

		const letterbox = document.createElement("div");
		letterbox.className = `${ROOT_CLS}__letterbox`;
		letterbox.setAttribute("aria-hidden", "true");
		stage.appendChild(letterbox);

		const vignette = document.createElement("div");
		vignette.className = `${ROOT_CLS}__vignette`;
		vignette.setAttribute("aria-hidden", "true");
		stage.appendChild(vignette);

		const chrome = document.createElement("div");
		chrome.className = `${ROOT_CLS}__chrome`;

		const meta = document.createElement("div");
		meta.className = `${ROOT_CLS}__meta`;
		this.metaEl = meta;

		const hint = document.createElement("div");
		hint.className = `${ROOT_CLS}__hint`;
		hint.textContent = "← →  ·  Space  ·  Esc (выход)";

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
		this.adoptStickyPlayer(host, root);

		this.onFullscreenChange = () => {
			const fs =
				document.fullscreenElement ??
				(document as Document & { webkitFullscreenElement?: Element })
					.webkitFullscreenElement;
			// User left OS fullscreen (Esc / OS chrome) — close the show.
			if (!fs && this.fullscreenActive && !this.closed) {
				this.fullscreenActive = false;
				this.stop();
			}
		};
		document.addEventListener("fullscreenchange", this.onFullscreenChange);
		document.addEventListener(
			"webkitfullscreenchange",
			this.onFullscreenChange,
		);
		void this.enterNativeFullscreen(root);
		// Fullscreen changes stage size — refit collage once the FS layout settles.
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				if (!this.closed) this.relayoutCollage();
			});
		});

		if (this.sparklesEnabled) {
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
			/* Hardcoded slideshow look — absolute values (board multipliers
			 * barely move the board spawn curve on a single host). */
			this.sparkles.setConfig({
				amount: 380,
				frequency: 170,
				size: 10,
				lifetime: 2600,
				color: "#ffffff",
				opacity: 95,
				drift: 90,
			});
			this.sparkles.setEnabled(true);
		}

		this.tilt = new VibeTiltController();
		this.tilt.attach(root, {
			getSuspended: () => false,
			getSelectionCount: () => 0,
			getCards: () => this.activeTiltCards(),
			getZoom: () => 1,
			isolateGlobalClass: true,
			glareEnabled: false,
		});
		this.tilt.setStrength(this.tiltStrength);
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
		for (const id of ["a", "b"] as const) {
			if (this.settleTimers[id]) {
				window.clearTimeout(this.settleTimers[id]);
				this.settleTimers[id] = 0;
			}
			if (this.restTimers[id]) {
				window.clearTimeout(this.restTimers[id]);
				this.restTimers[id] = 0;
			}
		}
		this.clearZSwapTimer();
		this.stopCollisionAvoidance(true);
		if (this.keyHandler) {
			window.removeEventListener("keydown", this.keyHandler, true);
			this.keyHandler = null;
		}
		if (this.onFullscreenChange) {
			document.removeEventListener(
				"fullscreenchange",
				this.onFullscreenChange,
			);
			document.removeEventListener(
				"webkitfullscreenchange",
				this.onFullscreenChange,
			);
			this.onFullscreenChange = null;
		}
		void this.exitNativeFullscreen();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.stageEl = null;
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
		// Move sticky out before removing the fullscreen root.
		this.restoreStickyPlayer();
		this.root?.remove();
		this.root = null;
		this.collageBoard = null;
		this.tiles = [];
		this.collageRects = [];
		this.flyA = null;
		this.flyB = null;
		this.motionA = null;
		this.motionB = null;
		this.imgA = null;
		this.imgB = null;
		this.metaEl = null;
		this.currentWhich = "a";
		this.currentIndex = -1;
		this.flyOwnedIndex = { a: -1, b: -1 };
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
		if (!slide || !this.flyA || !this.flyB) return;

		if (!animate) {
			this.clearZSwapTimer();
			this.stopCollisionAvoidance(true);
			this.currentWhich = "a";
			this.currentIndex = index;
			// Quick entrance on open: fly-up from the slot in "fly" mode,
			// or a short fade/zoom/slide-in for the classic transitions.
			this.ascend("a", index, true);
		} else {
			const outWhich = this.currentWhich;
			const outIndex = this.currentIndex;
			const inWhich: FlyId = outWhich === "a" ? "b" : "a";

			// Simultaneous: outgoing retires while incoming comes in.
			// Outgoing stays in front until mid-cross, then z-indexes swap
			// so they feel like they traded places in depth.
			if (outIndex >= 0) {
				this.stopCollisionAvoidance(true);
				this.descend(outWhich, outIndex);
				this.ascend(inWhich, index, false, /* startInBack */ true);
				this.scheduleCrossZSwap(inWhich, outWhich);
				this.startCollisionAvoidance(inWhich, outWhich);
			} else {
				this.stopCollisionAvoidance(true);
				this.ascend(inWhich, index, false);
			}

			this.currentWhich = inWhich;
			this.currentIndex = index;
		}

		this.index = index;

		if (this.metaEl) {
			const label = slide.label ? ` · ${slide.label}` : "";
			this.metaEl.textContent = `${index + 1} / ${this.slides.length}${label}`;
		}
	}

	private clearZSwapTimer() {
		if (this.zSwapTimer) {
			window.clearTimeout(this.zSwapTimer);
			this.zSwapTimer = 0;
		}
	}

	/**
	 * Halfway through the cross: bring the rising card in front of the
	 * falling one so they feel like they swapped depth order.
	 */
	private scheduleCrossZSwap(inWhich: FlyId, outWhich: FlyId) {
		this.clearZSwapTimer();
		const ascendMs = this.fadeMs;
		const descendMs = Math.max(80, Math.round(this.fadeMs * (2 / 3)));
		/* Swap when both are still mid-flight (shorter path's halfway). */
		const swapAt = Math.max(60, Math.round(Math.min(ascendMs, descendMs) * 0.5));
		this.zSwapTimer = window.setTimeout(() => {
			this.zSwapTimer = 0;
			if (this.closed) return;
			const inFly = inWhich === "a" ? this.flyA : this.flyB;
			const outFly = outWhich === "a" ? this.flyA : this.flyB;
			if (inFly) inFly.style.zIndex = FLY_Z_FRONT;
			if (outFly) outFly.style.zIndex = FLY_Z_BACK;
		}, swapAt);
	}

	private stopCollisionAvoidance(clearTransforms: boolean) {
		if (this.collisionRaf) {
			window.cancelAnimationFrame(this.collisionRaf);
			this.collisionRaf = 0;
		}
		this.collisionIn = null;
		this.collisionOut = null;
		this.collisionUntil = 0;
		this.collisionAscendUntil = 0;
		this.collisionAscendStart = 0;
		this.collisionAxisReady = false;
		this.collisionAxisNx = 1;
		this.collisionAxisNy = 0;
		this.collisionPush = 0;
		this.collisionOffset = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
		if (clearTransforms && this.transition === "fly") {
			if (this.flyA) this.flyA.style.transform = "";
			if (this.flyB) this.flyB.style.transform = "";
		}
	}

	/**
	 * Soft AABB separation while one card rises and the other falls —
	 * CSS still drives left/top/size; we only nudge via translate3d.
	 */
	private startCollisionAvoidance(inWhich: FlyId, outWhich: FlyId) {
		if (this.transition !== "fly") return;
		this.stopCollisionAvoidance(true);
		this.collisionIn = inWhich;
		this.collisionOut = outWhich;
		const ascendMs = this.fadeMs;
		const descendMs = Math.max(80, Math.round(this.fadeMs * (2 / 3)));
		const handoffMs = Math.max(
			200,
			Math.min(420, Math.round(descendMs * 0.5)),
		);
		/*
		 * Descend finishes earlier — keep a ghost collider for the full ascend,
		 * but ease collision influence out in the second half so the riser
		 * lands on true center without a late translate snap.
		 */
		const now = performance.now();
		this.collisionAscendStart = now;
		this.collisionAscendUntil = now + ascendMs + 60;
		this.collisionUntil =
			this.collisionAscendUntil +
			Math.max(420, Math.round(handoffMs * 0.9));

		const tick = () => {
			this.collisionRaf = 0;
			if (this.closed || this.transition !== "fly") {
				this.stopCollisionAvoidance(true);
				return;
			}
			const inFly = inWhich === "a" ? this.flyA : this.flyB;
			const outFly = outWhich === "a" ? this.flyA : this.flyB;
			if (!inFly?.isConnected) {
				this.stopCollisionAvoidance(true);
				return;
			}
			/* Outgoing may already be opacity-0 at its slot — still use it as
			 * a ghost collider until the rising card finishes traveling. */
			if (!outFly?.isConnected) {
				this.stopCollisionAvoidance(true);
				return;
			}

			const t = performance.now();
			const ascendSpan = Math.max(
				1,
				this.collisionAscendUntil - this.collisionAscendStart,
			);
			const ascendU = Math.min(
				1,
				Math.max(0, (t - this.collisionAscendStart) / ascendSpan),
			);
			/* Last ~55% of the rise: smoothly release the sideways nudge. */
			let influence = 1;
			if (ascendU > 0.45) {
				const f = (ascendU - 0.45) / 0.55;
				influence = 1 - f * f * (3 - 2 * f);
			}
			const ascendDone = t >= this.collisionAscendUntil;
			const forceDecay = ascendDone || influence < 0.02;
			this.tickCollisionSeparation(
				inFly,
				outFly,
				inWhich,
				outWhich,
				forceDecay,
				forceDecay ? 0 : influence,
			);

			const oa = this.collisionOffset[inWhich];
			const settled = Math.hypot(oa.x, oa.y) < 0.25;
			/* Only clear once the riser has eased back onto true center. */
			if (forceDecay && settled) {
				this.stopCollisionAvoidance(true);
				return;
			}

			this.collisionRaf = window.requestAnimationFrame(tick);
		};
		this.collisionRaf = window.requestAnimationFrame(tick);
	}

	/** Layout box with collision translate stripped out (stable for overlap math). */
	private collisionLayoutBox(fly: HTMLElement, which: FlyId) {
		const r = fly.getBoundingClientRect();
		const o = this.collisionOffset[which];
		const left = r.left - o.x;
		const top = r.top - o.y;
		const right = r.right - o.x;
		const bottom = r.bottom - o.y;
		return {
			left,
			top,
			right,
			bottom,
			cx: (left + right) * 0.5,
			cy: (top + bottom) * 0.5,
			hw: (right - left) * 0.5,
			hh: (bottom - top) * 0.5,
		};
	}

	private applyCollisionOffset(fly: HTMLElement, which: FlyId) {
		const o = this.collisionOffset[which];
		if (Math.abs(o.x) < 0.05 && Math.abs(o.y) < 0.05) {
			o.x = 0;
			o.y = 0;
			fly.style.transform = "";
			return;
		}
		fly.style.transform = `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0)`;
	}

	private tickCollisionSeparation(
		inFly: HTMLElement,
		outFly: HTMLElement,
		inWhich: FlyId,
		outWhich: FlyId,
		forceDecay: boolean,
		influence = 1,
	) {
		let desiredPush = 0;
		const outGone = Number.parseFloat(outFly.style.opacity || "1") < 0.08;

		if (!forceDecay && influence > 0.001) {
			const a = this.collisionLayoutBox(inFly, inWhich);
			/* Ghost collider: even after the faller fades, its slot box still
			 * pushes the riser aside until ascend finishes. */
			const b = this.collisionLayoutBox(outFly, outWhich);
			let dx = a.cx - b.cx;
			let dy = a.cy - b.cy;
			let dist = Math.hypot(dx, dy);

			if (!this.collisionAxisReady) {
				if (dist > 1) {
					this.collisionAxisNx = dx / dist;
					this.collisionAxisNy = dy / dist;
				} else {
					/* Prefer a gentle horizontal dodge when centers coincide. */
					this.collisionAxisNx = 1;
					this.collisionAxisNy = 0;
				}
				this.collisionAxisReady = true;
			}

			const nx = this.collisionAxisNx;
			const ny = this.collisionAxisNy;
			const ra =
				a.hw * Math.abs(nx) + a.hh * Math.abs(ny) + COLLISION_PAD_PX * 0.5;
			const rb =
				b.hw * Math.abs(nx) + b.hh * Math.abs(ny) + COLLISION_PAD_PX * 0.5;
			const proj = (a.cx - b.cx) * nx + (a.cy - b.cy) * ny;
			const sep = ra + rb - Math.abs(proj);
			if (sep > 0) {
				/* Soft knee: ease into the push instead of a hard step. */
				const t = Math.min(1, sep / 90);
				const soft = t * t * (3 - 2 * t);
				desiredPush =
					Math.min(
						COLLISION_MAX_PUSH_PX,
						sep * COLLISION_PUSH_GAIN * soft,
					) * influence;
			}
		}

		const targetLerp = forceDecay
			? COLLISION_TARGET_LERP * 0.35
			: COLLISION_TARGET_LERP;
		this.collisionPush += (desiredPush - this.collisionPush) * targetLerp;
		if (Math.abs(this.collisionPush) < 0.05) this.collisionPush = 0;

		const nx = this.collisionAxisNx;
		const ny = this.collisionAxisNy;
		const push = this.collisionPush;
		const targetInX = nx * push;
		const targetInY = ny * push;

		const lerp = forceDecay
			? COLLISION_OFFSET_LERP * 0.35
			: COLLISION_OFFSET_LERP;
		const oi = this.collisionOffset[inWhich];
		oi.x += (targetInX - oi.x) * lerp;
		oi.y += (targetInY - oi.y) * lerp;
		this.applyCollisionOffset(inFly, inWhich);

		if (outGone || forceDecay) {
			const oo = this.collisionOffset[outWhich];
			oo.x = 0;
			oo.y = 0;
			/* Don't fight finishDescendRest / opacity handoff on the faller. */
		} else {
			const oo = this.collisionOffset[outWhich];
			oo.x += (-nx * push - oo.x) * lerp;
			oo.y += (-ny * push - oo.y) * lerp;
			this.applyCollisionOffset(outFly, outWhich);
		}
	}

	private clearFlyTimers(which: FlyId) {
		if (this.settleTimers[which]) {
			window.clearTimeout(this.settleTimers[which]);
			this.settleTimers[which] = 0;
		}
		if (this.restTimers[which]) {
			window.clearTimeout(this.restTimers[which]);
			this.restTimers[which] = 0;
		}
	}

	/** Put a collage tile back on the table (no-op if not in fly mode). */
	private showTile(index: number) {
		if (this.transition !== "fly" || index < 0) return;
		const tile = this.tiles[index];
		if (tile) tile.style.opacity = "1";
	}

	private hideTile(index: number) {
		if (this.transition !== "fly" || index < 0) return;
		const tile = this.tiles[index];
		if (tile) tile.style.opacity = "0";
	}

	/**
	 * Abort any in-flight settle/rest on a fly layer and restore its collage
	 * tile if a descend was interrupted mid-way (manual skip bug).
	 */
	private releaseFlyLayer(which: FlyId) {
		if (which === this.collisionIn || which === this.collisionOut) {
			this.stopCollisionAvoidance(true);
		}
		const owned = this.flyOwnedIndex[which];
		const hadRest = this.restTimers[which] !== 0;
		this.clearFlyTimers(which);
		if (hadRest && owned >= 0) {
			this.showTile(owned);
		}
		this.flyOwnedIndex[which] = -1;

		const isA = which === "a";
		const fly = isA ? this.flyA : this.flyB;
		const motion = isA ? this.motionA : this.motionB;
		if (fly) {
			fly.style.opacity = "0";
			fly.style.transform = "";
			fly.style.zIndex = FLY_Z_IDLE;
			this.clearKenBurns(fly);
		}
		if (motion) removeAuraLayer(motion);
	}

	/**
	 * Classic crossfade look (dissolve / zoom / slide): both layers stay
	 * pinned at FOCUS_RECT, only opacity + transform animate.
	 */
	private applyClassicState(
		fly: HTMLElement,
		state: "enter-from" | "enter-to" | "exit",
	) {
		if (state === "enter-to") {
			fly.style.opacity = "1";
			fly.style.transform = "translate3d(0, 0, 0) scale(1)";
			return;
		}
		fly.style.opacity = "0";
		fly.style.transform = this.classicTransform(
			state === "enter-from" ? "in-from" : "out-to",
		);
	}

	private classicTransform(dir: "in-from" | "out-to"): string {
		if (this.transition === "zoom") {
			return dir === "in-from" ? "scale(1.08)" : "scale(0.92)";
		}
		if (this.transition === "slide") {
			return dir === "in-from"
				? "translate3d(3%, 0, 0)"
				: "translate3d(-3%, 0, 0)";
		}
		return "translate3d(0, 0, 0) scale(1)";
	}

	/**
	 * Lift a photo into the focused, large view. In "fly" mode this rises from
	 * its collage slot; otherwise it crossfades in place at FOCUS_RECT using
	 * the classic dissolve/zoom/slide look.
	 */
	private ascend(
		which: FlyId,
		index: number,
		instant = false,
		startInBack = false,
	) {
		const isA = which === "a";
		const fly = isA ? this.flyA : this.flyB;
		const motion = isA ? this.motionA : this.motionB;
		const img = isA ? this.imgA : this.imgB;
		const slide = this.slides[index];
		if (!fly || !motion || !img || !slide) return;

		// Reusing this layer cancels an unfinished descend — put that photo
		// back on the table so the slot doesn't stay empty.
		this.releaseFlyLayer(which);
		this.flyOwnedIndex[which] = index;

		const isFly = this.transition === "fly";
		const slot = isFly ? this.collageRects[index] ?? FOCUS_RECT : FOCUS_RECT;
		this.hideTile(index);

		this.clearKenBurns(fly);
		img.src = slide.src;
		img.alt = slide.label ?? "";

		/* Crossing: start behind the outgoing card; alone: stay in front. */
		fly.style.zIndex = startInBack ? FLY_Z_BACK : FLY_Z_FRONT;

		// Place instantly at the slot (invisible jump), then transition to focus.
		fly.style.transition = "none";
		this.applyPercentRect(fly, slot);
		if (isFly) {
			fly.style.opacity = "1";
			fly.style.transform = "";
		} else {
			this.applyClassicState(fly, "enter-from");
		}
		void fly.offsetWidth;

		if (instant) {
			fly.style.setProperty(
				"--intuition-fly-fade",
				`${Math.round(this.fadeMs * 0.6)}ms`,
			);
		} else {
			fly.style.removeProperty("--intuition-fly-fade");
		}
		const ascendMs = instant
			? Math.round(this.fadeMs * 0.6)
			: this.fadeMs;
		fly.style.transition = flyMotionTransition(ascendMs, !isFly);
		if (isFly) {
			this.applyPercentRect(fly, FOCUS_RECT);
		} else {
			this.applyClassicState(fly, "enter-to");
		}

		void this.refreshSlideFx(motion, img, slide.src);

		const settleDelay = ascendMs;
		this.settleTimers[which] = window.setTimeout(() => {
			this.settleTimers[which] = 0;
			if (this.closed) return;
			fly.style.removeProperty("--intuition-fly-fade");
			fly.style.transition = "";
			if (this.kenBurnsStrength > 0) {
				void this.applyKenBurns(fly, motion, img, index);
			}
		}, settleDelay + 30);
	}

	/**
	 * Retire a photo out of the focused view. In "fly" mode it descends back
	 * into its collage slot; otherwise it crossfades out in place.
	 */
	private descend(which: FlyId, index: number) {
		const isA = which === "a";
		const fly = isA ? this.flyA : this.flyB;
		const motion = isA ? this.motionA : this.motionB;
		if (!fly || !motion) return;

		// Drop settle KB timer only — keep ownership until rest finishes.
		if (this.settleTimers[which]) {
			window.clearTimeout(this.settleTimers[which]);
			this.settleTimers[which] = 0;
		}
		if (this.restTimers[which]) {
			window.clearTimeout(this.restTimers[which]);
			this.restTimers[which] = 0;
			const prev = this.flyOwnedIndex[which];
			if (prev >= 0 && prev !== index) this.showTile(prev);
		}

		this.flyOwnedIndex[which] = index;
		this.clearKenBurns(fly);
		/* Descend is 50% faster than ascend (⅔ of the fade duration). */
		const descendMs = Math.max(80, Math.round(this.fadeMs * (2 / 3)));
		fly.style.setProperty("--intuition-fly-fade", `${descendMs}ms`);
		/* Outgoing starts in front; mid-cross swap puts the riser ahead. */
		fly.style.zIndex = FLY_Z_FRONT;

		const isFly = this.transition === "fly";
		fly.style.transition = flyMotionTransition(descendMs, !isFly);
		void fly.offsetWidth;
		if (isFly) {
			const slot = this.collageRects[index] ?? FOCUS_RECT;
			this.applyPercentRect(fly, slot);
		} else {
			this.applyClassicState(fly, "exit");
		}

		this.restTimers[which] = window.setTimeout(() => {
			this.restTimers[which] = 0;
			if (this.closed) return;

			if (isFly) {
				/* Soft handoff: tile is dimmed by the collage; ease the bright
				 * fly away instead of popping straight to the dull slot. */
				const handoffMs = Math.max(200, Math.min(420, Math.round(descendMs * 0.5)));
				this.showTile(index);
				fly.style.transition = `opacity ${handoffMs}ms ${FLY_EASE_IN_OUT}`;
				void fly.offsetWidth;
				fly.style.opacity = "0";
				this.restTimers[which] = window.setTimeout(() => {
					this.restTimers[which] = 0;
					if (this.closed) return;
					this.finishDescendRest(which, index, fly, motion);
				}, handoffMs + 30);
				return;
			}

			this.finishDescendRest(which, index, fly, motion);
		}, descendMs + 40);
	}

	private finishDescendRest(
		which: FlyId,
		index: number,
		fly: HTMLElement,
		motion: HTMLElement,
	) {
		/* Leave the layer parked on its slot as a ghost collider for the riser. */
		this.collisionOffset[which] = { x: 0, y: 0 };
		fly.style.opacity = "0";
		fly.style.transform = "";
		fly.style.transition = "";
		fly.style.zIndex = FLY_Z_IDLE;
		fly.style.removeProperty("--intuition-fly-fade");
		this.showTile(index);
		if (this.flyOwnedIndex[which] === index) {
			this.flyOwnedIndex[which] = -1;
		}
		removeAuraLayer(motion);
	}

	private applyPercentRect(el: HTMLElement, rect: PercentRect) {
		el.style.left = `${rect.left}%`;
		el.style.top = `${rect.top}%`;
		el.style.width = `${rect.width}%`;
		el.style.height = `${rect.height}%`;
	}

	/**
	 * Fit the collage "table" fully inside the stage with padding (esp. top/bottom).
	 * Works for tiny (3 photos) and huge boards: contain-scale into the padded area,
	 * then place tiles in board-local % so aspect ratios stay correct.
	 * Slot rects for fly animations are stored as % of the stage.
	 */
	private relayoutCollage() {
		const stage = this.stageEl;
		const board = this.collageBoard;
		if (!stage || !board || this.slides.length === 0) return;

		const stageW = Math.max(
			1,
			stage.clientWidth || stage.getBoundingClientRect().width,
		);
		const stageH = Math.max(
			1,
			stage.clientHeight || stage.getBoundingClientRect().height,
		);
		if (stageW < 2 || stageH < 2) return;

		const n = this.slides.length;
		const hasFullLayout = this.slides.every(
			(s) =>
				Number.isFinite(s.x) &&
				Number.isFinite(s.y) &&
				Number.isFinite(s.width) &&
				Number.isFinite(s.height) &&
				(s.width as number) > 0 &&
				(s.height as number) > 0,
		);

		let items: { x: number; y: number; width: number; height: number }[];
		if (hasFullLayout) {
			items = this.slides.map((s) => ({
				x: s.x as number,
				y: s.y as number,
				width: s.width as number,
				height: s.height as number,
			}));
		} else {
			const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
			const rows = Math.max(1, Math.ceil(n / cols));
			const cell = 200;
			const gap = 16;
			items = this.slides.map((_, i) => {
				const r = Math.floor(i / cols);
				const c = i % cols;
				return {
					x: c * (cell + gap),
					y: r * (cell + gap),
					width: cell,
					height: cell,
				};
			});
		}

		const box = boundingBox(items);
		const availW = stageW * (1 - 2 * COLLAGE_PAD_X);
		const availH = stageH * (1 - 2 * COLLAGE_PAD_Y);
		const scale = Math.min(availW / box.width, availH / box.height);
		const boardW = Math.max(1, box.width * scale);
		const boardH = Math.max(1, box.height * scale);
		const boardLeft = (stageW - boardW) / 2;
		const boardTop = (stageH - boardH) / 2;

		board.style.left = `${(boardLeft / stageW) * 100}%`;
		board.style.top = `${(boardTop / stageH) * 100}%`;
		board.style.width = `${(boardW / stageW) * 100}%`;
		board.style.height = `${(boardH / stageH) * 100}%`;
		board.style.right = "auto";
		board.style.bottom = "auto";

		this.collageRects = items.map((it, i) => {
			const tileLeft = (it.x - box.x) * scale;
			const tileTop = (it.y - box.y) * scale;
			const tileW = Math.max(1, it.width * scale);
			const tileH = Math.max(1, it.height * scale);

			const tile = this.tiles[i];
			if (tile) {
				// Board-local % — board matches canvas bbox aspect, so AR stays correct.
				tile.style.left = `${(tileLeft / boardW) * 100}%`;
				tile.style.top = `${(tileTop / boardH) * 100}%`;
				tile.style.width = `${(tileW / boardW) * 100}%`;
				tile.style.height = `${(tileH / boardH) * 100}%`;
			}

			// Stage-local % for fly start/end matching the on-screen slot.
			return {
				left: ((boardLeft + tileLeft) / stageW) * 100,
				top: ((boardTop + tileTop) / stageH) * 100,
				width: (tileW / stageW) * 100,
				height: (tileH / stageH) * 100,
			};
		});
	}

	private activeTiltCards(): VibeCard[] {
		const cards: VibeCard[] = [];
		for (const fly of [this.flyA, this.flyB]) {
			if (!fly?.isConnected) continue;
			if (Number.parseFloat(getComputedStyle(fly).opacity || "0") < 0.12) {
				continue;
			}
			const photo = fly.querySelector(`.${ROOT_CLS}__photo`);
			if (photo instanceof HTMLElement) {
				cards.push({ el: photo, kind: "media" });
			}
		}
		return cards;
	}

	private async refreshSlideFx(
		host: HTMLElement,
		img: HTMLImageElement,
		seed: string,
	) {
		const gen = ++this.auraGen;
		try {
			await waitForImage(img);
			if (this.closed || gen !== this.auraGen) return;
			const palette = extractPalette(img);
			this.applyPaletteBackground(palette);
			if (!this.aurasEnabled) {
				removeAuraLayer(host);
				return;
			}
			paintAuraLayer(host, {
				color: palette?.[0] ?? "#7a6bb5",
				palette: palette ?? undefined,
				strength: 48,
				size: 100,
				seed,
				shimmer: true,
			});
		} catch {
			if (this.closed || gen !== this.auraGen) return;
			this.applyPaletteBackground(null);
			if (!this.aurasEnabled) {
				removeAuraLayer(host);
				return;
			}
			paintAuraLayer(host, {
				color: "#7a6bb5",
				strength: 42,
				size: 96,
				seed,
				shimmer: true,
			});
		}
	}

	private applyPaletteBackground(palette: string[] | null) {
		if (!this.root || !this.paletteBg) {
			this.root?.style.removeProperty("--intuition-present-c1");
			this.root?.style.removeProperty("--intuition-present-c2");
			this.root?.style.removeProperty("--intuition-present-c3");
			return;
		}
		const c1 = palette?.[0] ?? "#2a2438";
		const c2 = palette?.[1] ?? palette?.[0] ?? "#1a1524";
		const c3 = palette?.[2] ?? "#0a0a0b";
		this.root.style.setProperty("--intuition-present-c1", c1);
		this.root.style.setProperty("--intuition-present-c2", c2);
		this.root.style.setProperty("--intuition-present-c3", c3);
	}

	private async applyKenBurns(
		fly: HTMLElement,
		motion: HTMLElement,
		img: HTMLImageElement,
		index: number,
	) {
		await waitForImage(img);
		if (this.closed) return;
		const amp = this.kenBurnsAmplitude(img);
		if (amp <= 0.01) {
			this.clearKenBurns(fly);
			return;
		}
		const variant = KEN_BURNS_VARIANTS[index % KEN_BURNS_VARIANTS.length]!;
		const dur = this.intervalMs + this.fadeMs + 80;
		// Start from identity so enabling KB after fly-settle doesn't snap zoom.
		motion.style.transform = "scale(1) translate(0%, 0%)";
		motion.style.animationName = "";
		motion.style.setProperty("--intuition-kb-amp", amp.toFixed(3));
		fly.classList.add(variant);
		// Force a style flush, then clear inline transform so the keyframe
		// `from { scale(1) }` takes over with no discontinuity.
		void motion.offsetWidth;
		motion.style.transform = "";
		motion.style.animationDuration = `${dur}ms`;
		motion.style.animationTimingFunction = "linear";
		motion.style.animationFillMode = "forwards";
	}

	/** Portrait → weaker zoom; landscape → stronger. Strength 0–100 scales overall. */
	private kenBurnsAmplitude(img: HTMLImageElement): number {
		const base = this.kenBurnsStrength / 100;
		if (base <= 0) return 0;
		const w = img.naturalWidth || 1;
		const h = img.naturalHeight || 1;
		const ar = w / h;
		let aspectMul = 1;
		if (ar < 0.85) aspectMul = 0.55; // portrait / tall
		else if (ar > 1.25) aspectMul = 1.2; // landscape
		return Math.min(1.35, Math.max(0, base * aspectMul));
	}

	private clearKenBurns(fly: HTMLElement) {
		for (const v of KEN_BURNS_VARIANTS) fly.classList.remove(v);
		const motion = fly.querySelector(`.${ROOT_CLS}__motion`);
		if (motion instanceof HTMLElement) {
			motion.style.animationDuration = "";
			motion.style.animationName = "";
			motion.style.transform = "";
			motion.style.removeProperty("--intuition-kb-amp");
		}
	}

	private shuffleSlidesInPlace(list: PresentationSlide[]) {
		// Fisher–Yates shuffle (random order per start call).
		for (let i = list.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[list[i], list[j]] = [list[j], list[i]];
		}
	}

	/** Keep sticky audio visible inside OS fullscreen (only descendants of the FS element show). */
	private adoptStickyPlayer(host: HTMLElement, root: HTMLElement) {
		const sticky = host.querySelector<HTMLElement>(
			"[data-intuition-sticky-audio]",
		);
		if (!sticky || sticky.parentElement === root) return;
		this.stickyHome = sticky.parentElement;
		this.adoptedSticky = sticky;
		sticky.classList.add("intuition-sticky-audio--in-presentation");
		root.appendChild(sticky);
	}

	private restoreStickyPlayer() {
		const sticky = this.adoptedSticky;
		const home = this.stickyHome;
		if (sticky) {
			sticky.classList.remove("intuition-sticky-audio--in-presentation");
			if (home?.isConnected) home.appendChild(sticky);
		}
		this.adoptedSticky = null;
		this.stickyHome = null;
	}

	/** Hide OS taskbar + Obsidian chrome via native Fullscreen API. */
	private async enterNativeFullscreen(el: HTMLElement) {
		const anyEl = el as HTMLElement & {
			requestFullscreen?: () => Promise<void>;
			webkitRequestFullscreen?: () => void;
		};
		try {
			if (typeof anyEl.requestFullscreen === "function") {
				await anyEl.requestFullscreen();
				this.fullscreenActive = true;
				return;
			}
			if (typeof anyEl.webkitRequestFullscreen === "function") {
				anyEl.webkitRequestFullscreen();
				this.fullscreenActive = true;
			}
		} catch {
			/* Denied / no user gesture — keep CSS fixed overlay fallback. */
			this.fullscreenActive = false;
		}
	}

	private async exitNativeFullscreen() {
		if (!this.fullscreenActive) return;
		this.fullscreenActive = false;
		const doc = document as Document & {
			exitFullscreen?: () => Promise<void>;
			webkitExitFullscreen?: () => void;
			webkitFullscreenElement?: Element;
		};
		const fs = document.fullscreenElement ?? doc.webkitFullscreenElement;
		if (!fs) return;
		try {
			if (typeof doc.exitFullscreen === "function") {
				await doc.exitFullscreen();
			} else if (typeof doc.webkitExitFullscreen === "function") {
				doc.webkitExitFullscreen();
			}
		} catch {
			/* ignore */
		}
	}
}
