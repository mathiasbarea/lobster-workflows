
  

## ðŸ¦žðŸŒŠ Lobster-Workflows

  

### What it is?

  

**Lobster Workflows** is a control plane designed to build and operate a workspace-level platform for AI agents. It provides a standardized structure to manage complex, multi-step automation within a unified environment.

  

This system is built upon the **[Lobster](https://github.com/openclaw/lobster)** workflow shell, leveraging its capability to chain atomic actions into predictable, automated pipelines. While Lobster handles the low-level execution of tasks, this skill provides the high-level orchestration required for a professional deployment.

  

### Why is it useful?

  

Normally, managing multiple workflows can become chaotic with fragmented scripts and inconsistent logs. This tool transforms isolated scripts into a cohesive platform by providing **centralized execution records**, shared helpers to eliminate code duplication, and seamless synchronization with **OpenClaw cron** for scheduled automation.

  
  

### It is designed for teams or individuals who want:

  

- A **consistent structure** for Lobster workflows.
-  **Shared helpers** for multiple workflows.
-  **Centralized execution records** and daily metrics.
-  **Schedule sync** to OpenClaw cron.

  

### ðŸ“‹ Requirements

  

-  **Node.js:** Must be available on the system for script execution.
-  **OpenClaw:** Installed and configured with `lobster` and `llm-task` enabled.
-  **Lobster:** Installed and available on `PATH`.

  

>  **[If you need help installing Lobster and adding it to OpenClaw, check this guide.](https://github.com/mathiasbarea/Agentic-Tools/blob/main/Lobster-How-To.md)**

  <br>

## ðŸ› ï¸ What This Skill Creates

  

The skill manages three layers:

  

```Plaintext
workspace/
workflows/
<workflow-id>/
_shared/
_executions/
```

  

### `workflows/<workflow-id>/`

  

This is where each workflow lives. Each managed workflow should contain:

- `workflow.config.js`
- `README.md`
- `CONTRACT.md`
- A canonical runner such as `run-workflow.js`
- Workflow implementation files
- Tests

  

### `workflows/_shared/`

This is for **reusable code** that workflows can import directly. Examples include filesystem helpers, process helpers, OpenClaw client helpers, and envelope/error contracts. **Do not** put workflow-specific business logic here.

  
### `workflows/_executions/`

  

This is **centralized runtime state**. It stores run records, daily summaries, latest result per workflow, schedule snapshots, and cron sync state.
 <br>
  

## ðŸ§  Mental Model

  

This skill is the **control plane** for the workflows platform.

  -  **The workflow itself defines:** Identity, runtime, schedules, result extraction, and observability rules.
-  **The skill handles:** Workspace bootstrap, workflow scaffolding, managed execution, schedule sync, execution persistence, and daily metrics rebuilding.

  <br>

## ðŸ”„ Lifecycle

  

The normal lifecycle looks like this:

  

1.  **Bootstrap** the workspace.
2.  **Create** a workflow scaffold.
3.  **Implement** the workflow logic.
4.  **Define** schedules in `workflow.config.js`.
5.  **Sync** schedules to OpenClaw cron.
6.  **Run** workflows manually or from cron.
7.  **Rebuild** daily summaries.

<br>

## ðŸš€ Quick Start

  

### 1. Bootstrap the workspace

```Bash
node scripts/bootstrap-workspace.js --workspace-root /path/to/workspace
```
This creates `workflows/`, `_shared/`, and `_executions/`. It is **idempotent**; running it again is safe.

  
### 2. Create a new workflow

```Bash
node scripts/new-workflow.js --workspace-root /path/to/workspace --id my-workflow
```
This creates a scaffold with a config, README, CONTRACT, Lobster file, Node runner, starter action, and smoke test.


### 3. Run a workflow manually

```Bash
node scripts/run-workflow.js --workspace-root /path/to/workspace --workflow my-workflow
```
This runs the workflow through the **managed runtime** and writes records into `_executions`.

  
### 4. Sync schedules to OpenClaw cron

```Bash
node scripts/sync-schedules.js --workspace-root /path/to/workspace
```
Or for a specific workflow:
```Bash
node scripts/sync-schedules.js --workspace-root /path/to/workspace --workflow my-workflow
```
 
### 5. Rebuild the daily summary

```Bash
node scripts/rebuild-daily-summary.js --workspace-root /path/to/workspace --date 2026-03-18
```

<br>
  
## âš™ï¸ workflow.config.js

Every managed workflow exposes one canonical **machine-readable file** containing: `identity`, `runtime`, `schedules`, `result`, and `observability`.


This file **should stay declarative**. It should **not** write files, call APIs, depend on current time, or store runtime state (like metrics or job IDs).

 <br> 

## ðŸƒ How Managed Execution Works

  

When you run `scripts/run-workflow.js`, the skill executes these steps:


1.  **Loads**  `workflow.config.js`.
2.  **Resolves** the workflow entrypoint.
3.  **Merges** default inputs with provided ones.
4.  **Writes** initial run record (status: `running`).
5.  **Executes** the workflow.
6.  **Parses** the workflow JSON envelope.
7.  **Evaluates** success via `successCondition`.
8.  **Extracts** result via `result.extractor`.
9.  **Writes** the final record and updates `latestResult`.

<br>


## Telegram Approval Plugin

When a Lobster workflow pauses for approval, the managed runtime stores it in `awaiting_approval` together with the Lobster resume token and a short callback token used by Telegram buttons.

The optional Telegram plugin exists to turn Telegram inline button callbacks into a **native command bridge** for this skill only.

It is intentionally narrow:

- It only handles `/lwf ap:<token>` and `/lwf rj:<token>`.
- It forwards those callbacks to `scripts/resume-workflow.js`.
- It does **not** intercept unrelated Telegram approval flows from other plugins or skills.

This is why the plugin exists instead of relying on free-form chat parsing: Telegram buttons emit callback data, and this plugin resolves that callback directly before the message reaches the model.

### What it does

- Routes Telegram inline approve or reject clicks back into the managed runtime.
- Verifies that the Telegram sender is an allowed approver for that workflow.
- Resumes the Lobster workflow with approve or reject.
- Edits the original Telegram approval message with the final result.
- Suppresses the extra duplicate reply after the button click.

### How to install it

From inside the installed skill folder:

```Bash
cd ~/.openclaw/skills/lobster-workflows
node scripts/install-telegram-plugin.js
```

That helper does two things:

- Runs `openclaw plugins install --link ./plugin`
- Merges `lobster-workflows-telegram` into `plugins.allow` without removing other trusted plugins

After installing it, restart the OpenClaw gateway.

If you prefer to do it manually, you can still run:

```Bash
cd ~/.openclaw/skills/lobster-workflows
openclaw plugins install --link ./plugin
```

On the current OpenClaw version, `openclaw plugins install --link ./plugin` automatically records the install and enables the plugin entry, so users do **not** need to manually add `plugins.entries.lobster-workflows-telegram.enabled=true` in `openclaw.json`.

### About `plugins.allow`

The plugin works without manually editing `openclaw.json`, but OpenClaw may still warn if `plugins.allow` is empty.

That warning is about **explicit trust pinning**, not about whether the plugin is functional.

At the moment, `openclaw plugins install --link ./plugin` does **not** automatically add `lobster-workflows-telegram` to `plugins.allow`.

That is why this repo includes `scripts/install-telegram-plugin.js`: it links the plugin and updates `plugins.allow` through the CLI, so the user does not have to edit `openclaw.json` by hand.

If you need the manual CLI equivalent, first inspect the current value with `openclaw config get plugins.allow --json`, then write back the merged array with `openclaw config set plugins.allow ... --strict-json`.

Important: `plugins.allow` is a full array assignment. `openclaw config set` does not currently provide an append mode for that path.

<br>

## How Scheduling Works

Workflows declare schedules in `workflow.config.js`. While **OpenClaw cron** is the scheduler, the **source of truth** is the workflow config.

`sync-schedules.js` projects these configs into OpenClaw cron jobs named: `lobster-workflows::<workflowId>::<scheduleId>`

<br>

## ðŸ“‚ Where Results and Metrics Are Written

  

-  **Run records:**  `workflows/_executions/runs/YYYY-MM-DD/<workflow-id>/<execution-id>.json`
-  **Latest result:**  `workflows/_executions/latest/<workflow-id>.json`
-  **Daily summary:**  `workflows/_executions/daily/YYYY-MM-DD.json`
-  **Sync state:**  `workflows/_executions/sync/<workflow-id>.json`

<br>
  

## ðŸ“Š Daily Metrics

The summary builder calculates metrics such as `expectedRuns`, `successfulRuns`, `failedRuns`, and `missedRuns`. It also stores per-workflow summaries and the `latestResult`.

<br>  
 

## ðŸ’¡ Notes for Future Users

- Use `workflow.config.js` as the **stable contract** between your workflow and the platform.
- Use the **managed runner** if you want `_executions` to be updated.

  <br>  

## ðŸ”— Related Files

-  **[SKILL.md](/SKILL.md)**
-  **[Platform Architecture](/references/platform-architecture.md)**
-  **[Workflow Config](/references/workflow-config.md)**
