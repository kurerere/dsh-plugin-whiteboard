import type { Context } from '@deepseek-ai/cordis';
/** What one activation's migration found and did. */
export interface MigrationReport {
    /** Legacy boards adopted by their parent Session. */
    migrated: {
        from: string;
        to: string;
    }[];
    /** Legacy boards left alone, with the reason. */
    skipped: {
        legacyId: string;
        reason: string;
    }[];
}
/**
 * Adopt every legacy whiteboard board onto its parent Session.
 * @param ctx - Host plugin context (session query and logging).
 * @returns what was migrated and what was skipped; never throws.
 */
export declare function migrateLegacyBoards(ctx: Context): Promise<MigrationReport>;
