// SelfPhotos AI tools: the presets (our own saved instructions), the rules for picking several
// for one edit, and how a highlighted area is sent and pasted back, from ai-tools.json, which the
// Android app reads too (ai_tools.dart has the same rules); and which photos AI edits take.
// Not part of Immich.

import data from '#lib/ai-edit/ai/ai-tools.json';

export type AiTool = {
  id: string;
  // 'optional': with a highlight, only that area changes; 'required': needs one (Move);
  // 'ignored': always the whole photo (styles, Auto frame).
  highlight: 'optional' | 'required' | 'ignored';
  // false: the whole result is used even with a highlight (Move, styles, Auto frame).
  pasteBack: boolean;
  // Needs a few words from the user, added to its instruction (Move: where to).
  ask: boolean;
  // 'fix': several can be picked together; 'style': at most one (picking another swaps it).
  group: 'fix' | 'style';
  // Never combined with another tool (Move).
  alone: boolean;
  instruction: string;
};

type ToolData = Omit<AiTool, 'pasteBack' | 'ask' | 'alone'> & { pasteBack?: boolean; ask?: boolean; alone?: boolean };

export const AI_TOOLS: AiTool[] = (data.tools as ToolData[]).map((tool) => ({
  ...tool,
  pasteBack: tool.pasteBack ?? true,
  ask: tool.ask ?? false,
  alone: tool.alone ?? false,
}));

// How many tools one edit may combine.
export const MAX_SELECTED: number = data.maxSelected;

// The typed words' length limit: a few words for a tool that asks (Move: where to), more otherwise.
export const MAX_ASK_WORDS = 150;
export const MAX_WORDS = 500;

// The groups, in the row's order, each with its label.
export const TOOL_GROUPS = [
  { group: 'fix', labelKey: 'editor_ai_fixes' },
  { group: 'style', labelKey: 'editor_ai_styles' },
] as const;

// How a highlighted area is marked for the AI and pasted back (ai-area.ts).
export const AREA = data.area as {
  markLongSide: number;
  markQuality: number;
  tint: [number, number, number, number];
  maskLongSide: number;
  feather: number;
  shapeTolerance: number;
  // Lining the result up (ai-align.ts): the size it's measured at, and the most the fit may
  // still be off (a share of the photo's width) before nothing is pasted.
  alignLongSide: number;
  maxMisalignment: number;
  // The upright photo sent with a highlighted edit (ai-area.ts uprightPhoto).
  photoLongSide: number;
  photoQuality: number;
};

// A photo's size as Immich shows it (upright, with Immich's own crop): its width and height,
// when Immich knows them.
type Shown = { width?: number | null; height?: number | null };

// The largest photo AI edits take, by its size as shown (ai-tools.json, which the Android app
// reads too): memento-extras refuses larger ones too (413, code PHOTO_TOO_LARGE). Checked before
// anything is sent or paid for.
export const MAX_PHOTO = { megapixels: data.maxMegapixels, longSide: data.maxLongSide };

// Whether a photo is too large for AI edits: more than MAX_PHOTO.megapixels, or its longer side
// more than MAX_PHOTO.longSide. A photo whose size isn't known isn't refused here.
export const tooLargeForAi = ({ width, height }: Shown) =>
  !!width &&
  !!height &&
  (width * height > MAX_PHOTO.megapixels * 1_000_000 || Math.max(width, height) > MAX_PHOTO.longSide);

// A picture that counts as the photo at full size, for a highlighted edit's paste (memento-extras
// /save-area checks the same): each side at least `minShare` of the photo's as shown and not
// larger, the same orientation, and the same shape within `aspectTolerance`. So a RAW photo's
// full-size JPEG, a little smaller than the RAW, counts; Immich's preview doesn't.
export const FULL_SIZE = { minShare: 0.9, aspectTolerance: 0.01 };

// Whether `picture` is the photo (`shown`) at full size (FULL_SIZE). A photo whose size isn't
// known can't be compared: any picture counts.
export function isFullSize(picture: { width: number; height: number }, { width, height }: Shown): boolean {
  if (!width || !height) {
    return true;
  }
  const side = (read: number, photo: number) => read >= photo * FULL_SIZE.minShare && read <= photo;
  const turned =
    (picture.width > picture.height && width < height) || (picture.width < picture.height && width > height);
  return (
    side(picture.width, width) &&
    side(picture.height, height) &&
    !turned &&
    Math.abs(picture.width / picture.height / (width / height) - 1) <= FULL_SIZE.aspectTolerance
  );
}

// What's sent for a tool: its instruction, with the user's words for one that asks.
export const instructionFor = (tool: AiTool, words: string) =>
  tool.ask ? `${tool.instruction} ${words.trim()}` : tool.instruction;

// Whether this tool is among these.
export const has = (tools: AiTool[], tool: AiTool) => tools.some(({ id }) => id === tool.id);

// In ai-tools.json's order (so a style comes last).
const inOrder = (tools: AiTool[]) => AI_TOOLS.filter((tool) => has(tools, tool));

// The selected tools that stay when another is picked: Move (alone) is never combined (picking it
// clears the others, picking another clears it), and a style swaps the selected style.
const keptWith = (selected: AiTool[], tool: AiTool) =>
  tool.alone ? [] : selected.filter((other) => !other.alone && !(tool.group === 'style' && other.group === 'style'));

// The selection after tapping a tool: a selected one is unselected; another is added (keptWith).
// At most MAX_SELECTED: past that, nothing changes (so with 3 selected, only another style, which
// swaps, or Move, which goes alone, can be picked).
export function toggleTool(selected: AiTool[], tool: AiTool): AiTool[] {
  if (has(selected, tool)) {
    return selected.filter(({ id }) => id !== tool.id);
  }
  const kept = keptWith(selected, tool);
  return kept.length < MAX_SELECTED ? inOrder([...kept, tool]) : selected;
}

// A selected tool changes the whole photo (a style, Auto frame): no highlight meanwhile.
export const changesWholePhoto = (selected: AiTool[]) => selected.some(({ highlight }) => highlight === 'ignored');

// Whether a tool can be used with the highlight as it is: Move needs one, a whole-photo tool
// needs none.
const fitsHighlight = (tool: AiTool, hasHighlight: boolean) =>
  (tool.highlight !== 'required' || hasHighlight) && (tool.highlight !== 'ignored' || !hasHighlight);

// Why a tool can't be picked now (the i18n key of the reason; editor_ai_up_to takes the count
// MAX_SELECTED), or null: Move needs a highlight, a whole-photo tool needs none, and once
// MAX_SELECTED are selected the rest wait for one to be unselected (except another style, which
// swaps, and Move, which goes alone: toggleTool). A selected tool can always be unselected (null).
export function blockedReason(
  tool: AiTool,
  selected: AiTool[],
  hasHighlight: boolean,
): 'editor_ai_needs_highlight' | 'editor_ai_whole_only' | 'editor_ai_up_to' | null {
  if (has(selected, tool)) {
    return null;
  }
  if (!fitsHighlight(tool, hasHighlight)) {
    return tool.highlight === 'required' ? 'editor_ai_needs_highlight' : 'editor_ai_whole_only';
  }
  return keptWith(selected, tool).length >= MAX_SELECTED ? 'editor_ai_up_to' : null;
}

// Whether Generate can send these: a tool or some words, Move with its words and a highlight, and
// a whole-photo tool without one.
export const canGenerate = (selected: AiTool[], words: string, hasHighlight: boolean) =>
  (selected.length > 0 || words.trim() !== '') &&
  selected.every((tool) => fitsHighlight(tool, hasHighlight) && (!tool.ask || words.trim() !== ''));

// The one instruction an edit sends: each selected tool's instruction in ai-tools.json's order,
// then the typed words (for Move, its words are already in its instruction). One of them goes
// alone, as it is (so one preset, or words alone, send what they always did); several go as a
// list, after a header saying that "keep ... the same" in an item allows the other items'
// changes. The Android app makes the same string (ai_tools.dart combinedInstruction).
export function combinedInstruction(tools: AiTool[], words: string): string {
  const text = words.trim();
  const picked = inOrder(tools);
  const items = picked.map((tool) => instructionFor(tool, text));
  if (text && picked.every(({ ask }) => !ask)) {
    items.push(text);
  }
  return items.length > 1
    ? [
        'Make all of these changes to the photo in one edit. Where an item says to keep something the same, that means apart from the other changes in this list:',
        ...items.map((item) => `- ${item}`),
      ].join('\n')
    : (items[0] ?? '');
}

// A result's label: the selected tools' names in order, then the words, joined with " + "; Move
// (a tool that asks) with its words after a colon, as its label always was: "Move: to the left".
export function combinedLabel(tools: AiTool[], words: string, nameOf: (tool: AiTool) => string): string {
  const text = words.trim();
  const picked = inOrder(tools);
  const parts = picked.map((tool) => (tool.ask ? `${nameOf(tool)}: ${text}` : nameOf(tool)));
  if (text && picked.every(({ ask }) => !ask)) {
    parts.push(text);
  }
  return parts.join(' + ');
}

// The i18n keys of a tool's name and, for one that asks, its hint.
export const toolLabelKey = (tool: AiTool) => `editor_ai_tool_${tool.id}`;
export const toolAskKey = (tool: AiTool) => `editor_ai_tool_${tool.id}_ask`;
