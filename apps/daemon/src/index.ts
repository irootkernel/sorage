export const DAEMON_VERSION = "0.1.0";

export type {
  DaemonEndpoints,
  DaemonRequestContext,
  DaemonRequestHandler,
  DaemonRouteHandler,
  DaemonServerOptions,
  ReadinessReport,
} from "./server";
export {
  CONTENT_SECURITY_POLICY,
  createDaemonRequestHandler,
  createDaemonServer,
  daemonRoutes,
  isHostAllowed,
  isLoopbackBindAddress,
  SECURITY_HEADERS,
} from "./server";
