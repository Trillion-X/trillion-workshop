# Schema fields

`schemaFields` maps scalar JSON schema properties into the existing record editor
field contract. `schemaValues` preserves boolean values and converts numeric
inputs without accepting empty, nonfinite, or fractional integer values.
Unsupported required fields are returned explicitly for the consumer to explain.
This adapter does not claim complete JSON Schema validation; use the domain's
validation owner before acting. Expansion post preparation consumes this adapter.
