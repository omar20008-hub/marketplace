"use client";

import { useActionState, useState } from "react";
import { CalendarClock, Play, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  FootNote,
  Input,
  SectionLabel,
  Table,
  Td,
  Th,
} from "@/components/ds";
import {
  CADENCES,
  CADENCE_LABELS,
  DAY_NAMES,
  type Cadence,
} from "@/lib/cadence";
import {
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  setScheduleEnabled,
  type ScheduleState,
} from "@/server/schedule-actions";

export type ScheduleRow = {
  id: string;
  label: string;
  enabled: boolean;
  productTitle: string;
  lastStatus: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export type SchedulableInstallation = {
  id: string;
  productTitle: string;
  fields: { name: string; label: string; type: string; required: boolean }[];
};

/**
 * The schedules view.
 *
 * The inputs a product declares are collected here, when the schedule is made,
 * rather than at run time — a firing at 07:00 has nobody to ask. That is the
 * whole reason this is a form and not a single "repeat" toggle.
 */
export function SchedulesPanel({
  schedules,
  installations,
}: {
  schedules: ScheduleRow[];
  installations: SchedulableInstallation[];
}) {
  const [open, setOpen] = useState(false);
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [weekday, setWeekday] = useState("1");
  const [time, setTime] = useState("09:00");
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [args, setArgs] = useState<Record<string, string>>({});

  const [state, formAction, pending] = useActionState<ScheduleState, FormData>(
    async (previous, formData) => {
      const result = await createSchedule(previous, formData);
      if (!result.error) {
        setOpen(false);
        setArgs({});
      }
      return result;
    },
    {},
  );

  const chosen = installations.find((item) => item.id === installationId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FootNote>
          Times are UTC. A schedule runs on the same checks as the Run button, so
          one that is over your plan limit or missing a connection is stopped
          before anything is spent.
        </FootNote>
        {installations.length > 0 ? (
          <Button size="sm" type="button" onClick={() => setOpen((was) => !was)}>
            <CalendarClock size={15} strokeWidth={1.8} />
            {open ? "Cancel" : "New schedule"}
          </Button>
        ) : null}
      </div>

      {open ? (
        <Card className="p-4">
          {/*
            Keyed on the reply count. React puts a form back to its defaults once
            its action resolves, which leaves the DOM disagreeing with the state
            these fields are drawn from — the screen keeps saying "every
            Wednesday" while the next submit sends "every hour". Remounting on
            each reply redraws every field from state, so the two cannot drift.
          */}
          <form
            key={state.attempt ?? 0}
            action={formAction}
            className="flex flex-col gap-4"
          >
            <SectionLabel>New schedule</SectionLabel>

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Product</span>
              <select
                name="installationId"
                value={installationId}
                onChange={(event) => {
                  setInstallationId(event.target.value);
                  // Another product declares different fields, so values typed
                  // for the last one must not be carried across to it.
                  setArgs({});
                }}
                className="h-10 rounded-row border border-line bg-canvas px-3 text-sm"
              >
                {installations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.productTitle}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium">How often</span>
                <select
                  name="cadence"
                  value={cadence}
                  onChange={(event) => setCadence(event.target.value as Cadence)}
                  className="h-10 rounded-row border border-line bg-canvas px-3 text-sm"
                >
                  {CADENCES.map((item) => (
                    <option key={item} value={item}>
                      {CADENCE_LABELS[item]}
                    </option>
                  ))}
                </select>
              </label>

              {cadence === "weekly" ? (
                <label className="flex flex-1 flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Day</span>
                  <select
                    name="weekday"
                    value={weekday}
                    onChange={(event) => setWeekday(event.target.value)}
                    className="h-10 rounded-row border border-line bg-canvas px-3 text-sm"
                  >
                    {DAY_NAMES.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {cadence !== "hourly" ? (
                <label className="flex flex-1 flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Time · UTC</span>
                  <Input
                    name="time"
                    type="time"
                    required
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    step={60}
                  />
                </label>
              ) : null}
            </div>

            {chosen && chosen.fields.length > 0 ? (
              <div className="flex flex-col gap-3 border-t border-selected pt-3">
                <SectionLabel className="text-ink-3">
                  What it should run with, every time
                </SectionLabel>
                {chosen.fields.map((field) => (
                  <label key={field.name} className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">
                      {field.label}
                      {field.required ? (
                        <span className="ml-1 font-normal text-ink-3">· required</span>
                      ) : null}
                    </span>
                    <Input
                      name={`arg.${field.name}`}
                      type={field.type === "number" ? "number" : "text"}
                      // Caught by the browser before the round trip, so the
                      // ordinary mistake never costs a submit.
                      required={field.required}
                      value={args[field.name] ?? ""}
                      onChange={(event) =>
                        setArgs((current) => ({
                          ...current,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            ) : null}

            {state.error ? (
              <p className="text-[13px] text-danger-ink">{state.error}</p>
            ) : null}

            <div className="flex justify-end">
              <Button size="sm" type="submit" disabled={pending}>
                {pending ? "Saving…" : "Create schedule"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {schedules.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-3">
          {installations.length === 0
            ? "Add something to your workspace first, then you can put it on a schedule."
            : "No schedules yet."}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th>When</Th>
              <Th>Next run</Th>
              <Th>Last status</Th>
              <Th>State</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule) => (
              <tr key={schedule.id}>
                <Td>{schedule.productTitle}</Td>
                <Td className="text-ink-2">{schedule.label}</Td>
                <Td className="text-ink-2">
                  {schedule.enabled ? (schedule.nextRunAt ?? "—") : "—"}
                </Td>
                <Td className="text-ink-2">{schedule.lastStatus ?? "Not yet run"}</Td>
                <Td>
                  <Badge tone={schedule.enabled ? "ready" : "neutral"}>
                    {schedule.enabled ? "On" : "Paused"}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-1">
                    <form action={runScheduleNow}>
                      <input type="hidden" name="scheduleId" value={schedule.id} />
                      <button
                        type="submit"
                        title="Run now"
                        aria-label={`Run ${schedule.productTitle} now`}
                        className="flex size-8 items-center justify-center rounded-row text-ink-2 hover:bg-fill hover:text-ink"
                      >
                        <Play size={15} strokeWidth={1.8} />
                      </button>
                    </form>

                    <form action={setScheduleEnabled}>
                      <input type="hidden" name="scheduleId" value={schedule.id} />
                      {/* Absent means off, which is how a checkbox would post it. */}
                      {schedule.enabled ? null : (
                        <input type="hidden" name="enabled" value="on" />
                      )}
                      <button
                        type="submit"
                        className="h-8 rounded-full px-3 text-[13px] text-ink-2 hover:bg-fill hover:text-ink"
                      >
                        {schedule.enabled ? "Pause" : "Resume"}
                      </button>
                    </form>

                    <form action={deleteSchedule}>
                      <input type="hidden" name="scheduleId" value={schedule.id} />
                      <button
                        type="submit"
                        title="Delete"
                        aria-label={`Delete the schedule for ${schedule.productTitle}`}
                        className="flex size-8 items-center justify-center rounded-row text-ink-2 hover:bg-danger-tint hover:text-danger-ink"
                      >
                        <Trash2 size={15} strokeWidth={1.8} />
                      </button>
                    </form>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
