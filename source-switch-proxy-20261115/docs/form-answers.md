# Form-answer component

The browser runner does not decide how to invent form answers. Its dependency is the four-method interface exported by `lib/form-answers.js`. The default implementation uses `lib/generator.js`, a module with no Playwright, server, storage, or UI imports. `public/generator-ui.js` is the separate editor and run-output presentation layer.

## Contract

| Method | Input | Output / behavior |
| --- | --- | --- |
| `recordField(step, fields, bindings)` | A captured step, the recording's ordered field list, and a per-recording Map | Updates only those objects: binds Fill actions to placeholders and adds field definitions. Non-Fill steps are ignored. |
| `detectFields(workflow)` | A workflow | Returns a copy with Fill actions parameterized and an ordered generator recipe. Used by the editor. |
| `prepareWorkflow(workflow)` | A run's workflow snapshot | Returns a workflow ready for generation. Automatically converts older captured forms when they have no recipe. Does not alter the saved workflow. An explicitly disabled generator stays disabled. |
| `generateForRun(generator, profileVariables)` | A recipe and that run's profile variables | Returns `{ variables, generated, secretKeys }`. `variables` is used by playback; `generated` is saved with the run; `secretKeys` controls log redaction and password masking. |

All methods are synchronous. `generateForRun` is called once per run, after the job starts and before browser launch. It must not mutate profile variables. A recipe describes field order and rules; generated answers must never be cached on the recipe, module, or profile. Confirmation fields reference an earlier generated field so matching answers stay consistent for that run.

## Replacing the implementation

```js
import { Automation } from '../lib/automation.js';
import { formAnswers } from '../lib/form-answers.js';

const customAnswers = {
  ...formAnswers,
  generateForRun(recipe, profileVariables) {
    // Replace the default generation policy here; keep the result contract.
    return formAnswers.generateForRun(recipe, profileVariables);
  },
};
const automation = new Automation(store, { formAnswers: customAnswers });
```

For a normal update, change the policies in `lib/generator.js`. If adding a generator type, also update its Zod validation in `lib/schema.js` and the kind labels/editor controls in `public/generator-ui.js`. The interface is independent of proxy selection, browser context creation, tab handling, and playback action execution.

`lib/form-input-recorder.js` is the separate browser-side input adapter. `installFormInputs(emit)` watches input/change/focusout and Enter/Tab, then emits field metadata and an empty/nonempty flag instead of typed text. It is self-contained for browser serialization. The main recorder supplies the `emit` callback for selector/capture metadata; `recorderScript()` composes both functions into a single initialization script. Change typing capture behavior in this adapter without editing click/mouse capture.

The Automation adapter passes captured fields to `recordField`. API endpoints validate workflow/recipe data before invoking the component. Run output is persisted by the existing store, not by the component.

## Verification

`node --test test/generator.test.js` covers automatic legacy conversion, generated answers for two runs, password confirmation, input capture, editor preview/settings, saved run output, and secret masking. `npm test` also checks browser playback, popup tabs, desktop startup, and proxy behavior.
