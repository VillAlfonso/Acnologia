import { bindField, parameterizeWorkflow, generateValues } from './generator.js';

/**
 * Form-answer component boundary. No browser, network, filesystem, or UI access.
 * Pass a replacement as Automation's options.formAnswers to customize behavior.
 */
export const formAnswers = Object.freeze({
  recordField: bindField,
  detectFields: parameterizeWorkflow,
  prepareWorkflow(workflow) {
    // New recordings already have a recipe. Older captured forms are upgraded
    // for this run without rewriting the user's saved recording.
    if (workflow.generator) {
      if (workflow.generator.fields.some(field => field.kind === 'profile')) throw new Error('This recording still uses a profile field. Open Variables & generator and choose a generated or fixed value.');
      return workflow;
    }
    if (!workflow.steps.some(step => step.type === 'fill')) return workflow;
    return parameterizeWorkflow(workflow);
  },
  generateForRun: generateValues,
});
