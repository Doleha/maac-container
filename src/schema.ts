// Authoritative scenario contract for the container UI and submit proxy.
// Mirrors schema/maac-scenario.schema.json (the published artifact for external
// tooling). Keep the two in sync. The server's import endpoint remains the
// authoritative validator — this is client-side convenience to catch errors
// before submission.

export const SCENARIO_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://maacverify.ai/schemas/maac-scenario.schema.json',
  title: 'MAAC Phase 2 Client Scenario',
  type: 'object',
  required: ['scenarioId', 'experimentId', 'configId', 'modelId', 'taskTitle', 'taskDescription'],
  properties: {
    scenarioId: { type: 'string', minLength: 1 },
    experimentId: { type: 'string', minLength: 1 },
    configId: { type: 'string', minLength: 1 },
    modelId: { type: 'string', minLength: 1 },
    taskTitle: { type: 'string', minLength: 1 },
    taskDescription: { type: 'string', minLength: 1 },
    businessContext: { type: 'string' },
    scenarioRequirements: { type: 'array', items: { type: 'string' } },
    dataElements: { type: 'array', items: { type: 'string' } },
    tenantId: { type: 'string' },
    successCriteria: false,
    expectedCalculations: false,
    expectedInsights: false,
  },
  additionalProperties: true,
} as const;

const REQUIRED_STRING_FIELDS = [
  'scenarioId', 'experimentId', 'configId', 'modelId', 'taskTitle', 'taskDescription',
] as const;

const FORBIDDEN_FIELDS = ['successCriteria', 'expectedCalculations', 'expectedInsights'] as const;

const OPTIONAL_STRING_ARRAY_FIELDS = ['scenarioRequirements', 'dataElements'] as const;

export type ValidationResult = {
  scenarioId?: string;
  valid: boolean;
  errors: string[];
};

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// Validates one record against the scenario contract. Returns all errors found.
export function validateScenario(record: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['Record must be a JSON object'] };
  }

  const rec = record as Record<string, unknown>;
  const scenarioId = typeof rec.scenarioId === 'string' ? rec.scenarioId : undefined;

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = rec[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`Missing or empty required field: ${field}`);
    }
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (rec[field] !== undefined) {
      errors.push(`Answer-key field not permitted: ${field}`);
    }
  }

  if (rec.businessContext !== undefined && typeof rec.businessContext !== 'string') {
    errors.push('businessContext must be a string');
  }

  for (const field of OPTIONAL_STRING_ARRAY_FIELDS) {
    if (rec[field] !== undefined && !isStringArray(rec[field])) {
      errors.push(`${field} must be an array of strings`);
    }
  }

  if (rec.tenantId !== undefined && typeof rec.tenantId !== 'string') {
    errors.push('tenantId must be a string');
  }

  return { scenarioId, valid: errors.length === 0, errors };
}

export function validateBatch(records: unknown[]): ValidationResult[] {
  return records.map((r) => validateScenario(r));
}
