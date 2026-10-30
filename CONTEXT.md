# Supercluster-WASM

A WASM-compiled Rust library for geospatial point clustering in the browser, built to outperform the JavaScript supercluster on the clustering hot path.

## Language

**Point**:
A geospatial input feature (longitude/latitude) submitted for clustering. The atomic unit of input.
_Avoid_: marker, place, item, feature (feature is the GeoJSON carrier, not the domain concept)

**Cluster**:
A group of one or more Points represented as a single feature at a given Zoom Level.
_Avoid_: group, bucket, aggregate, node

**Zoom Level**:
An integer in [minZoom, maxZoom] at which a Cluster Lattice is computed. Higher zooms resolve finer clusters.
_Avoid_: z, level, scale

**Cluster Lattice**:
The complete set of Clusters and unclustered Points at one Zoom Level. One lattice exists per Zoom Level.
_Avoid_: layer, tier, grid

**Cluster Hierarchy**:
The parent-child relationship between Clusters across Zoom Levels; each Cluster at zoom Z has a parent at zoom Z-1 or is top-level. Navigated by getChildren / getLeaves / getClusterExpansionZoom.
_Avoid_: tree (ambiguous with Spatial Index), parent chain

**Spatial Index**:
The static kd-tree (kdbush) built per Cluster Lattice to answer radius and bounding-box queries during clustering.
_Avoid_: tree (ambiguous with Cluster Hierarchy), index (too generic)

**Aggregation Spec**:
A declarative specification of per-Cluster aggregated values (sum/count/min/max/mean) over named Point properties, evaluated during build. A Cluster without one carries point_count only. Distinct from Clustering itself — Aggregation folds Point properties into Cluster properties; Clustering groups Points spatially.
_Avoid_: aggregation (unqualified, when Clustering is meant), reduce, metrics, stats
