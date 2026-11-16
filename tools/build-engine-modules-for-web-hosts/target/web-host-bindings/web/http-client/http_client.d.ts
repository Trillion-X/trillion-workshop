/* tslint:disable */
/* eslint-disable */

/**
 * One person's request sender inside a web host.
 */
export class HttpClientInWebWorker {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Send one `CallExternalRequest` (JSON bytes). Resolves to the
     * `CallExternalResponse` JSON bytes; rejects with the request's error.
     */
    call(request: Uint8Array, caller_context?: Uint8Array | null): Promise<any>;
    /**
     * - `host_dispatch(target, partition, payload)` answers the vault target
     *   (`credential_resolver_target`) and the transport target.
     * - `partition_label` names the partition (BLAKE3 of the label).
     * - `slot_config` is `HttpClientRuntimeConfig` JSON (transport target,
     *   credential resolver, URL grants).
     */
    constructor(host_dispatch_function: Function, partition_label: string, slot_config: Uint8Array);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_httpclientinwebworker_free: (a: number, b: number) => void;
    readonly httpclientinwebworker_call: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly httpclientinwebworker_new: (a: any, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h84744f68bf754b70: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h31eb146b2b2e59ab: (a: number, b: number, c: any, d: any) => void;
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
