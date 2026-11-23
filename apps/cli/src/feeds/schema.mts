import { isRecord } from '@agent-board/shared';

const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean'] as const;
type SchemaType = (typeof TYPES)[number];

const ANNOTATIONS = ['description', 'default', 'title', 'examples'];
const KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'minimum',
  'maximum',
];

export const MAX_SCHEMA_DEPTH = 8;
const MAX_PATTERN = 500;
const MAX_ENUM = 100;

type Scalar = string | number | boolean | null;

export interface Schema {
  type?: SchemaType;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: Scalar[];
  minimum?: number;
  maximum?: number;
}

const shown = (text: string): string => JSON.stringify(text.slice(0, 40));

const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isType = (value: unknown): value is SchemaType => TYPES.some((type) => type === value);

const COUNTS = ['minItems', 'maxItems', 'minLength', 'maxLength'] as const;

function readCounts(value: Record<string, unknown>, where: string): Partial<Schema> | string {
  const kept: Partial<Schema> = {};
  for (const key of COUNTS) {
    const count = value[key];
    if (count === undefined) continue;
    if (!isCount(count)) return `${where}.${key} must be a whole number of at least 0`;
    kept[key] = count;
  }
  return kept;
}

function readComposite(value: Record<string, unknown>, where: string, depth: number): Partial<Schema> | string {
  const kept: Partial<Schema> = {};
  const { properties, required, additionalProperties, items } = value;
  if (properties !== undefined) {
    if (!isRecord(properties)) return `${where}.properties must be an object`;
    const parsed: Record<string, Schema> = {};
    for (const [name, child] of Object.entries(properties)) {
      const schema = parseAt(child, `${where}.properties.${name.slice(0, 40)}`, depth + 1);
      if (typeof schema === 'string') return schema;
      parsed[name] = schema;
    }
    kept.properties = parsed;
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((name) => typeof name === 'string'))
      return `${where}.required must be a list of property names`;
    kept.required = required;
  }
  if (additionalProperties !== undefined) {
    if (typeof additionalProperties === 'boolean') kept.additionalProperties = additionalProperties;
    else {
      const schema = parseAt(additionalProperties, `${where}.additionalProperties`, depth + 1);
      if (typeof schema === 'string') return schema;
      kept.additionalProperties = schema;
    }
  }
  if (items !== undefined) {
    const schema = parseAt(items, `${where}.items`, depth + 1);
    if (typeof schema === 'string') return schema;
    kept.items = schema;
  }
  return kept;
}

function readLimits(value: Record<string, unknown>, where: string): Partial<Schema> | string {
  const kept: Partial<Schema> = {};
  const { pattern, minimum, maximum } = value;
  const sized = readCounts(value, where);
  if (typeof sized === 'string') return sized;
  Object.assign(kept, sized);
  for (const [key, bound] of [
    ['minimum', minimum],
    ['maximum', maximum],
  ] as const) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isFinite(bound)) return `${where}.${key} must be a number`;
    kept[key] = bound;
  }
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN)
      return `${where}.pattern must be text of at most ${MAX_PATTERN} characters`;
    try {
      new RegExp(pattern, 'u');
      kept.pattern = pattern;
    } catch {
      return `${where}.pattern is not a regular expression`;
    }
  }
  if (value['enum'] !== undefined) {
    const allowed = value['enum'];
    if (!Array.isArray(allowed) || allowed.length > MAX_ENUM || !allowed.every(isScalar))
      return `${where}.enum must be a list of at most ${MAX_ENUM} strings, numbers, booleans or null`;
    kept.enum = allowed;
  }
  return kept;
}

function parseAt(value: unknown, where: string, depth: number): Schema | string {
  if (depth > MAX_SCHEMA_DEPTH) return `${where} is nested deeper than ${MAX_SCHEMA_DEPTH} levels`;
  if (!isRecord(value)) return `${where} must be an object`;
  const unknown = Object.keys(value).find((key) => !KEYWORDS.includes(key) && !ANNOTATIONS.includes(key));
  if (unknown !== undefined) return `${where} uses a keyword this CLI does not read: ${shown(unknown)}`;
  if (value['type'] !== undefined && !isType(value['type'])) return `${where}.type must be one of ${TYPES.join(', ')}`;
  const composite = readComposite(value, where, depth);
  if (typeof composite === 'string') return composite;
  const limits = readLimits(value, where);
  if (typeof limits === 'string') return limits;
  return { ...(isType(value['type']) ? { type: value['type'] } : {}), ...composite, ...limits };
}

/** The subset of JSON Schema that integrations may use for their options, or the reason a schema is not in it. */
export function parseSchema(value: unknown): Schema | string {
  return parseAt(value, 'schema', 0);
}

const typeName = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;

function matchesType(type: SchemaType, value: unknown): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeName(value) === type;
}

function validateText(schema: Schema, value: string, path: string): string | undefined {
  const length = Array.from(value).length;
  if (schema.minLength !== undefined && length < schema.minLength)
    return `${path} must be at least ${schema.minLength} characters`;
  if (schema.maxLength !== undefined && length > schema.maxLength)
    return `${path} must be at most ${schema.maxLength} characters`;
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
    return `${path} must match ${schema.pattern.slice(0, 100)}`;
  return undefined;
}

function validateNumber(schema: Schema, value: number, path: string): string | undefined {
  if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
  if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  return undefined;
}

function validateObject(schema: Schema, value: Record<string, unknown>, path: string): string | undefined {
  for (const name of schema.required ?? [])
    if (!Object.hasOwn(value, name)) return `${path}.${name.slice(0, 40)} is required`;
  for (const [name, member] of Object.entries(value)) {
    const where = `${path}.${name.slice(0, 40)}`;
    const declared = schema.properties !== undefined && Object.hasOwn(schema.properties, name);
    const child = declared ? schema.properties?.[name] : undefined;
    if (child !== undefined) {
      const problem = validate(child, member, where);
      if (problem !== undefined) return problem;
    } else if (schema.additionalProperties === false) return `${where} is not an option here`;
    else if (typeof schema.additionalProperties === 'object') {
      const problem = validate(schema.additionalProperties, member, where);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

function validateArray(schema: Schema, value: unknown[], path: string): string | undefined {
  if (schema.minItems !== undefined && value.length < schema.minItems)
    return `${path} must have at least ${schema.minItems} items`;
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    return `${path} must have at most ${schema.maxItems} items`;
  if (schema.items === undefined) return undefined;
  for (const [index, member] of value.entries()) {
    const problem = validate(schema.items, member, `${path}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The first way `value` does not fit `schema`, naming where (`options.repositories[1]`), or undefined when it fits. */
export function validate(schema: Schema, value: unknown, path = 'options'): string | undefined {
  if (schema.type !== undefined && !matchesType(schema.type, value))
    return `${path} must be ${schema.type === 'integer' ? 'a whole number' : `a ${schema.type}`}`;
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value))
    return `${path} must be one of ${schema.enum.map((allowed) => JSON.stringify(allowed)).join(', ')}`.slice(0, 200);
  if (typeof value === 'string') return validateText(schema, value, path);
  if (typeof value === 'number') return validateNumber(schema, value, path);
  if (Array.isArray(value)) return validateArray(schema, value, path);
  if (isRecord(value)) return validateObject(schema, value, path);
  return undefined;
}
