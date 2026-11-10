// Login illustration: aerial view of a parking row, one bay free with a price pin.
// Pure SVG so it stays sharp on every screen and costs no extra download.

function car(x, y, body, flip = false) {
  // top-down car, 34 × 62, nose pointing up (or down when flip)
  const t = flip ? `rotate(180 ${x + 17} ${y + 31})` : "";
  return `<g transform="${t}">
    <rect x="${x - 2}" y="${y + 14}" width="4" height="7" rx="2" fill="#0d1014"/>
    <rect x="${x + 32}" y="${y + 14}" width="4" height="7" rx="2" fill="#0d1014"/>
    <rect x="${x}" y="${y}" width="34" height="62" rx="11" fill="${body}"/>
    <rect x="${x}" y="${y}" width="34" height="62" rx="11" fill="url(#shade)"/>
    <path d="M${x + 5} ${y + 17} Q${x + 17} ${y + 11} ${x + 29} ${y + 17} L${x + 27} ${y + 25} H${x + 7} Z" fill="#1c2733"/>
    <rect x="${x + 7}" y="${y + 26}" width="20" height="17" rx="4" fill="${body}"/>
    <rect x="${x + 7}" y="${y + 26}" width="20" height="17" rx="4" fill="#fff" opacity=".12"/>
    <path d="M${x + 7} ${y + 44} H${x + 27} L${x + 28} ${y + 51} Q${x + 17} ${y + 54} ${x + 6} ${y + 51} Z" fill="#1c2733"/>
    <rect x="${x + 5}" y="${y + 2}" width="7" height="3" rx="1.5" fill="#fff7d1"/>
    <rect x="${x + 22}" y="${y + 2}" width="7" height="3" rx="1.5" fill="#fff7d1"/>
    <rect x="${x + 5}" y="${y + 57}" width="7" height="2.5" rx="1.2" fill="#e5484d"/>
    <rect x="${x + 22}" y="${y + 57}" width="7" height="2.5" rx="1.2" fill="#e5484d"/>
  </g>`;
}

export function heroSVG(priceLabel = "1,500 IQD") {
  const bayW = 52, top = 70, h = 88, x0 = 8;
  const bays = 6;
  const lines = [...Array(bays + 1)].map((_, i) => `<rect x="${x0 + i * bayW - 1.5}" y="${top}" width="3" height="${h}" fill="#F2B705"/>`).join("");
  const cx = (i) => x0 + i * bayW + (bayW - 34) / 2;
  const free = 2;
  const fx = x0 + free * bayW + bayW / 2;
  return `<svg viewBox="0 0 330 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="">
    <defs>
      <linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".5" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient>
      <radialGradient id="glow" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#F2B705" stop-opacity=".45"/><stop offset="1" stop-color="#F2B705" stop-opacity="0"/></radialGradient>
      <pattern id="grain" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="#fff" opacity=".035"/><circle cx="4" cy="4" r=".5" fill="#000" opacity=".12"/></pattern>
    </defs>
    <rect width="330" height="170" fill="#262c33"/>
    <rect width="330" height="170" fill="url(#grain)"/>
    <!-- driving lane with dashed centre line -->
    ${[...Array(9)].map((_, i) => `<rect x="${6 + i * 38}" y="34" width="20" height="3" rx="1.5" fill="#fff" opacity=".35"/>`).join("")}
    <!-- curb stop strip -->
    <rect x="${x0}" y="${top + h - 2}" width="${bays * bayW}" height="3" fill="#F2B705"/>
    ${lines}
    <rect x="${x0 + free * bayW + 2}" y="${top}" width="${bayW - 4}" height="${h - 2}" fill="url(#glow)"/>
    <text x="${fx}" y="${top + 62}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-weight="700" font-size="22" fill="#F2B705" opacity=".9">P</text>
    ${car(cx(0), top + 14, "#e9ecef")}
    ${car(cx(1), top + 16, "#b23a3a")}
    ${car(cx(3), top + 13, "#3f6fb5")}
    ${car(cx(4), top + 15, "#8d969f")}
    ${car(cx(5), top + 14, "#e9ecef")}
    <!-- moving car in the lane -->
    ${car(250, 4, "#d9a404", false).replace("<g transform=\"\">", '<g transform="rotate(90 267 35)">')}
    <!-- price pin above the free bay -->
    <g transform="translate(${fx} ${top - 8})">
      <rect x="-40" y="-30" width="80" height="24" rx="12" fill="#F2B705"/>
      <path d="M-6 -7 L0 2 L6 -7 Z" fill="#F2B705"/>
      <text x="0" y="-13.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-weight="700" font-size="11" fill="#1A1F25">${priceLabel}</text>
    </g>
  </svg>`;
}
