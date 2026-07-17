/**
 * Persist Canvas node geometry the way Obsidian expects.
 * Writing only node.x/y leaves cull/paint caches stale → blank cards on pan.
 */

export type PlaceableNodeData = {
	id?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	[key: string]: unknown;
};

export type PlaceableNode = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	nodeEl?: HTMLElement | null;
	render?: () => void;
	getData?: () => PlaceableNodeData;
	setData?: (data: PlaceableNodeData, addHistory?: boolean) => void;
	moveTo?: (x: number, y: number) => void;
	canvas?: { requestSave?: () => void };
};

export type PlaceableCanvas = {
	requestSave?: () => void;
	markViewportChanged?: () => void;
	requestFrame?: () => void;
};

export type NodeRectUpdate = {
	node: PlaceableNode;
	x: number;
	y: number;
	width?: number;
	height?: number;
};

const DEFAULT_RETRY_MS = [0, 16, 48, 120];

/** Clear leftover inline styles that desync Canvas culling from paint. */
export function scrubNodeChrome(
	node: PlaceableNode,
	extraClasses: string[] = [],
) {
	const el = node.nodeEl;
	if (!el) return;
	for (const cls of extraClasses) el.classList.remove(cls);
	el.style.removeProperty("transform");
	el.style.removeProperty("transition");
	el.style.removeProperty("opacity");
	el.style.removeProperty("will-change");
}

/** Write geometry via setData (preferred) + live fields + render. */
export function placeNodeRect(
	node: PlaceableNode,
	rect: { x: number; y: number; width?: number; height?: number },
) {
	const nx = Math.round(rect.x);
	const ny = Math.round(rect.y);
	const nw =
		typeof rect.width === "number"
			? Math.max(1, Math.round(rect.width))
			: undefined;
	const nh =
		typeof rect.height === "number"
			? Math.max(1, Math.round(rect.height))
			: undefined;

	if (typeof node.setData === "function") {
		const prev = node.getData?.() ?? { id: node.id };
		const next: PlaceableNodeData = { ...prev, x: nx, y: ny };
		if (nw !== undefined) next.width = nw;
		if (nh !== undefined) next.height = nh;
		node.setData(next);
	} else if (typeof node.moveTo === "function" && nw === undefined) {
		node.moveTo(nx, ny);
	}

	node.x = nx;
	node.y = ny;
	if (nw !== undefined) node.width = nw;
	if (nh !== undefined) node.height = nh;
	node.render?.();
}

/**
 * Apply one or more rect updates, refresh the viewport cull cache, and
 * re-apply shortly after so late Canvas writes cannot leave nodes blank.
 */
export function commitNodeRects(
	updates: NodeRectUpdate[],
	canvas?: PlaceableCanvas | null,
	opts?: { retryMs?: number[]; scrubClasses?: string[] },
) {
	if (updates.length === 0) return;

	const retryMs = opts?.retryMs ?? DEFAULT_RETRY_MS;
	const scrubClasses = opts?.scrubClasses ?? [];

	const apply = () => {
		for (const u of updates) {
			scrubNodeChrome(u.node, scrubClasses);
			placeNodeRect(u.node, u);
		}
		canvas?.markViewportChanged?.();
		canvas?.requestFrame?.();
		canvas?.requestSave?.();
		updates[0]?.node.canvas?.requestSave?.();
	};

	apply();
	for (const ms of retryMs) {
		window.setTimeout(apply, ms);
	}
}
