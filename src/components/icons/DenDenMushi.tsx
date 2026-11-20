import {
  HANDY_BAR_CY,
  HANDY_BAR_WIDTH,
  HANDY_BARS,
  HANDY_HEAD,
  HANDY_SHELL,
  HANDY_SPARKS,
  HANDY_VIEWBOX,
} from "./handyMarkPaths";

// Handy's mark: a sober Den Den Mushi. A spiral shell holding a sound wave,
// with a microphone as the head. Geometry comes from the brand sheet (see
// src-tauri/icons/source/handy-parts.json).
//
// "color" draws the shell/mic in the current text colour with red wave bars and
// signal sparks; "mono" draws everything in the current text colour (nav icons).

const ACCENT = "#e02020";

const DenDenMushi = ({
  width,
  height,
  className,
  variant = "mono",
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  variant?: "color" | "mono";
}) => {
  const color = variant === "color";
  const accent = color ? ACCENT : "currentColor";
  return (
    <svg
      width={width || 24}
      height={height || 24}
      viewBox={HANDY_VIEWBOX}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={HANDY_SHELL} fill="currentColor" fillRule="evenodd" />
      <path d={HANDY_HEAD} fill="currentColor" />
      {HANDY_BARS.map((b) => (
        <rect
          key={b.x}
          x={b.x - HANDY_BAR_WIDTH / 2}
          y={HANDY_BAR_CY - b.h / 2}
          width={HANDY_BAR_WIDTH}
          height={b.h}
          rx={HANDY_BAR_WIDTH / 2}
          fill={accent}
        />
      ))}
      {color &&
        HANDY_SPARKS.map((d) => (
          <path key={d.slice(0, 24)} d={d} fill={accent} />
        ))}
    </svg>
  );
};

export default DenDenMushi;
