/** The coverage minimap of the 3D Scan node: one small square per viewing direction. Shared by the node's panel and the linked-phone panel. */

const CELL = 7;
const COLORS = ['#555a63', '#d33b3b', '#e0a43a', '#35c25a'];

/** The azimuth x elevation map: one small square per viewing direction, red = no photo, green = covered, grey = cannot be reached. */
export function CoverageMap({ grid, counts, reachable }: { grid: { az: number; el: number }; counts: number[]; reachable: boolean[] }) {
  const w = grid.az * CELL;
  const h = grid.el * CELL;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Coverage map: around the object across, low to high up" style={{ display: 'block', maxWidth: '100%' }}>
      {counts.map((n, i) => {
        const col = i % grid.az;
        const row = Math.floor(i / grid.az);
        const kind = !reachable[i] ? 0 : n === 0 ? 1 : n === 1 ? 2 : 3;
        return <rect key={i} x={col * CELL + 0.5} y={(grid.el - 1 - row) * CELL + 0.5} width={CELL - 1} height={CELL - 1} fill={COLORS[kind]} />;
      })}
    </svg>
  );
}
