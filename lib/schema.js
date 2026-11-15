import { z } from 'zod';
import { generatorKinds } from './generator.js';

const variableKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key), 'Reserved variable name');
export const generatorSchema = z.object({
  enabled: z.boolean().default(true),
  fields: z.array(z.object({
    key: variableKey, label: z.string().max(100).default(''), kind: z.enum(generatorKinds),
    value: z.string().max(10000).default(''), source: z.string().max(100).default(''), length: z.number().int().min(8).max(128).default(16),
  })).max(500),
}).superRefine((generator, ctx) => {
  const seen = new Set();
  generator.fields.forEach((field, index) => {
    if (seen.has(field.key)) ctx.addIssue({ code: 'custom', path: ['fields', index, 'key'], message: 'Variable names must be unique' });
    if (field.kind === 'reference' && !seen.has(field.source)) ctx.addIssue({ code: 'custom', path: ['fields', index, 'source'], message: 'Choose an earlier variable to reuse' });
    if (field.kind === 'email' && field.value && !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(field.value)) ctx.addIssue({ code: 'custom', path: ['fields', index, 'value'], message: 'Enter an email domain, for example example.test' });
    seen.add(field.key);
  });
});

export const httpUrl = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an http or https URL');
export const stepSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['navigate', 'click', 'fill', 'select', 'check', 'press', 'wait', 'assert', 'screenshot', 'move']),
  label: z.string().max(200).default(''),
  selector: z.string().max(2000).default(''),
  value: z.string().max(10000).default(''),
  field: z.object({ hint: z.string().max(200), type: z.string().max(50), empty: z.boolean().default(false) }).optional(),
  enabled: z.boolean().default(true),
  pageId: z.number().int().min(0).max(100).default(0),
  timeout: z.number().int().min(100).max(120000).default(15000),
  mousePath: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), dt: z.number().min(0).max(250), width: z.number().positive().max(50000), height: z.number().positive().max(50000) })).max(400).optional(),
  clickPosition: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  capture: z.object({
    html: z.string().max(12000), tag: z.string().max(50), text: z.string().max(500),
    pageUrl: z.string().max(4000), pageTitle: z.string().max(300),
    timestamp: z.string().max(50), attributes: z.record(z.string().max(100), z.string().max(1000)),
  }).optional(),
}).superRefine((step, ctx) => {
  if (step.type === 'move' && !step.mousePath?.length) ctx.addIssue({ code: 'custom', message: 'Mouse movement needs recorded path points', path: ['mousePath'] });
  if (['click', 'fill', 'select', 'check', 'press', 'assert'].includes(step.type) && !step.selector.trim()) ctx.addIssue({ code: 'custom', message: 'This action needs a selector', path: ['selector'] });
  if (step.type === 'navigate' && !step.value.includes('{{') && !httpUrl.safeParse(step.value).success) ctx.addIssue({ code: 'custom', message: 'Navigate needs an http or https URL', path: ['value'] });
  if (step.type === 'wait' && (!/^\d+$/.test(step.value) || Number(step.value) > 120000)) ctx.addIssue({ code: 'custom', message: 'Wait must be 0–120000 milliseconds', path: ['value'] });
});
export const workflowSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''), startUrl: httpUrl,
  steps: z.array(stepSchema).max(500).default([]),
  generator: generatorSchema.optional(),
});
export function interpolate(value, variables) {
  return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`Missing form variable: ${key}`);
    return variables[key];
  });
}
