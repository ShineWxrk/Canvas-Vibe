import {
	DEFAULT_SPARKLE_CONFIG,
	migrateLegacySparkleConfig,
	normalizeSparkleConfig,
	type VibeSparkleConfig,
} from "./vibeSparkles";
import {
	DEFAULT_PRESENTATION_SETTINGS,
	normalizePresentationSettings,
	type PresentationSettings,
} from "./presentationSettings";
import type { CanvasChromeStyle } from "./canvasChrome";
import {
	COLLAGE_COUNT_DEFAULT,
	clampCollageCount,
	clampCollageGap,
	normalizeCollagePackAxis,
	type CollagePackAxis,
} from "./collageLayout";

export interface GlobalAuraSettings {
	enabled: boolean;
	shimmer: boolean;
	strength: number;
	size: number;
}

export const DEFAULT_GLOBAL_AURA: GlobalAuraSettings = {
	enabled: true,
	shimmer: true,
	strength: 50,
	size: 100,
};

export function normalizeGlobalAura(
	partial?: Partial<GlobalAuraSettings> | null,
): GlobalAuraSettings {
	const p = partial ?? {};
	return {
		enabled: p.enabled ?? DEFAULT_GLOBAL_AURA.enabled,
		shimmer: p.shimmer ?? DEFAULT_GLOBAL_AURA.shimmer,
		strength: Math.min(
			100,
			Math.max(0, Math.round(p.strength ?? DEFAULT_GLOBAL_AURA.strength)),
		),
		size: Math.min(
			200,
			Math.max(0, Math.round(p.size ?? DEFAULT_GLOBAL_AURA.size)),
		),
	};
}

export interface IntuitionCanvasSettings {
	hideImageLabels: boolean;
	hideAuras: boolean;
	vibeMode: boolean;
	/** 0–100, tilt/glare strength (50% ≈ former 100% / ±8°) */
	vibeStrength: number;
	/** 0–100, text glow strength (independent from tilt) */
	vibeTextStrength: number;
	/** Bumped when strength scale doubles so we can remap saved % once */
	vibeStrengthScale?: number;
	/** @deprecated use vibeSparkles.amount */
	vibeSparkle?: number;
	vibeSparkleScale?: number;
	/** Full sparkle / glitter settings */
	vibeSparkles: VibeSparkleConfig;
	/** Global aura defaults applied to all images */
	globalAura: GlobalAuraSettings;
	/** Accordion open state in vibe panel */
	vibePanelSections?: Record<string, boolean>;
	/** Per-canvas background/dot chrome, keyed by vault path */
	canvasChrome: Record<string, CanvasChromeStyle>;
	/** Gap between photos in collage grid (px) */
	collageGap: number;
	/** Tile by column count (masonry) or row count (justified rows). */
	collagePackAxis: CollagePackAxis;
	/** Number of columns or rows (1–20). */
	collageCount: number;
	/** Slideshow / presentation preferences (interval, fade, Ken Burns, FX, transition). */
	presentation: PresentationSettings;
	/** Sticky mini-player volume 0–100 */
	stickyAudioVolume: number;
	/** Sticky mini-player loop one track */
	stickyAudioLoop: boolean;
}

export const DEFAULT_SETTINGS: IntuitionCanvasSettings = {
	hideImageLabels: true,
	hideAuras: false,
	vibeMode: false,
	vibeStrength: 40,
	vibeTextStrength: 28,
	vibeStrengthScale: 2,
	vibeSparkleScale: 3,
	vibeSparkles: { ...DEFAULT_SPARKLE_CONFIG },
	globalAura: { ...DEFAULT_GLOBAL_AURA },
	vibePanelSections: {
		tilt: true,
		sparkles: false,
		auras: false,
	},
	canvasChrome: {},
	collageGap: 16,
	collagePackAxis: "cols",
	collageCount: COLLAGE_COUNT_DEFAULT,
	presentation: { ...DEFAULT_PRESENTATION_SETTINGS },
	stickyAudioVolume: 80,
	stickyAudioLoop: false,
};

export const VIBE_STRENGTH_SCALE = 2;
/** Bumped to 3 when sparkle amount/size/freq became absolute units. */
export const VIBE_SPARKLE_SCALE = 3;

export function clampPercent(value: number, fallback: number) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Normalize persisted plugin data and run one-shot migrations.
 * Returns `migrated: true` when the caller should persist cleaned settings.
 */
export function migrateSettings(
	raw: Partial<IntuitionCanvasSettings> | null,
): { settings: IntuitionCanvasSettings; migrated: boolean } {
	const settings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		raw,
	) as IntuitionCanvasSettings;
	if (!settings.canvasChrome) settings.canvasChrome = {};

	// Migrate legacy single sparkle % → full config
	const hadLegacySparkle = typeof raw?.vibeSparkle === "number";
	const legacyAmount = hadLegacySparkle
		? raw!.vibeSparkle
		: raw?.vibeSparkles?.amount;
	const prevSparkleScale = raw?.vibeSparkleScale ?? 1;
	const mergedSparkles = {
		...DEFAULT_SPARKLE_CONFIG,
		...(raw?.vibeSparkles ?? {}),
		...(legacyAmount != null ? { amount: legacyAmount } : {}),
	};
	settings.vibeSparkles =
		prevSparkleScale < VIBE_SPARKLE_SCALE
			? migrateLegacySparkleConfig(mergedSparkles)
			: normalizeSparkleConfig(mergedSparkles);
	settings.globalAura = normalizeGlobalAura(raw?.globalAura);
	settings.presentation = normalizePresentationSettings(raw?.presentation);
	settings.stickyAudioVolume = Math.min(
		100,
		Math.max(
			0,
			Math.round(
				Number(raw?.stickyAudioVolume ?? DEFAULT_SETTINGS.stickyAudioVolume),
			),
		),
	);
	settings.stickyAudioLoop = !!(
		raw?.stickyAudioLoop ?? DEFAULT_SETTINGS.stickyAudioLoop
	);
	settings.vibeTextStrength = clampPercent(
		raw?.vibeTextStrength ?? DEFAULT_SETTINGS.vibeTextStrength,
		DEFAULT_SETTINGS.vibeTextStrength,
	);
	settings.vibePanelSections = {
		...DEFAULT_SETTINGS.vibePanelSections,
		...(raw?.vibePanelSections ?? {}),
	};

	let migrated = false;
	const prevTiltScale = settings.vibeStrengthScale ?? 1;
	if (prevTiltScale < VIBE_STRENGTH_SCALE) {
		const factor = prevTiltScale / VIBE_STRENGTH_SCALE;
		settings.vibeStrength = clampPercent(
			settings.vibeStrength * factor,
			DEFAULT_SETTINGS.vibeStrength,
		);
		migrated = true;
	}
	if (prevSparkleScale < VIBE_SPARKLE_SCALE) {
		migrated = true;
	}

	// Drop deprecated vibeSparkle after one-shot amount migration — do not rewrite it.
	const settingsBag = settings as unknown as Record<string, unknown>;
	if (hadLegacySparkle || "vibeSparkle" in settingsBag) {
		delete settingsBag.vibeSparkle;
		migrated = true;
	}

	settings.vibeStrengthScale = VIBE_STRENGTH_SCALE;
	settings.vibeSparkleScale = VIBE_SPARKLE_SCALE;

	settings.collageGap = clampCollageGap(
		settings.collageGap ?? DEFAULT_SETTINGS.collageGap,
	);
	const rawAny = (raw ?? {}) as Record<string, unknown>;
	const hadLegacyCollage =
		"collageArrange" in rawAny ||
		"collageCenterSize" in rawAny ||
		"collageSizeMode" in rawAny ||
		"collageFixedAxis" in rawAny ||
		"collageFixedSize" in rawAny ||
		(!("collagePackAxis" in rawAny) && !("collageCount" in rawAny));
	settings.collagePackAxis = normalizeCollagePackAxis(
		rawAny.collagePackAxis ?? DEFAULT_SETTINGS.collagePackAxis,
	);
	const packAxis = settings.collagePackAxis;
	const legacyCount =
		typeof rawAny.collageCount === "number"
			? rawAny.collageCount
			: packAxis === "rows" && typeof rawAny.collageRows === "number"
				? rawAny.collageRows
				: typeof rawAny.collageCols === "number"
					? rawAny.collageCols
					: DEFAULT_SETTINGS.collageCount;
	settings.collageCount = clampCollageCount(legacyCount);
	if (hadLegacyCollage) migrated = true;
	delete settingsBag.collageArrange;
	delete settingsBag.collageCenterSize;
	delete settingsBag.collageSizeMode;
	delete settingsBag.collageFixedAxis;
	delete settingsBag.collageFixedSize;
	delete settingsBag.collageCols;
	delete settingsBag.collageRows;

	return { settings, migrated };
}
