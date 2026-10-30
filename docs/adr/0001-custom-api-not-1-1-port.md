# Custom API, not a 1:1 port of supercluster

We are building a custom public API rather than a behavior-exact port of the JavaScript supercluster. Correctness is defined as semantic equivalence — same cluster membership per zoom — with supercluster's fixtures as the oracle, not byte-identical output. This trades drop-in compatibility with mapbox-gl/deck.gl supercluster sources for API design freedom and a clean, falsifiable performance comparison against the JS baseline.

## Considered Options

- **1:1 behavior port** — would give a free oracle and drop-in compatibility, but nails the API to supercluster's shape and leaves "performance gain" as the only axis of freedom. Rejected because the goal is a better library, not a faster clone.
