# Shared Room Connection iOS JSCore Surface

## Purpose

This folder contains the package-owned native screen command entry used by the installed Apple app. It renders a join surface through generic screen nodes and writes only package-owned room connection facts through `engine.operation.label-addressed`.

## Boundary

- The package owns the visible connection wording and the address labels it writes.
- The Apple app owns only generic screen nodes, input values, and target invocation.
- Transport selection and peer byte exchange stay outside this package-owned surface.

