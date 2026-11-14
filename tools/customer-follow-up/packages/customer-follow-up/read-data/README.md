# Customer Follow-Up Read Data

This folder projects customer follow-up rows into product progress, customer
timelines, and the currently selected customer view.

## Boundary

The read layer owns only package-local projection from published records. CRM
relationship truth, contact identity truth, email truth, calendar truth,
payment truth, access truth, and content truth stay with their owner packages.
