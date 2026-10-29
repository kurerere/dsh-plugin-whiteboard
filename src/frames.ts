/**
 * Durable, content-addressed storage for captured frames.
 *
 * A frame is a PNG the **open panel** rendered; the Host never draws anything
 * itself. That makes the store deliberately dumb about the board: `save` takes
 * the bytes plus a small {@link FrameMeta} description, so the same code serves
 * an ordinary look, the automatic frame after a mutation, a dry-run preview and
 * a before/after diff sheet. What a frame *means* belongs to the caller.
 *
 * Layout, under `<dsh home>/storages/whiteboard/frames/<session>/`:
 *
 * - `<hash>.png` — one file per distinct picture, named by the first 16 hex
 *   chars of the SHA-256 of its bytes. Saving identical pixels again therefore
 *   costs one hash, not another megabyte, and a frame's path is stable.
 * - `index.json` — the newest-first {@link FrameRecord} list, at most
 *   {@link MAX_RECORDS} entries. It is written with a temp file + rename and
 *   per-session serialisation, so a reader (the model-facing tool, the next
 *   save) never sees a half-written list. Files dropped from the index are
 *   deleted in the same serialised step, which is what keeps a long board
 *   session from growing a PNG hoard.
 *
 * Losing the index must not lose the picture: if the index write fails the
 * failure is logged and the frame is still returned (the model gets the path and
 * the image); only the listing is stale. Everything is `0600`/`0700`, so another
 * account on a shared machine cannot read the user's board.
 *
 * Reads (`list`/`byHash`/`read`) also run through the per-session chain, so a
 * `list` issued while a save is in flight answers with the save included instead
 * of racing it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boardStorageDirectory } from './board-store.ts'
import type { BoardMode, Camera3D } from './scene.ts'
import type { CaptureOptions } from './shared.ts'

/** Where a frame came from, for the index and the model-facing listing. */
export type FrameSource = 'look' | 'auto' | 'preview' | 'diff'

/** What the caller knows about one frame; everything but the bytes. */
export interface FrameMeta {
  /** Output width in pixels. */
  width: number
  /** Output height in pixels. */
  height: number
  /** Surface the frame shows. */
  mode: BoardMode
  /** Board revision the frame shows (the document's own `rev`). */
  rev: number
  /** Which capture produced it. */
  source: FrameSource
  /** Live camera at capture time (3D only). */
  camera?: Camera3D
  /** Capture options the panel actually rendered with. */
  options?: CaptureOptions
}

/** One indexed frame: its metadata plus where it lives. */
export interface FrameRecord extends FrameMeta {
  /** First 16 hex chars of the PNG's SHA-256; also the file's base name. */
  hash: string
  /** Absolute PNG path the model can open with `read_image`. */
  path: string
  /** Byte length of the PNG. */
  bytes: number
  /** ISO-8601 time the frame was saved. */
  at: string
}

/** One persisted frame. */
export interface SavedFrame {
  /** Absolute PNG path the model can open with `read_image`. */
  path: string
  /** Short content hash, stable for identical pixels. */
  hash: string
  /** Byte length of the PNG. */
  bytes: number
  /** The decoded bytes, so the attachment path does not read the file again. */
  data: Buffer
  /** The index entry, which carries the metadata the model was told about. */
  record: FrameRecord
}

/** Durable PNG storage for captured frames. */
export interface FrameStore {
  /**
   * Persist one base64 PNG and index it.
   *
   * Same pixels reuse the same file and hash; the metadata and timestamp of the
   * newest save win. Indexing is best effort: a failed index write is logged and
   * still resolves with the saved frame.
   * @param sessionId - board key.
   * @param png - base64 PNG, with or without a data-URL prefix.
   * @param meta - size, surface, revision and provenance of the frame.
   * @returns the saved frame, including its index record.
   * @throws when the bytes are not a PNG.
   */
  save(sessionId: string, png: string, meta: FrameMeta): Promise<SavedFrame>
  /**
   * The retained frames of one board, newest first.
   * @param sessionId - board key.
   * @param limit - at most this many records (`undefined` means all retained).
   * @returns copies are not made; treat the records as read-only.
   */
  list(sessionId: string, limit?: number): Promise<FrameRecord[]>
  /**
   * Resolve a hash prefix to one frame, newest match first.
   * @param sessionId - board key.
   * @param prefix - hex prefix of at least 6 chars, case-insensitive.
   * @returns the matching record, or `undefined` when nothing matches.
   */
  byHash(sessionId: string, prefix: string): Promise<FrameRecord | undefined>
  /**
   * Read one retained frame's bytes.
   * @param sessionId - board key.
   * @param hash - full hash or a hex prefix of at least 6 chars.
   * @returns the record and its PNG bytes, or `undefined` when unknown/unreadable.
   */
  read(sessionId: string, hash: string): Promise<{ record: FrameRecord; data: Buffer } | undefined>
  /**
   * Keep only the newest `keep` frames and delete the rest of the files.
   * @param sessionId - board key.
   * @param keep - how many records to retain (`0` drops every frame).
   * @returns how many records were dropped (files removed alongside them).
   * @throws when the index cannot be rewritten; the frames stay listed then.
   */
  prune(sessionId: string, keep: number): Promise<number>
}

/** The one logging method the store uses; `ctx.logger` satisfies it. */
export interface FrameLogger {
  warn(message: string): void
}

/** File that lists a session's frames, newest first. */
const INDEX_FILE = 'index.json'

/** How many frames one board keeps before the oldest are pruned. */
const MAX_RECORDS = 64

/** Hex chars of the SHA-256 used as the file name. */
const HASH_LENGTH = 16

/** Shortest hash prefix `byHash`/`read` will resolve. */
const MIN_HASH_PREFIX = 6

/** A hash or hash prefix the store accepts (always lower-cased first). */
const HASH_PREFIX = new RegExp(`^[0-9a-f]{${MIN_HASH_PREFIX},}$`)

/** A full hash written by this store. */
const FULL_HASH = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`)

/** PNG signature; a frame that is not a PNG is a panel bug, not art. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Accepted frame sources, in the order they appear in the docs. */
const FRAME_SOURCES: readonly FrameSource[] = ['look', 'auto', 'preview', 'diff']

/**
 * How many times one atomic replace is retried, and the linear backoff step.
 * Those are the same transient Windows sharing failures the board document
 * handles; an index or a PNG replaced while a reader has it open must not turn
 * into a lost frame.
 */
const RENAME_ATTEMPTS = 6
const RENAME_BACKOFF_MS = 15

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one non-negative integer (a pixel count or a revision), or undefined. */
function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number === undefined ? undefined : Math.max(0, Math.round(number))
}

/** Copy one `[x, y, z]` vector from untrusted metadata. */
function vec3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const [x, y, z] = value
  if (typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof z !== 'number' || !Number.isFinite(z)) return undefined
  return [x, y, z]
}

/** Copy one camera from metadata, dropping anything malformed. */
function sanitizeCamera(value: unknown): Camera3D | undefined {
  if (!isRecord(value)) return undefined
  const position = vec3(value['position'])
  const target = vec3(value['target'])
  const fov = finiteNumber(value['fov'])
  if (position === undefined || target === undefined || fov === undefined) return undefined
  return { position, target, fov }
}

/** Copy the capture options worth keeping in the index, dropping malformed keys. */
function sanitizeCaptureOptions(value: unknown): CaptureOptions | undefined {
  if (!isRecord(value)) return undefined
  const out: CaptureOptions = {}
  const mode = value['mode']
  if (mode === 'auto' || mode === '2d' || mode === '3d') out.mode = mode
  const overlay = value['overlay']
  if (overlay === 'none' || overlay === 'ids') out.overlay = overlay
  const debug = value['debug']
  if (debug === 'lit' || debug === 'shadow-only' || debug === 'per-light') out.debug = debug
  const angles = value['angles']
  if (angles === 'default' || angles === 'turntable') out.angles = angles
  const maxWidth = finiteNumber(value['maxWidth'])
  if (maxWidth !== undefined && maxWidth > 0) out.maxWidth = Math.round(maxWidth)
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Copy the caller's metadata into the fields the index stores, so a later
 * mutation of the caller's object (or a stray field) cannot leak into the file.
 * @param meta - what the caller described.
 * @returns a fresh {@link FrameMeta}.
 * @throws when the metadata is not an object at all (an internal call-site bug).
 */
function copyMeta(meta: FrameMeta): FrameMeta {
  const candidate: unknown = meta
  if (!isRecord(candidate)) {
    throw new Error('whiteboard: a saved frame needs metadata (width, height, mode, rev, source); '
      + 'pass the frame size and the board revision it was captured at')
  }
  const mode = candidate['mode']
  const source = candidate['source']
  const camera = sanitizeCamera(candidate['camera'])
  const options = sanitizeCaptureOptions(candidate['options'])
  return {
    width: nonNegativeInteger(candidate['width']) ?? 0,
    height: nonNegativeInteger(candidate['height']) ?? 0,
    mode: mode === '2d' || mode === '3d' ? mode : '2d',
    rev: nonNegativeInteger(candidate['rev']) ?? 0,
    source: FRAME_SOURCES.includes(source as FrameSource) ? source as FrameSource : 'look',
    ...(camera === undefined ? {} : { camera }),
    ...(options === undefined ? {} : { options }),
  }
}

/**
 * Keep a session id usable as exactly one directory name.
 *
 * Dots are allowed inside an id (Session ids use them), but `.` and `..` are not
 * directory names this store may resolve to: joining them would step out of the
 * frames root. Such ids cannot come from the board store, but the segment
 * function is the last line of defence, so it handles them itself.
 * @param value - board key.
 * @returns one safe path segment.
 */
function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._:-]/g, '_')
  return segment === '' || segment === '.' || segment === '..' ? '_' : segment
}

/**
 * Decode one index entry.
 * @param value - parsed JSON entry.
 * @param directory - the session directory, used to rebuild the path.
 * @returns the record, or `undefined` when it is not usable.
 */
function decodeRecord(value: unknown, directory: string): FrameRecord | undefined {
  if (!isRecord(value)) return undefined
  const hash = value['hash']
  if (typeof hash !== 'string') return undefined
  const normalized = hash.trim().toLowerCase()
  if (!FULL_HASH.test(normalized)) return undefined
  const camera = sanitizeCamera(value['camera'])
  const options = sanitizeCaptureOptions(value['options'])
  const meta = copyMeta({
    width: nonNegativeInteger(value['width']) ?? 0,
    height: nonNegativeInteger(value['height']) ?? 0,
    mode: value['mode'] === '3d' ? '3d' : '2d',
    rev: nonNegativeInteger(value['rev']) ?? 0,
    source: FRAME_SOURCES.includes(value['source'] as FrameSource) ? value['source'] as FrameSource : 'look',
    ...(camera === undefined ? {} : { camera }),
    ...(options === undefined ? {} : { options }),
  })
  const at = value['at']
  return {
    ...meta,
    hash: normalized,
    path: join(directory, `${normalized}.png`),
    bytes: nonNegativeInteger(value['bytes']) ?? 0,
    at: typeof at === 'string' ? at : new Date(0).toISOString(),
  }
}

/**
 * Rename a finished temp file over its target, retrying the transient sharing
 * failures a concurrent reader provokes on Windows.
 * @param temp - the fully written temp file.
 * @param path - the live file to replace.
 */
async function renameWithRetry(temp: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!transient || attempt >= RENAME_ATTEMPTS - 1) throw error
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1))
      })
    }
  }
}

/**
 * Write one file through a sibling temp file, so a reader only ever sees the old
 * file or the whole new one.
 * @param path - target file.
 * @param data - text or bytes to write.
 */
async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o600 })
    await renameWithRetry(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Decode one base64 frame, insisting on a real PNG signature.
 * @param png - base64 PNG, with or without a data-URL prefix.
 * @returns the PNG bytes.
 * @throws when the payload is empty or not a PNG.
 */
function decodePng(png: string): Buffer {
  if (typeof png !== 'string' || png === '') throw new Error('the panel returned an empty frame')
  const raw = png.startsWith('data:') ? png.slice(png.indexOf(',') + 1) : png
  const data = Buffer.from(raw, 'base64')
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('the panel returned a frame that is not a PNG')
  }
  return data
}

/** Where the model's frames live for one board. */
interface FrameDirectory {
  /** Absolute session directory. */
  path: string
  /** Absolute `index.json` path. */
  index: string
}

/**
 * Create the frame store under the current dsh home.
 * @param logger - optional diagnostics sink (the Host plugin context's logger).
 * @returns the store; directories are created on the first save.
 */
export function createFrameStore(logger?: FrameLogger): FrameStore {
  const root = join(boardStorageDirectory(), 'frames')
  /** One read/write chain per board, so index updates cannot interleave. */
  const chains = new Map<string, Promise<void>>()

  const warn = (message: string): void => {
    logger?.warn(message)
  }

  const directoryFor = (sessionId: string): FrameDirectory => {
    const path = join(root, safeSegment(sessionId))
    return { path, index: join(path, INDEX_FILE) }
  }

  /** Run one operation against a board after every earlier operation settled. */
  const serial = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId)
    const run = previous === undefined ? work() : previous.then(work, work)
    const tail: Promise<void> = run.then(() => undefined, () => undefined)
    chains.set(sessionId, tail)
    void tail.then(() => {
      if (chains.get(sessionId) === tail) chains.delete(sessionId)
    })
    return run
  }

  /**
   * Read the newest-first index. A missing index is an empty one; a corrupt one
   * is logged and treated the same way, because a board with pictures but no
   * list should still save the next frame.
   * @param directory - the session directory.
   * @returns usable records, newest first, at most {@link MAX_RECORDS}.
   */
  const readIndex = async (directory: FrameDirectory): Promise<FrameRecord[]> => {
    let text: string
    try {
      text = await readFile(directory.index, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') {
        warn(`whiteboard: reading the frame index ${directory.index} failed (${String(error)}); treating it as empty`)
      }
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      warn(`whiteboard: the frame index ${directory.index} is not JSON (${String(error)}); treating it as empty`)
      return []
    }
    // Both shapes are accepted so a hand-edited or versioned file still loads.
    const entries = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed['frames'])
        ? parsed['frames']
        : undefined
    if (entries === undefined) {
      warn(`whiteboard: the frame index ${directory.index} is not a frame list; treating it as empty`)
      return []
    }
    const records: FrameRecord[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const record = decodeRecord(entry, directory.path)
      if (record === undefined || seen.has(record.hash)) continue
      seen.add(record.hash)
      records.push(record)
      if (records.length >= MAX_RECORDS) break
    }
    return records
  }

  /** Replace the index; the caller already holds the session's chain. */
  const writeIndex = async (directory: FrameDirectory, records: readonly FrameRecord[]): Promise<void> => {
    await writeAtomic(directory.index, `${JSON.stringify(records)}\n`)
  }

  /**
   * Delete PNGs the index no longer references; the index is the only truth, so
   * a file missing from it is either pruned or an orphan of a failed index write.
   * @param directory - the session directory.
   * @param records - the records that must keep their files.
   * @returns how many files were removed.
   */
  const pruneFiles = async (directory: FrameDirectory, records: readonly FrameRecord[]): Promise<number> => {
    const keep = new Set(records.map(record => `${record.hash}.png`))
    let names: string[]
    try {
      names = await readdir(directory.path)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.png') || keep.has(name)) continue
      try {
        await rm(join(directory.path, name), { force: true })
        removed += 1
      } catch (error) {
        warn(`whiteboard: removing the pruned frame ${join(directory.path, name)} failed (${String(error)})`)
      }
    }
    return removed
  }

  /** Normalise a hash or prefix from an untrusted caller. */
  const normalizeHash = (value: string): string | undefined => {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim().toLowerCase()
    return HASH_PREFIX.test(normalized) ? normalized : undefined
  }

  const save = async (sessionId: string, png: string, meta: FrameMeta): Promise<SavedFrame> => {
    // Decode and judge before taking the session's chain: a bad frame fails fast.
    const data = decodePng(png)
    const copied = copyMeta(meta)
    const hash = createHash('sha256').update(data).digest('hex').slice(0, HASH_LENGTH)
    const directory = directoryFor(sessionId)
    return serial(sessionId, async () => {
      await mkdir(directory.path, { recursive: true, mode: 0o700 })
      const path = join(directory.path, `${hash}.png`)
      // Content-addressed, so rewriting the same bytes is idempotent.
      await writeAtomic(path, data)
      const record: FrameRecord = {
        ...copied,
        hash,
        path,
        bytes: data.length,
        at: new Date().toISOString(),
      }
      const previous = await readIndex(directory)
      const records = [record, ...previous.filter(entry => entry.hash !== hash)].slice(0, MAX_RECORDS)
      try {
        await writeIndex(directory, records)
      } catch (error) {
        // The picture is what the caller needs; only the listing is degraded.
        warn(`whiteboard: saving the frame index ${directory.index} failed (${String(error)}); `
          + 'the frame itself was saved and can still be read by path')
        return { path, hash, bytes: data.length, data, record }
      }
      try {
        await pruneFiles(directory, records)
      } catch (error) {
        warn(`whiteboard: pruning old frames in ${directory.path} failed (${String(error)})`)
      }
      return { path, hash, bytes: data.length, data, record }
    })
  }

  const list = async (sessionId: string, limit?: number): Promise<FrameRecord[]> => {
    const directory = directoryFor(sessionId)
    return serial(sessionId, async () => {
      const records = await readIndex(directory)
      if (limit === undefined) return records
      const count = finiteNumber(limit) === undefined ? records.length : Math.max(0, Math.floor(limit))
      return records.slice(0, count)
    })
  }

  const byHash = async (sessionId: string, prefix: string): Promise<FrameRecord | undefined> => {
    const wanted = normalizeHash(prefix)
    if (wanted === undefined) return undefined
    const directory = directoryFor(sessionId)
    return serial(sessionId, async () => {
      const records = await readIndex(directory)
      return records.find(record => record.hash.startsWith(wanted))
    })
  }

  const read = async (
    sessionId: string,
    hash: string,
  ): Promise<{ record: FrameRecord; data: Buffer } | undefined> => {
    const wanted = normalizeHash(hash)
    if (wanted === undefined) return undefined
    const directory = directoryFor(sessionId)
    return serial(sessionId, async () => {
      const records = await readIndex(directory)
      // An exact hash first, then the newest prefix match — the model may pass
      // either a full hash it read from a record or the short form it typed.
      const record = records.find(entry => entry.hash === wanted)
        ?? records.find(entry => entry.hash.startsWith(wanted))
      if (record === undefined) return undefined
      try {
        return { record, data: await readFile(record.path) }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code !== 'ENOENT') {
          warn(`whiteboard: reading the frame ${record.path} failed (${String(error)})`)
        }
        return undefined
      }
    })
  }

  const prune = async (sessionId: string, keep: number): Promise<number> => {
    const directory = directoryFor(sessionId)
    return serial(sessionId, async () => {
      const records = await readIndex(directory)
      const count = finiteNumber(keep) === undefined ? 0 : Math.max(0, Math.floor(keep))
      const kept = records.slice(0, count)
      const removed = records.length - kept.length
      if (removed === 0) return 0
      // An explicit prune is allowed to report a broken index: the caller asked
      // for the files to go, and leaving the list claiming them would be worse.
      await writeIndex(directory, kept)
      try {
        await pruneFiles(directory, kept)
      } catch (error) {
        warn(`whiteboard: pruning old frames in ${directory.path} failed (${String(error)})`)
      }
      return removed
    })
  }

  return { save, list, byHash, read, prune }
}
