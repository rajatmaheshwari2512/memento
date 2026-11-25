// Creations: collages, recap videos, animations and cinematic photos (services/creations.service.ts,
// creation-render.service.ts).

import type { Mood } from "../../creations/src/job.ts";

export type CreationKind = "collage" | "recap" | "animation" | "cinematic";

// Where and when a creation belongs: a collage or recap just before its memory's first photo,
// so it shows first in the memory and sits at the event in the timeline; an animation at its
// burst. `local` is the wall-clock time there.
export type CreationStamp = { local: string; offset: string; utc: string; gps: { lat: number; lon: number } | null };

// What a job makes, chosen when its memory is made (a recap also its music's moods; none in jobs
// proposed before moods existed).
export type JobItem = { id: string; image: boolean; durationMs?: number };
export type JobInputs = { items: JobItem[]; stamp: CreationStamp; moods?: Mood[] };

// A row of creation_jobs.
export type Job = {
  id: number; user_id: string; themed_memory_id: number; kind: CreationKind; inputs: string; state: string; rank: number;
  attempts: number; queued_on: string | null; next_at: string; asset_id: string | null; last_error: string | null; created_at: string; updated_at: string;
  card_id: number | null; work_id: string | null; rendered_at: string | null;
};

// Sunday's card, with the first photo's day of the memory it was made from.
export type CardRow = { id: number; user_id: string; week: string; themed_memory_id: number; source_memory_at: string; extra: number };
// A card waiting to become a memory, with the server errors it has had so far.
export type WaitingCard = CardRow & { attempts: number };

// A photo's measured quality (creations/src/quality.ts), or sharpness null if it couldn't be read.
export type Quality = { sharpness: number | null; brightness: number; p2: number; p98: number };
