import { adjustPath, canAdjust, getAdjustAction } from '#lib/ai-edit/adjust/adjust-action.ts';
import type { MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';
import { mementoFlags } from '#lib/ai-edit/flags.svelte.ts';

const photo = { id: 'a1', isImage: true, isTrashed: false, isOwner: true };
const flags = (enabled: boolean | undefined) =>
  ({ adjust: enabled === undefined ? undefined : { enabled } }) as unknown as MementoFlags;

describe('Adjust entry', () => {
  afterEach(() => {
    mementoFlags.value = null;
  });

  it('works on your own photos only, not videos or the trash', () => {
    expect(canAdjust(photo)).toBe(true);
    expect(canAdjust({ ...photo, isOwner: false })).toBe(false);
    expect(canAdjust({ ...photo, isImage: false })).toBe(false);
    expect(canAdjust({ ...photo, isTrashed: true })).toBe(false);
    expect(canAdjust(undefined)).toBe(false);
  });

  it('follows the admin switch; a service without it counts as off; unknown yet counts as on', () => {
    mementoFlags.value = flags(false);
    expect(canAdjust(photo)).toBe(false);
    mementoFlags.value = flags(undefined);
    expect(canAdjust(photo)).toBe(false);
    mementoFlags.value = flags(true);
    expect(canAdjust(photo)).toBe(true);
    mementoFlags.value = null;
    expect(canAdjust(photo)).toBe(true);
  });

  it('shows its own Edit button only where Immich has none (motion photos)', () => {
    expect(getAdjustAction(photo, () => true, 'Editor').$if?.()).toBe(false);
    expect(getAdjustAction(photo, () => false, 'Editor').$if?.()).toBe(true);
    expect(getAdjustAction({ ...photo, isOwner: false }, () => false, 'Editor').$if?.()).toBe(false);
  });

  it('opens the chosen tab', () => {
    expect(adjustPath('a1')).toBe('/photos/adjust/a1?tab=adjust');
    expect(adjustPath('a1', 'filters')).toBe('/photos/adjust/a1?tab=filters');
  });
});
