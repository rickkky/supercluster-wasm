# Spatial index stays in WASM linear memory, opaque to JS

The clustering index (the per-zoom kd-tree and the stride arrays) lives in WASM linear memory and is not exposed or transferred to JS. Build and all queries (getClusters, getChildren, getLeaves, getClusterExpansionZoom) run as WASM calls inside a Web Worker; only result data crosses the boundary. This inverts kdbush's transferable-ArrayBuffer design philosophy, where JS owns and queries the buffer — but keeping computation in WASM is the entire point of the port, and exposing the buffer would just move build into WASM while leaving queries in JS.

## Consequences

Every query result must be serialized across the WASM→JS boundary, so result sets must stay compact (return ids and coordinates, let JS assemble GeoJSON). The kdbush serialized ArrayBuffer format (magic 0xdb, header, ids, coords) is not reproduced, since JS never needs to reconstruct the index.
