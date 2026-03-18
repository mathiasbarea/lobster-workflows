# Schedule And Result Rules

Use this reference when defining workflow schedules or the canonical result payload.

## Schedules

Schedules live in `workflow.config.js`.

The workflow is the source of truth for:

- `scheduleId`
- schedule kind
- timing
- timezone
- whether the schedule should count toward expected runs

OpenClaw cron is only the applied scheduler.

## Schedule Design Rules

- keep `scheduleId` stable
- prefer explicit timezones
- use empty schedules for manual-only workflows
- only count a schedule toward expected runs if it is a real planned automation
- do not store OpenClaw `jobId` inside the workflow config

## Expected Runs

The metrics system treats scheduled occurrences as the source for:

- `expectedRuns`
- `expectedWorkflows`

Manual runs do not increase `expectedRuns`.

## Result Payload

Every workflow should define a canonical result payload.

This result should be:

- small
- stable
- useful to a downstream consumer

Do not return an oversized dump if a smaller result is enough.

## Good Result Examples

- artifact workflows:
  - output manifest path
  - uploaded location
  - primary identifier
- calculation workflows:
  - computed value
  - unit
  - time range
- reporting workflows:
  - report path
  - record count
  - summary fields

## Bad Result Examples

- raw stdout from the whole workflow
- giant nested objects when only one identifier matters
- a meaningless `"ok"` when a more useful artifact identifier exists

## Success And Latest Result

`observability.successCondition` defines whether the envelope counts as success.

`result.extractor` defines what part of the workflow output becomes the canonical result.

`latestResultPolicy: "on-success"` is the normal default.

That means:

- successful runs update `latestResult`
- failed runs do not erase the last successful result
