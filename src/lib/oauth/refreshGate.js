// App-layer re-export — canonical implementation lives in open-sse (webpack-safe).
export {
  withRefreshGate,
  refreshLockPath,
  isSingleUseRefreshProvider,
} from "open-sse/services/tokenRefresh/refreshGate.js";
