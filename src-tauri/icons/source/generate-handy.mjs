// Handy logo + icon generator (Den Den Mushi, corporate mark).
// Regenerate: npm i @resvg/resvg-js@2.6.2 (outside the repo), then
//   RESVG_DIR=<dir with node_modules> node generate-handy.mjs <repoRoot> <previewDir> --write
//   npx @tauri-apps/cli@2 icon <previewDir>/app_1024.png -o src-tauri/icons
// Geometry (handy-parts.json) was traced from the approved brand sheet by
// trace-handy-parts.py; bars are rebuilt as clean rounded rects so they can animate.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { Resvg } = createRequire(`${process.env.RESVG_DIR}/`)("@resvg/resvg-js");

const [repo, preview] = process.argv.slice(2);
const WRITE = process.argv.includes("--write");
fs.mkdirSync(preview, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(
  fs.readFileSync(path.join(here, "handy-parts.json"), "utf8"),
);

const INK = "#1f2226",
  BONE = "#f5f5f3",
  CHAR = "#1a1d21";
const RED_ON_LIGHT = "#d40000",
  RED_ON_DARK = "#ee2a2a";
const BARS = [
  { x: 378, h: 99 },
  { x: 456, h: 170 },
  { x: 535, h: 268 },
  { x: 619, h: 129 },
];
const CY = 648;
const strip = (s) => s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

function symbol({
  base,
  accent,
  head,
  bars,
  sparks = true,
  bw = 52,
  barFill,
  vb,
  bg = "",
}) {
  const hs = bars ?? BARS.map((b) => b.h);
  const bar = BARS.map(
    (b, i) =>
      `<rect x="${b.x - bw / 2}" y="${CY - hs[i] / 2}" width="${bw}" height="${hs[i]}" rx="${bw / 2}" fill="${barFill ?? accent}"/>`,
  ).join("");
  const sp = sparks
    ? P.sparks.map((d) => `<path d="${d}" fill="${accent}"/>`).join("")
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${bg}<path d="${P.shell}" fill="${base}" fill-rule="evenodd"/><path d="${P.head}" fill="${head ?? base}"/>${bar}${sp}</svg>`;
}
const VB_FULL = "100 200 1060 820";
const VB_TRAY = "114 205 860 860"; // square, no sparks

const render = (svg, w) =>
  new Resvg(svg, {
    fitTo: { mode: "width", value: w },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
const outFiles = {};
const put = (rel, data) => {
  outFiles[rel] = data;
};

// ---- vector masters ----
put(
  "src-tauri/icons/source/handy-symbol.svg",
  symbol({ base: INK, accent: RED_ON_LIGHT, vb: VB_FULL }),
);
put(
  "src-tauri/icons/source/handy-reversed.svg",
  symbol({
    base: BONE,
    accent: RED_ON_DARK,
    vb: VB_FULL,
    bg: `<rect x="100" y="200" width="1060" height="820" fill="${CHAR}"/>`,
  }),
);

// ---- app icon: charcoal squircle, reversed symbol ----
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="228" fill="${CHAR}"/><g transform="translate(512 512) scale(.78) translate(-630 -610)">${strip(symbol({ base: BONE, accent: RED_ON_DARK, vb: VB_FULL }))}</g></svg>`;
put("src-tauri/icons/source/handy-app.svg", appSvg);
put("preview:app_1024.png", render(appSvg, 1024));

// ---- tray icons (64px) ----
const T = {
  light: { base: INK, accent: RED_ON_LIGHT },
  dark: { base: BONE, accent: RED_ON_DARK },
};
const FRAMES = 8;
// head: accent on frames 0-1 and 4-5, base on 2-3 and 6-7; bars ride a travelling wave
const frameBars = (f) =>
  BARS.map(
    (_, i) =>
      90 + 250 * (0.5 + 0.5 * Math.sin((2 * Math.PI * f) / FRAMES + i * 1.5)),
  );
const BADGE = { x: 840, y: 930, r: 150 };
const badgeMarks = `<circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r}" fill="#ffb000"/><rect x="${BADGE.x - 20}" y="${BADGE.y - 95}" width="40" height="105" rx="20" fill="#1a1d21"/><circle cx="${BADGE.x}" cy="${BADGE.y + 62}" r="25" fill="#1a1d21"/>`;
const tray = (theme, kind, f = 0) => {
  const { base, accent } = T[theme];
  switch (kind) {
    case "idle":
      return symbol({
        base,
        accent,
        sparks: false,
        barFill: base,
        bw: 64,
        vb: VB_TRAY,
      });
    case "transcribing":
      return symbol({
        base,
        accent,
        sparks: false,
        bw: 64,
        bars: [190, 190, 190, 190],
        vb: VB_TRAY,
      });
    case "recording":
      return symbol({
        base,
        accent,
        sparks: false,
        bw: 64,
        head: Math.floor(f / 2) % 2 === 0 ? accent : base,
        bars: frameBars(f),
        vb: VB_TRAY,
      });
    default: {
      const inner = strip(
        symbol({
          base,
          accent,
          sparks: false,
          barFill: base,
          bw: 64,
          vb: VB_TRAY,
        }),
      );
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB_TRAY}"><defs><mask id="w" maskUnits="userSpaceOnUse" x="0" y="0" width="1300" height="1300"><rect width="1300" height="1300" fill="#fff"/><circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r + 45}" fill="#000"/></mask></defs><g mask="url(#w)">${inner}</g>${badgeMarks}</svg>`;
    }
  }
};
// dark taskbar -> light glyph (no suffix); light taskbar -> dark glyph (_dark)
for (const [theme, suf] of [
  ["dark", ""],
  ["light", "_dark"],
]) {
  put(
    `src-tauri/resources/tray_idle${suf}.png`,
    render(tray(theme, "idle"), 64),
  );
  put(
    `src-tauri/resources/tray_transcribing${suf}.png`,
    render(tray(theme, "transcribing"), 64),
  );
  put(
    `src-tauri/resources/tray_idle_warning${suf}.png`,
    render(tray(theme, "warning"), 64),
  );
  for (let f = 0; f < FRAMES; f++)
    put(
      `src-tauri/resources/tray_recording${suf}_${f}.png`,
      render(tray(theme, "recording", f), 64),
    );
}

// ---- coloured variants (Linux tray): dark tile with reversed symbol ----
const tile = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="200" fill="${CHAR}"/><g transform="translate(512 512) translate(-544 -635)">${inner}</g></svg>`;
const body = (o) =>
  strip(
    symbol({
      base: BONE,
      accent: RED_ON_DARK,
      sparks: false,
      bw: 64,
      vb: VB_TRAY,
      ...o,
    }),
  );
put("src-tauri/resources/handy.png", render(tile(body({})), 64));
put(
  "src-tauri/resources/recording.png",
  render(tile(body({ head: RED_ON_DARK, bars: frameBars(2) })), 64),
);
put(
  "src-tauri/resources/transcribing.png",
  render(tile(body({ bars: [190, 190, 190, 190] })), 64),
);
put(
  "src-tauri/resources/handy_warning.png",
  render(tile(body({}) + badgeMarks), 64),
);

// ---- preview sheet ----
const names = Object.keys(outFiles).filter(
  (k) => k.includes("resources/tray_") && k.endsWith(".png"),
);
const cell = 80;
const rows = Math.ceil(names.length / 10);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell * 10}" height="${cell * rows}">${names
  .map((n, i) => {
    const col = i % 10,
      row = Math.floor(i / 10);
    const light = n.includes("_dark");
    return `<rect x="${col * cell}" y="${row * cell}" width="${cell}" height="${cell}" fill="${light ? "#f3f3f3" : "#202020"}"/><image x="${col * cell + 8}" y="${row * cell + 8}" width="64" height="64" href="data:image/png;base64,${outFiles[n].toString("base64")}"/>`;
  })
  .join("")}</svg>`;
fs.writeFileSync(
  path.join(preview, "tray_sheet.png"),
  new Resvg(sheet).render().asPng(),
);

for (const [rel, data] of Object.entries(outFiles)) {
  if (rel.startsWith("preview:")) {
    fs.writeFileSync(path.join(preview, rel.slice(8)), data);
    continue;
  }
  if (WRITE) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), data);
  }
}
console.log(
  "ok",
  Object.keys(outFiles).length,
  "files",
  WRITE ? "(written)" : "(preview only)",
);
