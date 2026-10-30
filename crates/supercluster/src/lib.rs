//! Build half of the `supercluster-wasm` clustering stack (ticket 03).
//!
//! Ingests GeoJSON Point features, projects lng/lat to the f32 spherical-
//! mercator `[0..1]` space (ADR 0003, matching supercluster's `fround`), stores
//! Points in a Structure-of-Arrays internal layout, and runs the per-zoom
//! `_cluster` loop that builds the Cluster Lattice — for each Point at each
//! Zoom Level, a radius query via the kdbush `within` finds neighbors, and
//! Points meeting `minPoints` are merged into a Cluster with a weighted center.
//!
//! Option semantics match supercluster verbatim (radius/extent/minPoints/
//! maxZoom/nodeSize defaults and the `r = radius / (extent * 2^zoom)` formula)
//! so the equivalence oracle's pruning boundaries align. cluster_ids are
//! internally stable and drillable but need not match supercluster's encoding;
//! this ticket is verified structurally — the Cluster Lattice is built and
//! queryable. Full behavioral verification (the query half) lands in ticket 04.
//!
//! The crate is a library: the WASM↔JS boundary wiring is ticket 07, so nothing
//! here depends on `wasm-bindgen` or touches JS types. Input is plain Rust
//! structs; the kdbush index and the SoA stride arrays stay in Rust memory.

pub mod aggregation;
pub mod cluster_id;
pub mod datasets;
pub mod encode;
pub mod feature;
pub mod hierarchy;
pub mod lattice;
pub mod oracle;
pub mod options;
pub mod projection;
pub mod query;
pub mod supercluster;

// The `wasm-bindgen` boundary (ticket 07): `SuperclusterWasm`, the FFI wrapper
// that exposes the API to JS as async methods over a Web Worker. Gated behind
// the `wasm` feature so native builds stay pure-Rust and serde-free.
#[cfg(feature = "wasm")]
pub mod wasm;
