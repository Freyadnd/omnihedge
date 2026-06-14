// Ambient declarations for @x402 packages whose .d.mts files require
// moduleResolution: bundler/node16. These stubs let tsc compile while
// the runtime uses the real CJS builds (which resolve fine in Node.js).

declare module '@x402/express' {
  import type { Request, Response, NextFunction } from 'express';

  export class x402ResourceServer {
    constructor(facilitator: unknown);
    register(network: string, scheme: unknown): this;
    registerExtension(ext: unknown): this;
  }
  export class x402HTTPResourceServer {
    constructor(server: unknown, routes: unknown);
    onProtectedRequest(hook: unknown): this;
  }
  export function paymentMiddlewareFromHTTPServer(
    server: unknown
  ): (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

declare module '@x402/core/server' {
  export class HTTPFacilitatorClient {
    constructor(opts: { url: string });
  }
}
