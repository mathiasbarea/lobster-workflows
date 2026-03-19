#!/usr/bin/env node

const payload = {
  ok: true,
  action: 'approved',
  generatedAt: new Date().toISOString(),
  data: {
    approved: true,
    message: 'Approval example completed successfully.',
  },
  meta: {
    example: 'approval-telegram-smoke',
  },
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
