import { ean13Modules, isValidEan13 } from "@/lib/product-codes";

/**
 * An EAN-13 barcode drawn as SVG (scales for labels and print), with the digits under it.
 * Renders nothing for codes that are not EAN-13 (other barcodes are shown as text).
 */
export function Ean13({ code, height = 64, className }: { code: string; height?: number; className?: string }) {
  if (!isValidEan13(code)) return null;
  const bits = ean13Modules(code);
  const bars: { x: number; w: number; guard: boolean }[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1") continue;
    let w = 1;
    while (bits[i + w] === "1") w++;
    const guard = i < 3 || (i >= 45 && i < 50) || i >= 92;
    bars.push({ x: i, w, guard });
    i += w - 1;
  }
  const quiet = 9;
  const width = 95 + quiet * 2;
  return (
    <svg viewBox={`0 0 ${width} ${height + 12}`} className={className} role="img" aria-label={code} direction="ltr">
      <rect width={width} height={height + 12} fill="#fff" />
      {bars.map((b) => (
        <rect key={b.x} x={b.x + quiet} y={2} width={b.w} height={b.guard ? height + 4 : height} fill="#000" />
      ))}
      <text x={width / 2} y={height + 11} textAnchor="middle" fontSize={9} fontFamily="ui-monospace, monospace" letterSpacing={1.5} fill="#000">
        {code}
      </text>
    </svg>
  );
}
