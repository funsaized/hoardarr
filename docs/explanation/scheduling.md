# Scheduling and ownership

Swamp serve watches the clock. The `media` workflow does the media work. systemd keeps the VM and
daemons available, but does not decide when to search or download.

```text
cron tick / manual run
          |
  admission + storage + VPN checks
          |
  acquire installation owner ----- existing owner -> refuse overlap
          |
  discover / reconcile / deliver
          |
  recover environment + release
```

## One owner at a time

The root workflow acquires an installation owner before starting its children. Each child checks
that same owner. A schedule tick during an unfinished run cannot acquire a second one.

There is no automatic timeout. A slow or interrupted download can outlive the caller, so elapsed
time alone cannot prove it is safe to start again.

## Three separate controls

| Control             | What it allows                                        |
| ------------------- | ----------------------------------------------------- |
| Commissioning       | Root authorizes a qualified image and installation    |
| Admission           | An operator permits new runs after maintenance checks |
| Schedule activation | Swamp may start runs at the configured times          |

A commissioned VM can serve diagnostics while admissions are closed. Manual runs can be allowed
while scheduling is off. New installations start with scheduling disabled; native provisioning also
closes admissions.

## Where the schedule lives

Native activation is saved in `P/state/maintenance/activation.json`, outside the rebuildable
checkout. Applying configuration preserves that choice, so `schedule.enabled` in YAML alone does not
tell you whether a native schedule is active.

Changing native definitions requires stopped writers. Admissions remain closed until you verify and
reopen them.

Cron uses the serve process's local time zone. Missed slots are skipped rather than replayed after
downtime.

## Delivery and recovery

A run selects every ready movie and every ready episode. Child calls use that run's delivery plan
and run in sequence, so multiple downloads can finish without concurrent library writers. Discovery
and download batch limits apply separately.

To recover, prove writers have stopped, inspect the report and journal, reconcile outside effects,
then release the saved owner. Deleting the lease file skips those checks and can let two runs touch
the same files.

[Back to the README](../../README.md#reference)
