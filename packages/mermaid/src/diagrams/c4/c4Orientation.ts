/**
 * Decides how the layout treats each relationship.
 *
 * A layered layout places the source of every edge before (above, in a top-down diagram) its
 * target. C4 diagrams read best with that flow running from the people who use a system,
 * through the system, to whatever it depends on, so the relationships are planned before
 * layout:
 *
 * - The direction hints of C4-PlantUML are honoured: `Rel_D`/`Rel_U`/`Rel_R`/`Rel_L` name where
 *   the target goes relative to the source. A hint along the diagram's flow keeps or reverses
 *   the relationship; a hint across it puts the two ends side by side in the same layer, in the
 *   order the hint gives (`Rel_R` in a top-down diagram, `Rel_D` in a left-to-right one).
 * - A plain relationship into a person, from something that is not a person, is reversed so the
 *   person stays upstream ("Sends e-mails to" a customer is drawn back up to the customer).
 * - Whatever cycles remain are broken by reversing the plain relationships that close them,
 *   found by a depth-first search that starts at the people and otherwise follows declaration
 *   order.
 *
 * Reversing only changes where the layout puts the two ends; the arrowheads are drawn on the
 * ends the relationship names.
 */

/** A relationship as far as planning is concerned. */
export interface C4RelToPlan {
  from: string;
  to: string;
  type: string;
}

/** The direction a relationship type asks for: where its target goes. */
export type C4RelHint = 'down' | 'up' | 'left' | 'right' | 'none';

export type C4FlowDirection = 'TB' | 'BT' | 'LR' | 'RL';

export interface C4RelPlan {
  /** Laid out from `to` to `from`. */
  reversed: boolean;
  /**
   * Set when the two ends go side by side in one layer: `before` comes first in the layer
   * (left of `after` in a vertical diagram, above it in a horizontal one).
   */
  sideBySide?: { before: string; after: string };
}

export const relDirectionHint = (relType: string): C4RelHint => {
  switch (relType) {
    case 'rel_d':
      return 'down';
    case 'rel_u':
      return 'up';
    case 'rel_l':
      return 'left';
    case 'rel_r':
      return 'right';
    default:
      return 'none';
  }
};

/** What a hint means in a diagram flowing in `direction`. */
const hintPlan = (
  hint: Exclude<C4RelHint, 'none'>,
  direction: C4FlowDirection,
  from: string,
  to: string
): C4RelPlan => {
  const vertical = direction === 'TB' || direction === 'BT';
  // The hint that agrees with the flow, and the one that runs against it.
  const along = { TB: 'down', BT: 'up', LR: 'right', RL: 'left' }[direction];
  const against = { TB: 'up', BT: 'down', LR: 'left', RL: 'right' }[direction];
  if (hint === along) {
    return { reversed: false };
  }
  if (hint === against) {
    return { reversed: true };
  }
  // Across the flow: within a layer, order runs left to right, or top to bottom.
  const targetAfter = vertical ? hint === 'right' : hint === 'down';
  return {
    reversed: false,
    sideBySide: targetAfter ? { before: from, after: to } : { before: to, after: from },
  };
};

/**
 * Plans every relationship.
 *
 * @param rels - the relationships, in declaration order
 * @param direction - the diagram's flow direction
 * @param nodeOrder - every element and boundary alias, in declaration order
 * @param isPerson - whether an alias names a person (internal or external)
 */
export const planRelationships = (
  rels: readonly C4RelToPlan[],
  direction: C4FlowDirection,
  nodeOrder: readonly string[],
  isPerson: (alias: string) => boolean
): C4RelPlan[] => {
  const plans: C4RelPlan[] = [];
  const fixed: boolean[] = [];

  for (const rel of rels) {
    const hint = relDirectionHint(rel.type);
    if (rel.from === rel.to) {
      plans.push({ reversed: false });
      fixed.push(true);
    } else if (hint === 'none') {
      plans.push({ reversed: isPerson(rel.to) && !isPerson(rel.from) });
      fixed.push(false);
    } else {
      plans.push(hintPlan(hint, direction, rel.from, rel.to));
      fixed.push(true);
    }
  }

  // Adjacency in declaration order, over the flow relationships as currently oriented.
  const outgoing = new Map<string, number[]>();
  const tail = (index: number) => (plans[index].reversed ? rels[index].to : rels[index].from);
  const head = (index: number) => (plans[index].reversed ? rels[index].from : rels[index].to);
  rels.forEach((rel, index) => {
    if (rel.from === rel.to || plans[index].sideBySide) {
      return;
    }
    const from = tail(index);
    if (!outgoing.has(from)) {
      outgoing.set(from, []);
    }
    outgoing.get(from)!.push(index);
  });

  // Every endpoint takes part, even one that is missing from `nodeOrder`.
  const roots: string[] = [];
  const seen = new Set<string>();
  const addRoot = (alias: string) => {
    if (!seen.has(alias)) {
      seen.add(alias);
      roots.push(alias);
    }
  };
  nodeOrder.filter(isPerson).forEach(addRoot);
  nodeOrder.forEach(addRoot);
  rels.forEach((rel) => {
    addRoot(rel.from);
    addRoot(rel.to);
  });

  // Iterative DFS, so a long chain cannot overflow the stack.
  const state = new Map<string, 'active' | 'done'>();
  for (const root of roots) {
    if (state.has(root)) {
      continue;
    }
    state.set(root, 'active');
    const stack: { alias: string; next: number }[] = [{ alias: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoing.get(frame.alias) ?? [];
      if (frame.next >= edges.length) {
        state.set(frame.alias, 'done');
        stack.pop();
        continue;
      }
      const index = edges[frame.next++];
      const target = head(index);
      const targetState = state.get(target);
      if (targetState === 'active') {
        // A back edge closes a cycle. Turning it round removes the cycle and, since its target
        // is an ancestor in the search, cannot create a new one. A hinted relationship keeps its
        // direction; the layout engine breaks such a cycle itself.
        if (!fixed[index]) {
          plans[index] = { reversed: !plans[index].reversed };
        }
      } else if (targetState === undefined) {
        state.set(target, 'active');
        stack.push({ alias: target, next: 0 });
      }
    }
  }

  return plans;
};
