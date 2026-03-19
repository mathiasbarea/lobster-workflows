name: approval-telegram-smoke
steps:
  - id: confirm
    approval: "Example approval request: approve or reject this run?"

  - id: approved
    run: >
      node ./emit-approved.js
    when: $confirm.approved
