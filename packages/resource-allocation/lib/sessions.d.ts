export interface SessionProjectSummary {
projectId: string;
projectName: string;
runs: number;
queueItems: number;
orphans: number;
lastSeen: number | null;
}
export interface SessionSummary {
sessionId: string;
runs: number;
queueItems: number;
orphans: number;
lastSeen: number | null;
projects: SessionProjectSummary[];
runIds: string[];
queueItemIds: string[];
orphanPids: number[];
owners: { agentIds: string[]; goalIds: string[]; jobIds: string[]; runIds: string[] };
}
export declare function normalizeSessionId(value: unknown): string | null;
export declare function normalizeOwner(owner: unknown, options?: { sessionId?: string | null }): Record<string, string> | null;
export declare function entryLastSeen(entry: unknown, options?: { type?: string | null; at?: number }): number | null;
export declare function buildSessionSummary(options?: {
runs?: Array<Record<string, unknown>>;
queueItems?: Array<Record<string, unknown>> | null;
waiting?: { entries?: Array<Record<string, unknown>> } | null;
orphans?: Array<Record<string, unknown>>;
projects?: Array<Record<string, unknown>>;
at?: number;
}): {
sessions: SessionSummary[];
unassigned: Record<string, unknown>;
counts: { sessions: number; ownerless: number; unassigned: number };
};
