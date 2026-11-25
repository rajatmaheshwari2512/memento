// AI tools' shared list (ai-tools.json, read by the Android app too), the rules for picking
// several for one edit, and which photos AI edits take.
import en from '#i18n/en.json';
import {
  AI_TOOLS,
  FULL_SIZE,
  MAX_ASK_WORDS,
  MAX_PHOTO,
  MAX_SELECTED,
  MAX_WORDS,
  blockedReason,
  canGenerate,
  combinedInstruction,
  combinedLabel,
  instructionFor,
  isFullSize,
  toggleTool,
  tooLargeForAi,
  toolAskKey,
  toolLabelKey,
  type AiTool,
} from '#lib/ai-edit/ai/ai-tools.ts';

// memento-extras refuses longer instructions (MAX_PROMPT_CHARS) and other tool names.
const MAX_PROMPT_CHARS = 1500;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}$/;
// The header before several items (the Android app's test has the same).
const HEADER =
  'Make all of these changes to the photo in one edit. Where an item says to keep something the same, that means apart from the other changes in this list:';

const tool = (id: string) => AI_TOOLS.find((candidate) => candidate.id === id)!;
const ids = (tools: AiTool[]) => tools.map(({ id }) => id);
// The selection after tapping these tools in turn.
const tapAll = (tapped: AiTool[]) => {
  let selected: AiTool[] = [];
  for (const next of tapped) {
    selected = toggleTool(selected, next);
  }
  return selected;
};
const pick = (...picked: string[]) => tapAll(picked.map((id) => tool(id)));

describe('AI tools', () => {
  it('every tool has a name the service accepts, a label, a group, and an instruction short enough with room for words', () => {
    const translations = en as unknown as Record<string, unknown>;
    expect(new Set(AI_TOOLS.map(({ id }) => id)).size).toBe(AI_TOOLS.length);
    for (const tool of AI_TOOLS) {
      expect(tool.id).toMatch(TOOL_NAME);
      expect(translations[toolLabelKey(tool)], tool.id).toBeTruthy();
      expect(['fix', 'style'], tool.id).toContain(tool.group);
      expect(instructionFor(tool, 'x'.repeat(MAX_ASK_WORDS)).length, tool.id).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
      if (tool.ask) {
        expect(translations[toolAskKey(tool)], tool.id).toBeTruthy();
      }
      // Move takes the thing elsewhere: pasting back only the highlighted area would lose it.
      if (tool.highlight !== 'optional') {
        expect(tool.pasteBack, tool.id).toBe(false);
      }
    }
    expect(MAX_SELECTED).toBe(3);
  });

  it('adds the words to a tool that asks for them', () => {
    const move = tool('move');
    expect(instructionFor(move, '  to the left ')).toBe(`${move.instruction} to the left`);
    const unblur = tool('unblur');
    expect(instructionFor(unblur, 'ignored')).toBe(unblur.instruction);
  });
});

describe('picking several tools', () => {
  it('toggles: several fixes, one style (another swaps it), a style with fixes', () => {
    expect(ids(pick('sky', 'enhance'))).toEqual(['enhance', 'sky']);
    expect(ids(pick('enhance', 'sky', 'enhance'))).toEqual(['sky']);
    expect(ids(pick('watercolour', 'sketch'))).toEqual(['sketch']);
    expect(ids(pick('watercolour', 'enhance', 'sky'))).toEqual(['enhance', 'sky', 'watercolour']);
    expect(ids(pick('enhance', 'sky', 'watercolour', 'painting'))).toEqual(['enhance', 'sky', 'painting']);
  });

  it('never combines Move: picking it clears the others, picking another clears it', () => {
    expect(ids(pick('enhance', 'watercolour', 'move'))).toEqual(['move']);
    expect(ids(pick('move', 'sky'))).toEqual(['sky']);
    expect(ids(pick('move', 'move'))).toEqual([]);
  });

  it('takes at most 3; then the unselected tools say why they wait, the selected ones can be unselected', () => {
    const three = pick('enhance', 'unblur', 'sky');
    expect(ids(toggleTool(three, tool('glare')))).toEqual(['enhance', 'unblur', 'sky']);
    expect(blockedReason(tool('glare'), three, false)).toBe('editor_ai_up_to');
    expect(blockedReason(tool('watercolour'), three, false)).toBe('editor_ai_up_to');
    expect(blockedReason(tool('sky'), three, false)).toBeNull();
    expect(blockedReason(tool('glare'), pick('enhance', 'sky'), false)).toBeNull();
  });

  it('with 3 selected, another style swaps in, Move goes alone, and the rest still wait', () => {
    const withStyle = pick('enhance', 'sky', 'watercolour');
    expect(blockedReason(tool('painting'), withStyle, false)).toBeNull();
    expect(ids(toggleTool(withStyle, tool('painting')))).toEqual(['enhance', 'sky', 'painting']);
    expect(blockedReason(tool('glare'), withStyle, false)).toBe('editor_ai_up_to');
    expect(ids(toggleTool(withStyle, tool('glare')))).toEqual(['enhance', 'sky', 'watercolour']);

    const fixes = pick('enhance', 'unblur', 'sky');
    expect(blockedReason(tool('move'), fixes, true)).toBeNull();
    expect(ids(toggleTool(fixes, tool('move')))).toEqual(['move']);
    expect(blockedReason(tool('move'), fixes, false)).toBe('editor_ai_needs_highlight');
    expect(blockedReason(tool('move'), withStyle, true)).toBeNull();
    expect(ids(toggleTool(withStyle, tool('move')))).toEqual(['move']);
    // No style selected to swap: a style waits like any other.
    expect(blockedReason(tool('watercolour'), fixes, false)).toBe('editor_ai_up_to');
    expect(ids(toggleTool(fixes, tool('watercolour')))).toEqual(['enhance', 'unblur', 'sky']);
  });

  it("keeps today's highlight rules: Move needs one, whole-photo tools need none", () => {
    expect(blockedReason(tool('move'), [], false)).toBe('editor_ai_needs_highlight');
    expect(blockedReason(tool('move'), [], true)).toBeNull();
    // Picked, then the highlight cleared: Move can still be unselected.
    expect(blockedReason(tool('move'), pick('move'), false)).toBeNull();
    expect(blockedReason(tool('watercolour'), [], true)).toBe('editor_ai_whole_only');
    expect(blockedReason(tool('reframe'), [], true)).toBe('editor_ai_whole_only');
    expect(blockedReason(tool('enhance'), [], true)).toBeNull();
  });

  it('Generate needs a tool or words; Move its words and a highlight; a whole-photo tool no highlight', () => {
    expect(canGenerate([], '  ', false)).toBe(false);
    expect(canGenerate([], 'make it warmer', false)).toBe(true);
    expect(canGenerate(pick('enhance', 'sky'), '', true)).toBe(true);
    expect(canGenerate(pick('move'), 'to the left', true)).toBe(true);
    expect(canGenerate(pick('move'), ' ', true)).toBe(false);
    expect(canGenerate(pick('move'), 'to the left', false)).toBe(false);
    expect(canGenerate(pick('watercolour'), '', false)).toBe(true);
    expect(canGenerate(pick('watercolour'), '', true)).toBe(false);
  });
});

describe('combinedInstruction', () => {
  // The Android app's test (ai_tools_test.dart) expects this same string.
  it('joins the tools in ai-tools.json order, then the words, into one list', () => {
    const expected =
      'Make all of these changes to the photo in one edit. Where an item says to keep something the same, that means apart from the other changes in this list:\n' +
      "- Enhance this photo the way a skilled photo editor would: balanced exposure, natural colour and white balance, more clarity and detail, less noise. Keep it realistic, and keep the content, the framing and every person's face exactly the same.\n" +
      "- Replace the sky with a beautiful, natural sky that suits the scene's time of day, and gently match the light on the rest of the scene to it. Keep everything that isn't sky where it is.\n" +
      '- Turn this photo into a delicate watercolour painting on textured paper, with soft washes of colour and visible brush strokes. Keep the composition, and keep the people recognisable.\n' +
      '- make it warmer';
    expect(combinedInstruction([tool('enhance'), tool('sky'), tool('watercolour')], 'make it warmer')).toBe(expected);
    expect(combinedInstruction([tool('watercolour'), tool('enhance'), tool('sky')], '  make it warmer \n')).toBe(
      expected,
    );
  });

  it('sends one item alone, as today: one preset, words alone, or Move with its words', () => {
    expect(combinedInstruction([tool('unblur')], '')).toBe(tool('unblur').instruction);
    expect(combinedInstruction([], '  make it warmer ')).toBe('make it warmer');
    expect(combinedInstruction([tool('move')], ' to the left ')).toBe(`${tool('move').instruction} to the left`);
    expect(combinedInstruction([tool('sky'), tool('glare')], '')).toBe(
      `${HEADER}\n- ${tool('sky').instruction}\n- ${tool('glare').instruction}`,
    );
    expect(combinedInstruction([tool('sky')], 'with clouds')).toBe(
      `${HEADER}\n- ${tool('sky').instruction}\n- with clouds`,
    );
  });

  it('fits the service with any selection the rules allow and the most words', () => {
    let longest = 0;
    for (const first of AI_TOOLS) {
      for (const second of AI_TOOLS) {
        for (const third of AI_TOOLS) {
          const selected = tapAll([first, second, third]);
          const words = 'x'.repeat(selected.some(({ ask }) => ask) ? MAX_ASK_WORDS : MAX_WORDS);
          longest = Math.max(longest, combinedInstruction(selected, words).length);
        }
      }
    }
    expect(longest).toBeGreaterThan(MAX_WORDS);
    expect(longest).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});

describe('combinedLabel', () => {
  const name = (picked: AiTool) => picked.id.toUpperCase();

  it("names the tools in order, then the words, joined with ' + '", () => {
    expect(combinedLabel([tool('watercolour'), tool('enhance')], ' warmer ', name)).toBe(
      'ENHANCE + WATERCOLOUR + warmer',
    );
    expect(combinedLabel([tool('unblur')], '', name)).toBe('UNBLUR');
    expect(combinedLabel([], 'make it warmer', name)).toBe('make it warmer');
  });

  it('names Move with its words after a colon, as before', () => {
    expect(combinedLabel([tool('move')], ' to the left ', name)).toBe('MOVE: to the left');
  });
});

// The Android app's test (ai_tools_test.dart) checks the same sizes.
describe('which photos AI edits take', () => {
  it('refuses a photo over 100 megapixels or 12,000 px on its longer side, by its size as shown', () => {
    expect(MAX_PHOTO).toEqual({ megapixels: 100, longSide: 12_000 });
    expect(tooLargeForAi({ width: 10_000, height: 10_000 })).toBe(false); // exactly 100 megapixels
    expect(tooLargeForAi({ width: 10_000, height: 10_001 })).toBe(true);
    expect(tooLargeForAi({ width: 12_000, height: 8000 })).toBe(false); // exactly 12,000 px
    expect(tooLargeForAi({ width: 8000, height: 12_001 })).toBe(true); // a narrow panorama, either way round
    expect(tooLargeForAi({ width: 12_001, height: 100 })).toBe(true);
    expect(tooLargeForAi({ width: 4080, height: 3072 })).toBe(false); // a phone's photo
  });

  it('takes a photo whose size Immich doesn’t know (the service checks it too)', () => {
    expect(tooLargeForAi({ width: null, height: null })).toBe(false);
    expect(tooLargeForAi({})).toBe(false);
  });
});

describe('isFullSize (the service’s check of a pasted copy)', () => {
  const photo = { width: 6000, height: 4000 };

  it('takes the photo itself, and a picture down to 90% on each side, never larger', () => {
    expect(FULL_SIZE).toEqual({ minShare: 0.9, aspectTolerance: 0.01 });
    expect(isFullSize({ width: 6000, height: 4000 }, photo)).toBe(true);
    expect(isFullSize({ width: 5760, height: 3840 }, photo)).toBe(true); // a RAW photo's full-size JPEG
    expect(isFullSize({ width: 5400, height: 3600 }, photo)).toBe(true); // exactly 90%
    expect(isFullSize({ width: 5399, height: 3600 }, photo)).toBe(false);
    expect(isFullSize({ width: 6001, height: 4000 }, photo)).toBe(false);
    expect(isFullSize({ width: 1440, height: 960 }, photo)).toBe(false); // Immich's preview
  });

  it('wants the same shape within 1%, upright as Immich shows it', () => {
    expect(isFullSize({ width: 6000, height: 3970 }, photo)).toBe(true); // 0.76% off
    expect(isFullSize({ width: 6000, height: 3960 }, photo)).toBe(false); // 1.01% off
    expect(isFullSize({ width: 4000, height: 6000 }, photo)).toBe(false); // turned
    // A nearly square photo, its picture turned: the same shape within 1%, but turned.
    expect(isFullSize({ width: 1000, height: 998 }, { width: 1000, height: 1005 })).toBe(false);
    expect(isFullSize({ width: 998, height: 1000 }, { width: 1000, height: 1005 })).toBe(true);
  });

  it('takes any picture of a photo whose size isn’t known', () => {
    expect(isFullSize({ width: 1440, height: 960 }, { width: null, height: null })).toBe(true);
  });
});
