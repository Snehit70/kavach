export type Status = "up-to-date" | "outdated" | "unknown";

export interface Package {
  manager: string;
  name: string;
  installed: string;
  latest?: string;
  status: Status;
  updateCmd?: string[];
  extra?: Record<string, unknown>;
}

export interface Adapter {
  name: string;
  available(): Promise<boolean>;
  scan(opts: { refresh: boolean }): Promise<Package[]>;
}
