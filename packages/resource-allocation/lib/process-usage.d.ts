export declare const DEFAULT_PROCESS_LIMIT: number;
export declare const MAX_PROCESS_LIMIT: number;
export interface ProcessUsageRow {
pid: number;
ppid: number;
comm: string;
state: string;
rssBytes: number;
cpuPct: number;
sessionId: string | null;
cgroup: string | null;
inDshWeb: boolean;
command: string;
}
export declare function rankProcessUsage(rows: ProcessUsageRow[], options?: { limit?: number; sort?: "rss" | "cpu" }): ProcessUsageRow[];
export declare function readProcessUsage(options?: {
sessionId?: string | null;
limit?: number;
sort?: "rss" | "cpu";
root?: string;
sampleMs?: number;
read?: (path: string) => string | null;
readdir?: () => string[];
sleep?: (ms: number) => Promise<void>;
}): Promise<{
at: number;
scope: "session" | "system";
sessionId: string | null;
sort: "rss" | "cpu";
limit: number;
sampleMs: number;
processes: ProcessUsageRow[];
}>;
