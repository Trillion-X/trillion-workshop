/* tslint:disable */
/* eslint-disable */

/**
 * `definitions_json`: a JSON list of definitions; `product_word`: the host's own word (its declared name); `ask(name, payload: Uint8Array, context?: Uint8Array) →
 * Promise<Uint8Array>`;
 * `read(from) → Promise<Uint8Array>`. Resolves to the finished run as JSON text.
 */
export function run(definitions_json: string, id: string, input_json: string, partition: string, product_word: string, ask: Function, read: Function): Promise<string>;

export function runWithStartedAt(definitions_json: string, id: string, input_json: string, partition: string, product_word: string, started_at: string, ask: Function, read: Function): Promise<string>;

/**
 * Versioned opt-in bounded adapter. Limits are host-owned scalar arguments,
 * never authored recipe fields. Missing this export in an older module is an
 * unsupported API; callers must not fall back to `run`.
 */
export function run_bounded_v1(definitions_json: string, id: string, input_json: string, partition: string, product_word: string, max_definitions_json_bytes: number, max_input_json_bytes: number, max_id_bytes: number, max_partition_bytes: number, max_definitions: number, max_total_steps: number, max_total_edges: number, max_nested_closure_bytes: number, max_output_json_bytes: number, max_step_attempts: number, max_loop_iterations: number, max_action_depth: number, ask: Function, read: Function): Promise<string>;

/**
 * Start-aware bounded companion; old modules cannot silently lose replay data.
 */
export function run_bounded_with_start_v1(definitions_json: string, id: string, input_json: string, partition: string, product_word: string, max_definitions_json_bytes: number, max_input_json_bytes: number, max_id_bytes: number, max_partition_bytes: number, max_definitions: number, max_total_steps: number, max_total_edges: number, max_nested_closure_bytes: number, max_output_json_bytes: number, max_step_attempts: number, max_loop_iterations: number, max_action_depth: number, started_at: string, start_id: string | null | undefined, ask: Function, read: Function): Promise<string>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: any, l: any) => any;
    readonly runWithStartedAt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: any, n: any) => any;
    readonly run_bounded_v1: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: any, x: any) => any;
    readonly run_bounded_with_start_v1: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: any, b1: any) => any;
    readonly wasm_bindgen__convert__closures_____invoke__h5bae8aac34841050: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h4bc85f9637a731d5: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
