# Contract

## Identity

- workflowId: `approval-telegram-smoke`

## Behavior

- pauses at a Lobster approval checkpoint
- expects approval or rejection from Telegram
- emits a success envelope only after approval

## Result

- `approved`
- `message`
