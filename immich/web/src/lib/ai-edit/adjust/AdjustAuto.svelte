<!--
  SelfPhotos Adjust: Auto, first in the Adjust tab. One click works out the light and colour
  sliders from the photo itself (adjust-auto.ts, from the preview already loaded); they can be
  moved after, and clicking again sets them from the photo again. Not part of Immich.
-->
<script lang="ts">
  import { autoAdjust, type AutoValues } from '#lib/ai-edit/adjust/adjust-auto.ts';
  import { Button } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    image: ImageBitmap | null;
    disabled: boolean;
    onAuto: (values: AutoValues) => void;
  }

  let { image, disabled, onAuto }: Props = $props();

  const auto = (picture: ImageBitmap) => {
    const canvas = new OffscreenCanvas(picture.width, picture.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return;
    }
    context.drawImage(picture, 0, 0);
    const { data } = context.getImageData(0, 0, picture.width, picture.height);
    canvas.width = canvas.height = 0; // free it now
    onAuto(autoAdjust(data, picture.width, picture.height));
  };
</script>

<Button
  size="small"
  shape="round"
  variant="outline"
  color="secondary"
  leadingIcon={mdiAutoFix}
  disabled={disabled || !image}
  onclick={() => image && auto(image)}
>
  {$t('editor_auto')}
</Button>
