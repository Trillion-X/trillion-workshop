# Keep an Elestio update schedule

`tool:keep-an-elestio-update-schedule` makes the two update schedules of one Elestio service equal what its owner keeps as DATA (a computer's row), and reads them back. It holds no schedule itself.

Why: on Nov 25 2026 both Elestio computers' rows took over their reboot (`99-no-automatic-reboot`), while Elestio's panel still kept their OS and software update schedules by hand. A setting kept only in a panel drifts from the row and is seen by no one.

## What it does

| Step | How |
|------|-----|
| Session | `auth/checkAPIToken` with the account email and the held `elestio-api-key` (fd 4), through `tool:keep-an-elestio-firewall`'s `signIn`. |
| Read | `servers/getServerDetails`: `system_AutoUpdate_Enabled`, `_SecurityPatchesOnly`, `_RebootDayOfWeek`, `_RebootHour`, `_RebootMinute`, and `app_AutoUpdate_Enabled`, `_DayOfWeek`, `_Hour`, `_Minute`. |
| Compare | Each schedule the request names (`system`, `app`); one it does not name is only read. |
| Send | `servers/DoActionOnServer` with `systemAutoUpdateEnable` (its security-only flag and time) or `systemAutoUpdateDisable`, and `appAutoUpdateEnable` (its time) or `appAutoUpdateDisable`. |
| Read back | Every `poll_seconds` until both are equal, or `wait_seconds` (120). |
| `apply: false` | Reads and answers the difference; sends nothing. |

Elestio names the system schedule's time `RebootDayOfWeek` and `RebootHour`, but it is when its weekly `unattended-upgrades` run starts (the computer's root crontab). Whether that run reboots is the computer's own apt setting, `Unattended-Upgrade::Automatic-Reboot`, which the computer's row keeps. The software schedule is Elestio's weekly watchtower run; a container that must keep its pinned image carries `com.centurylinklabs.watchtower.enable=false` itself, so the schedule can stay on for Elestio's own containers (its proxy and mail relay). Hours are UTC, as Elestio keeps them.

## Source and checks

`do-work/keep-an-elestio-update-schedule.mjs` (Node's own `fetch`; no package). `test/keep-an-elestio-update-schedule.test.mjs` answers each call with a made-up service: equal schedules only read, a changed time sent with its fields and read back after a lag, one switched off, apply false, one Elestio never takes, and refused shapes. Run `node --test tools/keep-an-elestio-update-schedule/test/`.

`workflow:keep-each-computers-update-schedule` (a row of the person's own `workflow_recipes`) reads each computer row's `runs.updates` with its Elestio service from `runs.firewall` and runs this tool for it.
