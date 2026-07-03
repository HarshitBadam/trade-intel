function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

function hypotrochoid(
  R: number,
  r: number,
  d: number,
  steps: number,
  cx = 300,
  cy = 300
): string {
  const revolutions = r / gcd(R, r);
  const maxT = Math.PI * 2 * revolutions;
  const k = (R - r) / r;
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * maxT;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t) + cx;
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t) + cy;
    path += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return path;
}

const ROSETTES = [
  { d: hypotrochoid(185, 63, 112, 2600), width: 0.55, opacity: 0.85, cls: "g-rose-1" },
  { d: hypotrochoid(140, 45, 92, 2000), width: 0.5, opacity: 0.7, cls: "g-rose-2" },
  { d: hypotrochoid(96, 32, 70, 1500), width: 0.5, opacity: 0.6, cls: "g-rose-3" },
] as const;

const RINGS = [
  { r: 248, width: 0.8, opacity: 0.5, cls: "g-ring-1" },
  { r: 243, width: 0.5, opacity: 0.32, cls: "g-ring-2" },
  { r: 70, width: 0.7, opacity: 0.45, cls: "g-ring-3" },
] as const;

export function Guilloche({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 600"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {RINGS.map((ring, i) => (
        <circle
          key={`ring-${i}`}
          cx={300}
          cy={300}
          r={ring.r}
          stroke="currentColor"
          strokeWidth={ring.width}
          opacity={ring.opacity}
          pathLength={1}
          className={`g-line ${ring.cls}`}
        />
      ))}
      {ROSETTES.map((rosette, i) => (
        <path
          key={`rosette-${i}`}
          d={rosette.d}
          stroke="currentColor"
          strokeWidth={rosette.width}
          opacity={rosette.opacity}
          pathLength={1}
          className={`g-line ${rosette.cls}`}
        />
      ))}
    </svg>
  );
}
