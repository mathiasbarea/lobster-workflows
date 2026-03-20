const { extractToolJson, invokeTool } = require('./openclaw-client');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function formatQuotedList(values) {
  return uniqueStrings(values).map((value) => `"${value}"`).join(', ');
}

function describeSchemaType(schema) {
  if (!isPlainObject(schema)) return '';
  if (typeof schema.type === 'string' && schema.type.trim()) {
    return schema.type.trim().toLowerCase();
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  if (isPlainObject(schema.properties)) return 'object';
  if (isPlainObject(schema.items) || Array.isArray(schema.items)) return 'array';
  return '';
}

function pluralizeType(type, countDescription) {
  if (!type) return 'items';
  if (type === 'string') return countDescription === '1' ? 'string' : 'strings';
  if (type === 'number') return countDescription === '1' ? 'number' : 'numbers';
  if (type === 'integer') return countDescription === '1' ? 'integer' : 'integers';
  if (type === 'boolean') return countDescription === '1' ? 'boolean' : 'booleans';
  if (type === 'object') return countDescription === '1' ? 'object' : 'objects';
  return countDescription === '1' ? type : `${type}s`;
}

function buildArrayDescription(name, schema) {
  const itemType = describeSchemaType(schema.items);
  const exactLength = Number.isInteger(schema.minItems) && Number.isInteger(schema.maxItems) && schema.minItems === schema.maxItems
    ? String(schema.minItems)
    : null;
  const lengthDescription = exactLength
    ? `exactly ${exactLength}`
    : Number.isInteger(schema.minItems)
      ? `at least ${schema.minItems}`
      : Number.isInteger(schema.maxItems)
        ? `at most ${schema.maxItems}`
        : null;
  const itemDescription = itemType
    ? pluralizeType(itemType, exactLength || '')
    : 'items';

  if (lengthDescription) {
    return `"${name}" must be an array of ${lengthDescription} ${itemDescription}.`;
  }
  return `"${name}" must be an array of ${itemDescription}.`;
}

function appendObjectSchemaLines(lines, schema, prefix = '', depth = 0, maxDepth = 1) {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const label = prefix || 'top-level';

  if (!prefix) {
    lines.push('Return exactly one JSON object.');
  }

  if (propertyNames.length > 0) {
    lines.push(`Allowed ${label} keys: ${formatQuotedList(propertyNames)}.`);
  }

  const requiredKeys = uniqueStrings(schema.required);
  if (requiredKeys.length > 0) {
    lines.push(`Required ${label} keys: ${formatQuotedList(requiredKeys)}.`);
  }

  if (schema.additionalProperties === false) {
    lines.push(`Do not include any other ${label} keys.`);
  }

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const propertyPath = prefix ? `${prefix}.${propertyName}` : propertyName;
    const propertyType = describeSchemaType(propertySchema);

    if (Array.isArray(propertySchema?.enum) && propertySchema.enum.length > 0) {
      lines.push(`"${propertyPath}" must be one of: ${propertySchema.enum.map((value) => JSON.stringify(value)).join(', ')}.`);
      continue;
    }

    if (propertyType === 'object') {
      const nestedProperties = isPlainObject(propertySchema.properties) ? Object.keys(propertySchema.properties) : [];
      if (nestedProperties.length > 0) {
        lines.push(`"${propertyPath}" must be an object with keys: ${formatQuotedList(nestedProperties)}${propertySchema.additionalProperties === false ? ' and no others' : ''}.`);
      } else {
        lines.push(`"${propertyPath}" must be an object.`);
      }
      const nestedRequired = uniqueStrings(propertySchema.required);
      if (nestedRequired.length > 0) {
        lines.push(`Required keys inside "${propertyPath}": ${formatQuotedList(nestedRequired)}.`);
      }
      if (depth < maxDepth) {
        appendObjectSchemaLines(lines, propertySchema, propertyPath, depth + 1, maxDepth);
      }
      continue;
    }

    if (propertyType === 'array') {
      lines.push(buildArrayDescription(propertyPath, propertySchema));
      continue;
    }

    if (propertyType) {
      lines.push(`"${propertyPath}" must be a ${propertyType}.`);
      continue;
    }
  }
}

function buildSchemaContractLines(schema, {
  stageLabel = null,
  forbiddenKeys = [],
  extraRules = [],
} = {}) {
  const lines = [];
  if (!isPlainObject(schema)) return lines;

  if (stageLabel) {
    lines.push(`This is the ${String(stageLabel).trim()} stage only.`);
  }

  const type = describeSchemaType(schema);
  if (type === 'object') {
    appendObjectSchemaLines(lines, schema);
  } else if (type) {
    lines.push(`Return exactly one JSON value of type "${type}".`);
  }

  const forbidden = uniqueStrings(forbiddenKeys);
  if (forbidden.length > 0) {
    lines.push(`Do not include these keys unless the schema explicitly allows them: ${formatQuotedList(forbidden)}.`);
  }

  for (const rule of uniqueStrings(extraRules)) {
    lines.push(rule.endsWith('.') ? rule : `${rule}.`);
  }

  return lines;
}

function prepareLlmTaskPayload(taskPayload, options = {}) {
  if (!isPlainObject(taskPayload)) {
    throw new Error('llm-task payload must be an object.');
  }

  const prompt = typeof taskPayload.prompt === 'string' ? taskPayload.prompt.trim() : '';
  if (!prompt) {
    throw new Error('llm-task payload must include a non-empty prompt.');
  }

  const contractLines = buildSchemaContractLines(taskPayload.schema, options);
  if (contractLines.length === 0) {
    return { ...taskPayload, prompt };
  }

  return {
    ...taskPayload,
    prompt: `${prompt}\n\nJSON CONTRACT:\n${contractLines.map((line) => `- ${line}`).join('\n')}`,
  };
}

async function invokeLlmTaskJson({
  taskPayload,
  invokeToolFn = invokeTool,
  options = {},
}) {
  const preparedPayload = prepareLlmTaskPayload(taskPayload, options);
  const parsed = await invokeToolFn({
    tool: 'llm-task',
    action: 'json',
    args: preparedPayload,
  });
  return extractToolJson(parsed);
}

module.exports = {
  buildSchemaContractLines,
  invokeLlmTaskJson,
  prepareLlmTaskPayload,
};
