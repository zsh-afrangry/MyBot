export type CronRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export function createManagedCron<Job = unknown, Run = unknown>(options: {port: number; request?: CronRequest}): {
  listJobs(): Promise<Job[]>;
  runs(id: string, limit: number): Promise<Run[]>;
  add(params: Record<string, unknown>): Promise<string>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
};
