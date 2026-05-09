/* eslint-disable @typescript-eslint/no-namespace */
export namespace RedisClientTypes {
  export type GetFunction = (key: string) => Promise<string | null>;
  export type SetFunction = (
    key: string,
    value: string,
    options?: { EX?: number }
  ) => Promise<string | null>;
  export type DelFunction = (key: string) => Promise<number>;
  export type KeysFunction = (pattern: string) => Promise<string[]>;
  export type EvalFunction = (
    script: string,
    options: { keys?: string[]; arguments?: string[] }
  ) => Promise<unknown>;
  export type MonitorFunction = () => Promise<void>;
}
