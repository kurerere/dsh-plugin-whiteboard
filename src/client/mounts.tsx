/**
 * The whiteboard tab: a view of the **current conversation's** board.
 *
 * The board is not a second chat. Its document belongs to the main Session (the
 * drawing tools belong to the main agent), so this tab body renders that one board
 * and a single-line input that sends a normal message into the same conversation.
 * Nothing here retains another Session, mounts the shipped composer, or knows
 * anything about whiteboard child Sessions.
 *
 * - {@link WhiteboardTab} is the registered body: board on top, input underneath.
 * - {@link WhiteboardBoard} is the bar plus the 2D canvas or three.js stage; it
 *   owns clear / undo / export and the empty-board hint.
 * - {@link WhiteboardComposer} writes into the shared draft and hands the text to
 *   the Host call that sends it; the Host face decides how that reaches the
 *   conversation.
 */

import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type ReactNode,
} from 'react'
import {
  Button, IconDownloadOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
  SegmentedControl, Tooltip, type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CaptureOptions, WhiteboardUndone } from '../shared.ts'
import type { BoardMode } from '../scene.ts'
import { surfaceCount } from './board.ts'
import { capture2d, useCapture, type CaptureFrame } from './capture.ts'
import type { DraftFace } from './model.ts'
import { surfacePaint } from './palette.ts'
import { useBoard } from './poll.ts'
import { Board2D } from './render2d.tsx'
import { Board3D, type Board3DCapture } from './render3d.tsx'
import type { NS } from './locales.ts'

/** Keys of the empty board's example prompts. */
const EXAMPLES = ['example.flow', 'example.lamp', 'example.timeline', 'example.kanban'] as const

/** Breathing room between the artboard and the stage edge, in CSS pixels. */
const PAGE_INSET = 12

/** How long the clear button stays armed, in milliseconds. */
const CLEAR_ARM_MS = 2600

/**
 * How long a status message ("已撤销上一批") stays in the bar, in milliseconds.
 *
 * It lives in the same slot as the count, so returning to the count shifts
 * nothing in the row: the actions are laid out after this slot and the spacer,
 * so only the slack between them changes.
 */
const FLASH_MS = 4000

/** How long an action error stays in the bar, in milliseconds. */
const ERROR_MS = 6000

/**
 * Undo glyph for the header bar. The primitives set has no undo arrow, so this
 * is drawn in the same language as the native icons (16-unit viewBox, 1.3
 * stroke, round caps/joins) and inherits `currentColor` like every `Icon*`.
 */
function UndoGlyph({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.1 6.9h6.6a3.5 3.5 0 0 1 0 7H6.2" />
      <path d="M5.9 4.1 3 6.9l2.9 2.8" />
    </svg>
  )
}

/** Local-time stamp for an exported file name: `20261028-0132`. */
function fileStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Name of an exported board image.
 * @param sessionId - main Session the board belongs to.
 * @param now - timestamp to stamp into the name.
 * @returns `whiteboard-<session short>-<yyyyMMdd-HHmm>.png`.
 */
function exportName(sessionId: string, now: Date): string {
  const short = sessionId.replace(/^session-/, '').slice(0, 8) || 'board'
  return `whiteboard-${short}-${fileStamp(now)}.png`
}

/**
 * Save the stage's canvas as a PNG.
 *
 * The canvas is copied onto an opaque surface first: the 3D stage keeps an alpha
 * channel (its background is the panel) and a transparent export looks broken in
 * any viewer. `preserveDrawingBuffer` on the WebGL renderer is what makes the 3D
 * copy contain the last frame at all.
 * @param canvas - the stage canvas to capture.
 * @param name - download file name.
 */
function saveCanvas(canvas: HTMLCanvasElement, name: string): void {
  const target = document.createElement('canvas')
  target.width = canvas.width
  target.height = canvas.height
  const context = target.getContext('2d')
  if (context === null) throw new Error('cannot create a 2D context')
  context.fillStyle = surfacePaint()
  context.fillRect(0, 0, target.width, target.height)
  context.drawImage(canvas, 0, 0)
  const anchor = document.createElement('a')
  anchor.href = target.toDataURL('image/png')
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** One stage measurement, in CSS pixels. */
interface StageSize {
  width: number
  height: number
}

/** Measure the stage element with a ResizeObserver (cheap, callback-ref based). */
function useStageSize(): { ref: (node: HTMLDivElement | null) => void; size: StageSize } {
  const [size, setSize] = useState<StageSize>({ width: 0, height: 0 })
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = undefined
    if (node === null) return
    const next = new ResizeObserver(() => {
      setSize({ width: node.clientWidth, height: node.clientHeight })
    })
    observer.current = next
    next.observe(node)
    setSize({ width: node.clientWidth, height: node.clientHeight })
  }, [])
  useEffect(() => () => { observer.current?.disconnect() }, [])
  return { ref, size }
}

// ---------------------------------------------------------------------------
// tab body
// ---------------------------------------------------------------------------

/** Business face the Host registration hands to the tab body. */
export interface WhiteboardTabInjected {
  /** Send one user message into the main conversation that owns this board. */
  say: (sessionId: string, text: string) => Promise<void>
  /** Clear one surface of this board. */
  clear: (sessionId: string, mode: BoardMode) => Promise<void>
  /** Step this board back one mutation. */
  undo: (sessionId: string) => Promise<WhiteboardUndone>
  /** The tab's composer draft, shared across remounts. */
  drafts: DraftFace
}

export type WhiteboardTabProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<WhiteboardTabInjected>

/** The part of the sidebar's live tab info this body reads. */
interface TabInfoFace {
  readonly tab: { readonly visible: boolean }
  readonly sidebar: { readonly fullscreen: boolean }
}

/**
 * Right-sidebar tab body for the Session the sidebar belongs to.
 *
 * The tab is a **view** of the board. It offers its own input only when the
 * conversation's composer is out of view — i.e. while the panel is presented
 * fullscreen. Docked beside the conversation, a second input would be a strictly
 * weaker duplicate of the one already on screen (no attachments, no `@`
 * references, no stop, no queue/steer choice) and, worse, a second draft: text
 * typed here is invisible in the main composer and vice versa. One conversation,
 * one input; the panel gets its own only when it is the whole window.
 * @param props - session-scoped tab props (the main Session) and the injected face.
 * @returns the board of this conversation, plus its input in the fullscreen case.
 */
export function WhiteboardTab(props: WhiteboardTabProps) {
  const { sessionId, useSession, say, clear, undo, drafts, t } = props
  const running = useSession(value => value.running)
  // The sidebar keeps bodies mounted for background Sessions and collapsed
  // columns, so a keyboard shortcut may only act for the tab the user can see.
  // `useTabInfo` is the sidebar's own answer; the board also re-checks the DOM at
  // key time in case a host ever renders the body without binding it.
  const readInfo = props.useTabInfo as (() => TabInfoFace) | undefined
  const info = readInfo?.()
  const visible = info?.tab.visible
  const standalone = info?.sidebar.fullscreen === true

  /** Put an example prompt in the input (never send it). */
  const fill = useCallback((text: string) => {
    drafts.set(sessionId, text)
    drafts.focus(sessionId)
  }, [drafts, sessionId])

  return (
    <div className="dshwb-root" data-whiteboard={sessionId} data-standalone={standalone ? 'true' : 'false'}>
      <WhiteboardBoard
        sessionId={sessionId}
        running={running}
        visible={visible}
        standalone={standalone}
        clear={clear}
        undo={undo}
        onPick={fill}
        t={t}
      />
      {standalone
        ? <WhiteboardComposer sessionId={sessionId} say={say} drafts={drafts} t={t} />
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// board surface
// ---------------------------------------------------------------------------

interface WhiteboardBoardProps {
  readonly sessionId: string
  /** Whether the main agent is running; the poller tightens while it is. */
  readonly running: boolean
  /** Whether the sidebar says this tab is visible; `undefined` when it cannot say. */
  readonly visible: boolean | undefined
  /**
   * Whether the tab owns its input (panel fullscreen). False while docked beside
   * the conversation, where the main composer is the only input.
   */
  readonly standalone: boolean
  readonly clear: WhiteboardTabInjected['clear']
  readonly undo: WhiteboardTabInjected['undo']
  /** Put an example prompt in the input. */
  readonly onPick: (text: string) => void
  readonly t: TranslateNS<typeof NS>
}

/**
 * The board: mode chips, surface actions, and the live drawing.
 * @param props - session identity, the agent's running state, Host calls and copy.
 * @returns the board column (header bar and stage).
 */
function WhiteboardBoard({ sessionId, running, visible, standalone, clear, undo, onPick, t }: WhiteboardBoardProps) {
  // A body the sidebar keeps mounted for a background Session or a collapsed
  // column stops polling until it is on screen again (an unknown answer polls).
  const { board, stale, canUndo } = useBoard(sessionId, running, visible !== false)
  const rev = board.rev
  const documentMode = board.mode
  const [view, setView] = useState<BoardMode>(documentMode)
  // One surface needs no choice. While only one of the two surfaces has content the
  // board shows that one, whatever the document's last touched surface says —
  // clearing the 3D scene used to leave a board with 2D shapes looking empty. The
  // 2D/3D switch therefore only exists when there really are two surfaces to switch
  // between: the model normally picks one, and a permanent toggle would be chrome
  // asking the user a question the model already answered.
  const has2d = board.canvas.shapes.length > 0
  const has3d = board.scene.objects.length > 0
  const bothSurfaces = has2d && has3d
  const surface: BoardMode = bothSurfaces ? view : has3d ? '3d' : '2d'
  const [pinned, setPinned] = useState(false)
  /**
   * The surface the clear button is armed for, not just "armed": arming 2D and
   * then switching to 3D must not let the second click clear 3D.
   */
  const [armed, setArmed] = useState<BoardMode | undefined>(undefined)
  const [resetKey, setResetKey] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Transient status message; a new object identity restarts its timer. */
  const [flash, setFlash] = useState<{ text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  /** The board column, used to answer "can the user see this tab?" at key time. */
  const boardRef = useRef<HTMLDivElement | null>(null)
  /** Mutable handle on the stage node, for the PNG export. */
  const stageNode = useRef<HTMLDivElement | null>(null)
  const { ref: measureStage, size } = useStageSize()
  const stageRef = useCallback((node: HTMLDivElement | null) => {
    stageNode.current = node
    measureStage(node)
  }, [measureStage])

  /** The stage has been measured; after this its canvas or WebGL engine exists. */
  const stageReady = size.width > 0 && size.height > 0

  /**
   * Latest board and surface, read by the capture hook at capture time. Keeping
   * them in refs is what lets that hook's polling effect stay armed across draws:
   * re-arming it on every revision would churn `AbortController`s and could drop
   * a request that arrived mid-draw.
   */
  const latestBoard = useRef(board)
  latestBoard.current = board
  const latestSurface = useRef<BoardMode>(surface)
  latestSurface.current = surface
  /** The 3D stage's capture handle; filled by `Board3D` once its engine is up. */
  const capture3d = useRef<Board3DCapture | undefined>(undefined)

  /**
   * Take the frame the model asked for.
   *
   * A request may name a surface, but a frame can only be taken of what is on
   * screen — that is the product decision behind this feature — so the displayed
   * surface wins and the answer reports it. Overlay, debug state and output size
   * are delegated to whichever renderer owns the pixels.
   */
  const snapshot = useCallback((options: CaptureOptions): CaptureFrame => {
    if (latestSurface.current === '3d') {
      const stage = capture3d.current
      if (stage === undefined) throw new Error('the 3D stage is not ready')
      return { ...stage.capture(options), mode: '3d' }
    }
    const stage = stageNode.current
    if (stage === null) throw new Error('the board stage is not mounted')
    return capture2d(stage, latestBoard.current, options)
  }, [])

  // Polls only while this tab is on screen and the stage is measurable, so an
  // idle board costs one 204 per tick and never renders a frame nobody sees.
  useCapture({ sessionId, surface, visible, ready: stageReady, revision: rev, snapshot })

  // Follow the surface the model just drew on, unless the user pinned one.
  useEffect(() => {
    if (pinned) return
    setView(documentMode)
  }, [documentMode, rev, pinned])

  // A pending confirmation belongs to the surface it was armed on.
  useEffect(() => { setArmed(undefined) }, [surface])

  useEffect(() => {
    if (armed === undefined) return undefined
    const timer = globalThis.setTimeout(() => { setArmed(undefined) }, CLEAR_ARM_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [armed])

  useEffect(() => {
    if (flash === undefined) return undefined
    const timer = globalThis.setTimeout(() => { setFlash(undefined) }, FLASH_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [flash])

  useEffect(() => {
    if (error === undefined) return undefined
    const timer = globalThis.setTimeout(() => { setError(undefined) }, ERROR_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [error])

  const choose = useCallback((next: BoardMode) => {
    if (next === view) {
      setPinned(false)
      return
    }
    setPinned(true)
    setView(next)
  }, [view])

  const onClear = useCallback(() => {
    if (busyRef.current) return
    if (armed !== surface) {
      setArmed(surface)
      return
    }
    setArmed(undefined)
    setError(undefined)
    clear(sessionId, surface).catch((failure: unknown) => {
      setError(t('error.clear', { error: (failure as Error).message }))
    })
  }, [armed, clear, sessionId, surface, t])

  /**
   * Step the board back one Host mutation.
   *
   * `canUndo` comes from the Host, never from a local guess: the undo stack is
   * Host state. `reverted: 'none'` is a normal answer (another tab got there
   * first, or the stack emptied), so it only refreshes, silently.
   */
  const onUndo = useCallback(() => {
    if (busyRef.current || !canUndo) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    setArmed(undefined)
    undo(sessionId)
      .then((result) => {
        if (result.reverted === 'draw') setFlash({ text: t('bar.undoDone') })
        else if (result.reverted === 'clear') setFlash({ text: t('bar.undoRestored') })
      })
      .catch((failure: unknown) => {
        setError(t('error.undo', { error: (failure as Error).message }))
      })
      .finally(() => {
        busyRef.current = false
        setBusy(false)
      })
  }, [canUndo, sessionId, t, undo])

  /** Save the visible stage (2D canvas or 3D frame) as a PNG. */
  const onExport = useCallback(() => {
    setError(undefined)
    const canvas = stageNode.current?.querySelector('canvas')
    // No canvas means the stage has not mounted yet (the button is disabled
    // while the surface is empty): nothing to save, nothing to complain about.
    if (canvas === null || canvas === undefined) return
    try {
      saveCanvas(canvas, exportName(sessionId, new Date()))
    } catch (failure) {
      setError(t('error.export', { error: (failure as Error).message }))
    }
  }, [sessionId, t])

  // Ctrl/Cmd+Z undoes the last batch, unless the caret is in a text field (the
  // tab's own input keeps its native undo) — the board is the only owner here.
  //
  // The listener is on `document`, but this body stays mounted for background
  // Sessions and collapsed columns, so the shortcut must prove the tab is on
  // screen before acting: the sidebar's own `tab.visible`, plus the DOM check the
  // shipped sidebar itself uses (`[hidden]`/`aria-hidden` ancestors and no boxes).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const active = document.activeElement
      if (active !== null && active.closest('textarea, input, [contenteditable]') !== null) return
      if (!canUndo || busyRef.current) return
      if (visible === false) return
      const node = boardRef.current
      if (node === null || node.getClientRects().length === 0) return
      if (node.closest('[hidden], [aria-hidden="true"]') !== null) return
      event.preventDefault()
      onUndo()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [canUndo, onUndo, visible])

  const count = surfaceCount(board, surface)
  const other: BoardMode = surface === '2d' ? '3d' : '2d'
  const modeControl = `dshwb-mode-${sessionId}`
  const pageSize = Math.max(0, Math.min(size.width, size.height) - PAGE_INSET * 2)
  const empty = count === 0

  // An empty board explains where the request goes, so the copy follows the input:
  // docked, the conversation's own composer is on screen and is the only one; the
  // tab only carries that sentence (and the example chips) when it owns the input.
  const hint: ReactNode = empty
    ? (
      <div className="dshwb-boardHint">
        <p className="dshwb-boardHintTitle">{t('board.empty.title')}</p>
        <p className="dshwb-boardHintBody">
          {t(standalone ? 'board.empty.body' : 'board.empty.bodyDocked')}
        </p>
        {standalone
          ? (
            <div className="dshwb-chips">
              {EXAMPLES.map(key => (
                <button key={key} type="button" className="dshwb-chip" onClick={() => { onPick(t(key)) }}>
                  {t(key)}
                </button>
              ))}
            </div>
          )
          : null}
      </div>
    )
    : undefined

  // The bar is one line: the meta slot carries whichever of these matters now,
  // so adding actions never changes the row's height or wraps it. A pending clear
  // confirmation is only shown for the surface it was armed on.
  const confirming = armed === surface
  const meta = error !== undefined
    ? { text: error, tone: 'error' as const }
    : confirming
      ? { text: t('bar.clearConfirm'), tone: 'error' as const }
      : flash !== undefined
        ? { text: flash.text, tone: 'status' as const }
        : {
          text: t(surface === '3d' ? 'bar.objects' : 'bar.shapes', { count: String(count) }),
          tone: 'count' as const,
        }

  return (
    <div className="dshwb-board" data-view={surface} data-pinned={pinned ? 'true' : 'false'} ref={boardRef}>
      <div className="dshwb-bar">
        {bothSurfaces
          ? (
            <SegmentedControl
              id={modeControl}
              value={surface}
              label={t('bar.mode')}
              onChange={choose}
              options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]}
            />
          )
          : null}
        <span
          className="dshwb-meta"
          data-tone={meta.tone}
          role={meta.tone === 'error' ? 'alert' : undefined}
          title={meta.tone === 'count' ? (pinned ? t('bar.pinnedHint') : t('bar.follow')) : meta.text}
        >
          {meta.text}
        </span>
        <span className="dshwb-grow" />
        {stale
          ? <span className="dshwb-stale" role="status" title={t('board.staleHint')}>{t('board.stale')}</span>
          : null}
        <Tooltip label={t('bar.undoHint')} side="bottom" delayMs={400}>
          <Button variant="ghost" size="sm" className="dshwb-iconBtn" disabled={!canUndo || busy}
            onClick={onUndo} aria-label={t('bar.undo')}>
            <UndoGlyph size={15} />
          </Button>
        </Tooltip>
        <Tooltip label={t('bar.exportHint')} side="bottom" delayMs={400}>
          <Button variant="ghost" size="sm" className="dshwb-iconBtn" disabled={empty}
            onClick={onExport} aria-label={t('bar.export')}>
            <IconDownloadOutlineRegular size={15} />
          </Button>
        </Tooltip>
        <Tooltip label={confirming ? t('bar.clearConfirmHint', { mode: surface === '3d' ? '3D' : '2D' }) : t('bar.clearHint')} side="bottom" delayMs={400}>
          <Button variant={confirming ? 'outline' : 'ghost'} size="sm"
            className={confirming ? 'dshwb-iconBtn dshwb-iconBtn--armed' : 'dshwb-iconBtn'}
            disabled={empty} onClick={onClear}
            aria-label={confirming ? t('bar.clearConfirm') : t('bar.clear')}>
            <IconTrashOutlineRegular size={15} />
          </Button>
        </Tooltip>
      </div>

      <div
        className="dshwb-stage"
        ref={stageRef}
        id={bothSurfaces ? `${modeControl}-${surface}-panel` : undefined}
        role={bothSurfaces ? 'tabpanel' : 'region'}
        aria-label={t(surface === '3d' ? 'board.hint.3d' : 'board.hint.2d')}
      >
        {bothSurfaces ? <div id={`${modeControl}-${other}-panel`} hidden /> : null}
        {!stageReady ? null : surface === '2d'
          ? <Board2D canvas={board.canvas} size={pageSize} hint={hint} />
          : (
            <Board3D
              scene={board.scene}
              resetKey={resetKey}
              hint={hint}
              captureRef={capture3d}
              fallback={<p className="dshwb-stageNotice">{t('webgl.unavailable')}</p>}
            />
          )}
        {surface === '3d' && count > 0
          ? (
            <Tooltip label={t('board.cameraReset')} side="left" delayMs={400}>
              <button type="button" className="dshwb-stageAction" aria-label={t('board.cameraReset')}
                onClick={() => { setResetKey(key => key + 1) }}>
                <IconRefreshOutlineRegular size={15} />
              </button>
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

interface WhiteboardComposerProps {
  readonly sessionId: string
  readonly say: WhiteboardTabInjected['say']
  readonly drafts: DraftFace
  readonly t: TranslateNS<typeof NS>
}

/**
 * The tab's single-line input: it sends an ordinary message into the current
 * conversation, which is what makes the model draw.
 *
 * It deliberately is not the shipped composer — the conversation already has one
 * mounted in the main view, and two composers over one draft and one submit path
 * is a conflict, not a feature. Enter sends (IME-safe), Shift+Enter is ignored
 * because the input is single-line.
 * @param props - session identity, the send call, the shared draft and copy.
 * @returns the input row.
 */
function WhiteboardComposer({ sessionId, say, drafts, t }: WhiteboardComposerProps) {
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => drafts.subscribe(sessionId, listener), [drafts, sessionId]),
    useCallback(() => drafts.get(sessionId), [drafts, sessionId]),
  )
  const focusRevision = useSyncExternalStore(
    useCallback((listener: () => void) => drafts.subscribeFocus(sessionId, listener), [drafts, sessionId]),
    useCallback(() => drafts.focusRevision(sessionId), [drafts, sessionId]),
  )
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** True while an IME owns the keyboard; Enter must not send then. */
  const [composing, setComposing] = useState(false)

  // An example prompt asks for the input's focus; the revision makes every
  // click count, even when the text did not change.
  useEffect(() => {
    if (focusRevision === 0) return
    inputRef.current?.focus()
  }, [focusRevision])

  useEffect(() => {
    if (error === undefined) return undefined
    const timer = globalThis.setTimeout(() => { setError(undefined) }, ERROR_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [error])

  const send = useCallback(() => {
    const text = value.trim()
    if (text === '' || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(undefined)
    say(sessionId, text)
      .then(() => {
        // Only clear what was sent: text typed while the round trip ran stays.
        if (drafts.get(sessionId) === value) drafts.set(sessionId, '')
      })
      .catch((failure: unknown) => {
        setError(t('error.say', { error: (failure as Error).message }))
      })
      .finally(() => {
        sendingRef.current = false
        setSending(false)
      })
  }, [drafts, say, sessionId, t, value])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (composing || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <div className="dshwb-composer">
      <div className="dshwb-composerRow">
        <input
          ref={inputRef}
          className="dshwb-input"
          type="text"
          value={value}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.placeholder')}
          spellCheck={false}
          onChange={(event) => { drafts.set(sessionId, event.target.value) }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { setComposing(true) }}
          onCompositionEnd={() => { setComposing(false) }}
        />
        <Button variant="primary" size="sm" disabled={value.trim() === '' || sending}
          onClick={send} aria-label={t('composer.send')}>
          {t('composer.send')}
        </Button>
      </div>
      {error === undefined
        ? <p className="dshwb-composerHint">{t('composer.hint')}</p>
        : <p className="dshwb-composerError" role="alert">{error}</p>}
    </div>
  )
}
