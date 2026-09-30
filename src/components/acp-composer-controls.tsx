"use client";

import { Popover } from "@base-ui/react/popover";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import type { AcpAction, AcpSnapshot } from "@/lib/acp";

const triggerClass =
  "flex h-7 min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50";
const popupClass =
  "max-h-[var(--available-height)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto border bg-background p-3 font-mono text-xs text-foreground outline-none";

export function AcpComposerControls({
  options = [],
  contextUsage,
  disabled,
  onAction,
}: {
  options?: AcpSnapshot["configOptions"];
  contextUsage?: AcpSnapshot["contextUsage"];
  disabled: boolean;
  onAction: (action: AcpAction) => void;
}) {
  const primary = options.filter(
    (option) =>
      option.category === "mode" ||
      option.category === "model" ||
      option.id === "mode" ||
      option.id === "model",
  );
  const summary = (primary.length ? primary : options.slice(0, 2))
    .map(
      (option) =>
        option.options.find((choice) => choice.value === option.currentValue)
          ?.name ?? option.currentValue,
    )
    .join(" · ");
  const percent = contextUsage
    ? Math.round((contextUsage.used / contextUsage.size) * 100)
    : undefined;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-1">
      {options.length > 0 && (
        <Popover.Root>
          <Popover.Trigger
            className={`${triggerClass} max-w-full`}
            aria-label={`Agent settings: ${summary}`}
            title={summary}
            disabled={disabled}
          >
            <SlidersHorizontal className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground">{summary}</span>
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              side="top"
              align="start"
              sideOffset={8}
              className="z-50"
            >
              <Popover.Popup className={popupClass}>
                <div className="mb-3 flex items-center justify-between">
                  <Popover.Title className="text-[11px] text-muted-foreground">
                    Agent settings
                  </Popover.Title>
                  <Popover.Close
                    aria-label="Close agent settings"
                    className="p-1 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <X className="size-3" />
                  </Popover.Close>
                </div>
                <div className="space-y-3">
                  {options.map((option) => (
                    <fieldset
                      key={option.id}
                      disabled={disabled}
                      className="min-w-0 disabled:opacity-50"
                    >
                      <legend className="mb-1.5 text-[11px]">
                        {option.name}
                      </legend>
                      {option.description && (
                        <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
                          {option.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {option.options.map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            aria-pressed={choice.value === option.currentValue}
                            title={choice.description}
                            disabled={disabled}
                            onClick={() => {
                              if (
                                !disabled &&
                                choice.value !== option.currentValue
                              )
                                onAction({
                                  type: "set-config",
                                  configId: option.id,
                                  value: choice.value,
                                });
                            }}
                            className="max-w-full break-words border px-2 py-1 text-left text-[11px] text-muted-foreground hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
                          >
                            {choice.name}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
                {disabled && (
                  <p
                    role="status"
                    className="mt-3 border-t pt-2 text-[10px] text-muted-foreground"
                  >
                    Settings unavailable while Codex is busy.
                  </p>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
      <Popover.Root>
        <Popover.Trigger
          className={`${triggerClass} ml-auto shrink-0`}
          aria-label="Context estimate details"
        >
          {contextUsage && (
            <progress
              aria-label="Last reported context usage"
              className="h-1 w-10 accent-primary"
              max={contextUsage.size}
              value={Math.min(contextUsage.used, contextUsage.size)}
            />
          )}
          <span>context {percent === undefined ? "—" : `${percent}%`}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="top"
            align="end"
            sideOffset={8}
            className="z-50"
          >
            <Popover.Popup className={popupClass}>
              <Popover.Title className="mb-2 text-[11px]">
                Context · last reported
              </Popover.Title>
              <p className="mb-2">
                {contextUsage
                  ? `${contextUsage.used.toLocaleString()} / ${contextUsage.size.toLocaleString()} (${percent}%)`
                  : "Context unavailable — not yet reported"}
              </p>
              <Popover.Description className="text-[10px] leading-4 text-muted-foreground">
                Last Codex-reported context estimate; not cumulative billable
                tokens or ChatGPT plan quota.
              </Popover.Description>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
