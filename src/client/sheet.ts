/**
 * Contact-sheet composition for multi-view captures.
 *
 * `whiteboard_look` can ask for more than one view of a 3D board: `per-light`
 * renders the same scene once per shadow-casting light, and `angles: 'turntable'`
 * renders four yaws around the scene target. Both answer with **one** image,
 * because the wire contract carries a single PNG per capture and the model reads
 * one picture far more cheaply than four. This module is the part that turns those
 * extra views into that one picture: a titled grid of tiles, each captioned with
 * what it shows, painted on the board's own surface.
 *
 * The tiles are produced by `render3d.tsx` at their final pixel size, so the
 * compositor is a straight-line layout job: it never re-renders three.js, never
 * touches the live stage, and only ever writes to a fresh 2D canvas. Everything
 * visual comes from `palette.ts` (`surfacePaint()`, `resolvePaint('ink')`,
 * `fontStack()`), so a sheet reads in both the light and the dark palette and
 * follows a theme flip like the rest of the board.
 */

import { fontStack, resolvePaint, surfacePaint } from './palette.ts'

/** One picture and the caption printed under it. */
export interface SheetTile {
  /** The view, already rendered at (about) its column width. */
  canvas: HTMLCanvasElement
  /** Caption printed in the strip under this tile. */
  label: string
}

/** How a contact sheet is laid out. */
export interface SheetOptions {
  /** Tiles per row; clamped to the tile count and to at least one. */
  columns: number
  /**
   * Total sheet width in pixels, *before* any later downscale. The composed
   * canvas never exceeds it: columns are sized to fit what is left after the
   * padding and the gaps.
   */
  width: number
  /** Heading printed above the grid; omitted or empty means no heading row. */
  title?: string
  /** Space between tiles, in pixels. Default 10. */
  gap?: number
  /** Space around the grid, in pixels. Default 12. */
  pad?: number
  /** Height of each caption strip, in pixels. Default 26. */
  labelHeight?: number
}

/** A composed contact sheet. */
export interface Sheet {
  /** The sheet, sized `canvas.width × canvas.height` output pixels. */
  canvas: HTMLCanvasElement
  /** Tile captions in tile order, suitable for `CaptureAnswer.tiles`. */
  labels: string[]
}

/** Default space between tiles, in pixels. */
const DEFAULT_GAP = 10
/** Default space around the grid, in pixels. */
const DEFAULT_PAD = 12
/** Default height of one caption strip, in pixels. */
const DEFAULT_LABEL_HEIGHT = 26
/** Type size of the sheet heading, in CSS pixels. */
const TITLE_SIZE = 15
/** Type size of a tile caption, in CSS pixels. */
const LABEL_SIZE = 12
/** Gap between the heading strip and the first tile row, as a multiple of the title size. */
const TITLE_STRIP = 2
/** Smallest column width the compositor bothers to lay out, in pixels. */
const MIN_COLUMN = 8

/**
 * Shorten a caption that does not fit its column.
 *
 * A tile label is data — `#4 directional 0` — so it is better to cut it visibly
 * than to let it run over the neighbouring tile or scale it into unreadability.
 * @param context - context of the sheet, with the caption font already set.
 * @param label - caption to print.
 * @param maxWidth - width available for the caption, in output pixels.
 * @returns the label, shortened with an ellipsis when it has to be.
 */
function fitLabel(context: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (context.measureText(label).width <= maxWidth) return label
  const ellipsis = '…'
  const characters = [...label]
  while (characters.length > 0 && context.measureText(`${characters.join('')}${ellipsis}`).width > maxWidth) {
    characters.pop()
  }
  return `${characters.join('')}${ellipsis}`
}

/**
 * Compose rendered views into one captioned contact sheet.
 *
 * Layout: one optional heading strip, then `rows` rows of `columns` tiles. Every
 * tile is scaled to its column width (aspect preserved) and centred in its cell,
 * so a grid of same-aspect views lines up exactly; the row height comes from the
 * **first** tile, which is what keeps the sheet's own aspect stable whatever the
 * later views contain. Captions sit in their own strip under each tile rather
 * than on top of the picture, where they would cover the very thing the view was
 * taken to show.
 * @param tiles - rendered views with their captions, in reading order.
 * @param options - grid shape, total width, and the optional heading.
 * @returns the sheet canvas and its captions; never larger than `options.width`.
 */
export function composeSheet(tiles: SheetTile[], options: SheetOptions): Sheet {
  const pad = Math.max(0, Math.round(options.pad ?? DEFAULT_PAD))
  const gap = Math.max(0, Math.round(options.gap ?? DEFAULT_GAP))
  const labelHeight = Math.max(0, Math.round(options.labelHeight ?? DEFAULT_LABEL_HEIGHT))
  const columns = Math.max(1, Math.min(Math.round(options.columns), Math.max(1, tiles.length)))
  const width = Math.max(1, Math.round(options.width))
  const title = options.title?.trim() ?? ''
  const titleHeight = title === '' ? 0 : Math.round(TITLE_SIZE * TITLE_STRIP)
  const rows = tiles.length === 0 ? 0 : Math.ceil(tiles.length / columns)

  // Columns share whatever the padding and the gaps leave; the sheet's own width
  // is the sum of the real columns, so the result can be a few pixels narrower
  // than `options.width` (never wider).
  const usable = width - pad * 2 - gap * (columns - 1)
  const columnWidth = Math.max(MIN_COLUMN, Math.floor(usable / columns))
  const first = tiles[0]
  const rowHeight = first === undefined
    ? 0
    : Math.max(1, Math.round((columnWidth * first.canvas.height) / Math.max(1, first.canvas.width)))
  const totalWidth = Math.max(1, Math.min(width, pad * 2 + columns * columnWidth + gap * (columns - 1)))
  const totalHeight = Math.max(
    1,
    pad * 2 + titleHeight + rows * (rowHeight + labelHeight) + Math.max(0, rows - 1) * gap,
  )

  const canvas = document.createElement('canvas')
  canvas.width = totalWidth
  canvas.height = totalHeight
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('cannot create a 2D context for the contact sheet')
  // The board surface is opaque in both palettes, and the tiles were captured
  // over it: the sheet has to start from the same paint or the gaps between the
  // tiles would read as holes in an exported PNG.
  context.fillStyle = surfacePaint()
  context.fillRect(0, 0, totalWidth, totalHeight)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const font = fontStack()
  const ink = resolvePaint('ink')

  if (title !== '') {
    context.save()
    context.fillStyle = ink
    context.font = `600 ${TITLE_SIZE}px ${font}`
    context.textAlign = 'left'
    context.textBaseline = 'middle'
    context.fillText(title, pad, pad + titleHeight / 2, Math.max(1, totalWidth - pad * 2))
    context.restore()
  }

  const top = pad + titleHeight
  tiles.forEach((tile, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = pad + column * (columnWidth + gap)
    const y = top + row * (rowHeight + labelHeight + gap)
    // Scale to the column width; the aspect-correct height is what gets centred
    // in the row (identical to the row height for the usual case of one scene
    // captured at one size).
    const drawHeight = Math.max(
      1,
      Math.round((columnWidth * tile.canvas.height) / Math.max(1, tile.canvas.width)),
    )
    context.save()
    // A tile whose aspect is wider than the row would otherwise run into its
    // caption strip and the next row; clip rather than shrink, so the tiles of a
    // sheet keep one shared scale.
    context.beginPath()
    context.rect(x, y, columnWidth, rowHeight)
    context.clip()
    context.drawImage(tile.canvas, x, y + (rowHeight - drawHeight) / 2, columnWidth, drawHeight)
    context.restore()

    context.save()
    context.fillStyle = ink
    context.font = `500 ${LABEL_SIZE}px ${font}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(
      fitLabel(context, tile.label, columnWidth - 8),
      x + columnWidth / 2,
      y + rowHeight + labelHeight / 2,
      Math.max(1, columnWidth - 8),
    )
    context.restore()
  })

  return { canvas, labels: tiles.map(tile => tile.label) }
}
