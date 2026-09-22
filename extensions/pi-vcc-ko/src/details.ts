import type { CompactionReason } from "./types.ts";

export interface PiVccCompactionDetails {
	compactor: "pi-vcc-ko";
	version: number;
	sections: string[];
	sourceMessageCount: number;
	previousSummaryUsed: boolean;
	reason?: CompactionReason;
	willRetry?: boolean;
}
