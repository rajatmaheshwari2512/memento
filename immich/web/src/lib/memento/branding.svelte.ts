// SelfPhotos: "Memento" branding. Swaps the logos everywhere @immich/ui's <Logo> is used
// (navigation bar, login, onboarding, shared links, error pages, ...) through the kit's
// own logoManager, so no component that shows a logo needs to change.
// The mark is black in light mode and white in dark mode, following Immich's own theme
// setting (not just the system's), so it's updated whenever the theme changes.
// Imported once, for its side effect, by routes/+layout.svelte.
import inlineDarkUrl from '#lib/assets/memento/memento-inline-dark.svg';
import inlineLightUrl from '#lib/assets/memento/memento-inline-light.svg';
import markDarkUrl from '#lib/assets/memento/memento-mark-dark.svg';
import markLightUrl from '#lib/assets/memento/memento-mark-light.svg';
import stackedDarkUrl from '#lib/assets/memento/memento-stacked-dark.svg';
import stackedLightUrl from '#lib/assets/memento/memento-stacked-light.svg';
import { logoManager, Theme, themeManager } from '@immich/ui';

/** The mark for the current theme (black on light, white on dark). Reactive. */
export const mementoMark = () => (themeManager.value === Theme.Dark ? markDarkUrl : markLightUrl);

$effect.root(() => {
  $effect(() => {
    logoManager.setLogo({
      stacked: { light: stackedLightUrl, dark: stackedDarkUrl },
      unstacked: { light: inlineLightUrl, dark: inlineDarkUrl },
      // Immich's "made by FUTO" stacked logo: our plain stacked logo instead.
      stacked_futo: { light: stackedLightUrl, dark: stackedDarkUrl },
      // The kit uses one icon for both themes, so it's swapped here when the theme changes.
      icon: mementoMark(),
    });
  });
});
