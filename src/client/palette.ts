/**
 * Paint resolution for the browser face.
 *
 * The board document stores paints as **palette tokens** (`blue`, `ink`, …) or
 * literal `#rrggbb` colors. Canvas and three.js need real colors, so every paint
 * is resolved here:
 *
 * 1. a token backed by a shipped dsh theme variable resolves against that
 *    variable (`--dsw-static-blue-500`, `--dsw-alias-label-primary`, …), which
 *    is what makes a board drawn in light mode still read in dark mode;
 * 2. tokens with no shipped variable (cyan, teal, lime, yellow, orange, pink,
 *    purple, indigo) use the light/dark table below, which is the only place in
 *    this plugin where color literals are allowed;
 * 3. an unknown paint string is parsed by the browser and falls back to the
 *    document's primary label color.
 *
 * Resolution goes through one offscreen probe element so `var()` chains,
 * `color-mix()` and `hsl()` all collapse to an `rgb()`/`rgba()` string that both
 * `CanvasRenderingContext2D` and `THREE.Color` understand. Results are cached per
 * theme revision; a theme flip (the shell toggling `body[data-ds-dark-theme]`)
 * clears the cache and notifies subscribers so renderers can redraw.
 */

import { PALETTE_TOKENS, type Paint, type PaletteToken } from '../scene.ts'

/** Which palette the document is painting in. */
export type ThemeMode = 'light' | 'dark'

/** Tokens backed by a shipped theme variable. */
const TOKEN_VARIABLE: Readonly<Partial<Record<PaletteToken, string>>> = {
  ink: '--dsw-alias-label-primary',
  muted: '--dsw-alias-label-tertiary',
  blue: '--dsw-static-blue-500',
  green: '--dsw-static-green-500',
  amber: '--dsw-static-amber-500',
  red: '--dsw-static-red-500',
  white: '--dsw-static-neutral-00',
  black: '--dsw-static-neutral-1000',
}

/**
 * Theme-specific override of a shared variable, applied before {@link TOKEN_VARIABLE}.
 *
 * `muted` paints incidental text that still has to be *read*: the shape count, the
 * composer hint, the empty-state body, and card sub-labels inside a drawing. The
 * shipped tertiary label measures 3.7:1 on the light panel — below AA for body
 * text — while the secondary label is 5.8:1 and still quieter than `ink`. Dark
 * keeps tertiary, where the same grey is legible on the dark surface.
 */
const TOKEN_VARIABLE_BY_THEME: Readonly<Partial<Record<PaletteToken, Readonly<Partial<Record<ThemeMode, string>>>>>> = {
  muted: { light: '--dsw-alias-label-secondary' },
}

/**
 * Fallback table for the tokens with no shipped variable, plus a safety net for
 * every token when the theme variables are not present (a standalone render, a
 * host page that never mounted `ui-theme`). Values are picked to sit on the dsh
 * surfaces of their own mode.
 */
const TOKEN_FALLBACK: Readonly<Record<PaletteToken, { readonly light: string; readonly dark: string }>> = {
  ink: { light: '#0f1115', dark: '#f9fafb' },
  muted: { light: '#81858c', dark: '#adb2b8' },
  blue: { light: '#3b82f6', dark: '#3b82f6' },
  cyan: { light: '#0891b2', dark: '#22d3ee' },
  teal: { light: '#0d9488', dark: '#2dd4bf' },
  green: { light: '#22c55e', dark: '#22c55e' },
  lime: { light: '#65a30d', dark: '#a3e635' },
  yellow: { light: '#ca8a04', dark: '#facc15' },
  amber: { light: '#f59e0b', dark: '#f59e0b' },
  orange: { light: '#ea580c', dark: '#fb923c' },
  red: { light: '#ef4444', dark: '#ef4444' },
  pink: { light: '#db2777', dark: '#f472b6' },
  purple: { light: '#7c3aed', dark: '#a78bfa' },
  indigo: { light: '#4f46e5', dark: '#818cf8' },
  white: { light: '#ffffff', dark: '#ffffff' },
  black: { light: '#000000', dark: '#000000' },
}

/** Font stack used when the document exposes none. */
const FALLBACK_FONT_STACK = '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'

const TOKENS: ReadonlySet<string> = new Set(PALETTE_TOKENS)

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(/i

/** One cached resolution per theme revision. */
let revision = 0
/** Memoized resolutions; cleared whenever the theme revision moves. */
const resolved = new Map<string, string>()
/** Theme listeners (renderers redraw on a palette change). */
const listeners = new Set<() => void>()
let observer: MutationObserver | undefined
let probe: HTMLDivElement | undefined

function documentBody(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  return document.body ?? undefined
}

/** Offscreen element used only to collapse a CSS color into `rgb()` form. */
function ensureProbe(): HTMLDivElement | undefined {
  if (probe !== undefined && probe.isConnected) return probe
  const body = documentBody()
  if (body === undefined) return undefined
  const element = document.createElement('div')
  element.setAttribute('aria-hidden', 'true')
  element.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden'
  body.appendChild(element)
  probe = element
  return element
}

/**
 * Pull one theme variable off the document and normalize it to a canvas color.
 * @param name - custom property name, `--dsw-…`.
 * @returns `rgb()`/`rgba()` color, or undefined when the variable is absent.
 */
function readVariable(name: string): string | undefined {
  const body = documentBody()
  if (body === undefined) return undefined
  const declared = globalThis.getComputedStyle(body).getPropertyValue(name)
  if (declared.trim() === '') return undefined
  return normalizeColor(declared)
}

/**
 * Collapse any CSS color expression to the `rgb()` form canvas and three.js read.
 * @param value - hex, rgb(), hsl(), var() chain, or color-mix() expression.
 * @returns the normalized color, or undefined when the browser rejects it.
 */
function normalizeColor(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (HEX_COLOR.test(trimmed)) return trimmed
  if (RGB_COLOR.test(trimmed)) return trimmed
  const element = ensureProbe()
  if (element === undefined) return undefined
  element.style.color = trimmed
  if (element.style.color === '') return undefined
  const computed = globalThis.getComputedStyle(element).color
  element.style.color = ''
  return RGB_COLOR.test(computed) ? computed : undefined
}

/**
 * The palette the document is painting in.
 * @returns `dark` while the shell marks the body with `data-ds-dark-theme`.
 */
export function currentTheme(): ThemeMode {
  const body = documentBody()
  if (body !== undefined) return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  if (typeof globalThis.matchMedia === 'function') {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

/**
 * Observe palette changes.
 * @param listener - called after a theme flip, once the cache has been dropped.
 * @returns unsubscribe function.
 */
export function subscribeTheme(listener: () => void): () => void {
  if (observer === undefined && typeof MutationObserver !== 'undefined') {
    const body = documentBody()
    if (body !== undefined) {
      observer = new MutationObserver(() => {
        revision += 1
        resolved.clear()
        for (const each of [...listeners]) each()
      })
      observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    }
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function resolveToken(token: PaletteToken, theme: ThemeMode): string {
  const overridden = TOKEN_VARIABLE_BY_THEME[token]?.[theme]
  if (overridden !== undefined) {
    const value = readVariable(overridden)
    if (value !== undefined) return value
  }
  const variable = TOKEN_VARIABLE[token]
  if (variable !== undefined) {
    const value = readVariable(variable)
    if (value !== undefined) return value
  }
  return TOKEN_FALLBACK[token][theme]
}

function computePaint(paint: Paint, theme: ThemeMode): string {
  if (TOKENS.has(paint)) return resolveToken(paint as PaletteToken, theme)
  const literal = normalizeColor(paint)
  if (literal !== undefined) return literal
  return resolveToken('ink', theme)
}

/**
 * Resolve a board paint into a canvas/three.js color.
 * @param paint - palette token or literal color.
 * @param fallback - paint used when `paint` is null/undefined.
 * @returns an `rgb()`/`rgba()`/hex string.
 */
export function resolvePaint(paint: Paint | null | undefined, fallback: Paint = 'ink'): string {
  const theme = currentTheme()
  const wanted = paint ?? fallback
  const key = `${revision}|${theme}|${String(wanted)}`
  const hit = resolved.get(key)
  if (hit !== undefined) return hit
  const value = computePaint(wanted, theme)
  resolved.set(key, value)
  return value
}

/**
 * Add alpha to a resolved color.
 * @param color - hex or `rgb()`/`rgba()` color produced by {@link resolvePaint}.
 * @param alpha - 0..1 multiplier; an existing rgba alpha is combined.
 * @returns an `rgba()` color.
 */
export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha))
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)
  if (hex !== null) {
    let digits = hex[1] ?? ''
    if (digits.length === 3) digits = digits.split('').map(part => part + part).join('')
    const red = Number.parseInt(digits.slice(0, 2), 16)
    const green = Number.parseInt(digits.slice(2, 4), 16)
    const blue = Number.parseInt(digits.slice(4, 6), 16)
    const base = digits.length >= 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1
    return `rgba(${red}, ${green}, ${blue}, ${round(clamped * base)})`
  }
  const parts = /^rgba?\(([^)]+)\)$/i.exec(color.trim())
  if (parts === null) return color
  const values = (parts[1] ?? '').split(/[,\s/]+/).filter(part => part !== '')
  const red = Number.parseFloat(values[0] ?? '0')
  const green = Number.parseFloat(values[1] ?? '0')
  const blue = Number.parseFloat(values[2] ?? '0')
  const existing = values.length > 3 ? Number.parseFloat(values[3] ?? '1') : 1
  return `rgba(${round(red)}, ${round(green)}, ${round(blue)}, ${round(clamped * (Number.isFinite(existing) ? existing : 1))})`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * The paint used for the dot grid on the board page.
 * @returns a translucent ink color that reads in both palettes.
 */
export function gridPaint(): string {
  return withAlpha(resolvePaint('ink'), currentTheme() === 'dark' ? 0.22 : 0.15)
}

/**
 * The paint used for a shape's soft drop shadow. The shell's mask token is a
 * dark translucent black in both palettes, which is what a shadow must be —
 * resolving it against ink would turn shadows into white glow in dark mode.
 * @returns an `rgba()` shadow color.
 */
export function shadowPaint(): string {
  const masked = readVariable('--dsw-alias-bg-mask-1')
  if (masked !== undefined) return masked
  return `rgba(0, 0, 0, ${currentTheme() === 'dark' ? 0.5 : 0.24})`
}

/**
 * The opaque surface a board is drawn on (`--dsw-alias-bg-layer-1`).
 *
 * The 2D canvas paints it under every frame and the PNG export paints it under
 * the captured stage, so an exported board has a real background in both
 * palettes instead of alpha (a WebGL stage has no background of its own).
 * @returns an `rgb()` color.
 */
export function surfacePaint(): string {
  const layered = readVariable('--dsw-alias-bg-layer-1')
  if (layered !== undefined) return layered
  return currentTheme() === 'dark' ? 'rgb(35, 35, 36)' : 'rgb(255, 255, 255)'
}

/**
 * The document's text font stack, for canvas text.
 * @returns a CSS font-family list.
 */
export function fontStack(): string {
  const body = documentBody()
  if (body === undefined) return FALLBACK_FONT_STACK
  const declared = globalThis.getComputedStyle(body).fontFamily
  return declared.trim() === '' ? FALLBACK_FONT_STACK : declared
}

/** Canvas font weight per board text weight. */
export const TEXT_WEIGHT: Readonly<Record<'regular' | 'medium' | 'bold', number>> = {
  regular: 400,
  medium: 520,
  bold: 640,
}
