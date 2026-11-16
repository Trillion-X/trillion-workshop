# src/

Pure AST, lexer, and parser modules for formula expressions.

## Files

| File | Purpose |
|------|---------|
| `lib.rs` | Formula AST data types shared by parser and evaluator consumers |
| `lexer.rs` | Tokenizes formula source text into positioned tokens, including caller-supplied specials `@`, `@@`, and `$scope` |
| `parser.rs` | Pratt parser that converts tokens into `AstNode` / `Expression` trees |

## Boundary

This crate is pure expression syntax. It does not know EEAF, tables, workspaces, slots, hosts, storage logs, or package systems. Callers decide what `@`, `@@`, and `$scope` mean at evaluation time.
