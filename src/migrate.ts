/**
 * One-time migration of the retired whiteboard-child boards onto their parent.
 *
 * The previous architecture keyed a board by a hidden child Session
 * (`session-whiteboard-<uuid>`). The board is keyed by the **main Session** now,
 * so every legacy document must be adopted by the conversation it belonged to —
 * the user has real drawings in those files and they must survive the change.
 *
 * The migration is cheap and idempotent: it scans the board directory once per
 * activation, resolves each legacy Session's `parentSession` through
 * `sessionQuery`, and copies the file to `<parent>.json` **only when the parent
 * has no board document yet**. Nothing is ever overwritten, and when several
 * legacy boards share one parent the newest one wins (by the child's `createdAt`,
 * falling back to the file timestamp). The legacy files are left in place.
 */
import { copyFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { boardStorageDirectory } from './board-store.ts'
import { isLegacyWhiteboardId } from './shared.ts'

/** What one activation's migration found and did. */
export interface MigrationReport {
  /** Legacy boards adopted by their parent Session. */
  migrated: { from: string; to: string }[]
  /** Legacy boards left alone, with the reason. */
  skipped: { legacyId: string; reason: string }[]
}

/** One legacy board candidate, before the per-parent newest-wins decision. */
interface Candidate {
  legacyId: string
  parentSessionId: string
  createdAt: number
  file: string
}

/** A `sessionQuery` observation, released as soon as its header is read. */
interface Observation {
  header: { parentSession?: string; origin?: string; createdAt?: number }
  [Symbol.dispose]?: () => void
}

/** Read one Session header and release the observation immediately. */
async function headerOf(ctx: Context, sessionId: string): Promise<Observation['header'] | undefined> {
  const query = ctx.sessionQuery
  const observation = await query.observeSession(sessionId as never) as Observation
  try {
    return observation.header
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/** Whether a board document already exists for one Session. */
async function hasDocument(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Adopt every legacy whiteboard board onto its parent Session.
 * @param ctx - Host plugin context (session query and logging).
 * @returns what was migrated and what was skipped; never throws.
 */
export async function migrateLegacyBoards(ctx: Context): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], skipped: [] }
  const directory = boardStorageDirectory()
  let names: string[]
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json'))
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code !== 'ENOENT') ctx.logger.warn(`whiteboard: cannot scan ${directory} for legacy boards: ${String(error)}`)
    return report
  }

  const candidates: Candidate[] = []
  for (const name of names) {
    const legacyId = basename(name, '.json')
    if (!isLegacyWhiteboardId(legacyId)) continue
    const file = join(directory, name)
    let header: Observation['header'] | undefined
    try {
      header = await headerOf(ctx, legacyId)
    } catch {
      report.skipped.push({ legacyId, reason: 'session not found' })
      continue
    }
    const parentSessionId = header?.parentSession
    if (parentSessionId === undefined) {
      report.skipped.push({ legacyId, reason: 'session has no parent' })
      continue
    }
    // A board whose conversation no longer exists is unreachable; leave it alone.
    const parentExists = await headerOf(ctx, parentSessionId).then(() => true, () => false)
    if (!parentExists) {
      report.skipped.push({ legacyId, reason: 'parent Session not found' })
      continue
    }
    let createdAt = typeof header?.createdAt === 'number' ? header.createdAt : 0
    if (createdAt === 0) {
      createdAt = (await stat(file).catch(() => undefined))?.mtimeMs ?? 0
    }
    candidates.push({ legacyId, parentSessionId, createdAt, file })
  }

  // One parent, one board: keep the newest legacy board when several existed.
  const newest = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const current = newest.get(candidate.parentSessionId)
    if (current === undefined || candidate.createdAt > current.createdAt) newest.set(candidate.parentSessionId, candidate)
  }
  for (const candidate of candidates) {
    if (newest.get(candidate.parentSessionId) !== candidate) {
      report.skipped.push({ legacyId: candidate.legacyId, reason: 'an older board for the same conversation' })
    }
  }

  for (const candidate of newest.values()) {
    const target = join(directory, `${candidate.parentSessionId}.json`)
    if (await hasDocument(target)) {
      report.skipped.push({ legacyId: candidate.legacyId, reason: 'the conversation already has a board' })
      continue
    }
    try {
      await copyFile(candidate.file, target)
      report.migrated.push({ from: candidate.legacyId, to: candidate.parentSessionId })
      ctx.logger.info(`whiteboard: adopted board ${candidate.legacyId} as ${candidate.parentSessionId}`)
    } catch (error) {
      report.skipped.push({ legacyId: candidate.legacyId, reason: `copy failed: ${String(error)}` })
    }
  }

  if (report.migrated.length > 0) {
    ctx.logger.info(`whiteboard: migrated ${report.migrated.length} legacy board(s); ${report.skipped.length} left alone`)
  }
  return report
}
