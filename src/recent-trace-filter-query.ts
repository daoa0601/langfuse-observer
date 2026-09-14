import type { RecentWindow } from "./observer-types.ts";
import { parseRecentWindow } from "./trace-model.ts";

const MAX_SEARCH_LENGTH = 256;

const MAX_CHOICE_LENGTH = 128;

const MAX_SELECTED_CHOICES = 32;

export type TraceRunState = "running" | "ended";

export interface RecentTraceFilters {
  readonly search: string | null;
  readonly environments: readonly string[];
  readonly tags: readonly string[];
  readonly levels: readonly string[];
  readonly runState: TraceRunState | null;
}

export interface RecentTraceRequest {
  readonly window: RecentWindow;
  readonly filters: RecentTraceFilters;
}

export type RecentTraceRequestResult =
  | Readonly<{ kind: "valid"; request: RecentTraceRequest }>
  | Readonly<{ kind: "invalid"; message: string }>;

type ScalarParameter =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "value"; value: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

type ChoiceParameters =
  | Readonly<{ kind: "valid"; values: readonly string[] }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function parseRecentTraceRequest(parameters: URLSearchParams): RecentTraceRequestResult {
  const windowParameter = readScalar({
    parameters,
    name: "window",
    label: "Recent window",
    maximumLength: 4,
    empty: "invalid",
  });

  if (windowParameter.kind === "invalid") {
    return windowParameter;
  }

  const window =
    windowParameter.kind === "absent" ? "24h" : parseRecentWindow(windowParameter.value);

  if (window === null) {
    return invalid("Recent window must be 1h, 6h, 24h, 7d, 30d, or 90d.");
  }

  const searchParameter = readScalar({
    parameters,
    name: "q",
    label: "Search",
    maximumLength: MAX_SEARCH_LENGTH,
    empty: "absent",
  });

  if (searchParameter.kind === "invalid") {
    return searchParameter;
  }

  const statusParameter = readScalar({
    parameters,
    name: "status",
    label: "Run state",
    maximumLength: 7,
    empty: "absent",
  });

  if (statusParameter.kind === "invalid") {
    return statusParameter;
  }

  const runState = parseRunState(statusParameter);

  if (runState.kind === "invalid") {
    return runState;
  }

  const environments = readChoices(parameters, "environment", "Environment");

  if (environments.kind === "invalid") {
    return environments;
  }

  const tags = readChoices(parameters, "tag", "Tag");

  if (tags.kind === "invalid") {
    return tags;
  }

  const levels = readChoices(parameters, "level", "Highest level");

  if (levels.kind === "invalid") {
    return levels;
  }

  return Object.freeze({
    kind: "valid",
    request: Object.freeze({
      window,
      filters: Object.freeze({
        search: searchParameter.kind === "value" ? searchParameter.value : null,
        environments: environments.values,
        tags: tags.values,
        levels: levels.values,
        runState: runState.value,
      }),
    }),
  });
}

function readScalar({
  parameters,
  name,
  label,
  maximumLength,
  empty,
}: Readonly<{
  parameters: URLSearchParams;
  name: string;
  label: string;
  maximumLength: number;
  empty: "absent" | "invalid";
}>): ScalarParameter {
  const values = parameters.getAll(name);

  if (values.length === 0) {
    return { kind: "absent" };
  }

  if (values.length > 1) {
    return invalid(`${label} must appear at most once.`);
  }

  const rawValue = values[0];

  if (rawValue === undefined) {
    return invalid(`${label} is missing.`);
  }

  const value = rawValue.trim();

  if (value.length === 0) {
    return empty === "absent" ? { kind: "absent" } : invalid(`${label} cannot be empty.`);
  }

  if (value.length > maximumLength) {
    return invalid(`${label} must be at most ${maximumLength} characters.`);
  }

  if (containsControlCharacter(value)) {
    return invalid(`${label} cannot contain control characters.`);
  }

  return Object.freeze({ kind: "value", value });
}

function readChoices(parameters: URLSearchParams, name: string, label: string): ChoiceParameters {
  const submitted = parameters.getAll(name);

  if (submitted.length > MAX_SELECTED_CHOICES) {
    return invalid(`${label} accepts at most ${MAX_SELECTED_CHOICES} selected values.`);
  }

  const values: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of submitted) {
    const value = rawValue.trim();

    if (value.length === 0) {
      return invalid(`${label} cannot be empty.`);
    }

    if (value.length > MAX_CHOICE_LENGTH) {
      return invalid(`${label} values must be at most ${MAX_CHOICE_LENGTH} characters.`);
    }

    if (containsControlCharacter(value)) {
      return invalid(`${label} cannot contain control characters.`);
    }

    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }

  return Object.freeze({ kind: "valid", values: Object.freeze(values) });
}

function parseRunState(
  parameter: ScalarParameter,
):
  | Readonly<{ kind: "valid"; value: TraceRunState | null }>
  | Readonly<{ kind: "invalid"; message: string }> {
  if (parameter.kind === "invalid") {
    return parameter;
  }

  if (parameter.kind === "absent") {
    return { kind: "valid", value: null };
  }

  switch (parameter.value) {
    case "running":
    case "ended":
      return Object.freeze({ kind: "valid", value: parameter.value });
    default:
      return invalid("Run state must be running or ended.");
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

function invalid(message: string): Readonly<{ kind: "invalid"; message: string }> {
  return Object.freeze({ kind: "invalid", message });
}
