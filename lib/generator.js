import { randomInt, randomBytes } from 'node:crypto';

export const generatorKinds = ['name', 'first_name', 'last_name', 'email', 'username', 'password', 'text', 'number', 'fixed', 'profile', 'reference'];

function describe(step) {
  const attrs = step.capture?.attributes || {};
  const hint = `${step.field?.hint || ''} ${attrs.autocomplete || ''} ${attrs.name || ''} ${attrs.id || ''} ${attrs['aria-label'] || ''} ${step.label || ''} ${step.selector || ''}`.toLowerCase();
  const type = step.field?.type || attrs.type || '';
  if (type === 'password' || /password|passwd|passphrase/.test(hint)) return /confirm|repeat|retype|again/.test(hint) ? 'confirm_password' : 'password';
  if (type === 'email' || /e.?mail|gmail/.test(hint)) return 'email';
  if (/first.?name|given.?name/.test(hint)) return 'first_name';
  if (/last.?name|family.?name|surname/.test(hint)) return 'last_name';
  if (/user.?name|login|nickname/.test(hint)) return 'username';
  if (/\bname\b|full.?name/.test(hint)) return 'name';
  if (type === 'number' || type === 'tel') return 'number';
  return 'text';
}

export function bindField(step, fields, bindings) {
  if (step.type !== 'fill') return;
  const identity = `${step.pageId || 0}:${step.selector}`;
  let key = bindings.get(identity);
  if (!key) {
    const existing = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(step.value)?.[1];
    const detected = describe(step);
    key = existing || detected;
    if (!existing) {
      let suffix = 2;
      while (fields.some(field => field.key === key)) key = `${detected}_${suffix++}`;
    }
    if (!fields.some(field => field.key === key)) {
      const password = fields.findLast(field => field.kind === 'password');
      fields.push({ key, label: (step.label || step.field?.hint || key).replace(/^Fill\s+/i, '').slice(0, 100),
        kind: detected === 'confirm_password' ? (password ? 'reference' : 'password') : detected,
        source: detected === 'confirm_password' && password ? password.key : '',
        value: detected === 'email' ? 'example.test' : detected === 'text' ? 'Sample' : '', length: 16 });
    }
    bindings.set(identity, key);
  }
  step.value = step.field?.empty ? '' : `{{${key}}}`;
}

export function parameterizeWorkflow(workflow) {
  const result = structuredClone(workflow);
  const fields = structuredClone(result.generator?.fields || []);
  const bindings = new Map();
  for (const step of result.steps) bindField(step, fields, bindings);
  result.generator = { enabled: true, fields };
  return result;
}

const firstNames = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Robin', 'Avery', 'Riley', 'Cameron'];
const lastNames = ['Bennett', 'Parker', 'Morgan', 'Reed', 'Hayes', 'Brooks', 'Ellis', 'Chen', 'Patel', 'Rivera'];
const pick = values => values[randomInt(values.length)];
function password(length) {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*'];
  const characters = groups.map(group => pick(group));
  const alphabet = groups.join('');
  while (characters.length < length) characters.push(pick(alphabet));
  for (let i = characters.length - 1; i > 0; i--) { const j = randomInt(i + 1); [characters[i], characters[j]] = [characters[j], characters[i]]; }
  return characters.join('');
}

export function generateValues(generator, profileVariables = {}) {
  const variables = { ...profileVariables }, generated = {}, secretKeys = [];
  if (!generator?.enabled) return { variables, generated, secretKeys };
  const first = pick(firstNames), last = pick(lastNames), suffix = randomBytes(6).toString('hex');
  for (const field of generator.fields) {
    let value;
    switch (field.kind) {
      case 'name': value = `${first} ${last}`; break;
      case 'first_name': value = first; break;
      case 'last_name': value = last; break;
      case 'username': value = `${first.toLowerCase()}${suffix}`; break;
      case 'email': value = `${first.toLowerCase()}.${last.toLowerCase()}.${suffix}@${field.value || 'example.test'}`; break;
      case 'password': value = password(field.length || 16); secretKeys.push(field.key); break;
      case 'number': value = String(randomInt(100000, 1000000)); break;
      case 'text': value = `${field.value || 'Sample'}-${suffix}`; break;
      case 'fixed': value = field.value || ''; break;
      case 'profile':
        if (!Object.hasOwn(profileVariables, field.key) || !profileVariables[field.key]) throw new Error(`Set profile variable: ${field.key}`);
        value = profileVariables[field.key]; break;
      case 'reference':
        if (!Object.hasOwn(generated, field.source)) throw new Error(`Generator ${field.key} must reference an earlier field`);
        value = generated[field.source];
        if (secretKeys.includes(field.source)) secretKeys.push(field.key);
        break;
      default: throw new Error(`Unsupported generator type for ${field.key}`);
    }
    variables[field.key] = value; generated[field.key] = value;
  }
  return { variables, generated, secretKeys };
}
