// SelfPhotos Adjust's Markup.

import {
  MARKUP_COLOURS,
  MARKUP_SIZES,
  MarkupHistory,
  TEXT,
  type MarkupItem,
  type MarkupPoint,
  type MarkupText,
} from '#lib/ai-edit/adjust/markup.ts';
import { clamp } from 'lodash-es';

export type MarkupTool = 'pen' | 'highlighter' | 'text' | 'shapes';
export type MarkupShapeKind = 'arrow' | 'box' | 'circle';

const replaced = <T>(list: T[], index: number, item: T) => list.map((old, i) => (i === index ? item : old));
const removed = <T>(list: T[], index: number) => list.filter((_, i) => i !== index);

export class MarkupEditor {
  #history = $state.raw(new MarkupHistory());
  tool = $state<MarkupTool>('pen');
  shape = $state<MarkupShapeKind>('arrow');
  colour = $state(MARKUP_COLOURS[0].fill);
  size = $state(1);
  selected = $state<number | null>(null);
  newText = $state(0);
  #typing = false;

  get items() {
    return this.#history.items;
  }

  get canUndo() {
    return this.#history.past.length > 0;
  }

  get canRedo() {
    return this.#history.future.length > 0;
  }

  get isEmpty() {
    return this.items.every((item) => item.kind === 'text' && item.text.trim() === '');
  }

  get selectedText(): MarkupText | null {
    const item = this.selected === null ? undefined : this.items[this.selected];
    return item?.kind === 'text' ? item : null;
  }

  commit(items: MarkupItem[]) {
    this.#history = this.#history.commit(items);
    this.#typing = false;
  }

  amend(items: MarkupItem[]) {
    this.#history = this.#history.amend(items);
  }

  update(index: number, item: MarkupItem, newChange: boolean) {
    const items = replaced(this.items, index, item);
    if (newChange) {
      this.commit(items);
    } else {
      this.amend(items);
    }
  }

  undo() {
    const steps = this.#history.past.length;
    this.select(null);
    if (this.#history.past.length === steps) {
      this.#history = this.#history.undo();
    }
  }

  redo() {
    this.select(null);
    this.#history = this.#history.redo();
  }

  clear() {
    this.select(null);
    if (!this.isEmpty) {
      this.commit([]);
    }
  }

  reset() {
    this.selected = null;
    this.#history = new MarkupHistory();
  }

  setTool(tool: MarkupTool) {
    this.select(null);
    this.tool = tool;
  }

  select(index: number | null) {
    if (index === this.selected) {
      return;
    }
    const left = this.selectedText;
    const leftIndex = this.selected;
    this.selected = index;
    this.#typing = false;
    if (left && leftIndex !== null && left.text.trim() === '') {
      this.amend(removed(this.items, leftIndex));
      if (index !== null && index > leftIndex) {
        this.selected = index - 1;
      }
    }
  }

  addText(at: MarkupPoint) {
    this.select(null);
    const text: MarkupText = {
      kind: 'text',
      colour: this.colour,
      fontSize: MARKUP_SIZES[this.size].text,
      at,
      text: '',
    };
    this.commit([...this.items, text]);
    this.selected = this.items.length - 1;
    this.#typing = true;
    this.newText++;
  }

  setText(value: string) {
    const item = this.selectedText;
    if (item && this.selected !== null) {
      this.update(this.selected, { ...item, text: value.slice(0, TEXT.maxLength) }, !this.#typing);
      this.#typing = true;
    }
  }

  moveText(index: number, item: MarkupText, at: MarkupPoint, newChange: boolean) {
    this.#changeText(index, { ...item, at }, newChange);
  }

  resizeText(index: number, item: MarkupText, fontSize: number, newChange: boolean) {
    this.#changeText(index, { ...item, fontSize: clamp(fontSize, TEXT.minSize, TEXT.maxSize) }, newChange);
  }

  deleteSelected() {
    if (this.selected !== null) {
      const index = this.selected;
      this.selected = null;
      this.commit(removed(this.items, index));
    }
  }

  setColour(colour: string) {
    this.colour = colour;
    const item = this.selectedText;
    if (item && this.selected !== null && item.colour !== colour) {
      this.#changeText(this.selected, { ...item, colour }, true);
    }
  }

  setSize(size: number) {
    this.size = size;
    const item = this.selectedText;
    if (item && this.selected !== null) {
      this.#changeText(this.selected, { ...item, fontSize: MARKUP_SIZES[size].text }, true);
    }
  }

  #changeText(index: number, item: MarkupText, newChange: boolean) {
    this.update(index, item, newChange && item.text !== '');
  }
}
