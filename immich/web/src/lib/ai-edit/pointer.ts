// SelfPhotos editors: a finger or the mouse drawing on the photo (Adjust's Markup,
// MarkupLayer.svelte, and AI Edit's brush, AiPhoto.svelte): where a press is on the picture, and
// how far apart a line's points are kept. Not part of Immich.

import { clamp } from 'lodash-es';

// A place on the picture: 0–1 of its width and height (top left is 0, 0).
export type Point = [number, number];

// Where `event` is on `element`: 0–1 of its width and height, kept inside it.
export function pointOn(element: Element, event: PointerEvent): Point {
  const box = element.getBoundingClientRect();
  return [clamp((event.clientX - box.left) / box.width, 0, 1), clamp((event.clientY - box.top) / box.height, 0, 1)];
}

// Whether a press draws (a finger, a pen, or the mouse's main button); if so, `element` captures
// it: its moves and its lift keep coming to `element`, also outside it.
export function captureDrawingPress(element: Element, event: PointerEvent) {
  if (event.button > 0) {
    return false;
  }
  element.setPointerCapture(event.pointerId);
  return true;
}

// `to` is more than `step` (a share of the picture) from `from`: a line keeps only points that
// far apart, so a long one stays small.
export const movedPast = (from: Point, to: Point, step: number) => Math.hypot(to[0] - from[0], to[1] - from[1]) > step;
