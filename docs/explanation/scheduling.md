# Scheduling and ownership

Swamp serve owns the clock. The `media` root workflow owns reconciliation. systemd keeps the guest
and daemons available; it does not decide when to search or download.

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

The root DAG acquires an installation owner before its child workflows run. Child calls assert that
same owner. A schedule tick during an unfinished run cannot acquire a second owner. Ownership has no
automatic timeout because a slow or interrupted external operation can outlive its caller.

There are three independent native controls:

| Control             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| Commissioning       | Root authorizes a particular qualified image and installation |
| Admission           | An operator permits new media runs after maintenance checks   |
| Schedule activation | Swamp may start automatic runs at configured cron slots       |

A commissioned VM can serve diagnostics with admissions inhibited. Manual operation can be open
while the schedule is disabled. New installations start with scheduling disabled; native
provisioning also inhibits admissions.

Native activation lives in `P/state/maintenance/activation.json`, outside the rebuildable checkout.
Configuration application preserves that intent. The YAML `schedule.enabled` field alone does not
describe native activation. Changing native definitions requires stopped application writers and
leaves admissions inhibited until verification.

Cron follows the serve process's local time zone. The generated trigger skips missed slots instead
of catching up after downtime. Recovery is explicit: prove writers have stopped, inspect the report
and journal, reconcile side effects, then release the saved owner. Deleting a lease file bypasses
that sequence and can let two runs operate on the same files.

Each reconciliation selects every ready movie and at most one ready episode for delivery. The DAG
passes that run's delivery plan to sequential child calls, so multiple ready movies can finish in
one run without concurrent library writers. Discovery/download batch limits still apply separately.
