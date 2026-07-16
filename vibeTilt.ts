/** Near-cursor vibe: 3D tilt for media; text glow on hover over glyphs only. */

const GLARE_CLS = "intuition-vibe-glare";
const TILTING_ATTR = "data-intuition-vibe-tilting";
const TEXT_GLOW_ATTR = "data-intuition-vibe-text";
const FILTER_ATTR = "data-intuition-vibe-filter";
/** Full strength ±9° at slider 100%. */
const MAX_TILT_DEG = 9;
/** Media near-cursor falloff (screen px from edge). */
const NEAR_PX = 280;
const HOOK_ATTR = "data-intuition-vibe-hook";

export type VibeCardKind = "text" | "media";

export interface VibeCard {
	el: HTMLElement;
	kind: VibeCardKind;
}

type SuspendCheck = () => boolean;
type CardsProvider = () => VibeCard[];
type ZoomProvider = () => number;

/**
 * Progressive tilt budget by canvas zoom:
 * near → all, mid → 5, overview → 4.
 */
function maxMediaTiltsForZoom(zoom: number): number {
	if (zoom >= 0.85) return Number.POSITIVE_INFINITY;
	if (zoom >= 0.45) return 5;
	return 4;
}

export class VibeTiltController {
	private enabled = false;
	/** 0–1 tilt + media glare */
	private strength = 0.8;
	/** 0–1 text glow on glyph hover */
	private textStrength = 0.25;
	private root: HTMLElement | null = null;
	private getSuspended: SuspendCheck = () => false;
	private getSelectionCount: () => number = () => 0;
	private getCards: CardsProvider = () => this.fallbackCards();
	private getZoom: ZoomProvider = () => 1;
	private dragging = false;
	private raf = 0;
	private lastX = 0;
	private lastY = 0;
	private onMove: ((e: PointerEvent) => void) | null = null;
	private onDown: ((e: PointerEvent) => void) | null = null;
	private onUp: (() => void) | null = null;
	private onLeave: (() => void) | null = null;
	/** When true, don't toggle body/leaf vibe classes (presentation overlay). */
	private isolateGlobalClass = false;
	private glareEnabled = true;
	/** Reacts to is-selected/is-focused toggles independent of pointer events —
	 * catches selection made via click-through on media controls, keyboard,
	 * or any path that never reaches our pointerdown listener. */
	private selectionObserver: MutationObserver | null = null;

	attach(
		root: HTMLElement,
		opts: {
			getSuspended: SuspendCheck;
			getSelectionCount: () => number;
			getCards?: CardsProvider;
			getZoom?: ZoomProvider;
			isolateGlobalClass?: boolean;
			glareEnabled?: boolean;
		},
	) {
		this.root = root;
		this.getSuspended = opts.getSuspended;
		this.getSelectionCount = opts.getSelectionCount;
		if (opts.getCards) this.getCards = opts.getCards;
		if (opts.getZoom) this.getZoom = opts.getZoom;
		this.isolateGlobalClass = !!opts.isolateGlobalClass;
		this.glareEnabled = opts.glareEnabled !== false;

		if (root.getAttribute(HOOK_ATTR) === "1") return;
		root.setAttribute(HOOK_ATTR, "1");

		this.onMove = (e: PointerEvent) => {
			this.lastX = e.clientX;
			this.lastY = e.clientY;
			if (!this.enabled) return;
			if (this.raf) return;
			this.raf = window.requestAnimationFrame(() => {
				this.raf = 0;
				this.tick(this.lastX, this.lastY);
			});
		};

		this.onDown = (e: PointerEvent) => {
			if (!this.enabled) return;
			const t = e.target as HTMLElement | null;
			if (!t) return;
			const cursor = window.getComputedStyle(t).cursor.toLowerCase();
			if (
				cursor.includes("resize") ||
				cursor.includes("nwse") ||
				cursor.includes("nesw") ||
				cursor.includes("ew-") ||
				cursor.includes("ns-")
			) {
				this.clearAllEffects();
				return;
			}
			if (t.closest(".canvas-node")) {
				this.dragging = true;
				this.clearAllEffects();
			}
		};

		this.onUp = () => {
			this.dragging = false;
		};

		this.onLeave = () => {
			if (this.enabled) this.clearAllEffects();
		};

		root.addEventListener("pointermove", this.onMove, { passive: true });
		/**
		 * Capture phase: media nodes (audio/image) can have inner handlers
		 * (native <audio> controls, Obsidian's own node click handling) that
		 * stop propagation before a bubble-phase listener on `root` would ever
		 * see the click. Capture fires on the way down, before that can happen,
		 * so selecting a media node reliably clears any in-flight tilt/glare.
		 */
		root.addEventListener("pointerdown", this.onDown, {
			passive: true,
			capture: true,
		});
		window.addEventListener("pointerup", this.onUp, { passive: true });
		root.addEventListener("pointerleave", this.onLeave, { passive: true });

		/**
		 * Belt-and-suspenders: also react directly to the is-selected/is-focused
		 * class toggle Obsidian applies to `.canvas-node`. This covers selection
		 * that never fires a pointerdown on `root` at all (keyboard selection,
		 * programmatic selection, or a stopped-propagation click) and guarantees
		 * tilt is zeroed the instant a node becomes selected — no pointermove
		 * needed to "catch up".
		 */
		if (typeof MutationObserver !== "undefined") {
			this.selectionObserver = new MutationObserver((mutations) => {
				for (const m of mutations) {
					const target = m.target as HTMLElement;
					if (!target.classList?.contains("canvas-node")) continue;
					if (
						target.classList.contains("is-selected") ||
						target.classList.contains("is-focused")
					) {
						this.disableTiltForNode(target);
					}
				}
			});
			this.selectionObserver.observe(root, {
				attributes: true,
				attributeFilter: ["class"],
				subtree: true,
			});
		}
	}

	/** Immediately zero tilt/glare/text-glow for one canvas node (selection path). */
	private disableTiltForNode(node: HTMLElement) {
		const container =
			(node.querySelector(".canvas-node-container") as HTMLElement | null) ??
			node;
		this.resetCard(container);
		this.resetTextGlow(node);
	}

	/** Selected/focused nodes are being manipulated by the user — no tilt/glow.
	 * Walk up to the actual `.canvas-node` in case the tracked element is a
	 * descendant/wrapper rather than the node itself. */
	private isNodeSelected(node: HTMLElement): boolean {
		const canvasNodeEl =
			(node.closest(".canvas-node") as HTMLElement | null) ?? node;
		return (
			canvasNodeEl.classList.contains("is-selected") ||
			canvasNodeEl.classList.contains("is-focused")
		);
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		if (this.root) {
			this.root.classList.toggle("intuition-canvas-vibe", on);
			if (!this.isolateGlobalClass) {
				this.root
					.closest(".workspace-leaf-content")
					?.classList.toggle("intuition-canvas-vibe", on);
				document.body.classList.toggle("intuition-canvas-vibe", on);
			}
		} else if (!this.isolateGlobalClass) {
			document.body.classList.toggle("intuition-canvas-vibe", on);
		}
		if (!on) this.clearAllEffects();
	}

	/** strengthPercent: 0–100 — media tilt + glare */
	setStrength(strengthPercent: number) {
		this.strength = Math.min(1, Math.max(0, strengthPercent / 100));
		if (this.strength <= 0.01 && this.textStrength <= 0.01) this.clearAllEffects();
		else if (this.enabled && this.lastX && this.lastY) {
			this.tick(this.lastX, this.lastY);
		}
	}

	setZoom(zoom: number) {
		// Kept for call sites; live zoom comes from getZoom each tick.
		void zoom;
	}

	private liveZoom(): number {
		const z = this.getZoom();
		return typeof z === "number" && Number.isFinite(z) && z > 0 ? z : 1;
	}

	/** strengthPercent: 0–100 — text glow on glyph hover */
	setTextStrength(strengthPercent: number) {
		this.textStrength = Math.min(1, Math.max(0, strengthPercent / 100));
		if (this.strength <= 0.01 && this.textStrength <= 0.01) this.clearAllEffects();
		else if (this.enabled && this.lastX && this.lastY) {
			this.tick(this.lastX, this.lastY);
		}
	}

	isEnabled() {
		return this.enabled;
	}

	destroy() {
		this.selectionObserver?.disconnect();
		this.selectionObserver = null;
		if (this.root && this.onMove) {
			this.root.removeEventListener("pointermove", this.onMove);
			if (this.onDown) {
				this.root.removeEventListener("pointerdown", this.onDown, {
					capture: true,
				});
			}
			if (this.onLeave) this.root.removeEventListener("pointerleave", this.onLeave);
			this.root.removeAttribute(HOOK_ATTR);
			this.root.classList.remove("intuition-canvas-vibe");
		}
		if (this.onUp) window.removeEventListener("pointerup", this.onUp);
		if (!this.isolateGlobalClass) {
			document.body.classList.remove("intuition-canvas-vibe");
			this.root
				?.closest(".workspace-leaf-content")
				?.classList.remove("intuition-canvas-vibe");
		}
		this.root?.classList.remove("intuition-canvas-vibe");
		this.clearAllEffects();
		this.root = null;
		this.enabled = false;
	}

	private fallbackCards(): VibeCard[] {
		if (!this.root) return [];
		const out: VibeCard[] = [];
		const seen = new Set<HTMLElement>();

		const push = (el: HTMLElement, kind: VibeCardKind) => {
			if (seen.has(el) || el.classList.contains("is-group")) return;
			seen.add(el);
			out.push({ el, kind });
		};

		this.root
			.querySelectorAll<HTMLElement>(
				".canvas-node.is-text, .canvas-node[data-intuition-plain], .canvas-node[data-intuition-text-align]",
			)
			.forEach((el) => push(el, "text"));

		this.root.querySelectorAll<HTMLElement>(".canvas-node").forEach((el) => {
			if (seen.has(el) || el.classList.contains("is-group")) return;
			const hasImg = !!el.querySelector("img, .media-embed, .image-embed");
			const hasText =
				!!el.querySelector(
					".markdown-preview-view, .markdown-source-view, .cm-editor, .cm-content",
				) || el.classList.contains("is-text");
			if (hasText && !hasImg) push(el, "text");
			else if (hasImg) push(el, "media");
		});

		return out;
	}

	private tick(clientX: number, clientY: number) {
		if (!this.root || !this.enabled) return;
		const zoom = this.liveZoom();
		if (this.strength <= 0.01 && this.textStrength <= 0.01) {
			this.clearAllEffects();
			return;
		}
		if (
			this.dragging ||
			this.getSuspended() ||
			this.getSelectionCount() > 1 ||
			this.root.classList.contains("is-dragging") ||
			this.root.classList.contains("intuition-canvas-panning") ||
			this.root.classList.contains("intuition-canvas-zoom-settling") ||
			this.root.querySelector(".canvas-node.is-dragging, .canvas-node.is-resizing")
		) {
			this.clearAllEffects();
			return;
		}

		const cards = this.getCards();
		const nearPx = Math.max(56, NEAR_PX * Math.min(1, zoom / 0.9));
		const maxTilts = maxMediaTiltsForZoom(zoom);
		type MediaHit = {
			container: HTMLElement;
			influence: number;
			nx: number;
			ny: number;
			cardStrength: number;
		};
		const hits: MediaHit[] = [];
		const keep = new Set<HTMLElement>();

		for (const card of cards) {
			const { el: node, kind } = card;
			const isSelected = this.isNodeSelected(node);

			if (kind === "text") {
				if (
					!isSelected &&
					this.textStrength > 0.01 &&
					this.isPointerOverTextGlyphs(node, clientX, clientY)
				) {
					this.paintTextGlow(node);
				} else {
					this.resetTextGlow(node);
				}
				continue;
			}

			if (isSelected || node.dataset.intuitionNoTilt === "1") {
				this.disableTiltForNode(node);
				continue;
			}

			const localMul = readTiltStrengthMul(node);
			const cardStrength = this.strength * localMul;
			if (cardStrength <= 0.01) {
				const c = node.querySelector(
					".canvas-node-container",
				) as HTMLElement | null;
				if (c) this.resetCard(c);
				continue;
			}

			const container =
				(node.querySelector(".canvas-node-container") as HTMLElement | null) ??
				node;
			const rect = container.getBoundingClientRect();
			if (rect.width < 4 || rect.height < 4) continue;

			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const dist = distToRect(clientX, clientY, rect);
			const reach = Math.max(nearPx, Math.max(rect.width, rect.height) * 0.35);
			const influence = 1 - Math.min(1, dist / reach);
			if (influence <= 0.02) continue;

			const nx = Math.max(
				-1,
				Math.min(1, (clientX - cx) / Math.max(8, rect.width / 2)),
			);
			const ny = Math.max(
				-1,
				Math.min(1, (clientY - cy) / Math.max(8, rect.height / 2)),
			);
			hits.push({ container, influence, nx, ny, cardStrength });
		}

		hits.sort((a, b) => b.influence - a.influence);
		const winners = Number.isFinite(maxTilts)
			? hits.slice(0, maxTilts)
			: hits;
		for (const hit of winners) keep.add(hit.container);

		for (const card of cards) {
			if (card.kind !== "media") continue;
			const container =
				(card.el.querySelector(".canvas-node-container") as HTMLElement | null) ??
				card.el;
			if (!keep.has(container)) this.resetCard(container);
		}

		for (const hit of winners) {
			const maxTilt = MAX_TILT_DEG * hit.cardStrength;
			const rotY = hit.nx * maxTilt * hit.influence;
			const rotX = -hit.ny * maxTilt * hit.influence;
			hit.container.style.transition = "none";
			hit.container.style.transform = `perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg)`;
			hit.container.setAttribute(TILTING_ATTR, "1");
			if (this.glareEnabled) {
				this.paintGlare(
					hit.container,
					hit.nx,
					hit.ny,
					hit.influence,
					hit.cardStrength,
				);
			}
		}

	}

	/** True only when pointer is over glyph hosts — not empty card padding. */
	private isPointerOverTextGlyphs(
		node: HTMLElement,
		clientX: number,
		clientY: number,
	): boolean {
		const stack = document.elementsFromPoint(clientX, clientY);
		for (const el of stack) {
			if (!(el instanceof HTMLElement)) continue;
			if (!node.contains(el)) continue;
			if (
				el.classList.contains("canvas-node") ||
				el.classList.contains("canvas-node-container") ||
				el.classList.contains("canvas-node-content") ||
				el.classList.contains("markdown-source-view") ||
				el.classList.contains("cm-editor") ||
				el.classList.contains("cm-scroller") ||
				el.classList.contains("cm-contentContainer") ||
				el.classList.contains("markdown-preview-sizer")
			) {
				continue;
			}
			if (
				el.closest(
					".canvas-node-resizer, .canvas-node-connection-point, .canvas-node-label",
				)
			) {
				continue;
			}
			if (
				el.closest(
					".markdown-preview-view, .cm-content, .cm-line, .cm-widget",
				) ||
				el.matches(
					"p, span, a, li, h1, h2, h3, h4, h5, h6, strong, em, code, .cm-line, .cm-content",
				)
			) {
				return true;
			}
		}
		return false;
	}

	/** Soft drop-shadow on the text content layer (not the card chrome). */
	private textGlowFadeTimers = new WeakMap<HTMLElement, number>();

	private paintTextGlow(node: HTMLElement) {
		if (this.textStrength <= 0.01) {
			this.resetTextGlow(node);
			return;
		}

		/** Cap ~10% softer than former max at 100% slider */
		const s = this.textStrength * 0.9;
		const accent =
			getComputedStyle(document.body)
				.getPropertyValue("--interactive-accent")
				.trim() || "#7a6bb5";
		const aNear = colorToRgba(accent, 0.42 * s);
		const aFar = colorToRgba(accent, 0.2 * s);
		const bNear = (4 + 12 * s).toFixed(1);
		const bFar = (12 + 28 * s).toFixed(1);
		const bright = (1 + 0.05 * s).toFixed(3);

		const targets = collectTextGlowTargets(node);
		if (targets.length === 0) return;

		node.setAttribute(TEXT_GLOW_ATTR, "1");

		targets.forEach((el) => {
			const prev = this.textGlowFadeTimers.get(el);
			if (prev) {
				window.clearTimeout(prev);
				this.textGlowFadeTimers.delete(el);
			}
			el.style.setProperty("transition", "filter 0.18s ease-out", "important");
			el.style.setProperty(
				"filter",
				`brightness(${bright}) drop-shadow(0 0 ${bNear}px ${aNear}) drop-shadow(0 0 ${bFar}px ${aFar})`,
				"important",
			);
			el.setAttribute(FILTER_ATTR, "1");
		});
	}

	private clearGlowFilter(el: HTMLElement) {
		el.style.removeProperty("filter");
		el.style.removeProperty("transition");
		el.removeAttribute(FILTER_ATTR);
	}

	private resetTextGlow(node: HTMLElement) {
		const targets = collectTextGlowTargets(node);
		if (targets.length === 0 && !node.hasAttribute(TEXT_GLOW_ATTR)) return;

		node.removeAttribute(TEXT_GLOW_ATTR);

		targets.forEach((el) => {
			const prev = this.textGlowFadeTimers.get(el);
			if (prev) window.clearTimeout(prev);

			el.style.setProperty(
				"transition",
				"filter 0.48s ease-in-out",
				"important",
			);
			el.style.setProperty(
				"filter",
				"brightness(1) drop-shadow(0 0 0px transparent) drop-shadow(0 0 0px transparent)",
				"important",
			);

			const id = window.setTimeout(() => {
				this.clearGlowFilter(el);
				this.textGlowFadeTimers.delete(el);
			}, 500);
			this.textGlowFadeTimers.set(el, id);
		});
	}

	private paintGlare(
		container: HTMLElement,
		nx: number,
		ny: number,
		influence: number,
		cardStrength: number,
	) {
		let glare = container.querySelector(`.${GLARE_CLS}`) as HTMLElement | null;
		if (!glare) {
			glare = document.createElement("div");
			glare.className = GLARE_CLS;
			glare.setAttribute("aria-hidden", "true");
			container.appendChild(glare);
		}

		const px = 50 + nx * 35;
		const py = 50 + ny * 35;
		const base = (0.12 + influence * 0.38) * cardStrength;
		glare.style.opacity = String(base);
		glare.style.background = `radial-gradient(
			circle at ${px.toFixed(1)}% ${py.toFixed(1)}%,
			rgba(255, 255, 255, 0.45) 0%,
			rgba(255, 255, 255, 0.12) 28%,
			transparent 58%
		)`;
	}

	private resetCard(container: HTMLElement) {
		if (!container.hasAttribute(TILTING_ATTR)) return;
		container.style.transition = "transform 0.28s ease-out";
		container.style.removeProperty("transform");
		container.removeAttribute(TILTING_ATTR);
		const glare = container.querySelector(`.${GLARE_CLS}`) as HTMLElement | null;
		if (glare) glare.style.opacity = "0";
	}

	/** @deprecated alias — prefer clearAllEffects */
	clearAllTilts() {
		this.clearAllEffects();
	}

	clearAllEffects() {
		const scope: ParentNode = this.root ?? document;
		scope.querySelectorAll(`.${GLARE_CLS}`).forEach((el) => {
			(el as HTMLElement).style.opacity = "0";
		});
		scope.querySelectorAll<HTMLElement>(`[${TILTING_ATTR}]`).forEach((el) => {
			el.style.transition = "transform 0.28s ease-out";
			el.style.removeProperty("transform");
			el.removeAttribute(TILTING_ATTR);
		});
		/* Unwrap any leftover debug tilt planes from prior experiments. */
		scope.querySelectorAll(".intuition-vibe-tilt-plane").forEach((plane) => {
			const parent = plane.parentElement;
			if (!parent) {
				plane.remove();
				return;
			}
			while (plane.firstChild) parent.insertBefore(plane.firstChild, plane);
			plane.remove();
		});
		scope.querySelectorAll<HTMLElement>(`[${TEXT_GLOW_ATTR}]`).forEach((el) => {
			this.resetTextGlow(el);
		});
		scope.querySelectorAll<HTMLElement>(`[${FILTER_ATTR}]`).forEach((el) => {
			el.style.removeProperty("filter");
			el.style.removeProperty("transition");
			el.removeAttribute(FILTER_ATTR);
		});
		scope
			.querySelectorAll(
				".intuition-vibe-shine-layer, .intuition-vibe-text-shine",
			)
			.forEach((el) => el.remove());
	}
}

function distToRect(x: number, y: number, r: DOMRect): number {
	const dx = Math.max(r.left - x, 0, x - r.right);
	const dy = Math.max(r.top - y, 0, y - r.bottom);
	return Math.hypot(dx, dy);
}

/** Per-image multiplier from data-intuition-tilt-strength (0–100). Missing → 1. */
function readTiltStrengthMul(node: HTMLElement): number {
	const raw = node.dataset.intuitionTiltStrength;
	if (raw == null || raw === "") return 1;
	const n = Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.min(1, Math.max(0, n / 100));
}

function colorToRgba(color: string, alpha: number): string {
	const a = Math.min(1, Math.max(0, alpha));
	const hex = color.trim();
	if (/^#[0-9a-f]{3}$/i.test(hex)) {
		const r = parseInt(hex[1] + hex[1], 16);
		const g = parseInt(hex[2] + hex[2], 16);
		const b = parseInt(hex[3] + hex[3], 16);
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	}
	if (/^#[0-9a-f]{6}$/i.test(hex)) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	}
	const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
	if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
	return `rgba(122, 107, 181, ${a})`;
}

function collectTextGlowTargets(node: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	const preview = node.querySelector(
		".markdown-preview-view",
	) as HTMLElement | null;
	const cm = node.querySelector(".cm-content") as HTMLElement | null;
	if (preview) out.push(preview);
	if (cm) out.push(cm);
	if (out.length === 0) {
		const content = node.querySelector(
			".canvas-node-content",
		) as HTMLElement | null;
		if (content) out.push(content);
	}
	return out;
}
