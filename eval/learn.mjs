import { publish } from '../src/playbook.mjs';
import { capture, execute, json, requireThat } from '../src/workflow.mjs';
import { addUsage, episode } from './agent.mjs';
import { auditDescription, auditSeed, withAuditCollector } from './audit.mjs';

export async function learnAudit({ complete, db, dispatch, registry }) {
  const discovery = await episode({ item: auditSeed, arm: 'direct-projected', complete, db, dispatch });
  requireThat(discovery.correct, 'The audit seed discovery failed its gold-answer check');
  const response = await complete({
    temperature: 0, max_tokens: 600,
    messages: [
      { role: 'system', content: [
        'Compile the successful read-only task into a reusable JSON workflow.',
        'Use exactly the top-level keys version (1), inputs (name to scalar type), steps (array), output (name to reference).',
        'Each step has id, op, args. An arg is a reference {"input":"batch"} or {"step":"step-id","field":"field-name"}.',
        'Output references named fields of steps. Never put example values into the workflow.',
        'Use a single string input named batch. Call audit_scope.v1 with batch to get key (string) and pages (integer).',
        'The approved audit_collect.v1 takes key and pages, performs the ledger/carrier loop and returns count, total-cents, exception-ids.',
        'Project those three outputs verbatim. Return only the JSON workflow.',
      ].join(' ') },
      { role: 'user', content: json({ request: auditSeed.prompt, successfulTrace: discovery.trace }) },
    ],
  });
  const compileUsage = { input: 0, output: 0, cached: 0, total: 0 };
  addUsage(compileUsage, response.usage);
  requireThat(response.choices?.[0]?.finish_reason === 'stop', 'Audit plan compilation did not finish');
  const spec = JSON.parse(response.choices[0].message.content);
  const compositeDispatch = withAuditCollector(dispatch);
  const learned = await capture(spec, { batch: 'AUD-SEED' }, registry, compositeDispatch);
  requireThat(json(learned.result) === json(auditSeed.expected), 'Compiled audit failed seed verification');
  const validation = await execute(learned.workflow, { batch: 'AUD-VERIFY' }, registry, compositeDispatch);
  requireThat(json(validation) === json({ count: 2, 'total-cents': 407, 'exception-ids': 'O004,O007' }),
    'Compiled audit failed independent verification');
  const receipt = publish(db, 'shipment-audit', auditDescription, learned.workflow);
  return { receipt, discoveryUsage: discovery.usage, compileUsage, workflow: learned.workflow };
}
