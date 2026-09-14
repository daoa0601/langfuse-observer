import type {
  CurrentTraceFilterPanel,
  LegacyTraceFilterPanel,
  RecentTracePage,
  TraceFilterOption,
  TraceRunStateOption,
} from "./recent-trace-filters.ts";
import {
  apiLabel,
  escapeAttribute,
  escapeHtml,
  formatDate,
  renderWindowOptions,
} from "./view-helpers.ts";

export function renderTraceFilterSidebar(page: RecentTracePage): string {
  return `
    <aside class="trace-filter-panel" aria-labelledby="trace-filters-heading">
      <form class="trace-filter-sidebar" method="get" action="/">
        <div class="filter-sidebar-heading">
          <div>
            <p class="section-label">Narrow this window</p>
            <h2 id="trace-filters-heading">Filters</h2>
          </div>
          <a href="/?window=${escapeAttribute(page.window)}">Clear</a>
        </div>
        <label class="filter-search" for="trace-search">
          <span>Trace name or ID</span>
          <input id="trace-search" name="q" type="search" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Search traces" value="${escapeAttribute(page.filterPanel.search ?? "")}">
        </label>
        <label class="filter-window" for="filter-window">
          <span>Recent window</span>
          <select id="filter-window" name="window">${renderWindowOptions(page.window)}</select>
        </label>
        ${renderChoiceGroup("Environment", "environment", page.filterPanel.environments)}
        ${renderChoiceGroup("Trace tags", "tag", page.filterPanel.tags)}
        ${renderVersionSpecificFilters(page.filterPanel)}
        <button class="button primary filter-submit" type="submit">Apply filters</button>
        <p class="filter-connection"><span class="status-dot" aria-hidden="true"></span>Langfuse connected · ${escapeHtml(apiLabel(page.apiVersion))} · ${escapeHtml(formatDate(page.queriedAt))}</p>
      </form>
    </aside>`;
}

function renderVersionSpecificFilters(
  panel: CurrentTraceFilterPanel | LegacyTraceFilterPanel,
): string {
  switch (panel.kind) {
    case "v4":
      return `${renderChoiceGroup("Highest level", "level", panel.levels)}${renderRunStateGroup(panel.runStates)}`;
    case "v3":
      return `${renderUnavailableGroup("Highest level", "Highest level is unavailable from the v3 trace list.")}${renderUnavailableGroup("Run state", "Run state is unavailable from the v3 trace list.")}`;
    default: {
      const exhaustive: never = panel;

      return exhaustive;
    }
  }
}

function renderChoiceGroup(
  label: string,
  name: "environment" | "tag" | "level",
  options: readonly TraceFilterOption[],
): string {
  const selectedCount = options.filter((option) => option.selected).length;
  const open = selectedCount > 0 ? " open" : "";

  const summary =
    selectedCount > 0
      ? `${selectedCount} selected`
      : `${options.length} ${options.length === 1 ? "option" : "options"}`;

  const choices =
    options.length === 0
      ? `<p class="filter-empty">No values in this window.</p>`
      : `<fieldset class="filter-options">
          <legend class="sr-only">${escapeHtml(label)}</legend>
          ${options.map((option) => renderChoice(name, option)).join("")}
        </fieldset>`;

  return `
    <details class="filter-group"${open}>
      <summary><span>${escapeHtml(label)}</span><small>${escapeHtml(summary)}</small></summary>
      ${choices}
    </details>`;
}

function renderChoice(name: "environment" | "tag" | "level", option: TraceFilterOption): string {
  return `
    <label class="filter-option">
      <input name="${name}" type="checkbox" value="${escapeAttribute(option.value)}"${option.selected ? " checked" : ""}>
      <span>${escapeHtml(option.value)}</span>
      <small>${option.traceCount}</small>
    </label>`;
}

function renderRunStateGroup(options: readonly TraceRunStateOption[]): string {
  const selected = options.find((option) => option.selected);
  const open = selected === undefined ? "" : " open";

  return `
    <details class="filter-group"${open}>
      <summary><span>Run state</span><small>${escapeHtml(selected?.label ?? "Any")}</small></summary>
      <fieldset class="filter-options">
        <legend class="sr-only">Run state</legend>
        <label class="filter-option">
          <input name="status" type="radio" value=""${selected === undefined ? " checked" : ""}>
          <span>Any run state</span>
        </label>
        ${options
          .map(
            (option) => `
          <label class="filter-option">
            <input name="status" type="radio" value="${option.value}"${option.selected ? " checked" : ""}>
            <span>${escapeHtml(option.label)}</span>
            <small>${option.traceCount}</small>
          </label>`,
          )
          .join("")}
      </fieldset>
    </details>`;
}

function renderUnavailableGroup(label: string, reason: string): string {
  return `
    <details class="filter-group unavailable">
      <summary><span>${escapeHtml(label)}</span><small>Unavailable</small></summary>
      <p>${escapeHtml(reason)}</p>
    </details>`;
}
