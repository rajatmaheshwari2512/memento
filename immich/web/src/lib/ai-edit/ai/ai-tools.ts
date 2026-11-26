// SelfPhotos AI tools: the presets (our own saved instructions), the rules for picking several
// for one edit, and how a highlighted area is sent and pasted back, from ai-tools.json.

import data from '#lib/ai-edit/ai/ai-tools.json';

export type AiTool = {
  id: string;
  highlight: 'optional' | 'required' | 'ignored';
  pasteBack: boolean;
  ask: boolean;
  group: 'fix' | 'style';
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

// The typed words' length limit: a few words for a tool that asks (Move: where to), more
// otherwise.
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
  alignLongSide: number;
  maxMisalignment: number;
  photoLongSide: number;
  photoQuality: number;
};

type Shown = { width?: number | null; height?: number | null };

// The largest photo AI edits take, by its size as shown.
export const MAX_PHOTO = { megapixels: data.maxMegapixels, longSide: data.maxLongSide };

// Whether a photo is too large for AI edits.
export const tooLargeForAi = ({ width, height }: Shown) =>
  !!width &&
  !!height &&
  (width * height > MAX_PHOTO.megapixels * 1_000_000 || Math.max(width, height) > MAX_PHOTO.longSide);

// A picture that counts as the photo at full size.
export const FULL_SIZE = { minShare: 0.9, aspectTolerance: 0.01 };

// Whether `picture` is the photo (`shown`) at full size (FULL_SIZE).
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

const inOrder = (tools: AiTool[]) => AI_TOOLS.filter((tool) => has(tools, tool));

const keptWith = (selected: AiTool[], tool: AiTool) =>
  tool.alone ? [] : selected.filter((other) => !other.alone && !(tool.group === 'style' && other.group === 'style'));

// The selection after tapping a tool: a selected one is unselected; another is added (keptWith).
export function toggleTool(selected: AiTool[], tool: AiTool): AiTool[] {
  if (has(selected, tool)) {
    return selected.filter(({ id }) => id !== tool.id);
  }
  const kept = keptWith(selected, tool);
  return kept.length < MAX_SELECTED ? inOrder([...kept, tool]) : selected;
}

// A selected tool changes the whole photo (a style, Auto frame): no highlight meanwhile.
export const changesWholePhoto = (selected: AiTool[]) => selected.some(({ highlight }) => highlight === 'ignored');

const fitsHighlight = (tool: AiTool, hasHighlight: boolean) =>
  (tool.highlight !== 'required' || hasHighlight) && (tool.highlight !== 'ignored' || !hasHighlight);

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

// Whether Generate can send these.
export const canGenerate = (selected: AiTool[], words: string, hasHighlight: boolean) =>
  (selected.length > 0 || words.trim() !== '') &&
  selected.every((tool) => fitsHighlight(tool, hasHighlight) && (!tool.ask || words.trim() !== ''));

// The one instruction an edit sends.
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

// A result's label: the selected tools' names in order, then the words, joined with " + ".
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
