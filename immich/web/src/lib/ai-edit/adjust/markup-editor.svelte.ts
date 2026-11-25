// SelfPhotos Adjust's Markup: what the Markup tab holds while you draw, shared by its tools
// (MarkupTools.svelte) and the layer on the photo (MarkupLayer.svelte): the items with their
// undo history, the tool, colour and size picked, and the text being edited. The page keeps one
// for as long as it's open, so the markup stays while other tabs are used. Not part of Immich.
// Android's is markup_editor.dart.

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
  size = $state(1); // MARKUP_SIZES' index
  // The text being edited (an index into `items`), on the Text tool.
  selected = $state<number | null>(null);
  // Goes up each time a new text is placed, so the tools put the cursor in its field.
  newText = $state(0);
  // Typing in the selected text has started a change (placing a new text is one).
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

  // Nothing that shows: no items, or only a text with nothing typed yet.
  get isEmpty() {
    return this.items.every((item) => item.kind === 'text' && item.text.trim() === '');
  }

  get selectedText(): MarkupText | null {
    const item = this.selected === null ? undefined : this.items[this.selected];
    return item?.kind === 'text' ? item : null;
  }

  // A change that can be undone. Typing after it is a change of its own.
  commit(items: MarkupItem[]) {
    this.#history = this.#history.commit(items);
    this.#typing = false;
  }

  // More of the last change: a line growing, a drag going on.
  amend(items: MarkupItem[]) {
    this.#history = this.#history.amend(items);
  }

  // Changes item `index`, as a new change or as more of the last one.
  update(index: number, item: MarkupItem, newChange: boolean) {
    const items = replaced(this.items, index, item);
    if (newChange) {
      this.commit(items);
    } else {
      this.amend(items);
    }
  }

  undo() {
    // Leaving a text placed but not typed drops it with its step: that's what's undone then.
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

  // Everything gone, the history too (Reset changes, or saved).
  reset() {
    this.selected = null;
    this.#history = new MarkupHistory();
  }

  setTool(tool: MarkupTool) {
    this.select(null);
    this.tool = tool;
  }

  // Picks the text to edit, or none. A text left empty is removed.
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

  // A new, empty text at `at`, being edited.
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

  // Typing in the selected text: one change, from the first letter to leaving it.
  setText(value: string) {
    const item = this.selectedText;
    if (item && this.selected !== null) {
      this.update(this.selected, { ...item, text: value.slice(0, TEXT.maxLength) }, !this.#typing);
      this.#typing = true;
    }
  }

  // A text moved to `at`.
  moveText(index: number, item: MarkupText, at: MarkupPoint, newChange: boolean) {
    this.#changeText(index, { ...item, at }, newChange);
  }

  // A text's size, within the limits.
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

  // A colour or size picked: for what's drawn next, and the text being edited.
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

  // A text moved, resized or restyled: with nothing typed yet, it's part of placing it, not a
  // change of its own.
  #changeText(index: number, item: MarkupText, newChange: boolean) {
    this.update(index, item, newChange && item.text !== '');
  }
}
