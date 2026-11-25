// AI edit usage and limits (services/limits.service.ts).

export type Usage = {
  today: { used: number; limit: number };
  thisMonth: { used: number; limit: number; estimatedCostUsd: number };
};

export type PersonUsage = { userId: string; today: number; thisMonth: number; costUsd: number; dailyLimit: number; ownDailyLimit: number | null };

// Everyone's AI edits this month, for Memento admin (GET /admin/usage).
export type EveryonesUsage = { users: PersonUsage[]; month: { used: number; limit: number; costUsd: number }; defaultDailyLimit: number };

// Counted edits and their estimated cost (repositories/limits.repository.ts).
export type EditTotals = { count: number; costUsd: number };

// One person's counted edits this month, and how many of them were today.
export type PersonEditTotals = { userId: string; today: number; thisMonth: number; costUsd: number };

// An edit attempt as it's logged before Google is called.
export type NewEdit = { id: string; userId: string; assetId: string; day: string; model: string; promptChars: number };
