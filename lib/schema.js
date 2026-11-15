import { z } from 'zod';

export const httpUrl = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an http or https URL');
export const stepSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['navigate', 'click', 'fill', 'select', 'check', 'press', 'wait', 'assert', 'screenshot', 'move']),
  label: z.string().max(200).default(''),
  selector: z.string().max(2000).default(''),
  value: z.string().max(10000).default(''),
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
});
export const profileSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000)).default({}),
});
export function interpolate(value, variables) {
  return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`Missing profile variable: ${key}`);
    return variables[key];
  });
}
