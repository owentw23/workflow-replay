import { summarize } from './metrics.mjs';

export function confirmationReport(rows, repeats, arms) {
  const routedArms = ['playbook-only', 'host-routed'];
  const replayed = new Map(routedArms.map(arm => [arm, new Set(rows.filter(row => row.arm === arm
    && row.expectedRoute && row.routing === 'local' && row.routes.includes(row.expectedRoute))
    .map(row => `${row.caseId}:${row.repeat}`))]));
  const cohorts = {
    covered: rows.filter(row => row.expectedRoute),
    nearMiss: rows.filter(row => !row.expectedRoute),
    routedByBoth: rows.filter(row => routedArms.every(arm => replayed.get(arm).has(`${row.caseId}:${row.repeat}`))),
  };
  const breakdown = Object.fromEntries(Object.entries(cohorts).map(([key, items]) => [
    key, summarize(items, repeats, arms),
  ]));
  const routeSafety = Object.fromEntries(routedArms.map(arm => {
    const attempted = rows.filter(row => row.arm === arm);
    return [arm, {
      expected: attempted.filter(row => row.expectedRoute).length,
      shortlisted: attempted.filter(row => row.expectedRoute && row.shortlisted.includes(row.expectedRoute)).length,
      executed: replayed.get(arm).size,
      nearMiss: attempted.filter(row => !row.expectedRoute).length,
      wrongReplay: attempted.filter(row => row.routes.some(route => route !== row.expectedRoute)).length,
    }];
  }));
  return { ...summarize(rows, repeats, arms), breakdown, routeSafety };
}
