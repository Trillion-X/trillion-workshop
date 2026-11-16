/* tslint:disable */
/* eslint-disable */

/**
 * One person's trigger engine in a Worker. `answer(requestJson: string) → Promise<any>` answers the engine's
 * read, list and send requests (see the file header). Rules stay resident between `apply` calls.
 */
export class TriggerEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `changes_json`: a JSON list of `{address, path?, value}` or `{address, removed: true}`. Resolves to the
     * result as JSON text: `{status, dispatch_failures, writes, continue}`.
     */
    apply(changes_json: string): Promise<any>;
    constructor(partition: string, answer: Function);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __getrandom_custom: (a: number, b: number) => number;
    readonly __wbg_triggerengine_free: (a: number, b: number) => void;
    readonly triggerengine_apply: (a: number, b: number, c: number) => any;
    readonly triggerengine_new: (a: number, b: number, c: any) => number;
    readonly wasm_bindgen__convert__closures_____invoke__hfc114995890cd7e6: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h9157211187480f24: (a: number, b: number, c: any, d: any) => void;
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
