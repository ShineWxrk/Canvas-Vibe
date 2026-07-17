/** Drag-to-pan focal point while an image is in crop (cover) mode. */

import { Notice } from "obsidian";
import {
	clampFocal,
	readImageStyle,
	writeImageStyle,
	type ImageNodeLike,
} from "./imageStyles";

const BODY_ACTIVE = "intuition-crop-pan-active";
const BODY_DRAG = "is-dragging-crop";
const TARGET_CLS = "intuition-crop-pan-target";

export class ImageCropPanController {
	private active = false;
	private node: ImageNodeLike | null = null;
	private notice: Notice | null = null;
	private dragging = false;
	private startX = 0;
	private startY = 0;
	private startFocalX = 50;
	private startFocalY = 50;
	private frameW = 1;
	private frameH = 1;
	private onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
	private cleanupListeners: (() => void) | null = null;

	get isActive() {
		return this.active;
	}

	/** Enter pan mode for one cropped image. Esc or call stop() to exit. */
	start(node: ImageNodeLike) {
		const style = readImageStyle(node);
		if (style.fitMode !== "crop") {
			new Notice("Сначала включи режим «Обрезка»", 1600);
			return;
		}
		if (!node.nodeEl) {
			new Notice("Картинка ещё не готова", 1200);
			return;
		}

		this.stop();
		this.active = true;
		this.node = node;
		node.nodeEl.classList.add(TARGET_CLS);
		document.body.classList.add(BODY_ACTIVE);

		this.notice = new Notice(
			"Сдвиг кадра: тяни фото · клик по пустому / Esc — готово",
			0,
		);

		this.onKeyDown = (ev: KeyboardEvent) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				this.stop();
			}
		};
		window.addEventListener("keydown", this.onKeyDown, true);

		const onBlankClick = (ev: PointerEvent) => {
			if (!this.active || !this.node?.nodeEl) return;
			if (ev.button !== 0) return;
			const target = ev.target as HTMLElement | null;
			if (!target) return;
			/* Keep pan / panel controls working. */
			if (this.node.nodeEl.contains(target)) return;
			if (
				target.closest(
					"[data-intuition-image-panel], .intuition-image-panel, .intuition-vibe-panel, .modal-container, .notice, .menu",
				)
			) {
				return;
			}
			this.stop();
		};
		/* Bubble phase so our pan capture on the node runs first. */
		window.addEventListener("pointerdown", onBlankClick, false);

		const onDown = (ev: PointerEvent) => {
			if (!this.active || !this.node?.nodeEl) return;
			if (ev.button !== 0) return;
			const el = this.node.nodeEl;
			if (!el.contains(ev.target as Node)) return;
			const cursor = window.getComputedStyle(ev.target as Element).cursor;
			if (cursor.includes("resize")) return;

			ev.preventDefault();
			ev.stopPropagation();
			this.dragging = true;
			document.body.classList.add(BODY_DRAG);
			this.startX = ev.clientX;
			this.startY = ev.clientY;
			const live = readImageStyle(this.node);
			this.startFocalX = live.focalX;
			this.startFocalY = live.focalY;
			const r = el.getBoundingClientRect();
			this.frameW = Math.max(1, r.width);
			this.frameH = Math.max(1, r.height);
			try {
				(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
			} catch {
				/* ignore */
			}
		};

		const onMove = (ev: PointerEvent) => {
			if (!this.dragging || !this.node) return;
			const dx = ev.clientX - this.startX;
			const dy = ev.clientY - this.startY;
			const nextX = clampFocal(this.startFocalX - (dx / this.frameW) * 100);
			const nextY = clampFocal(this.startFocalY - (dy / this.frameH) * 100);
			const base = readImageStyle(this.node);
			writeImageStyle(this.node, { ...base, focalX: nextX, focalY: nextY });
		};

		const onUp = (ev: PointerEvent) => {
			if (!this.dragging) return;
			this.dragging = false;
			document.body.classList.remove(BODY_DRAG);
			try {
				(ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
			} catch {
				/* ignore */
			}
		};

		const el = node.nodeEl;
		el.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onUp, true);

		this.cleanupListeners = () => {
			el.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointerdown", onBlankClick, false);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onUp, true);
		};
	}

	stop() {
		this.cleanupListeners?.();
		this.cleanupListeners = null;

		if (this.onKeyDown) {
			window.removeEventListener("keydown", this.onKeyDown, true);
			this.onKeyDown = null;
		}

		this.node?.nodeEl?.classList.remove(TARGET_CLS);
		document.body.classList.remove(BODY_ACTIVE, BODY_DRAG);
		this.notice?.hide();
		this.notice = null;
		this.active = false;
		this.dragging = false;
		this.node = null;
	}
}
