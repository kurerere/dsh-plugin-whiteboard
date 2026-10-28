/**
 * Guide artwork for the whiteboard entry in the right sidebar's new-tab guide.
 *
 * Drawn in the shipped `GuideArtwork*` language: a 36×36 canvas, geometry
 * centred on 18, a `#539CFA` outline plus warm `#FFBC4D` / `#FFCD78` accents —
 * the same fixed palette and stroke weight the native guide entries use
 * (`GuideArtworkFiles` is a 2-unit amber folder, `GuideArtworkBrowser` is a blue
 * ring with amber fills).
 *
 * The subject is a painter's palette: "the model paints what you describe".
 * Three paint wells (rather than the four-to-six a 24px icon set draws) keep the
 * dots readable at the 26px the guide actually renders, and keeping every well
 * warm avoids introducing a third colour next to the native entries.
 *
 * Owned by the plugin author: the artwork is fixed-palette by design, because
 * the sidebar guide draws every entry on its own tinted surface.
 */

import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Blue palette outline with three warm paint wells. */
export function GuideArtworkWhiteboard({ size = 36, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(2.4,2.4) scale(1.3)">
        {/* the palette body: round body, thumb hole at the lower right */}
        <path
          d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"
          fill="none"
          stroke="#539CFA"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* the paint wells */}
        <circle cx="13.4" cy="6.8" r="1.55" fill="#FFBC4D" />
        <circle cx="17.3" cy="10.8" r="1.55" fill="#FFCD78" />
        <circle cx="8.7" cy="7.8" r="1.55" fill="#FFBC4D" />
      </g>
    </svg>
  )
}
