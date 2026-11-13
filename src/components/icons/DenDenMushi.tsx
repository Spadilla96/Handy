import { useId } from "react";

// Handy's "snail-phone" mark: a snail carrying a telephone handset on its
// shell, a nod to One Piece's transponder snails. Geometry mirrors
// src-tauri/icons/source/denden-*.svg (1024 grid).

const SPIRAL =
  "M396 525a48 48 0 0 1 96 0a96 96 0 0 1-192 0a144 144 0 0 1 288 0a192 192 0 0 1-384 0";
const HANDLE = "M262 300Q262 168 420 168Q578 168 578 300";
const CUPS: [number, number, number][] = [
  [262, 300, -14],
  [578, 300, 14],
];
const STALKS: [number, number, number, number][] = [
  [735, 420, 702, 262],
  [815, 420, 848, 262],
];
const EYES: [number, number][] = [
  [700, 236],
  [850, 236],
];

const C = {
  ink: "#0b1d2e",
  body: "#7fb35c",
  bodyDark: "#5e9440",
  straw: "#f4cd55",
  strawDark: "#d9a72e",
  red: "#e5333f",
  bone: "#ece6da",
};

const Cup = ({
  x,
  y,
  a,
  fill,
  stroke,
  sw,
}: {
  x: number;
  y: number;
  a: number;
  fill: string;
  stroke: string;
  sw: number;
}) => (
  <rect
    x={x - 62}
    y={y - 42}
    width={124}
    height={84}
    rx={34}
    transform={`rotate(${a} ${x} ${y})`}
    fill={fill}
    stroke={stroke}
    strokeWidth={sw}
    paintOrder="stroke"
  />
);

export const DenDenMushiArt = () => (
  <g transform="translate(-16 50)">
    <g
      fill={C.body}
      stroke={C.ink}
      strokeWidth={22}
      paintOrder="stroke"
      strokeLinejoin="round"
    >
      <rect x={150} y={700} width={730} height={104} rx={52} />
      <rect x={690} y={380} width={170} height={410} rx={85} />
    </g>
    <rect x={190} y={760} width={650} height={22} rx={11} fill={C.bodyDark} />
    {STALKS.map(([x1, y1, x2, y2]) => (
      <line
        key={`so${x1}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={C.ink}
        strokeWidth={58}
        strokeLinecap="round"
      />
    ))}
    {STALKS.map(([x1, y1, x2, y2]) => (
      <line
        key={`si${x1}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={C.body}
        strokeWidth={34}
        strokeLinecap="round"
      />
    ))}
    {EYES.map(([x, y]) => (
      <g key={`e${x}`}>
        <circle
          cx={x}
          cy={y}
          r={60}
          fill="#fff"
          stroke={C.ink}
          strokeWidth={20}
        />
        <circle cx={x + 12} cy={y + 10} r={26} fill={C.ink} />
        <circle cx={x + 20} cy={y} r={8} fill="#fff" />
      </g>
    ))}
    <path
      d="M722 560Q775 612 828 560"
      fill="none"
      stroke={C.ink}
      strokeWidth={20}
      strokeLinecap="round"
    />
    <circle
      cx={420}
      cy={525}
      r={250}
      fill={C.straw}
      stroke={C.ink}
      strokeWidth={22}
    />
    <circle
      cx={420}
      cy={525}
      r={220}
      fill="none"
      stroke={C.strawDark}
      strokeWidth={14}
      strokeDasharray="2 34"
      strokeLinecap="round"
      opacity={0.55}
    />
    <path
      d={SPIRAL}
      fill="none"
      stroke={C.red}
      strokeWidth={36}
      strokeLinecap="round"
    />
    <path
      d={HANDLE}
      fill="none"
      stroke={C.ink}
      strokeWidth={96}
      strokeLinecap="round"
    />
    {CUPS.map(([x, y, a]) => (
      <Cup key={x} x={x} y={y} a={a} fill={C.bone} stroke={C.ink} sw={22} />
    ))}
    <path
      d={HANDLE}
      fill="none"
      stroke={C.bone}
      strokeWidth={54}
      strokeLinecap="round"
    />
  </g>
);

const Silhouette = () => (
  <g transform="translate(-16 50)">
    <g fill="white">
      <rect x={150} y={700} width={730} height={104} rx={52} />
      <rect x={690} y={380} width={170} height={410} rx={85} />
    </g>
    {STALKS.map(([x1, y1, x2, y2]) => (
      <line
        key={x1}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="white"
        strokeWidth={44}
        strokeLinecap="round"
      />
    ))}
    {EYES.map(([x, y]) => (
      <g key={x}>
        <circle cx={x} cy={y} r={66} fill="white" />
        <circle cx={x + 10} cy={y + 8} r={30} fill="black" />
      </g>
    ))}
    <circle
      cx={420}
      cy={525}
      r={250}
      fill="white"
      stroke="black"
      strokeWidth={80}
      paintOrder="stroke"
    />
    <path
      d={SPIRAL}
      fill="none"
      stroke="black"
      strokeWidth={60}
      strokeLinecap="round"
    />
    <path
      d={HANDLE}
      fill="none"
      stroke="black"
      strokeWidth={140}
      strokeLinecap="round"
    />
    {CUPS.map(([x, y, a]) => (
      <Cup key={x} x={x} y={y} a={a} fill="white" stroke="black" sw={80} />
    ))}
    <path
      d={HANDLE}
      fill="none"
      stroke="white"
      strokeWidth={60}
      strokeLinecap="round"
    />
  </g>
);

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
  const maskId = `ddm-${useId().replace(/:/g, "")}`;
  return (
    <svg
      width={width || 24}
      height={height || 24}
      viewBox="96 96 832 832"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {variant === "color" ? (
        <DenDenMushiArt />
      ) : (
        <>
          <defs>
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x={0}
              y={0}
              width={1024}
              height={1024}
            >
              <rect width={1024} height={1024} fill="black" />
              <Silhouette />
            </mask>
          </defs>
          <rect
            width={1024}
            height={1024}
            fill="currentColor"
            mask={`url(#${maskId})`}
          />
        </>
      )}
    </svg>
  );
};

export default DenDenMushi;
