declare module "dynalite" {
  import type { Server } from "node:http";

  type DynaliteOptions = {
    createTableMs?: number;
    deleteTableMs?: number;
    updateTableMs?: number;
    maxItemSizeKb?: number;
    /** LevelDB directory; in-memory when omitted. */
    path?: string;
    verbose?: boolean;
    debug?: boolean;
    ssl?: boolean;
  };

  function dynalite(options?: DynaliteOptions): Server;
  export default dynalite;
}
