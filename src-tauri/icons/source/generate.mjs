// Regenerate: npm i @resvg/resvg-js@2.6.2 (outside the repo), then
//   node generate.mjs <repoRoot> <previewDir> --write
//   npx @tauri-apps/cli@2 icon <previewDir>/app_1024.png -o src-tauri/icons
// Generates Handy "snail-phone" icon sources + PNG renders.
// usage: node gen.mjs <repoRoot> <outPreviewDir>
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const [repo, preview] = process.argv.slice(2);
fs.mkdirSync(preview, { recursive: true });

const C = {
  sea: "#0f2a44",
  sea2: "#163a5e",
  ink: "#0b1d2e",
  body: "#7fb35c",
  bodyDark: "#5e9440",
  straw: "#f4cd55",
  strawDark: "#d9a72e",
  red: "#e5333f",
  bone: "#ece6da",
  white: "#ffffff",
};

// ---- shared geometry (1024 space) ----
const SHELL = { cx: 420, cy: 525, r: 250 };
const spiral = (d = 48, n = 4) => {
  const { cx, cy } = SHELL;
  let x = cx - d / 2;
  let p = `M${x} ${cy}`;
  for (let k = 1; k <= n; k++) {
    const r = k * d;
    const dx = k % 2 ? 2 * r : -2 * r;
    p += ` a${r} ${r} 0 0 1 ${dx} 0`;
  }
  return p;
};
// handset: handle arc + two cups
const HANDLE = "M262 300 Q262 168 420 168 Q578 168 578 300";
const cups = (fill, stroke, sw) =>
  [
    [262, 300, -14],
    [578, 300, 14],
  ]
    .map(
      ([x, y, a]) =>
        `<rect x="${x - 62}" y="${y - 42}" width="124" height="84" rx="34" transform="rotate(${a} ${x} ${y})" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" paint-order="stroke"/>`,
    )
    .join("");
const BODY = `<rect x="150" y="700" width="730" height="104" rx="52"/>`;
const NECK = `<rect x="690" y="380" width="170" height="410" rx="85"/>`;
const STALKS = [
  [735, 420, 702, 262],
  [815, 420, 848, 262],
];
const EYES = [
  [700, 236],
  [850, 236],
];

// color snail (no background)
const snailColor = () => {
  const o = `stroke="${C.ink}" stroke-width="22" paint-order="stroke" stroke-linejoin="round"`;
  return `
  <g ${o} fill="${C.body}">${BODY}${NECK}</g>
  <rect x="190" y="760" width="650" height="22" rx="11" fill="${C.bodyDark}"/>
  ${STALKS.map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${C.ink}" stroke-width="58" stroke-linecap="round"/>`).join("")}
  ${STALKS.map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${C.body}" stroke-width="34" stroke-linecap="round"/>`).join("")}
  ${EYES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="60" fill="${C.white}" stroke="${C.ink}" stroke-width="20"/><circle cx="${x + 12}" cy="${y + 10}" r="26" fill="${C.ink}"/><circle cx="${x + 20}" cy="${y}" r="8" fill="${C.white}"/>`).join("")}
  <path d="M722 560 Q775 612 828 560" fill="none" stroke="${C.ink}" stroke-width="20" stroke-linecap="round"/>
  <circle cx="${SHELL.cx}" cy="${SHELL.cy}" r="${SHELL.r}" fill="${C.straw}" stroke="${C.ink}" stroke-width="22"/>
  <circle cx="${SHELL.cx}" cy="${SHELL.cy}" r="${SHELL.r - 30}" fill="none" stroke="${C.strawDark}" stroke-width="14" stroke-dasharray="2 34" stroke-linecap="round" opacity=".55"/>
  <path d="${spiral()}" fill="none" stroke="${C.red}" stroke-width="36" stroke-linecap="round"/>
  <path d="${HANDLE}" fill="none" stroke="${C.ink}" stroke-width="96" stroke-linecap="round"/>
  ${cups(C.bone, C.ink, 22)}
  <path d="${HANDLE}" fill="none" stroke="${C.bone}" stroke-width="54" stroke-linecap="round"/>
  `;
};

// silhouette as mask content (white = ink). gap = black separations
const snailMask = (gap = 40, spiralW = 60) => `
  <g fill="white">${BODY}${NECK}</g>
  ${STALKS.map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="white" stroke-width="44" stroke-linecap="round"/>`).join("")}
  ${EYES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="66" fill="white"/><circle cx="${x + 10}" cy="${y + 8}" r="30" fill="black"/>`).join("")}
  <circle cx="${SHELL.cx}" cy="${SHELL.cy}" r="${SHELL.r}" fill="white" stroke="black" stroke-width="${gap * 2}" paint-order="stroke"/>
  <path d="${spiral()}" fill="none" stroke="black" stroke-width="${spiralW}" stroke-linecap="round"/>
  <path d="${HANDLE}" fill="none" stroke="black" stroke-width="${60 + gap * 2}" stroke-linecap="round"/>
  ${cups("white", "black", gap * 2)}
  <path d="${HANDLE}" fill="none" stroke="white" stroke-width="60" stroke-linecap="round"/>
`;

// content bounds ≈ x 128..928, y 120..826 -> center group
const CENTER = "translate(-16 50)";

const appSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="228" fill="${C.sea}"/>
  <path d="M0 860 Q128 820 256 860 T512 860 T768 860 T1024 860 V796 Q1024 1024 796 1024 H228 Q0 1024 0 796Z" fill="${C.sea2}"/>
  <g transform="translate(512 512) scale(.86) translate(-512 -512) ${CENTER}">${snailColor()}</g>
</svg>`;

// colored, transparent, tight (for sidebar/onboarding)
const colorTightSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 96 832 832" width="1024" height="1024">
  <g transform="${CENTER}">${snailColor()}</g>
</svg>`;

const VB = "96 96 832 832";
const monoSvg = (color, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" width="64" height="64">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="1500">
    <rect x="-200" y="-200" width="1500" height="1500" fill="black"/>
    <g transform="${CENTER}">${snailMask()}</g>${extra}
  </mask></defs>
  <rect x="-200" y="-200" width="1500" height="1500" fill="${color}" mask="url(#m)"/>
</svg>`;

// circle variants: centered in viewBox (cx=512, cy=566)
const CC = { x: 512, y: 512, r: 410 };
const recordingSvg = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" width="64" height="64">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="1500">
    <rect x="-200" y="-200" width="1500" height="1500" fill="black"/>
    <circle cx="${CC.x}" cy="${CC.y}" r="${CC.r}" fill="white"/>
    <g transform="translate(${CC.x} ${CC.y}) scale(.62) translate(-512 -${CC.y}) ${CENTER}">
      ${snailMask(44, 64).replaceAll('"white"', '"__W"').replaceAll('"black"', '"white"').replaceAll('"__W"', '"black"')}
    </g>
  </mask></defs>
  <rect x="-200" y="-200" width="1500" height="1500" fill="${color}" mask="url(#m)"/>
</svg>`;

const transcribingSvg = (color) => {
  const s = 1.45;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" width="64" height="64">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="1500">
    <rect x="-200" y="-200" width="1500" height="1500" fill="black"/>
    <circle cx="${CC.x}" cy="${CC.y}" r="${CC.r}" fill="white"/>
    <g transform="translate(${CC.x} ${CC.y}) scale(${s}) translate(${-SHELL.cx} ${-SHELL.cy})">
      <path d="${spiral()}" fill="none" stroke="black" stroke-width="${58}" stroke-linecap="round"/>
    </g>
  </mask></defs>
  <rect x="-200" y="-200" width="1500" height="1500" fill="${color}" mask="url(#m)"/>
</svg>`;
};

// warning badge bottom-right
const BADGE = { x: 770, y: 770, r: 150 };
const warnExtra = `<circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r + 50}" fill="black"/>
  <circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r}" fill="white"/>
  <rect x="${BADGE.x - 22}" y="${BADGE.y - 100}" width="44" height="120" rx="22" fill="black"/>
  <circle cx="${BADGE.x}" cy="${BADGE.y + 62}" r="26" fill="black"/>`;

// colored linux variants
const colorTrayIdle = () => colorTightSvg().replace('width="1024" height="1024"', 'width="64" height="64"');
const colorTrayWarn = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" width="64" height="64">
  <defs><mask id="w" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="1500"><rect x="-200" y="-200" width="1500" height="1500" fill="white"/><circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r + 50}" fill="black"/></mask></defs>
  <g mask="url(#w)"><g transform="${CENTER}">${snailColor()}</g></g>
  <circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r}" fill="${C.red}"/>
  <rect x="${BADGE.x - 22}" y="${BADGE.y - 100}" width="44" height="120" rx="22" fill="white"/>
  <circle cx="${BADGE.x}" cy="${BADGE.y + 62}" r="26" fill="white"/>
</svg>`;

const out = {};
out["src-tauri/icons/source/denden-app.svg"] = appSvg();
out["src-tauri/icons/source/denden-color.svg"] = colorTightSvg();
out["src-tauri/icons/source/denden-mono.svg"] = monoSvg("#000000");

const tray = {
  tray_idle: monoSvg("#ffffff"),
  tray_idle_dark: monoSvg("#000000"),
  tray_recording: recordingSvg("#ffffff"),
  tray_recording_dark: recordingSvg("#000000"),
  tray_transcribing: transcribingSvg("#ffffff"),
  tray_transcribing_dark: transcribingSvg("#000000"),
  tray_idle_warning: monoSvg("#ffffff", warnExtra),
  tray_idle_warning_dark: monoSvg("#000000", warnExtra),
  handy: colorTrayIdle(),
  recording: recordingSvg(C.red),
  transcribing: transcribingSvg(C.strawDark),
  handy_warning: colorTrayWarn(),
};

const render = (svg, w) =>
  new Resvg(svg, { fitTo: { mode: "width", value: w }, background: "rgba(0,0,0,0)" }).render().asPng();

const write = process.argv.includes("--write");
for (const [rel, svg] of Object.entries(out)) {
  fs.writeFileSync(path.join(preview, path.basename(rel)), svg);
  if (write) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), svg);
  }
}
for (const [name, svg] of Object.entries(tray)) {
  const png = render(svg, 64);
  fs.writeFileSync(path.join(preview, `${name}.png`), png);
  fs.writeFileSync(path.join(preview, `${name}@big.png`), render(svg, 256));
  if (write) fs.writeFileSync(path.join(repo, "src-tauri/resources", `${name}.png`), png);
}
for (const w of [1024, 128, 32]) fs.writeFileSync(path.join(preview, `app_${w}.png`), render(out["src-tauri/icons/source/denden-app.svg"], w));
fs.writeFileSync(path.join(preview, `color_256.png`), render(out["src-tauri/icons/source/denden-color.svg"], 256));

// contact sheet: tray icons on light + dark
const names = Object.keys(tray);
const cell = 96;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${names.length * cell}" height="${cell * 2}">
<rect width="100%" height="${cell}" fill="#f3f3f3"/><rect y="${cell}" width="100%" height="${cell}" fill="#202020"/>
${names
  .map((n, i) => {
    const b64 = render(tray[n], 64).toString("base64");
    return [0, 1].map((row) => `<image x="${i * cell + 16}" y="${row * cell + 16}" width="64" height="64" href="data:image/png;base64,${b64}"/>`).join("");
  })
  .join("")}
</svg>`;
fs.writeFileSync(path.join(preview, "tray_sheet.png"), new Resvg(sheet).render().asPng());
console.log("ok", write ? "(written to repo)" : "(preview only)");
