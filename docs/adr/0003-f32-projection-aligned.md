# f32 projection, aligned with supercluster

Point coordinates are projected to the spherical-mercator [0..1] space and stored as f32 (matching supercluster's `fround`), not f64. Raw-point coordinates and kd-tree coordinates use f32; cluster centers are f64 (see "Cluster centers are f64, not f32" below); only intermediate accumulations (squared radius, weighted-center sums) may use f64 to avoid error growth. This is chosen so cluster membership is directly comparable to supercluster's output for the semantic-equivalence oracle — f64 would shift boundary-point membership and inject noise into the equivalence check, fuzzing the very contract that makes "performance gain" falsifiable.

## Cluster centers are f64, not f32

A refinement forced by the semantic-equivalence oracle: supercluster does **not** f32-round cluster centers in its `data` array. In `_cluster`, the weighted center is pushed unfrounded (`nextData.push(wx / numPoints, wy / numPoints, ...)`), and `data` is a plain JS `Array` of f64 numbers. Only the kd-tree's `coords` is a `Float32Array` — f32-rounded at `tree.add` time inside `_createTree`. So at zoom `z+1`, the query point and the weighted-center accumulation both read the **f64** center from `data`, while the `within` radius query prunes against the **f32**-rounded coords in the tree.

Replicating this asymmetry exactly is required for *membership* equivalence, not just count equivalence: f32-rounding a cluster center shifts it by up to ~1e-7, which is enough to move a boundary point across the radius at the next zoom. The two implementations then partition the same points into different clusters of equal total count — counts match, membership does not. The oracle's contract is membership, so the port must match the asymmetry:

- **Raw-point coords**: f32-rounded on ingest (`fround(lng_x(lng))`), matching supercluster's `fround(lngX(lng))`. Stored as f64 carrying an f32 value.
- **Cluster centers**: stored as **unfrounded f64** (`wx / num_points`), matching supercluster's unfrounded `nextData`. Never passed through `fround` on the `data` path.
- **kd-tree coords**: f32-rounded at `finish` time (`tree.add(fround(x[i]) as f32, ...)`), matching supercluster's `Float32Array` `coords`. The tree is the only place f32-rounding is applied to cluster centers.

Concretely, `Lattice.x`/`Lattice.y` are `Vec<f64>`: raw points hold f32-rounded values promoted to f64; cluster centers hold unfrounded f64. `finish` f32-rounds into the kd-tree; `within` reads the f32 tree but the clustering loop reads the f64 `x`/`y`. This is the literal shape of supercluster's `data` (f64) + `Float32Array` coords (f32) split.

## Considered Options

- **f64 throughout** — more precise, but breaks direct membership comparison with supercluster and pursues a "more precise than supercluster" goal we never set. Rejected.
- **f32 cluster centers (literal ADR 0003 reading)** — matches the ADR's "stored coordinates use f32" wording, but diverges from supercluster's actual `data`/`Float32Array` split and produces membership that differs from the oracle (counts match, partitions do not). Rejected because the oracle's contract is membership, not counts.

