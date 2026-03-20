## 🦞🌊 Lobster-Workflows

**Lobster Workflows** orchestrates a standardized environment for building and operating AI agent automations. It provides a unified framework to manage complex, multi-step workflows at the workspace level.

This system is built upon the **[Lobster](https://github.com/openclaw/lobster)** workflow shell, leveraging its capability to chain atomic actions into predictable, automated pipelines. While Lobster handles the low-level execution of tasks, this skill provides the high-level orchestration required for a professional deployment.

### Why is it useful?  

Normally, managing multiple workflows can become chaotic with fragmented scripts and inconsistent logs. This tool transforms isolated scripts into a cohesive platform by providing **centralized execution records**, shared helpers to eliminate code duplication, and seamless synchronization with **OpenClaw cron** for scheduled automation.  

### It is designed for teams or individuals who want:

- A **consistent structure** for Lobster workflows.
- **Shared helpers** for multiple workflows.
- **Centralized execution records** and daily metrics.
- **Schedule sync** to OpenClaw cron.

### 📋 Requirements

-  **Node.js:** Must be available on the system for script execution.
-  **OpenClaw:** Installed and configured.
-  **Lobster:** Installed and available on `PATH`.
-  **`llm-task` workflows:** If a workflow uses OpenClaw `llm-task`, the bundled `llm-task` plugin must be enabled, included in `plugins.allow` when that allowlist exists, and allowlisted for the agent that runs managed workflows.

>  **[If you need help installing Lobster and adding it to OpenClaw, check this guide.](https://github.com/mathiasbarea/Agentic-Tools/blob/main/Lobster-How-To.md)**

<br>

## 🚀 Quick Start

Provide the repository URL to your OpenClaw Agent and instruct it to install both the skill and the associated plugin:

Repository URL: https://github.com/mathiasbarea/lobster-workflows

To install the Telegram Approval Plugin and verify the environment integrity, execute the following commands from within the lobster-workflows skill directory:

```bash
node scripts/install-telegram-plugin.js
node scripts/doctor.js
```

If your workflows use JSON-only LLM steps through OpenClaw `llm-task`, run this once as well:

```bash
node scripts/enable-llm-task.js
```

That helper makes the effective OpenClaw setup usable by:

- enabling `plugins.entries.llm-task`
- merging `llm-task` into `plugins.allow` when that allowlist already exists
- merging `llm-task` into `agents.list[].tools.allow` for agent `main`

Then, restart your OpenClaw Gateway.

⚠️ Ensure your Telegram integration is active within your OpenClaw instance. Additionally, your Telegram User ID must be explicitly authorized to process approvals.

**You can configure authorized approvers in three different layers:**

1.  **`workflow.config.js`:** Define IDs under `approvals.telegram.approvers`. This is the **recommended approach** for teams, as it allows you to assign specific owners to different workflows.
2.  **Environment Variable:** Add your ID to the `OPENCLAW_TELEGRAM_APPROVERS` global variable.
3.  **Global Configuration:** Define IDs in your `openclaw.json` file under `channels.telegram.execApprovals.approvers`.
    
**Why use workflow-level configuration?** Setting approvers directly in the `workflow.config.js` provides granular control. This allows different team members to be responsible for managing specific automations, ensuring that only the relevant stakeholders receive approval requests for their respective workflows.

<br>

## Telegram Approval Plugin

The platform is built to support workflows that require explicit human approval before executing critical or sensitive actions.

When a Lobster workflow reaches an approval gate and pauses for intervention, the managed runtime persists the session state in the awaiting_approval registry. This entry captures the essential Lobster resume token along with a unique callback token used specifically for Telegram interactive buttons.

Once the action is approved or rejected via the interface, the runtime uses these tokens to instantly resume the workflow exactly where it left off, ensuring a seamless and secure human-in-the-loop experience.

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

<br>

## ⌨️ Useful commands

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

### 2.5. Enable `llm-task` for workflow-driven JSON steps

```bash
node scripts/enable-llm-task.js
```

Use this when a workflow calls OpenClaw `llm-task` directly or indirectly. `doctor.js` now enforces this for workflows that reference `llm-task`, and also warns when the optional readiness is still missing so future workflows do not fail unexpectedly.

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
Useful flags:
```Bash
node scripts/sync-schedules.js --workspace-root /path/to/workspace --sync-backend auto
node scripts/sync-schedules.js --workspace-root /path/to/workspace --dry-run
```
`--sync-backend` accepts `auto`, `cli`, or `gateway`. `--dry-run` computes the reconciliation plan and remediation commands without mutating OpenClaw cron or writing sync state.
When `auto` cannot use the CLI transport, it retries through the gateway. If live cron state is still unreachable, the script returns `status: "recovery-only"` with retry commands and, when possible, a dry-run remediation plan derived from the last successful sync snapshot.
Persisted sync state now records both the latest attempt and the last confirmed successful sync, so `_executions/sync/<workflow>.json` can explicitly show `synced`, `failed`, `partial`, or `recovery-only`.
Operational sync failures now include the exact invocation, stdout/stderr, Windows CLI resolution context when relevant, and a recommendation matched to the failure class.
### 5. Rebuild the daily summary

```Bash
node scripts/rebuild-daily-summary.js --workspace-root /path/to/workspace --date 2026-03-18
```
<br>

## 🛠️ What This Skill Creates

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

## 🧠 Mental Model

This skill is the **control plane** for the workflows platform.

-  **The workflow itself defines:** Identity, runtime, schedules, result extraction, and observability rules.
-  **The skill handles:** Workspace bootstrap, workflow scaffolding, managed execution, schedule sync, execution persistence, and daily metrics rebuilding.

<br>

## 🔄 Lifecycle

The normal lifecycle looks like this:

1.  **Bootstrap** the workspace.
2.  **Create** a workflow scaffold.
3.  **Implement** the workflow logic.
4.  **Define** schedules in `workflow.config.js`.
5.  **Sync** schedules to OpenClaw cron.
6.  **Run** workflows manually or from cron.
7.  **Rebuild** daily summaries.

<br>
  
## ⚙️ workflow.config.js

Every managed workflow exposes one canonical **machine-readable file** containing: `identity`, `runtime`, `schedules`, `result`, and `observability`.

This file **should stay declarative**. It should **not** write files, call APIs, depend on current time, or store runtime state (like metrics or job IDs).

<br> 

## 🏃 How Managed Execution Works

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

## 📅 How Scheduling Works

Workflows declare schedules in `workflow.config.js`. While **OpenClaw cron** is the scheduler, the **source of truth** is the workflow config.

`sync-schedules.js` projects these configs into OpenClaw cron jobs named: `lobster-workflows::<workflowId>::<scheduleId>`

<br>

## 📂 Where Results and Metrics Are Written

  

-  **Run records:**  `workflows/_executions/runs/YYYY-MM-DD/<workflow-id>/<execution-id>.json`
-  **Latest result:**  `workflows/_executions/latest/<workflow-id>.json`
-  **Daily summary:**  `workflows/_executions/daily/YYYY-MM-DD.json`
-  **Sync state:**  `workflows/_executions/sync/<workflow-id>.json`

<br>
  

## 📊 Daily Metrics

The summary builder calculates metrics such as `expectedRuns`, `successfulRuns`, `failedRuns`, and `missedRuns`. It also stores per-workflow summaries and the `latestResult`.

<br>  
 

## 💡 Notes for Future Users

- Use `workflow.config.js` as the **stable contract** between your workflow and the platform.
- Use the **managed runner** if you want `_executions` to be updated.

  <br>  

## 🔗 Related Files

-  **[SKILL.md](/SKILL.md)**
-  **[Platform Architecture](/references/platform-architecture.md)**
-  **[Workflow Config](/references/workflow-config.md)**
