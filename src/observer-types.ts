import type { JsonValue } from "./json.ts";

export type { JsonObject, JsonValue } from "./json.ts";

export type ApiVersion = "v3" | "v4";

export type ApiVersionChoice = "auto" | ApiVersion;

export type RecentWindow = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";

export type NumberFields = Readonly<Record<string, number>>;

export type QueryScope =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "bounded"; from: string; to: string }>;

export type ObserverErrorCode =
  | "AUTH_FAILED"
  | "CANCELLED"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "RESULT_TOO_LARGE"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "UNSUPPORTED_API"
  | "UPSTREAM_ERROR";

export interface ObserverContext {
  readonly signal?: AbortSignal;
}

export interface LangfuseConfig {
  readonly apiVersion: ApiVersionChoice;
  readonly baseUrl: URL;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly host: "127.0.0.1";
  readonly port: number;
}

export type ObserverConfig = Pick<
  LangfuseConfig,
  "apiVersion" | "baseUrl" | "publicKey" | "secretKey"
>;

export interface ObservationCore {
  readonly id: string;
  readonly traceId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly name: string | null;
  readonly sessionId: string | null;
  readonly level: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly isLogicalRoot: boolean;
}

export interface LightObservation extends ObservationCore {
  readonly traceName: string | null;
  readonly environment: string | null;
  readonly tags: readonly string[];
}

export interface FullObservation extends LightObservation {
  readonly userId: string | null;
  readonly statusMessage: string | null;
  readonly input: JsonValue;
  readonly output: JsonValue;
  readonly metadata: JsonValue;
  readonly model: string | null;
  readonly modelParameters: JsonValue;
  readonly usage: NumberFields;
  readonly cost: NumberFields;
  readonly promptName: string | null;
  readonly promptVersion: number | null;
  readonly latency: number | null;
  readonly timeToFirstToken: number | null;
  readonly totalCost: number | null;
}

export type ParsedObservationFields = Omit<
  FullObservation,
  "traceName" | "environment" | "tags" | "userId" | "totalCost"
>;

export type ObservationRelation = "root" | "child" | "missing-parent" | "cycle-break";

export interface ObservationRow {
  readonly observation: FullObservation;
  readonly depth: number;
  readonly relation: ObservationRelation;
}

interface RecentTraceBase {
  readonly id: string;
  readonly name: string;
  readonly startedAt: string;
  readonly latestRootAt: string;
  readonly hasOpenRoot: boolean | null;
  readonly highestLevel: string | null;
  readonly environment: string | null;
  readonly tags: readonly string[];
}

export interface CurrentRecentTrace extends RecentTraceBase {
  readonly rootCount: number;
  readonly hasOpenRoot: boolean;
  readonly highestLevel: string;
}

export interface LegacyRecentTrace extends RecentTraceBase {
  readonly rootCount: null;
  readonly hasOpenRoot: null;
  readonly highestLevel: null;
}

interface SessionSummaryBase {
  readonly id: string;
  readonly startedAt: string;
  readonly latestAt: string;
  readonly highestLevel: string;
  readonly environments: readonly string[];
  readonly tags: readonly string[];
}

export interface CurrentSessionSummary extends SessionSummaryBase {
  readonly traceCount: number;
  readonly observationCount: number;
}

export interface LegacySessionSummary extends SessionSummaryBase {
  readonly traceCount: null;
  readonly observationCount: null;
}

export interface CurrentSessionTrace {
  readonly id: string;
  readonly name: string;
  readonly startedAt: string;
  readonly latestAt: string;
  readonly observationCount: number;
  readonly highestLevel: string;
  readonly environment: string | null;
  readonly tags: readonly string[];
}

export interface LegacySessionTrace extends Omit<CurrentSessionTrace, "observationCount"> {
  readonly observationCount: null;
}

export type RecentTracesResult =
  | Readonly<{
      apiVersion: "v3";
      window: RecentWindow;
      queriedAt: string;
      traces: readonly LegacyRecentTrace[];
    }>
  | Readonly<{
      apiVersion: "v4";
      window: RecentWindow;
      queriedAt: string;
      traces: readonly CurrentRecentTrace[];
    }>;

export type RecentSessionsResult =
  | Readonly<{
      apiVersion: "v3";
      window: RecentWindow;
      queriedAt: string;
      sessions: readonly LegacySessionSummary[];
    }>
  | Readonly<{
      apiVersion: "v4";
      window: RecentWindow;
      queriedAt: string;
      sessions: readonly CurrentSessionSummary[];
    }>;

interface SessionDetailBase extends SessionSummaryBase {
  readonly traceCount: number;
}

export interface CurrentSessionDetail extends SessionDetailBase {
  readonly apiVersion: "v4";
  readonly queryScope: Extract<QueryScope, { kind: "bounded" }>;
  readonly observationCount: number;
  readonly traces: readonly CurrentSessionTrace[];
}

export interface LegacySessionDetail extends SessionDetailBase {
  readonly apiVersion: "v3";
  readonly queryScope: Extract<QueryScope, { kind: "complete" }>;
  readonly observationCount: null;
  readonly traces: readonly LegacySessionTrace[];
}

export type SessionDetail = CurrentSessionDetail | LegacySessionDetail;

export interface TraceDescription {
  readonly id: string;
  readonly name: string;
  readonly observationCount: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sessionIds: readonly string[];
  readonly rows: readonly ObservationRow[];
}

export interface TraceContext {
  readonly environment: string | null;
  readonly input: JsonValue;
  readonly metadata: JsonValue;
  readonly output: JsonValue;
  readonly release: string | null;
  readonly tags: readonly string[];
  readonly userId: string | null;
  readonly version: string | null;
}

export interface CurrentTraceDetail extends TraceDescription {
  readonly apiVersion: "v4";
  readonly queryScope: Extract<QueryScope, { kind: "bounded" }>;
}

export interface LegacyTraceDetail extends TraceDescription {
  readonly apiVersion: "v3";
  readonly queryScope: Extract<QueryScope, { kind: "complete" }>;
  readonly totalCost: number | null;
  readonly traceContext: TraceContext;
}

export type TraceDetail = CurrentTraceDetail | LegacyTraceDetail;

export interface LangfuseObserver {
  listRecentTraces(window: RecentWindow, context?: ObserverContext): Promise<RecentTracesResult>;
  listRecentSessions(
    window: RecentWindow,
    context?: ObserverContext,
  ): Promise<RecentSessionsResult>;
  getSession(sessionId: string, context?: ObserverContext): Promise<SessionDetail | null>;
  getTrace(traceId: string, context?: ObserverContext): Promise<TraceDetail | null>;
}

export interface JsonRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly unsupportedOnMissing?: boolean;
  readonly notFoundAsMissingRecord?: boolean;
  readonly signal?: AbortSignal | undefined;
}

export type RequestJson = (request: JsonRequest) => Promise<JsonValue>;

export type FetchImplementation = (url: URL, init: RequestInit) => Promise<Response>;

export interface ObserverDependencies {
  readonly fetchImpl?: FetchImplementation;
  readonly now?: () => Date;
}

export interface Problem {
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
}
