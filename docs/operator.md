# Operating countinghouse-registry

This document grows with the implementation; each section names the part of
the design (`docs/superpowers/specs/2026-11-10-registry-design.md`) it covers.

## Install

- Node ≥ 24.15.
- The service stores everything in one SQLite file through the `sqlite3`
  package, a hard dependency of the service. Its prebuilt binding needs
  **glibc ≥ 2.38** (check with `ldd --version`; Ubuntu 22.04 has 2.35 and
  needs `npm install --build-from-source`). The CLI package
  (`countinghouse-registry-cli`) has no native dependency.
