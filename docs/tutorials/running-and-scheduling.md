# Run on a schedule

Use the demo from [the first lesson](first-run.md). You can watch the scheduler without starting
real downloads. Open two terminals with the same Swamp credentials.

## Set a time

In `~/hoardarr-demo/hoardarr.yaml`, set the cron expression to once per minute:

```yaml
schedule:
  enabled: false
  cron: "* * * * *"
```

From the source directory, enable the trigger:

```sh
bin/hoardarr schedule enable --dir "$HOME/hoardarr-demo"
```

## Start Swamp serve

In the first terminal:

```sh
swamp serve --repo-dir "$HOME/hoardarr-demo" --host 127.0.0.1 --port 9090
```

After the next minute boundary, check history in the second terminal:

```sh
swamp workflow history media --repo-dir "$HOME/hoardarr-demo" --json
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

You'll see a scheduled run even if everything was already delivered. The trigger uses
`dryRun: false`, so it authorizes real work on a real installation. This demo still uses fixtures.

Cron uses the Swamp server process's local time zone. Check its environment when interpreting a
time. The native launcher removes inherited `TZ`, so the guest's OS time zone applies there. Missed
slots are skipped (`catchUp.policy: none`). The host boot service only starts the VM.

## Turn it off

After the current run finishes, disable the schedule. Then stop serve with Ctrl-C:

```sh
bin/hoardarr schedule disable --dir "$HOME/hoardarr-demo"
```

Compose reads schedule settings from the host-mounted configuration at startup. Edit
`schedule.enabled` there and apply it.

A native VM needs the full [stopped-writer procedure](../how-to/operate-native.md). Use that guide
after commissioning; the demo steps do not replace its maintenance checks.

[Back to the README](../../README.md#reference)
