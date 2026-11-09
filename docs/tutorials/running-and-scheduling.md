# Run on a schedule

Use the demo from [the first lesson](first-run.md). This lets you observe the scheduler without
starting real downloads. You need two terminals and the same Swamp credentials in both.

In `~/hoardarr-demo/hoardarr.yaml`, change the cron expression to once per minute:

```yaml
schedule:
  enabled: false
  cron: "* * * * *"
```

From the source directory, enable the generated trigger:

```sh
bin/hoardarr schedule enable --dir "$HOME/hoardarr-demo"
```

Start the server in the first terminal:

```sh
swamp serve --repo-dir "$HOME/hoardarr-demo" --host 127.0.0.1 --port 9090
```

In the second terminal, inspect workflow history after the next minute boundary:

```sh
swamp workflow history media --repo-dir "$HOME/hoardarr-demo" --json
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

A scheduled run appears in history even if everything was already delivered. The root workflow uses
`dryRun: false`, so enabling a real installation's trigger authorizes real reconciliation. The demo
still uses fixture providers.

The cron expression uses the Swamp server process's local time zone. Inspect the server environment
when interpreting a time. The native guest launcher removes inherited `TZ`, so its OS time-zone
configuration applies. Missed slots are skipped (`catchUp.policy: none`). A host boot service starts
the VM; it does not schedule media work.

Turn the schedule off, then stop serve with Ctrl-C:

```sh
bin/hoardarr schedule disable --dir "$HOME/hoardarr-demo"
```

For Compose, edit `schedule.enabled` in the host-mounted configuration and apply it; that file is
the startup source of truth. For a commissioned native VM, follow the stopped-writer procedure in
[Operate a commissioned VM](../how-to/operate-native.md). The demo command sequence is not a
substitute for native maintenance checks.
