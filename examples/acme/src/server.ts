type Handler = () => unknown;

export function createServer() {
  const routes = new Map<string, Handler>();
  return {
    get: (path: string, handler: Handler) => routes.set(path, handler),
    listen: (port: number, onReady: () => void) => onReady(),
  };
}
