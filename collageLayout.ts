/** Pinterest-style column masonry / row pack for Canvas image nodes (v1: one-shot layout). */

/** Which count drives tile layout: columns (masonry) or rows (row-pack). */
export type CollagePackAxis = "cols" | "rows";

export const COLLAGE_COUNT_MIN = 1;
export const COLLAGE_COUNT_MAX = 20;
export const COLLAGE_COUNT_DEFAULT = 3;
export const COLLAGE_GAP_MIN = 0;
/** Manual px input + clamp; slider may use a lower max for easy dragging. */
export const COLLAGE_GAP_MAX = 500;
export const COLLAGE_GAP_SLIDER_MAX = 200;
export const COLLAGE_GAP_DEFAULT = 16;

export interface MasonryItem {
	id: string;
	/** width / height */
	aspect: number;
}

export interface MasonryRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface MasonryOptions {
	originX: number;
	originY: number;
	/** Overall collage width; columns share this minus gaps */
	totalWidth?: number;
	/**
	 * Exact column width in px. When set, photos are sized to this width
	 * (height = width / aspect) instead of stretching to fill totalWidth.
	 */
	columnWidth?: number;
	gap?: number;
	columns?: number;
	minColumnWidth?: number;
}

export interface ExactRowsOptions {
	originX: number;
	originY: number;
	/** Target width each row should fill */
	rowWidth: number;
	/** Exact number of rows to pack into */
	rows: number;
	gap?: number;
}

/**
 * Pack items into columns (shortest-column first), preserving input order.
 * Returns canvas coordinates for each item id.
 *
 * Pass `columnWidth` for fixed-width cells, or `totalWidth` to divide space
 * evenly across columns (auto fit — can enlarge photos).
 */
export function layoutMasonry(
	items: MasonryItem[],
	opts: MasonryOptions,
): Map<string, MasonryRect> {
	const out = new Map<string, MasonryRect>();
	if (!items.length) return out;

	const gap = opts.gap ?? 16;
	const minCol = opts.minColumnWidth ?? 140;
	const fixedColW =
		opts.columnWidth != null && Number.isFinite(opts.columnWidth)
			? Math.max(20, opts.columnWidth)
			: null;

	const widthHint =
		fixedColW != null
			? fixedColW * Math.min(4, items.length) +
				gap * Math.max(0, Math.min(3, items.length - 1))
			: Math.max(opts.totalWidth ?? 600, minCol);

	const columns = clamp(
		opts.columns ?? suggestColumns(items.length, widthHint, gap, minCol),
		1,
		Math.min(COLLAGE_COUNT_MAX, items.length),
	);

	const colW =
		fixedColW ??
		(() => {
			const totalWidth = Math.max(
				opts.totalWidth ?? 600,
				columns * minCol + (columns - 1) * gap,
			);
			return (totalWidth - gap * (columns - 1)) / columns;
		})();

	const colHeights = Array.from({ length: columns }, () => 0);
	const colStep = colW + gap;

	for (const item of items) {
		const aspect =
			Number.isFinite(item.aspect) && item.aspect > 0.05
				? item.aspect
				: 1;
		const w = colW;
		const h = Math.max(40, colW / aspect);

		let bestCol = 0;
		let bestY = Infinity;
		for (let c = 0; c < columns; c++) {
			if (colHeights[c] < bestY) {
				bestY = colHeights[c];
				bestCol = c;
			}
		}

		const x = opts.originX + bestCol * colStep;
		const y = opts.originY + bestY;

		out.set(item.id, {
			x,
			y,
			width: w,
			height: h,
		});

		colHeights[bestCol] = bestY + h + gap;
	}

	return out;
}

/**
 * Pack items into exactly `rows` justified rows (equal height within a row,
 * widths from aspect so the row fills `rowWidth`). Preserves reading order.
 */
export function layoutExactRows(
	items: MasonryItem[],
	opts: ExactRowsOptions,
): Map<string, MasonryRect> {
	const out = new Map<string, MasonryRect>();
	if (!items.length) return out;

	const gap = opts.gap ?? 16;
	const rows = clamp(opts.rows, 1, Math.min(COLLAGE_COUNT_MAX, items.length));
	const rowWidth = Math.max(40, opts.rowWidth);

	let y = opts.originY;
	for (let r = 0; r < rows; r++) {
		const start = Math.floor((r * items.length) / rows);
		const end = Math.floor(((r + 1) * items.length) / rows);
		const rowItems = items.slice(start, end);
		if (!rowItems.length) continue;

		const aspects = rowItems.map((item) =>
			Number.isFinite(item.aspect) && item.aspect > 0.05 ? item.aspect : 1,
		);
		const aspectSum = aspects.reduce((s, a) => s + a, 0);
		const gapsW = gap * Math.max(0, rowItems.length - 1);
		const h = Math.max(20, (rowWidth - gapsW) / Math.max(0.05, aspectSum));

		let x = opts.originX;
		let rowMaxH = h;
		for (let i = 0; i < rowItems.length; i++) {
			const w = Math.max(20, h * aspects[i]);
			out.set(rowItems[i].id, { x, y, width: w, height: h });
			x += w + gap;
			rowMaxH = Math.max(rowMaxH, h);
		}
		y += rowMaxH + gap;
	}

	return out;
}

/** Prefer ~sqrt(n) columns, capped by how many fit in totalWidth. */
export function suggestColumns(
	count: number,
	totalWidth: number,
	gap = 16,
	minColumnWidth = 140,
): number {
	if (count <= 1) return 1;
	if (count === 2) return 2;

	const bySqrt = Math.round(Math.sqrt(count));
	const maxByWidth = Math.max(
		1,
		Math.floor((totalWidth + gap) / (minColumnWidth + gap)),
	);
	return clamp(Math.min(bySqrt, maxByWidth, 4), 2, Math.min(4, count));
}

export function boundingBox(
	nodes: Iterable<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let n = 0;
	for (const node of nodes) {
		n += 1;
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + node.width);
		maxY = Math.max(maxY, node.y + node.height);
	}
	if (!n || !Number.isFinite(minX)) {
		return { x: 0, y: 0, width: 600, height: 400 };
	}
	return {
		x: minX,
		y: minY,
		width: Math.max(200, maxX - minX),
		height: Math.max(200, maxY - minY),
	};
}

/** Visual reading order: top→bottom, then left→right. */
export function sortNodesReadingOrder<
	T extends { x: number; y: number; width: number; height: number },
>(nodes: T[]): T[] {
	return [...nodes].sort((a, b) => {
		const ay = a.y + a.height / 2;
		const by = b.y + b.height / 2;
		if (Math.abs(ay - by) > 40) return ay - by;
		return a.x - b.x;
	});
}

export function aspectFromImageNode(node: {
	width: number;
	height: number;
	nodeEl?: HTMLElement | null;
}): number {
	const img = node.nodeEl?.querySelector("img") as HTMLImageElement | null;
	if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
		return img.naturalWidth / img.naturalHeight;
	}
	if (node.width > 0 && node.height > 0) return node.width / node.height;
	return 1;
}

/** Natural width/height from the loaded <img>, or null if unavailable. */
export function naturalSizeFromImageNode(node: {
	nodeEl?: HTMLElement | null;
}): { width: number; height: number } | null {
	const img = node.nodeEl?.querySelector("img") as HTMLImageElement | null;
	if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
	return { width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Fit node to the image's intrinsic aspect ratio without resetting “size”.
 * Preserves area (w×h) so a big photo stays roughly as large after un-stretching;
 * recenters so the frame doesn’t jump.
 */
export function restoreNaturalAspectPreservingArea(node: {
	x: number;
	y: number;
	width: number;
	height: number;
	nodeEl?: HTMLElement | null;
	render?: () => void;
}): boolean {
	const natural = naturalSizeFromImageNode(node);
	if (!natural) return false;
	if (node.width <= 0 || node.height <= 0) return false;

	const ar = natural.width / natural.height;
	if (!Number.isFinite(ar) || ar <= 0) return false;

	const area = Math.max(1, node.width * node.height);
	let newH = Math.sqrt(area / ar);
	let newW = newH * ar;
	newW = Math.max(20, newW);
	newH = Math.max(20, newH);

	const cx = node.x + node.width / 2;
	const cy = node.y + node.height / 2;
	node.width = newW;
	node.height = newH;
	node.x = cx - newW / 2;
	node.y = cy - newH / 2;
	node.render?.();
	return true;
}

export function clampCollageCount(value: number): number {
	if (!Number.isFinite(value)) return COLLAGE_COUNT_DEFAULT;
	return Math.min(
		COLLAGE_COUNT_MAX,
		Math.max(COLLAGE_COUNT_MIN, Math.round(value)),
	);
}

export function clampCollageGap(value: number): number {
	if (!Number.isFinite(value)) return COLLAGE_GAP_DEFAULT;
	return Math.min(
		COLLAGE_GAP_MAX,
		Math.max(COLLAGE_GAP_MIN, Math.round(value)),
	);
}

export function normalizeCollagePackAxis(value: unknown): CollagePackAxis {
	return value === "rows" ? "rows" : "cols";
}

function clamp(n: number, min: number, max: number) {
	return Math.min(max, Math.max(min, n));
}
