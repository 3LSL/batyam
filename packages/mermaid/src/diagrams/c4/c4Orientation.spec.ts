import { describe, expect, it } from 'vitest';
import { planRelationships, relDirectionHint } from './c4Orientation.js';

const rel = (from: string, to: string, type = 'rel') => ({ from, to, type });
const people = (...aliases: string[]) => {
  const set = new Set(aliases);
  return (alias: string) => set.has(alias);
};

describe('relDirectionHint', () => {
  it('reads the C4-PlantUML direction suffixes', () => {
    expect(relDirectionHint('rel_d')).toBe('down');
    expect(relDirectionHint('rel_u')).toBe('up');
    expect(relDirectionHint('rel_l')).toBe('left');
    expect(relDirectionHint('rel_r')).toBe('right');
    expect(relDirectionHint('rel')).toBe('none');
    expect(relDirectionHint('birel')).toBe('none');
    expect(relDirectionHint('rel_b')).toBe('none');
  });
});

describe('planRelationships', () => {
  it('keeps a plain relationship in its own direction', () => {
    const plans = planRelationships([rel('a', 'b')], 'TB', ['a', 'b'], people());
    expect(plans).toEqual([{ reversed: false }]);
  });

  it('reverses a plain relationship into a person, so the person stays upstream', () => {
    const plans = planRelationships(
      [rel('system', 'customer')],
      'TB',
      ['customer', 'system'],
      people('customer')
    );
    expect(plans[0].reversed).toBe(true);
  });

  it('keeps a relationship between two people as written', () => {
    const plans = planRelationships([rel('a', 'b')], 'TB', ['a', 'b'], people('a', 'b'));
    expect(plans[0].reversed).toBe(false);
  });

  it('breaks a cycle at the relationship that leads back to a person', () => {
    // customer -> app -> mail -> customer: the e-mail back to the customer is drawn upwards.
    const plans = planRelationships(
      [rel('customer', 'app'), rel('app', 'mail'), rel('mail', 'customer')],
      'TB',
      ['mail', 'customer', 'app'],
      people('customer')
    );
    expect(plans.map((plan) => plan.reversed)).toEqual([false, false, true]);
  });

  it('breaks a cycle without people at the relationship that closes it', () => {
    const plans = planRelationships(
      [rel('a', 'b'), rel('b', 'c'), rel('c', 'a')],
      'TB',
      ['a', 'b', 'c'],
      people()
    );
    expect(plans.map((plan) => plan.reversed)).toEqual([false, false, true]);
  });

  it('never turns a hinted relationship round to break a cycle', () => {
    const plans = planRelationships(
      [rel('a', 'b', 'rel_d'), rel('b', 'a', 'rel_d')],
      'TB',
      ['a', 'b'],
      people()
    );
    expect(plans.map((plan) => plan.reversed)).toEqual([false, false]);
  });

  it('leaves a relationship to itself alone', () => {
    const plans = planRelationships([rel('a', 'a')], 'TB', ['a'], people('a'));
    expect(plans).toEqual([{ reversed: false }]);
  });

  describe('in a top-down diagram', () => {
    it('reads Rel_D along the flow and Rel_U against it', () => {
      const plans = planRelationships(
        [rel('a', 'b', 'rel_d'), rel('a', 'c', 'rel_u')],
        'TB',
        ['a', 'b', 'c'],
        people()
      );
      expect(plans).toEqual([{ reversed: false }, { reversed: true }]);
    });

    it('puts the ends of Rel_R and Rel_L side by side, target right and left', () => {
      const plans = planRelationships(
        [rel('a', 'b', 'rel_r'), rel('a', 'c', 'rel_l')],
        'TB',
        ['a', 'b', 'c'],
        people()
      );
      expect(plans).toEqual([
        { reversed: false, sideBySide: { before: 'a', after: 'b' } },
        { reversed: false, sideBySide: { before: 'c', after: 'a' } },
      ]);
    });
  });

  describe('in a bottom-up diagram', () => {
    it('reads Rel_U along the flow', () => {
      const plans = planRelationships(
        [rel('a', 'b', 'rel_u'), rel('a', 'c', 'rel_d')],
        'BT',
        ['a', 'b', 'c'],
        people()
      );
      expect(plans).toEqual([{ reversed: false }, { reversed: true }]);
    });
  });

  describe('in a left-to-right diagram', () => {
    it('reads Rel_R along the flow and Rel_L against it', () => {
      const plans = planRelationships(
        [rel('a', 'b', 'rel_r'), rel('a', 'c', 'rel_l')],
        'LR',
        ['a', 'b', 'c'],
        people()
      );
      expect(plans).toEqual([{ reversed: false }, { reversed: true }]);
    });

    it('puts the ends of Rel_D and Rel_U side by side, target below and above', () => {
      const plans = planRelationships(
        [rel('a', 'b', 'rel_d'), rel('a', 'c', 'rel_u')],
        'LR',
        ['a', 'b', 'c'],
        people()
      );
      expect(plans).toEqual([
        { reversed: false, sideBySide: { before: 'a', after: 'b' } },
        { reversed: false, sideBySide: { before: 'c', after: 'a' } },
      ]);
    });
  });

  it('leaves side-by-side relationships out of cycle breaking', () => {
    const plans = planRelationships(
      [rel('a', 'b'), rel('b', 'a', 'rel_r')],
      'TB',
      ['a', 'b'],
      people()
    );
    expect(plans[0]).toEqual({ reversed: false });
    expect(plans[1].sideBySide).toEqual({ before: 'b', after: 'a' });
  });

  it('copes with endpoints missing from the declaration order', () => {
    const plans = planRelationships([rel('x', 'y'), rel('y', 'x')], 'TB', [], people());
    expect(plans.map((plan) => plan.reversed)).toEqual([false, true]);
  });
});
