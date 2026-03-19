# approval-telegram-smoke

Minimal human-in-the-loop example for Telegram approvals.

It demonstrates:

- `runnerType: 'lobster'`
- a native Lobster `approval` checkpoint
- Telegram approver routing in `workflow.config.js`
- a resolved success result after approval

The `approvals.telegram.approvers` value uses a placeholder numeric Telegram user ID (`1234567890`). Replace it with a real user ID in an actual deployment.
