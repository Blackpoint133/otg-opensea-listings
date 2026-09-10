declare module "node-localstorage" {
  export class LocalStorage {
    constructor(location: string, quota?: number, warningThreshold?: number, strict?: boolean);
    [key: string]: unknown;
  }
}
