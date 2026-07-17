import type { WorkspaceLeaf } from "obsidian";
import { isImageNode, type ImageNodeLike } from "./imageStyles";
import { canvasRoot } from "./pluginUtils";

const DOM_HOOK_ATTR = "data-intuition-canvas-resize-hook";

interface CanvasNodeLike {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	nodeEl?: HTMLElement | null;
	render?: () => void;
	canvas?: { requestSave?: () => void };
}

interface CanvasLike {
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
	selection?: Set<CanvasNodeLike>;
}

interface CanvasViewLike {
	containerEl: HTMLElement;
	canvas?: CanvasLike;
}

type RegisterDomEvent = (
	el: HTMLElement | Window | Document,
	type: string,
	callback: (evt: Event) => unknown,
	options?: boolean | AddEventListenerOptions,
) => void;

export type ImageResizeDeps = {
	registerDomEvent: RegisterDomEvent;
};

/**
 * Smart image resize via DOM cursor on handles.
 * More reliable than patching Obsidian internals.
 */
export class ImageResizeController {
	private aspectResizeActive = false;

	constructor(private deps: ImageResizeDeps) {}

	get isActive() {
		return this.aspectResizeActive;
	}

	install(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

		if (root.getAttribute(DOM_HOOK_ATTR) === "1") return;
		root.setAttribute(DOM_HOOK_ATTR, "1");

		this.deps.registerDomEvent(root, "pointerdown", (event: Event) => {
			this.onCanvasPointerDown(view, event as PointerEvent);
		});
	}

	getSelectedImageNodes(view: CanvasViewLike): ImageNodeLike[] {
		const canvas = view.canvas;
		if (!canvas?.nodes) return [];

		const out: ImageNodeLike[] = [];
		const seen = new Set<string>();

		const push = (node: CanvasNodeLike) => {
			if (!isImageNode(node as ImageNodeLike) || seen.has(node.id)) return;
			seen.add(node.id);
			out.push(node as ImageNodeLike);
		};

		if (canvas.selection) {
			for (const item of canvas.selection) push(item);
		}

		if (out.length === 0) {
			for (const node of canvas.nodes.values()) {
				if (node.nodeEl?.classList.contains("is-selected")) push(node);
			}
		}

		return out;
	}

	private onCanvasPointerDown(view: CanvasViewLike, event: PointerEvent) {
		if (this.aspectResizeActive) return;

		const cursorInfo = findResizeCursor(event);
		if (!cursorInfo) return;

		const node = this.getSelectedImageNode(view);
		if (!node || node.width <= 0 || node.height <= 0) return;

		if (cursorInfo.kind === "side-h") {
			this.startSideFreeStretch(node, "horizontal");
		} else if (cursorInfo.kind === "side-v") {
			this.startSideFreeStretch(node, "vertical");
		} else {
			this.startCornerAspectLock(node);
		}
	}

	private getSelectedImageNode(view: CanvasViewLike): CanvasNodeLike | null {
		return (
			(this.getSelectedImageNodes(view)[0] as CanvasNodeLike | undefined) ??
			null
		);
	}

	private startSideFreeStretch(
		node: CanvasNodeLike,
		axis: "horizontal" | "vertical",
	) {
		if (this.aspectResizeActive) return;
		this.aspectResizeActive = true;

		const start = {
			x: node.x,
			y: node.y,
			w: node.width,
			h: node.height,
		};

		const enforce = () => {
			if (axis === "horizontal") {
				node.height = start.h;
				node.y = start.y;
			} else {
				node.width = start.w;
				node.x = start.x;
			}
			node.render?.();
		};

		let raf = 0;
		const tick = () => {
			enforce();
			raf = window.requestAnimationFrame(tick);
		};
		raf = window.requestAnimationFrame(tick);

		const onMove = () => enforce();
		window.addEventListener("pointermove", onMove);

		const stop = () => {
			window.cancelAnimationFrame(raf);
			window.removeEventListener("pointermove", onMove);
			enforce();
			this.aspectResizeActive = false;
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			node.canvas?.requestSave?.();
		};

		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}

	private startCornerAspectLock(node: CanvasNodeLike) {
		if (this.aspectResizeActive) return;
		this.aspectResizeActive = true;

		const start = {
			x: node.x,
			y: node.y,
			w: node.width,
			h: node.height,
		};
		const ratio = start.w / start.h;

		const tickApply = () => {
			const leftMoved = Math.abs(node.x - start.x) > 1;
			const topMoved = Math.abs(node.y - start.y) > 1;
			applyAspectLock(node, start, ratio, leftMoved, topMoved);
		};

		let raf = 0;
		const tick = () => {
			tickApply();
			raf = window.requestAnimationFrame(tick);
		};
		raf = window.requestAnimationFrame(tick);

		const onMove = () => tickApply();
		window.addEventListener("pointermove", onMove);

		const stop = () => {
			window.cancelAnimationFrame(raf);
			window.removeEventListener("pointermove", onMove);
			tickApply();
			this.aspectResizeActive = false;
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			node.canvas?.requestSave?.();
		};

		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}
}

function findResizeCursor(
	event: PointerEvent,
): { kind: "side-h" | "side-v" | "corner"; cursor: string } | null {
	let el: HTMLElement | null = event.target as HTMLElement | null;
	for (let i = 0; i < 6 && el; i++) {
		const cursor = window.getComputedStyle(el).cursor.toLowerCase();
		const kind = classifyCursor(cursor);
		if (kind) return { kind, cursor };

		const cls = el.className?.toString?.().toLowerCase?.() ?? "";
		if (/resiz/.test(cls)) {
			if (
				/left|right|e-|w-|east|west/.test(cls) &&
				!/top|bottom|n-|s-/.test(cls)
			) {
				return { kind: "side-h", cursor: cls };
			}
			if (
				/top|bottom|n-|s-|north|south/.test(cls) &&
				!/left|right|e-|w-/.test(cls)
			) {
				return { kind: "side-v", cursor: cls };
			}
			if (/corner|nw|ne|sw|se/.test(cls)) {
				return { kind: "corner", cursor: cls };
			}
		}
		el = el.parentElement;
	}

	return null;
}

function classifyCursor(
	cursor: string,
): "side-h" | "side-v" | "corner" | null {
	if (!cursor || cursor === "auto" || cursor === "default") return null;

	if (
		cursor === "ew-resize" ||
		cursor === "e-resize" ||
		cursor === "w-resize" ||
		cursor === "col-resize"
	) {
		return "side-h";
	}
	if (
		cursor === "ns-resize" ||
		cursor === "n-resize" ||
		cursor === "s-resize" ||
		cursor === "row-resize"
	) {
		return "side-v";
	}
	if (
		cursor === "nwse-resize" ||
		cursor === "nesw-resize" ||
		cursor === "nw-resize" ||
		cursor === "ne-resize" ||
		cursor === "sw-resize" ||
		cursor === "se-resize"
	) {
		return "corner";
	}
	if (cursor.includes("resize")) {
		return "corner";
	}
	return null;
}

function applyAspectLock(
	node: CanvasNodeLike,
	start: { x: number; y: number; w: number; h: number },
	ratio: number,
	movesLeft: boolean,
	movesTop: boolean,
) {
	const rightEdge = movesLeft ? start.x + start.w : node.x + node.width;
	const bottomEdge = movesTop ? start.y + start.h : node.y + node.height;

	const heightFromWidth = node.width / ratio;
	const widthFromHeight = node.height * ratio;
	const widthIsPrimary =
		Math.abs(heightFromWidth - node.height) <=
		Math.abs(widthFromHeight - node.width);

	let width: number;
	let height: number;
	if (widthIsPrimary) {
		width = Math.max(20, node.width);
		height = width / ratio;
	} else {
		height = Math.max(20, node.height);
		width = height * ratio;
	}

	node.x = movesLeft ? rightEdge - width : start.x;
	node.y = movesTop ? bottomEdge - height : start.y;
	node.width = width;
	node.height = height;
	node.render?.();
}

/** Exported for onunload scrub of the hook attribute. */
export { DOM_HOOK_ATTR };
