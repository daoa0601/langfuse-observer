import { createJsonRequester, ObserverError } from "./langfuse-api.ts";
import { createLegacyObserver } from "./langfuse-v3.ts";
import { createCurrentObserver } from "./langfuse-v4.ts";
import type {
  ApiVersion,
  LangfuseObserver,
  ObserverContext,
  ObserverConfig,
  ObserverDependencies,
  RecentWindow,
} from "./observer-types.ts";

export { ObserverError } from "./langfuse-api.ts";

export function createLangfuseObserver(
  config: ObserverConfig,
  dependencies: ObserverDependencies = {},
): Readonly<LangfuseObserver> {
  const now = dependencies.now ?? (() => new Date());
  const requestJson = createJsonRequester(config, dependencies.fetchImpl ?? fetch);

  const observers: Readonly<Record<ApiVersion, Readonly<LangfuseObserver>>> = Object.freeze({
    v3: createLegacyObserver({ now, requestJson }),
    v4: createCurrentObserver({ now, requestJson }),
  });

  let selectedVersion = config.apiVersion;

  return Object.freeze({
    listRecentTraces: (window: RecentWindow, context?: ObserverContext) =>
      call((observer) => observer.listRecentTraces(window, context)),
    listRecentSessions: (window: RecentWindow, context?: ObserverContext) =>
      call((observer) => observer.listRecentSessions(window, context)),
    getSession: (sessionId: string, context?: ObserverContext) =>
      call((observer) => observer.getSession(sessionId, context)),
    getTrace: (traceId: string, context?: ObserverContext) =>
      call((observer) => observer.getTrace(traceId, context)),
  });

  async function call<Result>(
    operation: (observer: LangfuseObserver) => Promise<Result>,
  ): Promise<Result> {
    if (selectedVersion !== "auto") {
      return operation(observers[selectedVersion]);
    }

    return selectVersion(operation);
  }

  async function selectVersion<Result>(
    operation: (observer: LangfuseObserver) => Promise<Result>,
  ): Promise<Result> {
    try {
      const result = await operation(observers.v4);
      selectedVersion = "v4";

      return result;
    } catch (error) {
      if (!(error instanceof ObserverError) || error.code !== "UNSUPPORTED_API") {
        throw error;
      }

      const result = await operation(observers.v3);
      selectedVersion = "v3";

      return result;
    }
  }
}
