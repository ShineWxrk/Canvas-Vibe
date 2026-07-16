/** Full-viewport photo presentation: transitions, Ken Burns, auras, sparkles. */

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
	settings?: Partial<PresentationSettings>;
	/** Sparkle base config from plugin vibe settings. */
	sparklesConfig?: Partial<VibeSparkleConfig> | null;
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

const TX_CLASSES = [
	`${ROOT_CLS}__layer--tx-prep`,
	`${ROOT_CLS}__layer--tx-zoom-out`,
	`${ROOT_CLS}__layer--tx-slide-out`,
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
	private fadeMs = DEFAULT_PRESENTATION_SETTINGS.fadeMs;
	private intervalMs = DEFAULT_PRESENTATION_SETTINGS.intervalSec * 1000;
	private kenBurnsStrength = DEFAULT_PRESENTATION_SETTINGS.kenBurnsStrength;
	private aurasEnabled = true;
	private sparklesEnabled = true;
	private paletteBg = true;
	private transition: PresentationTransition = "dissolve";
	private onClose: (() => void) | null = null;
	private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
	private closed = true;
	private auraGen = 0;
	private sparkles: VibeSparkleController | null = null;
	private tilt: VibeTiltController | null = null;
	private sparkleAnchor: HTMLElement | null = null;
	private hostEl: HTMLElement | null = null;
	private kbClearTimer = 0;
	private sparklesConfig: Partial<VibeSparkleConfig> | null = null;
	private tiltStrength = 50;
	/** True when we successfully entered native OS fullscreen for this run. */
	private fullscreenActive = false;
	private onFullscreenChange: (() => void) | null = null;
	/** Sticky player reparented into fullscreen root for the duration of the show. */
	private adoptedSticky: HTMLElement | null = null;
	private stickyHome: HTMLElement | null = null;

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

		const cfg = normalizePresentationSettings(options.settings);
		if (cfg.shuffle) this.shuffleSlidesInPlace(this.slides);
		this.intervalMs = Math.round(cfg.intervalSec * 1000);
		this.fadeMs = cfg.fadeMs;
		this.kenBurnsStrength = cfg.kenBurnsStrength;
		this.aurasEnabled = cfg.auras;
		this.sparklesEnabled = cfg.sparkles;
		this.paletteBg = cfg.paletteBg;
		this.transition = normalizePresentationTransition(cfg.transition);
		this.sparklesConfig = options.sparklesConfig ?? null;
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
		root.dataset.transition = this.transition;
		root.classList.toggle(`${ROOT_CLS}--palette-bg`, this.paletteBg);
		root.classList.toggle(`${ROOT_CLS}--vignette`, cfg.vignette);
		root.classList.toggle(`${ROOT_CLS}--letterbox`, cfg.letterbox);
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
			const sparkleBase = normalizeSparkleConfig(
				this.sparklesConfig ?? DEFAULT_SPARKLE_CONFIG,
			);
			this.sparkles.setConfig({
				...sparkleBase,
				amount: Math.min(500, Math.round(sparkleBase.amount * 2.4)),
				frequency: Math.min(200, Math.round(sparkleBase.frequency * 2.0)),
				size: Math.min(48, Math.round(sparkleBase.size * 1.2)),
				opacity: Math.min(100, Math.round(sparkleBase.opacity * 1.05)),
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
		if (this.kbClearTimer) {
			window.clearTimeout(this.kbClearTimer);
			this.kbClearTimer = 0;
		}
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
			this.clearLayerTransition(this.layerA);
			this.clearLayerTransition(this.layerB);
			this.imgA.src = slide.src;
			this.imgA.alt = slide.label ?? "";
			this.layerA.classList.add(`${ROOT_CLS}__layer--in`);
			this.layerA.classList.remove(`${ROOT_CLS}__layer--out`);
			this.layerB.classList.add(`${ROOT_CLS}__layer--out`);
			this.layerB.classList.remove(`${ROOT_CLS}__layer--in`);
			this.layerA.style.opacity = "1";
			this.layerA.style.transform = "";
			this.layerB.style.opacity = "0";
			this.layerB.style.transform = "";
			if (this.kenBurnsStrength > 0) {
				void this.applyKenBurns(this.layerA, this.motionA, this.imgA, index);
			}
			void this.refreshSlideFx(this.motionA, this.imgA, slide.src);
			this.usingA = true;
		} else {
			const incomingImg = this.usingA ? this.imgB : this.imgA;
			const incomingLayer = this.usingA ? this.layerB : this.layerA;
			const incomingMotion = this.usingA ? this.motionB : this.motionA;
			const outgoingLayer = this.usingA ? this.layerA : this.layerB;

			this.freezeKenBurns(outgoingLayer);
			this.clearKenBurns(incomingLayer);

			incomingImg.src = slide.src;
			incomingImg.alt = slide.label ?? "";
			incomingLayer.classList.add(`${ROOT_CLS}__layer--in`);
			incomingLayer.classList.remove(`${ROOT_CLS}__layer--out`);
			outgoingLayer.classList.add(`${ROOT_CLS}__layer--out`);
			outgoingLayer.classList.remove(`${ROOT_CLS}__layer--in`);

			this.runTransition(incomingLayer, outgoingLayer);

			if (this.kenBurnsStrength > 0) {
				void this.applyKenBurns(
					incomingLayer,
					incomingMotion,
					incomingImg,
					index,
				);
			}
			void this.refreshSlideFx(incomingMotion, incomingImg, slide.src);
			this.usingA = !this.usingA;

			this.kbClearTimer = window.setTimeout(() => {
				this.kbClearTimer = 0;
				if (this.closed) return;
				this.clearKenBurns(outgoingLayer);
				this.clearLayerTransition(outgoingLayer);
			}, this.fadeMs + 40);
		}

		this.index = index;

		if (this.metaEl) {
			const label = slide.label ? ` · ${slide.label}` : "";
			this.metaEl.textContent = `${index + 1} / ${this.slides.length}${label}`;
		}
	}

	private runTransition(incoming: HTMLElement, outgoing: HTMLElement) {
		this.clearLayerTransition(incoming);
		this.clearLayerTransition(outgoing);
		const fade = `${this.fadeMs}ms`;
		incoming.style.transition = "none";
		outgoing.style.transition = `opacity ${fade} ease, transform ${fade} ease`;

		if (this.transition === "zoom") {
			incoming.classList.add(`${ROOT_CLS}__layer--tx-prep`);
			incoming.style.opacity = "0";
			incoming.style.transform = "scale(1.08)";
		} else if (this.transition === "slide") {
			incoming.classList.add(`${ROOT_CLS}__layer--tx-prep`);
			incoming.style.opacity = "0";
			incoming.style.transform = "translateX(7%)";
		} else {
			incoming.style.opacity = "0";
			incoming.style.transform = "";
		}

		void incoming.offsetWidth;

		incoming.style.transition = `opacity ${fade} ease, transform ${fade} ease`;
		incoming.style.opacity = "1";
		incoming.style.transform = "none";
		incoming.classList.remove(`${ROOT_CLS}__layer--tx-prep`);

		outgoing.style.opacity = "0";
		if (this.transition === "zoom") {
			outgoing.classList.add(`${ROOT_CLS}__layer--tx-zoom-out`);
			outgoing.style.transform = "scale(0.94)";
		} else if (this.transition === "slide") {
			outgoing.classList.add(`${ROOT_CLS}__layer--tx-slide-out`);
			outgoing.style.transform = "translateX(-6%)";
		} else {
			outgoing.style.transform = "";
		}
	}

	private clearLayerTransition(layer: HTMLElement) {
		for (const c of TX_CLASSES) layer.classList.remove(c);
		layer.style.transition = "";
		layer.style.transform = "";
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
				strength: 42,
				size: 88,
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
				strength: 36,
				size: 84,
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
		layer: HTMLElement,
		motion: HTMLElement,
		img: HTMLImageElement,
		index: number,
	) {
		await waitForImage(img);
		if (this.closed) return;
		const amp = this.kenBurnsAmplitude(img);
		if (amp <= 0.01) {
			this.clearKenBurns(layer);
			return;
		}
		const variant = KEN_BURNS_VARIANTS[index % KEN_BURNS_VARIANTS.length]!;
		const dur = this.intervalMs + this.fadeMs + 80;
		motion.style.transform = "";
		motion.style.animationName = "";
		motion.style.setProperty("--intuition-kb-amp", amp.toFixed(3));
		layer.classList.add(variant);
		motion.style.animationDuration = `${dur}ms`;
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
