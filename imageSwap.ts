/** Alt+drag an image onto another to swap their canvas positions. */

import type { WorkspaceLeaf } from "obsidian";
import { isImageNode, type ImageNodeLike } from "./imageStyles";
import { canvasRoot } from "./pluginUtils";

const HOOK_ATTR = "data-intuition-canvas-swap-hook";
const GHOST_CLS = "intuition-swap-ghost";
const DIM_CLS = "intuition-swap-dimmed";
const MOVE_THRESHOLD_PX = 8;
const PREVIEW_MS = 320;
/** Re-apply after Obsidian finishes its native drag commit. */
const COMMIT_RETRY_MS = [0, 16, 48, 120];

interface CanvasNodeData {
	id?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	[key: string]: unknown;
}

export interface CanvasNodeLike {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	nodeEl?: HTMLElement | null;
	render?: () => void;
	canvas?: { requestSave?: () => void };
	getData?: () => CanvasNodeData;
	setData?: (data: CanvasNodeData, addHistory?: boolean) => void;
	moveTo?: (x: number, y: number) => void;
}

interface CanvasLike {
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
	selection?: Set<CanvasNodeLike>;
	requestSave?: () => void;
	markViewportChanged?: () => void;
	requestFrame?: () => void;
}

export interface CanvasViewLike {
	containerEl: HTMLElement;
	canvas?: CanvasLike;
}

type RegisterDomEvent = (
	el: HTMLElement | Window | Document,
	type: string,
	callback: (evt: Event) => unknown,
	options?: boolean | AddEventListenerOptions,
) => void;

export type ImageSwapDeps = {
	registerDomEvent: RegisterDomEvent;
	isResizeActive?: () => boolean;
};

type GhostPreview = {
	node: CanvasNodeLike;
	ghost: HTMLElement;
	fromLeft: number;
	fromTop: number;
	fromWidth: number;
	fromHeight: number;
};

/**
 * Alt+drag swap. Alt may be held from the start or pressed mid-drag.
 * Preview uses a floating ghost clone (never touches canvas-node
 * transform / x/y until commit).
 */
export class ImageSwapController {
	private tracking = false;
	private altHeld = false;
	private source: CanvasNodeLike | null = null;
	private startX = 0;
	private startY = 0;
	private pointerStartX = 0;
	private pointerStartY = 0;
	private lastClientX = 0;
	private lastClientY = 0;
	private moved = false;
	private view: CanvasViewLike | null = null;
	private homeLeft = 0;
	private homeTop = 0;
	private homeWidth = 0;
	private homeHeight = 0;
	private hoverTarget: CanvasNodeLike | null = null;
	private preview: GhostPreview | null = null;
	private keysHooked = false;

	constructor(private deps: ImageSwapDeps) {}

	/** True only while Alt-swap preview/mode is engaged (not every drag). */
	get isActive() {
		return this.tracking && this.altHeld;
	}

	install(leaf: WorkspaceLeaf) {
		this.ensureAltKeys();
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

		root
			.querySelectorAll<HTMLElement>(
				".canvas-node.intuition-swap-preview, .canvas-node.intuition-swap-dimmed",
			)
			.forEach((el) => {
				el.classList.remove(
					"intuition-swap-preview",
					"intuition-swap-dimmed",
				);
				el.style.removeProperty("transform");
				el.style.removeProperty("transition");
				el.style.removeProperty("opacity");
			});
		document.querySelectorAll(`.${GHOST_CLS}`).forEach((el) => el.remove());

		if (root.getAttribute(HOOK_ATTR) === "1") return;
		root.setAttribute(HOOK_ATTR, "1");

		this.deps.registerDomEvent(
			root,
			"pointerdown",
			(event: Event) => {
				this.onPointerDown(view, event as PointerEvent);
			},
			true,
		);
	}

	swapTwoSelected(view: CanvasViewLike): boolean {
		const images = getSelectedImages(view);
		if (images.length !== 2) return false;
		const a = images[0];
		const b = images[1];
		commitSwap(a, b, a.x, a.y, b.x, b.y, view.canvas);
		return true;
	}

	/**
	 * Track Alt even when pressed mid-drag without moving the mouse —
	 * pointer events won't fire until the cursor moves.
	 */
	private ensureAltKeys() {
		if (this.keysHooked) return;
		this.keysHooked = true;

		const onKeyDown = (event: Event) => {
			const ev = event as KeyboardEvent;
			if (!this.tracking) return;

			/* Sync from modifier state on any key — covers mid-drag Alt. */
			const alt = ev.altKey || isAltKey(ev);
			if (alt) {
				/* Keep Windows from focusing the menu bar and killing the drag. */
				ev.preventDefault();
				this.altHeld = true;
				this.refreshHoverFromLastPointer();
			} else {
				this.altHeld = ev.altKey;
			}
		};

		const onKeyUp = (event: Event) => {
			const ev = event as KeyboardEvent;
			if (!this.tracking) return;
			if (isAltKey(ev)) {
				this.altHeld = false;
				this.hoverTarget = null;
				this.setPreviewTarget(null);
				return;
			}
			this.altHeld = ev.altKey;
			if (!this.altHeld) {
				this.hoverTarget = null;
				this.setPreviewTarget(null);
			}
		};

		this.deps.registerDomEvent(window, "keydown", onKeyDown, true);
		this.deps.registerDomEvent(window, "keyup", onKeyUp, true);
	}

	private onPointerDown(view: CanvasViewLike, event: PointerEvent) {
		if (this.tracking) return;
		if (event.button !== 0) return;
		if (this.deps.isResizeActive?.()) return;
		if (looksLikeResizeHandle(event.target)) return;

		const source = findImageNodeFromEvent(view, event);
		if (!source || source.width <= 0 || source.height <= 0) return;
		/*
		 * Do not require is-selected: the first click+drag often selects in
		 * the same gesture, so selection may still be empty on pointerdown.
		 */

		const home = source.nodeEl?.getBoundingClientRect();
		this.tracking = true;
		this.altHeld = event.altKey || event.getModifierState?.("Alt") === true;
		this.source = source;
		this.startX = source.x;
		this.startY = source.y;
		this.homeLeft = home?.left ?? event.clientX;
		this.homeTop = home?.top ?? event.clientY;
		this.homeWidth = home?.width ?? source.width;
		this.homeHeight = home?.height ?? source.height;
		this.pointerStartX = event.clientX;
		this.pointerStartY = event.clientY;
		this.lastClientX = event.clientX;
		this.lastClientY = event.clientY;
		this.moved = false;
		this.view = view;
		this.hoverTarget = null;

		const onMove = (ev: PointerEvent) => {
			if (!this.tracking || !this.source || !this.view) return;
			this.lastClientX = ev.clientX;
			this.lastClientY = ev.clientY;
			this.altHeld =
				ev.altKey || ev.getModifierState?.("Alt") === true;

			const dx = ev.clientX - this.pointerStartX;
			const dy = ev.clientY - this.pointerStartY;
			if (dx * dx + dy * dy >= MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) {
				this.moved = true;
			}
			if (!this.moved) return;

			this.refreshHover(ev.clientX, ev.clientY, this.altHeld);
		};

		const stop = (ev: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			this.finish(ev);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}

	private refreshHoverFromLastPointer() {
		/* Alt mid-drag should arm preview even if the cursor hasn't moved
		 * since the key was pressed (as long as we've left the deadzone). */
		if (!this.moved) {
			const dx = this.lastClientX - this.pointerStartX;
			const dy = this.lastClientY - this.pointerStartY;
			if (dx * dx + dy * dy >= MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) {
				this.moved = true;
			}
		}
		if (!this.moved) return;
		this.refreshHover(this.lastClientX, this.lastClientY, this.altHeld);
	}

	private refreshHover(clientX: number, clientY: number, alt: boolean) {
		if (!this.source || !this.view) return;
		if (!alt) {
			this.hoverTarget = null;
			this.setPreviewTarget(null);
			return;
		}
		const hit = findImageAtPoint(
			this.view,
			clientX,
			clientY,
			this.source.id,
		);
		this.hoverTarget = hit;
		this.setPreviewTarget(hit);
	}

	private setPreviewTarget(next: CanvasNodeLike | null) {
		const cur = this.preview;
		if (cur?.node.id === next?.id) return;

		if (cur) this.dismissGhost(cur, true);
		this.preview = null;
		if (!next) return;

		const el = next.nodeEl;
		if (!el?.isConnected) return;
		const rect = el.getBoundingClientRect();
		if (rect.width < 4 || rect.height < 4) return;

		const ghost = buildGhost(el, rect);
		document.body.appendChild(ghost);
		el.classList.add(DIM_CLS);

		this.preview = {
			node: next,
			ghost,
			fromLeft: rect.left,
			fromTop: rect.top,
			fromWidth: rect.width,
			fromHeight: rect.height,
		};

		requestAnimationFrame(() => {
			if (this.preview?.ghost !== ghost) return;
			ghost.style.left = `${this.homeLeft}px`;
			ghost.style.top = `${this.homeTop}px`;
			ghost.style.width = `${this.homeWidth}px`;
			ghost.style.height = `${this.homeHeight}px`;
		});
	}

	private dismissGhost(state: GhostPreview, animate: boolean) {
		const { node, ghost, fromLeft, fromTop, fromWidth, fromHeight } = state;
		node.nodeEl?.classList.remove(DIM_CLS);

		if (!animate || !ghost.isConnected) {
			ghost.remove();
			return;
		}

		ghost.style.left = `${fromLeft}px`;
		ghost.style.top = `${fromTop}px`;
		ghost.style.width = `${fromWidth}px`;
		ghost.style.height = `${fromHeight}px`;

		const done = () => {
			ghost.removeEventListener("transitionend", done);
			ghost.remove();
		};
		ghost.addEventListener("transitionend", done);
		window.setTimeout(done, PREVIEW_MS + 80);
	}

	private clearPreviewImmediate() {
		const state = this.preview;
		this.preview = null;
		if (!state) return;
		state.node.nodeEl?.classList.remove(DIM_CLS);
		state.ghost.remove();
	}

	private finish(event: PointerEvent) {
		const source = this.source;
		const view = this.view;
		const startX = this.startX;
		const startY = this.startY;
		const moved = this.moved;
		const hovered = this.hoverTarget;
		const wantSwap =
			event.altKey ||
			event.getModifierState?.("Alt") === true ||
			this.altHeld;

		this.tracking = false;
		this.altHeld = false;
		this.source = null;
		this.view = null;
		this.hoverTarget = null;

		this.clearPreviewImmediate();

		if (!source || !view || !moved || !wantSwap) return;

		const target =
			hovered ??
			findImageAtPoint(view, event.clientX, event.clientY, source.id);
		if (!target) return;

		/*
		 * Freeze both slots before Obsidian's late drag-write. Source may
		 * already have a transient drop x/y; target still holds its home.
		 */
		const targetX = readNodeX(target);
		const targetY = readNodeY(target);
		commitSwap(source, target, startX, startY, targetX, targetY, view.canvas);
	}
}

/**
 * Persist a two-node place-swap through setData (not just node.x/y) and
 * re-apply a few times so Obsidian's native drag commit cannot leave the
 * model/DOM out of sync — that desync is what blanks nodes on pan/zoom.
 */
function commitSwap(
	a: CanvasNodeLike,
	b: CanvasNodeLike,
	aHomeX: number,
	aHomeY: number,
	bHomeX: number,
	bHomeY: number,
	canvas?: CanvasLike | null,
) {
	const ax = Math.round(aHomeX);
	const ay = Math.round(aHomeY);
	const bx = Math.round(bHomeX);
	const by = Math.round(bHomeY);

	const apply = () => {
		scrubNodeChrome(a);
		scrubNodeChrome(b);
		placeNode(a, bx, by);
		placeNode(b, ax, ay);
		canvas?.markViewportChanged?.();
		canvas?.requestFrame?.();
		canvas?.requestSave?.();
		a.canvas?.requestSave?.();
	};

	apply();
	for (const ms of COMMIT_RETRY_MS) {
		window.setTimeout(apply, ms);
	}
}

function readNodeX(node: CanvasNodeLike): number {
	const data = node.getData?.();
	if (typeof data?.x === "number" && Number.isFinite(data.x)) return data.x;
	return node.x;
}

function readNodeY(node: CanvasNodeLike): number {
	const data = node.getData?.();
	if (typeof data?.y === "number" && Number.isFinite(data.y)) return data.y;
	return node.y;
}

function placeNode(node: CanvasNodeLike, x: number, y: number) {
	const nx = Math.round(x);
	const ny = Math.round(y);
	if (typeof node.setData === "function") {
		const prev = node.getData?.() ?? { id: node.id };
		node.setData({ ...prev, x: nx, y: ny });
	} else if (typeof node.moveTo === "function") {
		node.moveTo(nx, ny);
	}
	node.x = nx;
	node.y = ny;
	node.render?.();
}

/** Clear leftover inline styles that desync Canvas culling from paint. */
function scrubNodeChrome(node: CanvasNodeLike) {
	const el = node.nodeEl;
	if (!el) return;
	el.classList.remove(DIM_CLS, "intuition-swap-preview");
	el.style.removeProperty("transform");
	el.style.removeProperty("transition");
	el.style.removeProperty("opacity");
	el.style.removeProperty("will-change");
}

function buildGhost(sourceEl: HTMLElement, rect: DOMRect): HTMLElement {
	const ghost = document.createElement("div");
	ghost.className = GHOST_CLS;
	ghost.setAttribute("aria-hidden", "true");

	const img = sourceEl.querySelector("img");
	if (img) {
		const clone = img.cloneNode(true) as HTMLImageElement;
		clone.removeAttribute("id");
		ghost.appendChild(clone);
	} else {
		const thumb = sourceEl.querySelector(
			".canvas-node-content, .media-embed, .image-embed",
		) as HTMLElement | null;
		if (thumb) {
			const clone = thumb.cloneNode(true) as HTMLElement;
			ghost.appendChild(clone);
		}
	}

	const radius = window.getComputedStyle(sourceEl).borderRadius || "8px";
	ghost.style.cssText = [
		"position:fixed",
		`left:${rect.left}px`,
		`top:${rect.top}px`,
		`width:${rect.width}px`,
		`height:${rect.height}px`,
		`border-radius:${radius}`,
		"overflow:hidden",
		"pointer-events:none",
		"z-index:10000",
		`transition:left ${PREVIEW_MS}ms cubic-bezier(0.22, 1, 0.36, 1), top ${PREVIEW_MS}ms cubic-bezier(0.22, 1, 0.36, 1), width ${PREVIEW_MS}ms cubic-bezier(0.22, 1, 0.36, 1), height ${PREVIEW_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
		"box-shadow:0 12px 28px rgba(0,0,0,0.28)",
	].join(";");

	return ghost;
}

function isAltKey(ev: KeyboardEvent): boolean {
	return (
		ev.key === "Alt" ||
		ev.code === "AltLeft" ||
		ev.code === "AltRight"
	);
}

function getSelectedImages(view: CanvasViewLike): CanvasNodeLike[] {
	const out: CanvasNodeLike[] = [];
	const seen = new Set<string>();
	const push = (node: CanvasNodeLike) => {
		if (!isImageNode(node as ImageNodeLike) || seen.has(node.id)) return;
		seen.add(node.id);
		out.push(node);
	};
	const sel = view.canvas?.selection;
	if (sel) {
		for (const item of sel) push(item as CanvasNodeLike);
	}
	if (out.length === 0 && view.canvas?.nodes) {
		for (const node of view.canvas.nodes.values()) {
			if (node.nodeEl?.classList.contains("is-selected")) push(node);
		}
	}
	return out;
}

function looksLikeResizeHandle(target: EventTarget | null): boolean {
	let el = target as HTMLElement | null;
	for (let i = 0; i < 6 && el; i++) {
		const cursor = window.getComputedStyle(el).cursor.toLowerCase();
		if (
			cursor.includes("resize") ||
			cursor === "col-resize" ||
			cursor === "row-resize"
		) {
			return true;
		}
		const cls = el.className?.toString?.().toLowerCase?.() ?? "";
		if (/resiz/.test(cls)) return true;
		el = el.parentElement;
	}
	return false;
}

function findImageNodeFromEvent(
	view: CanvasViewLike,
	event: PointerEvent,
): CanvasNodeLike | null {
	const nodes = view.canvas?.nodes;
	if (!nodes) return null;

	const hit = (event.target as HTMLElement | null)?.closest?.(
		".canvas-node",
	) as HTMLElement | null;
	if (!hit) return null;

	for (const node of nodes.values()) {
		const el = node.nodeEl;
		if (!el) continue;
		if (el === hit || el.contains(hit) || hit.contains(el)) {
			if (isImageNode(node as ImageNodeLike)) return node;
			return null;
		}
	}

	const id = hit.getAttribute("data-node-id") ?? hit.dataset.nodeId;
	if (id && nodes.has(id)) {
		const node = nodes.get(id)!;
		return isImageNode(node as ImageNodeLike) ? node : null;
	}

	return null;
}

function findImageAtPoint(
	view: CanvasViewLike,
	clientX: number,
	clientY: number,
	excludeId: string,
): CanvasNodeLike | null {
	const nodes = view.canvas?.nodes;
	if (!nodes) return null;

	let best: CanvasNodeLike | null = null;
	let bestArea = Infinity;

	for (const node of nodes.values()) {
		if (node.id === excludeId) continue;
		if (!isImageNode(node as ImageNodeLike)) continue;
		const el = node.nodeEl;
		if (!el?.isConnected) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4) continue;
		if (
			clientX < r.left ||
			clientX > r.right ||
			clientY < r.top ||
			clientY > r.bottom
		) {
			continue;
		}
		const area = r.width * r.height;
		if (area < bestArea) {
			bestArea = area;
			best = node;
		}
	}

	return best;
}
