// How good each candidate photo looks (sharpness, exposure), measured by the creations container on Immich's thumbnails. Each photo is measured once (asset_quality), at most QUALITY.perRun in one person's run. If the container is down or busy, picking goes on with the details alone.

import { measureQuality } from "../clients/creations.client.ts";
import { downloadTo } from "../clients/immich.client.ts";
import { MAX_BYTES, TIMEOUT_MS } from "../constants/creations.constants.ts";
import { QUALITY } from "../constants/memories.constants.ts";
import { shortlist } from "./memory-picks.service.ts";
import { qualityOf, saveQuality } from "./repositories/creations.repository.ts";
import type { Quality } from "../types/creations.types.ts";
import type { Credential } from "../types/immich.types.ts";
import type { Candidate, PickOptions } from "../types/memories.types.ts";
import { log } from "../utils/http.ts";
import { inFolder, inWorkFolder } from "../utils/work-folder.ts";

// One run's allowance, shared by all of a person's memories that day.
export type QualityBudget = { left: number; unavailable: boolean };

export function runBudget(): QualityBudget {
  return { left: QUALITY.perRun, unavailable: false };
}

async function measure(cred: Credential, ids: string[]): Promise<Map<string, Quality>> {
  return inWorkFolder(async (id, dir) => {
    const files: string[] = [];
    const fileIds: string[] = [];
    for (const [i, assetId] of ids.entries()) {
      try {
        await downloadTo(cred, `/api/assets/${encodeURIComponent(assetId)}/thumbnail?size=thumbnail&edited=true`, await inFolder(dir, `${i}.webp`), MAX_BYTES.thumbnail, 30_000);
        files.push(`${i}.webp`);
        fileIds.push(assetId);
      } catch {
      }
    }
    const measured = new Map<string, Quality>();
    if (files.length === 0) return measured;
    const results = await measureQuality(id, files, TIMEOUT_MS.quality);
    fileIds.forEach((assetId, i) => measured.set(assetId, results[i] ?? { sharpness: null, brightness: 0, p2: 0, p98: 0 }));
    return measured;
  });
}

// Quality for the candidates worth knowing it for, from the cache or measured now.
export async function qualityFor(
  cred: Credential, candidates: Candidate[], options: Omit<PickOptions, "count" | "start" | "end">, budget: QualityBudget,
): Promise<Map<string, Quality>> {
  const ids = shortlist(candidates, options, QUALITY.perMemory);
  const known = qualityOf(ids);
  const missing = ids.filter((id) => !known.has(id)).slice(0, budget.left);
  if (missing.length === 0 || budget.unavailable) return known;
  try {
    const measured = await measure(cred, missing);
    for (const [id, q] of measured) {
      saveQuality(id, q);
      known.set(id, q);
    }
    budget.left -= missing.length;
    log({ event: "quality_measured", photos: measured.size });
  } catch (error) {
    budget.unavailable = true;
    log({ event: "quality_unavailable", error: error instanceof Error ? error.message : String(error) });
  }
  return known;
}
