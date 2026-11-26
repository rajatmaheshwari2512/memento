// SelfPhotos: "Memento" branding.
import inlineDarkUrl from '#lib/assets/memento/memento-inline-dark.svg';
import inlineLightUrl from '#lib/assets/memento/memento-inline-light.svg';
import markDarkUrl from '#lib/assets/memento/memento-mark-dark.svg';
import markLightUrl from '#lib/assets/memento/memento-mark-light.svg';
import stackedDarkUrl from '#lib/assets/memento/memento-stacked-dark.svg';
import stackedLightUrl from '#lib/assets/memento/memento-stacked-light.svg';
import { logoManager, Theme, themeManager } from '@immich/ui';

/** The mark for the current theme (black on light, white on dark). */
export const mementoMark = () => (themeManager.value === Theme.Dark ? markDarkUrl : markLightUrl);

$effect.root(() => {
  $effect(() => {
    logoManager.setLogo({
      stacked: { light: stackedLightUrl, dark: stackedDarkUrl },
      unstacked: { light: inlineLightUrl, dark: inlineDarkUrl },
      stacked_futo: { light: stackedLightUrl, dark: stackedDarkUrl },
      icon: mementoMark(),
    });
  });
});
