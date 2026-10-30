// Shared oracle configuration.
//
// The oracle options and the zoom range it compares over are used by the
// oracle unit tests, the self-verify gate, and the on-demand 1M oracle.
// Centralizing them here avoids Shotgun Surgery: a maxZoom change edits one
// place, not three. Defaults match supercluster (radius 40, extent 512,
// minPoints 2, maxZoom 16, nodeSize 64) per ADR 0003 / spec, narrowed to
// maxZoom 6 to match refs/supercluster/bench.js's benchmark configuration.

// supercluster defaults with maxZoom 6 (the benchmark configuration from
// refs/supercluster/bench.js). The oracle compares implementations under
// identical options, so the exact radius/extent values matter only in that
// both sides agree; maxZoom 6 keeps the oracle fast at scale.
export const DEFAULT_OPTIONS = Object.freeze({ maxZoom: 6 });

// Zoom levels the oracle diffs membership across: every clustering zoom plus
// maxZoom+1 (the raw-point lattice, where every group is a singleton).
export const ALL_ZOOMS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
