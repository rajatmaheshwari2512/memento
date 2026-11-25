// SelfPhotos editor: saving a copy (Adjust's, or an AI edit), then waiting until Immich has
// made its thumbnails, so the viewer opened on it shows it. Immich makes them in the
// background, possibly before the save answers, so they're noted from the start; after a few
// seconds without them the copy opens anyway. Not part of Immich.

import { waitForWebsocketEvent, websocketEvents } from '#lib/stores/websocket.ts';

export async function saveCopy(save: () => Promise<{ assetId: string }>): Promise<string> {
  const ready: string[] = [];
  const stopListening = websocketEvents.on('on_upload_success', ({ id }) => {
    ready.push(id);
  });
  try {
    const { assetId } = await save();
    if (!ready.includes(assetId)) {
      await waitForWebsocketEvent('on_upload_success', ({ id }) => id === assetId, 8000).catch(() => {});
    }
    return assetId;
  } finally {
    stopListening();
  }
}
