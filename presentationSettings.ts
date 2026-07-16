/** Slideshow / presentation preferences (persisted in plugin settings). */

export type PresentationTransition = "dissolve" | "zoom" | "slide";

export interface PresentationSettings {
	/** Seconds each slide stays fully visible (before fade). */
	intervalSec: number;
	/** Crossfade / transition duration in ms. */
	fadeMs: number;
	/** 0 = off, 100 = full Ken Burns (~14% zoom). */
	kenBurnsStrength: number;
	auras: boolean;
	sparkles: boolean;
	transition: PresentationTransition;
	/** Soft gradient backdrop from photo palette. */
	paletteBg: boolean;
	vignette: boolean;
	letterbox: boolean;
}

export const PRESENTATION_LIMITS = {
	intervalSec: { min: 2, max: 30 },
	fadeMs: { min: 200, max: 3000 },
	kenBurnsStrength: { min: 0, max: 100 },
} as const;

export const DEFAULT_PRESENTATION_SETTINGS: PresentationSettings = {
	intervalSec: 7,
	fadeMs: 1200,
	kenBurnsStrength: 100,
	auras: true,
	sparkles: true,
	transition: "dissolve",
	paletteBg: true,
	vignette: true,
	letterbox: true,
};

export function normalizePresentationTransition(
	value: unknown,
): PresentationTransition {
	if (value === "zoom" || value === "slide" || value === "dissolve") return value;
	return DEFAULT_PRESENTATION_SETTINGS.transition;
}

export function normalizePresentationSettings(
	partial?: Partial<PresentationSettings> | null,
): PresentationSettings {
	const p = partial ?? {};
	const L = PRESENTATION_LIMITS;
	const intervalSec = clamp(
		Number(p.intervalSec ?? DEFAULT_PRESENTATION_SETTINGS.intervalSec),
		L.intervalSec.min,
		L.intervalSec.max,
	);
	const fadeMs = clamp(
		Math.round(Number(p.fadeMs ?? DEFAULT_PRESENTATION_SETTINGS.fadeMs)),
		L.fadeMs.min,
		L.fadeMs.max,
	);
	const kenBurnsStrength = clamp(
		Math.round(
			Number(
				p.kenBurnsStrength ?? DEFAULT_PRESENTATION_SETTINGS.kenBurnsStrength,
			),
		),
		L.kenBurnsStrength.min,
		L.kenBurnsStrength.max,
	);
	return {
		intervalSec,
		fadeMs,
		kenBurnsStrength,
		auras: p.auras ?? DEFAULT_PRESENTATION_SETTINGS.auras,
		sparkles: p.sparkles ?? DEFAULT_PRESENTATION_SETTINGS.sparkles,
		transition: normalizePresentationTransition(p.transition),
		paletteBg: p.paletteBg ?? DEFAULT_PRESENTATION_SETTINGS.paletteBg,
		vignette: p.vignette ?? DEFAULT_PRESENTATION_SETTINGS.vignette,
		letterbox: p.letterbox ?? DEFAULT_PRESENTATION_SETTINGS.letterbox,
	};
}

function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}
