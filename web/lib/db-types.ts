// The subset of the @tursodatabase DatabasePromise API (Node and wasm builds share it) that the sync code uses.
export interface Tx {
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  get(sql: string, ...params: unknown[]): Promise<any>;
  all(sql: string, ...params: unknown[]): Promise<any[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Tx {
  transactionAsync<F extends (tx: Tx, ...args: any[]) => Promise<any>>(fn: F): (...args: any[]) => ReturnType<F>;
}

export type Row = Record<string, unknown>;
