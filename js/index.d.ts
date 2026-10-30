// TypeScript definitions for the supercluster-wasm main-thread API (ticket 07).
//
// The Spatial Index stays opaque in WASM linear memory (ADR 0002): the main
// thread talks to a Web Worker over postMessage and receives decoded GeoJSON
// Features. These types describe the JS-facing surface only.

/** A GeoJSON Point feature (the input shape). */
export interface PointFeatureInput {
  type: 'Feature';
  id?: number | string;
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
  properties?: Record<string, unknown> | null;
}

/** A GeoJSON FeatureCollection of Point features. */
export interface FeatureCollectionInput {
  type: 'FeatureCollection';
  features: PointFeatureInput[];
}

export type GeoJSONInput = FeatureCollectionInput | PointFeatureInput[];

/** An aggregation op — mirrors the Rust `AggOp`. */
export type AggOpName = 'sum' | 'count' | 'min' | 'max' | 'mean';

/** One field in a declarative aggregation spec (mirrors `AggField`). */
export interface AggregationFieldInput {
  /** The output property name (appears on cluster features). */
  name: string;
  /** The source property name to read off each input feature. */
  prop: string;
  /** The aggregation op. */
  op: AggOpName;
}

/** The aggregation spec passed via `options.aggregation`. */
export interface AggregationSpecInput {
  fields: AggregationFieldInput[];
}

/** Clustering options — camelCase keys, defaults match supercluster verbatim. */
export interface SuperclusterOptions {
  /** Minimum zoom to generate clusters on. Default 0. */
  minZoom?: number;
  /** Maximum zoom level to cluster points on. Default 16. */
  maxZoom?: number;
  /** Minimum points to form a cluster. Default 2. */
  minPoints?: number;
  /** Cluster radius in pixels. Default 40. */
  radius?: number;
  /** Tile extent (tile size). Default 512. */
  extent?: number;
  /** Size of the kd-tree node. Default 64. */
  nodeSize?: number;
  /** Declarative aggregation spec (ticket 06). */
  aggregation?: AggregationSpecInput;
}

/** A decoded GeoJSON Feature (cluster or point). */
export interface FeatureOutput {
  type: 'Feature';
  id?: number | string;
  properties: Record<string, unknown>;
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
}

/** A synthesized cluster Feature. */
export interface ClusterFeatureOutput extends FeatureOutput {
  properties: {
    cluster: true;
    cluster_id: number;
    point_count: number;
    point_count_abbreviated: number | string;
    [aggregatedName: string]: unknown;
  };
}

/** The compact typed-array result contract (the raw worker response). */
export interface QueryResult {
  count: number;
  rows: Float64Array;
  aggregated: Float64Array;
  specLen: number;
}

/** The hybrid id+encoded result contract (the raw `getClustersIds` response).
 * Point rows are a compact `Uint32Array` of source-feature ids (the main
 * thread indexes its own already-held source features — zero per-row encode);
 * Cluster rows are the encoded `cluster_rows` (stride 5) + `cluster_aggregated`
 * (cluster-dense, stride `specLen`) pair, identical in shape to `QueryResult`'s
 * `rows`/`aggregated` but carrying the cluster rows only. */
export interface HybridQueryResult {
  count: number;
  point_ids: Uint32Array;
  cluster_rows: Float64Array;
  cluster_aggregated: Float64Array;
  specLen: number;
}

/**
 * Decode a WASM query result into GeoJSON Features.
 * @param res The raw result object from the worker.
 * @param sourceFeatures The geometry-bearing subset of loaded features (indexed by feature_id).
 * @param specFieldNames The aggregation spec field names, in spec order.
 */
export function decodeQueryResult(
  res: QueryResult,
  sourceFeatures: PointFeatureInput[],
  specFieldNames?: string[],
): FeatureOutput[];

/**
 * Decode a hybrid id+encoded `getClustersIds` result into GeoJSON Features.
 * The returned `Feature[]` matches `decodeQueryResult`'s shape exactly — a
 * drop-in replacement. Point rows push `sourceFeatures[point_id]` (zero
 * allocation, reference push); Cluster rows decode to synthesized Features.
 * @param res The raw hybrid result object from the worker.
 * @param sourceFeatures The geometry-bearing subset of loaded features (indexed by point_id).
 * @param specFieldNames The aggregation spec field names, in spec order.
 */
export function decodeHybridResult(
  res: HybridQueryResult,
  sourceFeatures: PointFeatureInput[],
  specFieldNames?: string[],
): FeatureOutput[];

/**
 * The main-thread clustering index. Owns a Web Worker that holds the WASM
 * index; all methods are async (promise-correlated over postMessage).
 */
export class Supercluster {
  constructor();
  /** Resolves once the worker has loaded the WASM module. */
  get ready(): Promise<void>;
  /** Build the index from GeoJSON features + options. */
  load(points: GeoJSONInput, options?: SuperclusterOptions): Promise<void>;
  /**
   * Build the index from a pre-flattened `[lng, lat, ...]` coordinate array —
   * the fast path (one copy + pure-Rust build, no GeoJSON parse). The
   * coordinate buffer is TRANSFERRED into the worker (zero-copy): the array
   * is consumed and unusable from the moment `load()` is called — including
   * if `load()` later rejects — pass a copy if it must stay re-usable.
   * Callers using this path render clusters only; unclustered points decode
   * to synthesized coordinates (no source features to recover).
   */
  load(points: Float64Array, options?: SuperclusterOptions): Promise<void>;
  /** Viewport query. `bbox` is [minLng, minLat, maxLng, maxLat]. */
  getClusters(bbox: [number, number, number, number], zoom: number): Promise<FeatureOutput[]>;
  /**
   * Viewport query, the hybrid id+encoded fast path. `bbox` is
   * [minLng, minLat, maxLng, maxLat]. Returns decoded GeoJSON Features whose
   * shape matches `getClusters` exactly — a drop-in replacement. Point rows
   * are zero-allocation source-feature reference pushes; Cluster rows decode to
   * synthesized Features. Requires the main thread to hold the source features
   * (loaded via GeoJSON, not `load_coords`).
   */
  getClustersIds(bbox: [number, number, number, number], zoom: number): Promise<FeatureOutput[]>;
  /** Direct children of a cluster, in kd-tree traversal order. */
  getChildren(clusterId: number): Promise<FeatureOutput[]>;
  /** Paginated leaves. `limit` null/undefined = all leaves. */
  getLeaves(clusterId: number, limit?: number | null, offset?: number): Promise<FeatureOutput[]>;
  /** The lowest zoom at which the cluster expands into >1 child. */
  getClusterExpansionZoom(clusterId: number): Promise<number>;
  /** Terminate the worker. No further calls are possible. */
  terminate(): void;
}
