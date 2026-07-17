import type { WorkspaceLeaf } from "obsidian";
import type { VibeSparkleController } from "./vibeSparkles";
import type { VibeTiltController } from "./vibeTilt";
import { canvasRoot, leafId, toggleCanvasFxClass } from "./pluginUtils";

/** When canvas zoom is below this, use lite auras (no shimmer/sparkles). */
export const FAR_ZOOM_CLASS = "intuition-canvas-far-zoom";
/**
 * Overview / sharp zoom-out: full blur+blob auras thrash the compositor
 * (photos blank, UI flicker). Lite FX only on deep overview; normal / close zoom stays full.
 */
export const FAR_ZOOM_THRESHOLD = 0.18;
export const ZOOM_HOOK_ATTR = "data-intuition-zoom-fx";
/** While panning/scrolling the board — pause auras/sparkles + clear tilt. */
export const PANNING_CLASS = "intuition-canvas-panning";
/**
 * While zoom is still settling after a wheel/gesture — clear + suspend 3D tilt.
 * Sharp zoom + live perspective drops compositor paint; pan "heals" via clearAllEffects —
 * apply the same during zoom itself.
 */
export const ZOOM_SETTLING_CLASS = "intuition-canvas-zoom-settling";
/** Relative |Δzoom|/prev — restart aura CSS animations (never hide). */
export const SHARP_ZOOM_REL = 0.1;

interface CanvasLike {
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	zoom?: number;
	tZoom?: number;
	tx?: number;
	ty?: number;
	x?: number;
	y?: number;
	isDragging?: boolean;
	setDragging?: (dragging: boolean) => void;
	markViewportChanged?: () => void;
	setViewport?: (tx: number, ty: number, tZoom: number) => void;
}

interface CanvasViewLike {
	containerEl: HTMLElement;
	canvas?: CanvasLike;
}

/** Minimal Plugin shape for registerDomEvent typing without importing the class. */
type RegisterDomEvent = (
	el: HTMLElement | Window | Document,
	type: string,
	callback: (evt: Event) => unknown,
	options?: boolean | AddEventListenerOptions,
) => void;

export type ZoomPanFxDeps = {
	registerDomEvent: RegisterDomEvent;
	getSparkles: (id: string) => VibeSparkleController | undefined;
	getTilt: (id: string) => VibeTiltController | undefined;
};

export class ZoomPanFxController {
	private zoomFarByLeaf = new Map<string, boolean>();
	private patchedCanvasViewport = new WeakSet<object>();
	private lastViewportByLeaf = new Map<
		string,
		{ x: number; y: number; zoom: number }
	>();
	private panIdleTimers = new Map<string, number>();
	private zoomIdleTimers = new Map<string, number>();
	private auraRestartTimers = new Map<string, number>();
	/** Last sane zoom per canvas — rejects float epsilons (~1e-16) that flicker HUD to 0%. */
	private lastGoodZoomByCanvas = new WeakMap<object, number>();

	constructor(private deps: ZoomPanFxDeps) {}

	install(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);
		this.patchCanvasViewportHook(leaf);
		if (root.getAttribute(ZOOM_HOOK_ATTR) === "1") {
			this.syncZoomFx(leaf);
			return;
		}
		root.setAttribute(ZOOM_HOOK_ATTR, "1");

		let raf = 0;
		const schedule = () => {
			if (raf) return;
			raf = window.requestAnimationFrame(() => {
				raf = 0;
				this.syncZoomFx(leaf);
			});
		};

		const endPan = () => this.setPanning(leaf, false);

		this.deps.registerDomEvent(root, "wheel", schedule, { passive: true });
		this.deps.registerDomEvent(
			root,
			"pointerup",
			() => {
				schedule();
				endPan();
			},
			{ passive: true },
		);
		this.deps.registerDomEvent(window, "pointerup", endPan);
		this.deps.registerDomEvent(window, "pointercancel", endPan);
		this.syncZoomFx(leaf);
	}

	readZoom(view: CanvasViewLike): number {
		return this.readCanvasZoom(view);
	}

	destroy() {
		for (const t of this.panIdleTimers.values()) window.clearTimeout(t);
		this.panIdleTimers.clear();
		for (const t of this.zoomIdleTimers.values()) window.clearTimeout(t);
		this.zoomIdleTimers.clear();
		for (const t of this.auraRestartTimers.values()) window.clearTimeout(t);
		this.auraRestartTimers.clear();
	}

	/** Obsidian fires markViewportChanged on every zoom/pan — most reliable hook. */
	private patchCanvasViewportHook(leaf: WorkspaceLeaf) {
		const canvas = (leaf.view as CanvasViewLike).canvas;
		if (!canvas || this.patchedCanvasViewport.has(canvas)) return;
		this.patchedCanvasViewport.add(canvas);

		const c = canvas;
		const schedule = () => {
			window.requestAnimationFrame(() => this.syncZoomFx(leaf));
		};

		if (typeof c.markViewportChanged === "function") {
			const orig = c.markViewportChanged.bind(c);
			c.markViewportChanged = () => {
				orig();
				schedule();
			};
		}
		if (typeof c.setViewport === "function") {
			const orig = c.setViewport.bind(c);
			c.setViewport = (tx, ty, tZoom) => {
				orig(tx, ty, tZoom);
				schedule();
			};
		}
		if (typeof c.setDragging === "function") {
			const orig = c.setDragging.bind(c);
			c.setDragging = (dragging: boolean) => {
				orig(dragging);
				this.setPanning(leaf, !!dragging);
			};
		}
	}

	/** Continuous pan (e.g. isDragging). Idle-off via setPanning(leaf, false). */
	setPanning(leaf: WorkspaceLeaf, on: boolean) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

		const idle = this.panIdleTimers.get(id);
		if (idle) {
			window.clearTimeout(idle);
			this.panIdleTimers.delete(id);
		}

		const apply = (active: boolean) => {
			const was = root.classList.contains(PANNING_CLASS);
			toggleCanvasFxClass(view, PANNING_CLASS, active);
			this.deps.getSparkles(id)?.setPanning(active);
			if (active && !was) {
				this.deps.getTilt(id)?.clearAllEffects();
			}
		};

		if (on) {
			apply(true);
			return;
		}

		const t = window.setTimeout(() => {
			this.panIdleTimers.delete(id);
			if (view.canvas?.isDragging) return;
			apply(false);
		}, 80);
		this.panIdleTimers.set(id, t);
	}

	/** Brief pan pulse (viewport moved without zoom). */
	pulsePanning(leaf: WorkspaceLeaf) {
		this.setPanning(leaf, true);
		this.setPanning(leaf, false);
	}

	/** Brief zoom-settling pulse. */
	pulseSettling(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

		const idle = this.zoomIdleTimers.get(id);
		if (idle) {
			window.clearTimeout(idle);
			this.zoomIdleTimers.delete(id);
		}

		const was = root.classList.contains(ZOOM_SETTLING_CLASS);
		toggleCanvasFxClass(view, ZOOM_SETTLING_CLASS, true);
		if (!was) {
			this.deps.getTilt(id)?.clearAllEffects();
		}

		const t = window.setTimeout(() => {
			this.zoomIdleTimers.delete(id);
			toggleCanvasFxClass(view, ZOOM_SETTLING_CLASS, false);
		}, 120);
		this.zoomIdleTimers.set(id, t);
	}

	private syncZoomFx(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const id = leafId(leaf);
		const zoom = this.readCanvasZoom(view);
		const far = zoom > 0 && zoom < FAR_ZOOM_THRESHOLD;
		const wasFar = this.zoomFarByLeaf.get(id) ?? false;

		toggleCanvasFxClass(view, FAR_ZOOM_CLASS, far);
		this.zoomFarByLeaf.set(id, far);

		this.deps.getSparkles(id)?.setZoom(zoom);
		this.deps.getTilt(id)?.setZoom(zoom);

		/* Leaving overview — kick breathe/drift back on (far CSS had animation:none). */
		if (wasFar && !far) {
			this.queueAuraRestart(leaf);
		}

		const canvas = view.canvas;
		const x = canvas?.tx ?? canvas?.x ?? 0;
		const y = canvas?.ty ?? canvas?.y ?? 0;
		const prev = this.lastViewportByLeaf.get(id);
		this.lastViewportByLeaf.set(id, { x, y, zoom });
		if (prev) {
			const moved =
				Math.abs(prev.x - x) > 0.5 || Math.abs(prev.y - y) > 0.5;
			const zoomed = Math.abs(prev.zoom - zoom) > 0.001;
			if (zoomed) {
				this.pulseSettling(leaf);
				const rel =
					Math.abs(zoom - prev.zoom) / Math.max(prev.zoom, 0.001);
				/* Only restart while already in full-FX zoom — never while far CSS wins. */
				if (rel >= SHARP_ZOOM_REL && !far) {
					this.queueAuraRestart(leaf);
				}
			}
			if (moved && !zoomed) {
				this.pulsePanning(leaf);
			}
		}

		if (canvas?.isDragging) this.setPanning(leaf, true);
	}

	/**
	 * Debounced CSS animation restart (auras stay visible).
	 * Skips while far-zoom lite CSS is active.
	 */
	private queueAuraRestart(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const prev = this.auraRestartTimers.get(id);
		if (prev) window.clearTimeout(prev);
		const t = window.setTimeout(() => {
			this.auraRestartTimers.delete(id);
			if (this.zoomFarByLeaf.get(id)) return;
			this.restartAuraAnimations(view);
		}, 80);
		this.auraRestartTimers.set(id, t);
	}

	/** Re-enable breathe/drift after far-zoom or a sharp near-zoom jump. */
	private restartAuraAnimations(view: CanvasViewLike) {
		const root = canvasRoot(view);
		if (
			root.classList.contains(FAR_ZOOM_CLASS) ||
			view.containerEl.classList.contains(FAR_ZOOM_CLASS)
		) {
			return;
		}

		const auras = view.containerEl.querySelectorAll<HTMLElement>(
			".intuition-image-aura, .intuition-image-aura__blob",
		);
		if (!auras.length) return;

		auras.forEach((el) => {
			el.style.setProperty("animation", "none");
		});
		void view.containerEl.offsetWidth;
		requestAnimationFrame(() => {
			auras.forEach((el) => {
				el.style.removeProperty("animation");
			});
		});
	}

	private readCanvasZoom(view: CanvasViewLike): number {
		const canvas = view.canvas;
		const fromZoom = canvas?.zoom;
		const fromTarget = canvas?.tZoom;
		const lastGood =
			(canvas ? this.lastGoodZoomByCanvas.get(canvas) : undefined) ?? 1;

		/**
		 * Obsidian briefly exposes canvas.zoom / tZoom as float noise (~1e-16)
		 * at zoom extremes — `> 0` accepts it and the HUD jumps 78%→0%→33%.
		 * Real canvas zoom in practice stays >= ~6%; reject anything under 1%.
		 */
		const MIN_ZOOM = 0.01;
		const isSane = (z: unknown): z is number =>
			typeof z === "number" && Number.isFinite(z) && z >= MIN_ZOOM;

		let usedFallback = true;
		let result = lastGood;

		if (isSane(fromZoom)) {
			result = fromZoom;
			usedFallback = false;
		} else if (isSane(fromTarget)) {
			result = fromTarget;
			usedFallback = false;
		} else {
			const canvasEl =
				canvas?.canvasEl ??
				view.containerEl.querySelector<HTMLElement>(".canvas");
			if (canvasEl) {
				const scale = readElementScale(canvasEl);
				if (isSane(scale)) {
					result = scale;
					usedFallback = false;
				}
			}

			if (usedFallback) {
				const hosts = [
					canvas?.wrapperEl,
					view.containerEl.querySelector<HTMLElement>(".canvas-wrapper"),
				].filter(Boolean) as HTMLElement[];

				for (const el of hosts) {
					const scale = readElementScale(el);
					if (isSane(scale)) {
						result = scale;
						usedFallback = false;
						break;
					}
				}
			}
		}

		if (canvas && isSane(result)) {
			this.lastGoodZoomByCanvas.set(canvas, result);
		}

		return result;
	}
}

function readElementScale(el: HTMLElement): number {
	const t = getComputedStyle(el).transform;
	if (!t || t === "none") return 0;
	const m2 = t.match(/matrix3d\(([^)]+)\)/);
	if (m2) {
		const a = Number.parseFloat(m2[1].split(",")[0] ?? "");
		if (Number.isFinite(a) && Math.abs(a) > 0.001) return Math.abs(a);
	}
	const m = t.match(/matrix\(([^)]+)\)/);
	if (!m) return 0;
	const a = Number.parseFloat(m[1].split(",")[0] ?? "");
	if (!Number.isFinite(a) || Math.abs(a) <= 0.001) return 0;
	return Math.abs(a);
}
