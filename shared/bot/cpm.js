'use strict';

/**
 * cpm.js
 * ======
 *
 * Generic Critical Path Method (CPM) solver over a task dependency graph.
 * Used by shared/bot/coa_planner.js to schedule a team's mission tasks
 * (each task = "engage threat group X", "screen objective Y", ...) across
 * turns: tasks on the critical path (zero slack) get first claim on the
 * units best suited for them (highest OE, see capability_eval.js).
 *
 * Standard two-pass algorithm:
 *   - forward pass:  ES[t] = max(EF[dep] for dep in deps, default 0)
 *                     EF[t] = ES[t] + duration[t]
 *   - backward pass: LF[t] = min(LS[succ] for succ in successors, default projectDuration)
 *                     LS[t] = LF[t] - duration[t]
 *   - slack[t] = LS[t] - ES[t]; critical iff slack == 0
 */

/**
 * @param {Array<{id:string, duration:number, dependsOn?:string[]}>} tasks
 * @returns {{
 *   schedule: Map<string,{id:string,duration:number,es:number,ef:number,ls:number,lf:number,slack:number,critical:boolean}>,
 *   projectDuration: number,
 *   criticalPath: string[],
 * }}
 */
function computeCPM(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn || []) {
      if (!byId.has(dep)) throw new Error(`CPM: task "${t.id}" depends on unknown task "${dep}"`);
    }
  }

  // Topological order via Kahn's algorithm (also detects cycles).
  const inDegree = new Map(tasks.map(t => [t.id, 0]));
  const successors = new Map(tasks.map(t => [t.id, []]));
  for (const t of tasks) {
    for (const dep of t.dependsOn || []) {
      inDegree.set(t.id, inDegree.get(t.id) + 1);
      successors.get(dep).push(t.id);
    }
  }

  const queue = tasks.filter(t => inDegree.get(t.id) === 0).map(t => t.id);
  const order = [];
  const remaining = new Map(inDegree);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const succ of successors.get(id)) {
      remaining.set(succ, remaining.get(succ) - 1);
      if (remaining.get(succ) === 0) queue.push(succ);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error('CPM: dependency graph has a cycle');
  }

  // Forward pass: earliest start/finish.
  const es = new Map(), ef = new Map();
  for (const id of order) {
    const t = byId.get(id);
    const start = (t.dependsOn || []).reduce((max, dep) => Math.max(max, ef.get(dep)), 0);
    es.set(id, start);
    ef.set(id, start + t.duration);
  }

  const projectDuration = tasks.length === 0 ? 0 : Math.max(...order.map(id => ef.get(id)));

  // Backward pass: latest start/finish.
  const lf = new Map(), ls = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const t = byId.get(id);
    const succs = successors.get(id);
    const finish = succs.length === 0 ? projectDuration : Math.min(...succs.map(s => ls.get(s)));
    lf.set(id, finish);
    ls.set(id, finish - t.duration);
  }

  const schedule = new Map();
  const criticalPath = [];
  for (const id of order) {
    const t = byId.get(id);
    const slack = ls.get(id) - es.get(id);
    const entry = { id, duration: t.duration, es: es.get(id), ef: ef.get(id), ls: ls.get(id), lf: lf.get(id), slack, critical: slack === 0 };
    schedule.set(id, entry);
    if (entry.critical) criticalPath.push(id);
  }

  return { schedule, projectDuration, criticalPath };
}

module.exports = { computeCPM };
