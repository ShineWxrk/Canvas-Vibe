/** Soft colored glow + shimmer (v2) behind Canvas image nodes. */

const AURA_CLS = "intuition-image-aura";
const AURA_ATTR = "data-intuition-aura";
const BLOB_CLS = "intuition-image-aura__blob";

export type AuraPalette = [string, string, string];

export function removeAuraLayer(nodeEl: HTMLElement) {
	nodeEl.querySelectorAll(`.${AURA_CLS}`).forEach((el) => el.remove());
	delete nodeEl.dataset.intuitionAura;
	delete nodeEl.dataset.intuitionAuraShimmer;
	for (const prop of [
		"--intuition-aura-color",
		"--intuition-aura-strength",
		"--intuition-aura-size",
		"--intuition-aura-duration",
		"--intuition-aura-delay",
		"--intuition-aura-rgb",
		"--intuition-aura-rgb-a",
		"--intuition-aura-rgb-b",
		"--intuition-aura-rgb-c",
		"--intuition-aura-drift-a",
		"--intuition-aura-drift-b",
		"--intuition-aura-drift-c",
		"--intuition-aura-delay-a",
		"--intuition-aura-delay-b",
		"--intuition-aura-delay-c",
	]) {
		nodeEl.style.removeProperty(prop);
	}
}

export interface PaintAuraOptions {
	color: string;
	palette?: string[];
	strength: number;
	size?: number;
	seed?: string;
	/** v2: drifting multi-color blobs */
	shimmer?: boolean;
}

/**
 * Places a blurred glow layer behind the card chrome.
 * Lives on `.canvas-node` (sibling of container) so overflow:hidden on the
 * container doesn't clip it.
 */
export function paintAuraLayer(nodeEl: HTMLElement, opts: PaintAuraOptions) {
	const {
		color,
		strength,
		size = 100,
		seed = "",
		shimmer = true,
		palette,
	} = opts;

	const intensity = Math.min(100, Math.max(0, strength)) / 100;
	const sizePct = Math.min(200, Math.max(0, Math.round(size)));
	if (sizePct <= 0 || intensity <= 0.01) {
		removeAuraLayer(nodeEl);
		return;
	}

	const seedKey = seed || nodeEl.dataset.nodeId || nodeEl.id || randomSeed();
	const timing = auraTimingFromSeed(seedKey);
	const drifts = [
		auraTimingFromSeed(seedKey + ":a"),
		auraTimingFromSeed(seedKey + ":b"),
		auraTimingFromSeed(seedKey + ":c"),
	];

	const colors = normalizePalette(palette?.length ? palette : [color], color);
	const rgbs = colors.map((c) =>
		lightenForDarkCanvas(hexToRgb(c) ?? { r: 120, g: 90, b: 180 }),
	);

	nodeEl.dataset.intuitionAura = "1";
	nodeEl.dataset.intuitionAuraShimmer = shimmer ? "1" : "0";
	nodeEl.style.setProperty("--intuition-aura-color", rgbToHex(rgbs[0]));
	nodeEl.style.setProperty("--intuition-aura-strength", String(intensity));
	nodeEl.style.setProperty("--intuition-aura-size", String(sizePct));
	nodeEl.style.setProperty("--intuition-aura-duration", `${timing.duration}s`);
	nodeEl.style.setProperty("--intuition-aura-delay", `${timing.delay}s`);
	nodeEl.style.setProperty(
		"--intuition-aura-rgb",
		`${rgbs[0].r}, ${rgbs[0].g}, ${rgbs[0].b}`,
	);
	nodeEl.style.setProperty(
		"--intuition-aura-rgb-a",
		`${rgbs[0].r}, ${rgbs[0].g}, ${rgbs[0].b}`,
	);
	nodeEl.style.setProperty(
		"--intuition-aura-rgb-b",
		`${rgbs[1].r}, ${rgbs[1].g}, ${rgbs[1].b}`,
	);
	nodeEl.style.setProperty(
		"--intuition-aura-rgb-c",
		`${rgbs[2].r}, ${rgbs[2].g}, ${rgbs[2].b}`,
	);
	nodeEl.style.setProperty("--intuition-aura-drift-a", `${drifts[0].duration + 3}s`);
	nodeEl.style.setProperty("--intuition-aura-drift-b", `${drifts[1].duration + 4.5}s`);
	nodeEl.style.setProperty("--intuition-aura-drift-c", `${drifts[2].duration + 2.2}s`);
	nodeEl.style.setProperty("--intuition-aura-delay-a", `${drifts[0].delay}s`);
	nodeEl.style.setProperty("--intuition-aura-delay-b", `${drifts[1].delay}s`);
	nodeEl.style.setProperty("--intuition-aura-delay-c", `${drifts[2].delay}s`);

	let aura = nodeEl.querySelector(`.${AURA_CLS}`) as HTMLElement | null;
	if (!aura) {
		aura = document.createElement("div");
		aura.className = AURA_CLS;
		aura.setAttribute(AURA_ATTR, "1");
		const container = nodeEl.querySelector(".canvas-node-container");
		if (container?.parentElement === nodeEl) {
			nodeEl.insertBefore(aura, container);
		} else {
			nodeEl.prepend(aura);
		}
	}

	/* Keep blob nodes stable so CSS animations don't restart (causes flicker). */
	const wantShimmer = !!shimmer;
	const existingBlobs = aura.querySelectorAll(`.${BLOB_CLS}`).length;
	const needsBlobRebuild =
		(wantShimmer && existingBlobs !== 3) || (!wantShimmer && existingBlobs > 0);
	if (needsBlobRebuild) {
		aura.replaceChildren();
		if (wantShimmer) {
			for (const letter of ["a", "b", "c"] as const) {
				const blob = document.createElement("div");
				blob.className = `${BLOB_CLS} ${BLOB_CLS}--${letter}`;
				aura.appendChild(blob);
			}
		}
	}
}

function normalizePalette(parts: string[], fallback: string): AuraPalette {
	const base = parts.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
	const primary =
		base[0] ?? (/^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback : "#7a6bb5");
	if (base.length >= 3) return [base[0], base[1], base[2]];
	if (base.length === 2) return [base[0], base[1], shiftHueHex(base[0], -36)];
	return [primary, shiftHueHex(primary, 32), shiftHueHex(primary, -40)];
}

/** Stable per-node duration + phase so auras don't breathe in lockstep. */
function auraTimingFromSeed(seed: string): { duration: number; delay: number } {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	h >>>= 0;
	const duration = 4 + (h % 320) / 100;
	const delay = -(((h >>> 10) % 1000) / 1000) * duration;
	return {
		duration: Math.round(duration * 100) / 100,
		delay: Math.round(delay * 100) / 100,
	};
}

function randomSeed(): string {
	return `r${Math.floor(Math.random() * 1e9)}`;
}

/** Average saturated colors from a small downscale of the image. */
export function extractDominantColor(img: HTMLImageElement): string | null {
	const palette = extractPalette(img);
	return palette?.[0] ?? null;
}

/** Top ~3 vivid colors for shimmer blobs. */
export function extractPalette(img: HTMLImageElement): AuraPalette | null {
	if (!img.naturalWidth || !img.naturalHeight) return null;

	const size = 48;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;

	try {
		ctx.drawImage(img, 0, 0, size, size);
		const { data } = ctx.getImageData(0, 0, size, size);

		const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();

		for (let i = 0; i < data.length; i += 4) {
			const a = data[i + 3];
			if (a < 40) continue;
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const sat = max === 0 ? 0 : (max - min) / max;
			const bri = max / 255;
			if (bri < 0.08 || bri > 0.96) continue;
			if (sat < 0.1) continue;

			const hue = rgbToHue(r, g, b);
			const bucket = Math.floor(hue / 15) % 24;
			const weight = 0.35 + sat * 1.5 + (bri > 0.3 && bri < 0.85 ? 0.3 : 0);
			const prev = buckets.get(bucket) ?? { r: 0, g: 0, b: 0, w: 0 };
			prev.r += r * weight;
			prev.g += g * weight;
			prev.b += b * weight;
			prev.w += weight;
			buckets.set(bucket, prev);
		}

		const ranked = [...buckets.entries()]
			.map(([id, v]) => ({
				id,
				w: v.w,
				color: boostSaturation(v.r / v.w, v.g / v.w, v.b / v.w),
			}))
			.sort((a, b) => b.w - a.w);

		if (ranked.length === 0) {
			const single = extractDominantColorFallback(data);
			if (!single) return null;
			return normalizePalette([single], single);
		}

		const picks: string[] = [rgbToHex(ranked[0].color)];
		for (const entry of ranked.slice(1)) {
			if (picks.length >= 3) break;
			const hex = rgbToHex(entry.color);
			const distinct = picks.every((p) => colorDistance(p, hex) > 48);
			if (distinct) picks.push(hex);
		}

		return normalizePalette(picks, picks[0]);
	} catch {
		return null;
	}
}

function extractDominantColorFallback(data: Uint8ClampedArray): string | null {
	let rSum = 0;
	let gSum = 0;
	let bSum = 0;
	let wSum = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 40) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const bri = Math.max(r, g, b) / 255;
		if (bri < 0.05 || bri > 0.97) continue;
		rSum += r;
		gSum += g;
		bSum += b;
		wSum += 1;
	}
	if (wSum < 1) return null;
	return rgbToHex(boostSaturation(rSum / wSum, gSum / wSum, bSum / wSum));
}

export function waitForImage(
	img: HTMLImageElement,
): Promise<HTMLImageElement | null> {
	if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
	return new Promise((resolve) => {
		const done = () => {
			img.removeEventListener("load", onLoad);
			img.removeEventListener("error", onErr);
		};
		const onLoad = () => {
			done();
			resolve(img.naturalWidth > 0 ? img : null);
		};
		const onErr = () => {
			done();
			resolve(null);
		};
		img.addEventListener("load", onLoad);
		img.addEventListener("error", onErr);
		window.setTimeout(() => {
			done();
			resolve(img.complete && img.naturalWidth > 0 ? img : null);
		}, 4000);
	});
}

function boostSaturation(
	r: number,
	g: number,
	b: number,
): { r: number; g: number; b: number } {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
	const avg = (r + g + b) / 3;
	const factor = 1.35;
	return {
		r: clampByte(avg + (r - avg) * factor),
		g: clampByte(avg + (g - avg) * factor),
		b: clampByte(avg + (b - avg) * factor),
	};
}

function lightenForDarkCanvas(c: {
	r: number;
	g: number;
	b: number;
}): { r: number; g: number; b: number } {
	const luma = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
	const amount = luma < 0.2 ? 0.62 : luma < 0.4 ? 0.48 : 0.34;
	return {
		r: clampByte(c.r + (255 - c.r) * amount),
		g: clampByte(c.g + (255 - c.g) * amount),
		b: clampByte(c.b + (255 - c.b) * amount),
	};
}

function rgbToHue(r: number, g: number, b: number): number {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	if (d === 0) return 0;
	let h = 0;
	if (max === rn) h = ((gn - bn) / d) % 6;
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	h *= 60;
	if (h < 0) h += 360;
	return h;
}

function shiftHueHex(hex: string, degrees: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;
	return rgbToHex(rotateHue(rgb, degrees));
}

function rotateHue(
	c: { r: number; g: number; b: number },
	degrees: number,
): { r: number; g: number; b: number } {
	const r = c.r / 255;
	const g = c.g / 255;
	const b = c.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	let h = rgbToHue(c.r, c.g, c.b);
	h = (h + degrees + 360) % 360;
	return hslToRgb(h, s, Math.min(0.72, Math.max(0.35, l + 0.08)));
}

function hslToRgb(
	h: number,
	s: number,
	l: number,
): { r: number; g: number; b: number } {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let rp = 0;
	let gp = 0;
	let bp = 0;
	if (h < 60) [rp, gp, bp] = [c, x, 0];
	else if (h < 120) [rp, gp, bp] = [x, c, 0];
	else if (h < 180) [rp, gp, bp] = [0, c, x];
	else if (h < 240) [rp, gp, bp] = [0, x, c];
	else if (h < 300) [rp, gp, bp] = [x, 0, c];
	else [rp, gp, bp] = [c, 0, x];
	return {
		r: clampByte((rp + m) * 255),
		g: clampByte((gp + m) * 255),
		b: clampByte((bp + m) * 255),
	};
}

function colorDistance(a: string, b: string): number {
	const ca = hexToRgb(a);
	const cb = hexToRgb(b);
	if (!ca || !cb) return 0;
	const dr = ca.r - cb.r;
	const dg = ca.g - cb.g;
	const db = ca.b - cb.b;
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clampByte(n: number): number {
	return Math.min(255, Math.max(0, Math.round(n)));
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
	const h = (n: number) => n.toString(16).padStart(2, "0");
	return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function hexToRgb(color: string): { r: number; g: number; b: number } | null {
	const m = /^#([0-9a-fA-F]{6})$/.exec(color);
	if (!m) return null;
	const hex = m[1];
	return {
		r: parseInt(hex.slice(0, 2), 16),
		g: parseInt(hex.slice(2, 4), 16),
		b: parseInt(hex.slice(4, 6), 16),
	};
}
